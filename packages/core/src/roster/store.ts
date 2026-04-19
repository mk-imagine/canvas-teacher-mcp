import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { RosterCrypto } from './crypto.js'
import type { RosterStudent, RosterFile, RosterKeyProvider } from './types.js'

const CURRENT_VERSION = 2

/**
 * RosterStore: persistent storage for the shared student roster.
 *
 * FERPA protection is currently file-permission-based (mode 0600) with
 * plaintext data at rest (on-disk format v2). The AES-256-GCM encryption
 * machinery (`RosterCrypto`, `RosterKeyProvider`) is retained as dead wiring
 * for future re-enablement. To re-enable, construct with a `keyProvider` and
 * update `save()` to branch on its presence.
 *
 * On-disk format:
 *   v2 (current): `{ version: 2, last_updated: "<ISO>", students: [...] }`
 *   v1 (legacy):  `{ version: 1, last_updated: "<ISO>", encrypted: "<base64>" }`
 *
 * Legacy v1 files are auto-quarantined on load when no keyProvider is wired:
 * the file is renamed to `roster.json.encrypted-legacy` and the store returns
 * an empty roster so `syncRosterFromEnrollments` can repopulate cleanly.
 *
 * Writes are atomic: data is written to a `.tmp` file, then renamed into place.
 * File permissions are set to `0600` on both the temp file and the final file.
 */
export class RosterStore {
  private readonly rosterPath: string
  private readonly keyProvider: RosterKeyProvider | undefined
  private crypto: RosterCrypto | null = null

  constructor(configDir: string, keyProvider?: RosterKeyProvider) {
    this.rosterPath = join(configDir, 'roster.json')
    this.keyProvider = keyProvider
  }

  /**
   * Derives the key on first call and caches the resulting `RosterCrypto` instance.
   * Only used for decrypting legacy v1 files when a keyProvider is wired.
   */
  private async ensureCrypto(): Promise<RosterCrypto> {
    if (this.keyProvider === undefined) {
      throw new Error('No keyProvider configured; cannot decrypt legacy roster.')
    }
    if (this.crypto === null) {
      const key = await this.keyProvider.deriveKey()
      this.crypto = new RosterCrypto(key)
    }
    return this.crypto
  }

