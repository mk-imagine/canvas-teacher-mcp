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

/**
 * RosterStore: persistent encrypted storage for the shared student roster.
 *
 * On-disk format: `{ version: 1, last_updated: "<ISO 8601>", encrypted: "<base64>" }`
 *
 * Writes are atomic: data is written to a `.tmp` file, then renamed into place,
 * ensuring the roster file is never left in a partially-written state.
 *
 * Key derivation is lazy: the `RosterKeyProvider.deriveKey()` is called on first
 * `load()` or `save()` and the resulting `RosterCrypto` instance is cached for the
 * lifetime of this `RosterStore` instance.
 */
export class RosterStore {
  private readonly rosterPath: string
  private readonly keyProvider: RosterKeyProvider
  private crypto: RosterCrypto | null = null

  constructor(configDir: string, keyProvider: RosterKeyProvider) {
    this.rosterPath = join(configDir, 'roster.json')
    this.keyProvider = keyProvider
  }

  /**
   * Derives the key on first call and caches the resulting `RosterCrypto` instance.
   */
  private async ensureCrypto(): Promise<RosterCrypto> {
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
   * Throws a descriptive error if the file is corrupt, has an unsupported version,
   * or cannot be decrypted with the current key.
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
    if (file.version !== 1) {
      throw new Error(`Unsupported roster file version: ${file.version}`)
    }

    const crypto = await this.ensureCrypto()
    // decrypt() throws an actionable error (containing "roster rekey") if the key is wrong
    return crypto.decrypt(file.encrypted)
  }

  /**
   * Saves the roster to disk using an atomic write.
   *
   * Writes to `<rosterPath>.tmp` then renames into place, so the file is never
   * left in a partially-written state. File permissions are set to `0600` on both
   * the temp file and the final file.
   */
  async save(students: RosterStudent[]): Promise<void> {
    const crypto = await this.ensureCrypto()

    const rosterFile: RosterFile = {
      version: 1,
      last_updated: new Date().toISOString(),
      encrypted: crypto.encrypt(students),
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