  /**
   * Loads the roster from disk.
   *
   * Returns an empty array if the roster file does not exist.
   *
   * - v2 plaintext: returns the `students` array directly.
   * - v1 encrypted with keyProvider: decrypts (legacy read path).
   * - v1 encrypted without keyProvider: quarantines the file by renaming to
   *   `roster.json.encrypted-legacy` and returns an empty array, emitting a
   *   stderr warning. The caller is expected to re-sync from Canvas.
   */
  async load(): Promise<RosterStudent[]> {
    if (!existsSync(this.rosterPath)) {
      return []
    }

    let raw: string
    try {
      raw = readFileSync(this.rosterPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read roster file at ${this.rosterPath}: ${String(err)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `Roster file at ${this.rosterPath} contains invalid JSON. The file may be corrupt.`
      )
    }

    const file = parsed as RosterFile

    if (file.version === 2 && Array.isArray(file.students)) {
      // Backfill-safe: older v2 records may predate the sectionIds field.
      return file.students.map((s) => ({
        ...s,
        sectionIds: Array.isArray(s.sectionIds) ? s.sectionIds : [],
      }))
    }

    if (file.version === 1 && typeof file.encrypted === 'string') {
      if (this.keyProvider === undefined) {
        const quarantinePath = `${this.rosterPath}.encrypted-legacy`
        renameSync(this.rosterPath, quarantinePath)
        process.stderr.write(
          `[roster] Encrypted legacy roster quarantined to ${quarantinePath}; continuing with empty roster.\n`
        )
        return []
      }
      const crypto = await this.ensureCrypto()
      return crypto.decrypt(file.encrypted)
    }

    throw new Error(`Unsupported roster file version: ${file.version}`)
  }

  /**
   * Saves the roster to disk using an atomic write, mode 0600.
   *
   * Always writes the v2 plaintext format. Encryption-at-rest is currently
   * disabled; the `keyProvider` and `RosterCrypto` wiring is retained for
   * future re-enablement but not exercised on the write path.
   */
  async save(students: RosterStudent[]): Promise<void> {
    const rosterFile: RosterFile = {
      version: CURRENT_VERSION,
      last_updated: new Date().toISOString(),
      students,
    }

    const content = JSON.stringify(rosterFile, null, 2)
    const dir = join(this.rosterPath, '..')
    mkdirSync(dir, { recursive: true })

    const tmpPath = `${this.rosterPath}.tmp`
    writeFileSync(tmpPath, content, { mode: 0o600, encoding: 'utf-8' })
    renameSync(tmpPath, this.rosterPath)
    try {
      chmodSync(this.rosterPath, 0o600)
    } catch {
      // Non-fatal — mode was already set on write
    }
  }

  /**
   * Returns the student with the given Canvas user ID, or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByCanvasUserId(id: number, courseId: number): Promise<RosterStudent | null> {
    const students = await this.load()
    return students.find((s) => s.canvasUserId === id && s.courseIds.includes(courseId)) ?? null
  }

  /**
   * Returns the student whose `emails` array contains a match for the given
   * address (case-insensitive), or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByEmail(email: string, courseId: number): Promise<RosterStudent | null> {
    const students = await this.load()
    const lower = email.toLowerCase()
    return students.find((s) => s.courseIds.includes(courseId) && s.emails.some((e) => e.toLowerCase() === lower)) ?? null
  }

  /**
   * Returns the student whose `zoomAliases` array contains a match for the
   * given alias (case-insensitive), or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByZoomAlias(alias: string, courseId: number): Promise<RosterStudent | null> {
    const students = await this.load()
    const lower = alias.toLowerCase()
    return students.find((s) => s.courseIds.includes(courseId) && s.zoomAliases.some((a) => a.toLowerCase() === lower)) ?? null
  }

  /**
   * Returns all students in the roster.
   * Reads fresh from disk on every call.
   */
  async allStudents(courseId: number): Promise<RosterStudent[]> {
    const students = await this.load()
    return students.filter((s) => s.courseIds.includes(courseId))
  }

  /**
   * Inserts or replaces a student record in the roster.
   *
   * If a student with the same `canvasUserId` already exists, the entire record
   * is replaced (full replace, not merge). If not found, the record is appended.
   */
  async upsertStudent(student: RosterStudent): Promise<void> {
    const students = await this.load()
    const idx = students.findIndex((s) => s.canvasUserId === student.canvasUserId)
    if (idx >= 0) {
      students.splice(idx, 1, student)
    } else {
      students.push(student)
    }
    await this.save(students)
  }

  /**
   * Removes a specific course ID from a student's `courseIds` array.
   *
   * If the removal leaves the student with no course IDs, the student record is
   * removed from the roster entirely. Returns `true` if the student was found,
   * `false` if no student with `canvasUserId` exists.
   */
  async removeStudentCourseId(canvasUserId: number, courseId: number): Promise<boolean> {
    const students = await this.load()
    const idx = students.findIndex((s) => s.canvasUserId === canvasUserId)
    if (idx < 0) {
      return false
    }
    const student = students[idx]
    student.courseIds = student.courseIds.filter((id) => id !== courseId)
    if (student.courseIds.length === 0) {
      students.splice(idx, 1)
    }
    await this.save(students)
    return true
  }

  /**
   * Adds a Zoom display name alias to a student's `zoomAliases` array.
   *
   * Deduplicates case-insensitively — if an alias matching `alias` (ignoring
   * case) already exists, no duplicate is added. Returns `true` if the student
   * was found, `false` if no student with `canvasUserId` exists.
   */
  async appendZoomAlias(canvasUserId: number, alias: string): Promise<boolean> {
    const students = await this.load()
    const student = students.find((s) => s.canvasUserId === canvasUserId)
    if (!student) {
      return false
    }
    const aliasLower = alias.toLowerCase()
    if (!student.zoomAliases.some((a) => a.toLowerCase() === aliasLower)) {
      student.zoomAliases.push(alias)
    }
    await this.save(students)
    return true
  }
}
