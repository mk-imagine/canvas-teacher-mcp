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
   * Returns the student with the given Canvas user ID, or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByCanvasUserId(id: number): Promise<RosterStudent | null> {
    const students = await this.load()
    return students.find((s) => s.canvasUserId === id) ?? null
  }

  /**
   * Returns the student whose `emails` array contains a match for the given
   * address (case-insensitive), or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByEmail(email: string): Promise<RosterStudent | null> {
    const students = await this.load()
    const lower = email.toLowerCase()
    return students.find((s) => s.emails.some((e) => e.toLowerCase() === lower)) ?? null
  }

  /**
   * Returns the student whose `zoomAliases` array contains a match for the
   * given alias (case-insensitive), or `null` if not found.
   * Reads fresh from disk on every call.
   */
  async findByZoomAlias(alias: string): Promise<RosterStudent | null> {
    const students = await this.load()
    const lower = alias.toLowerCase()
    return students.find((s) => s.zoomAliases.some((a) => a.toLowerCase() === lower)) ?? null
  }

  /**
   * Returns all students in the roster.
   * Reads fresh from disk on every call.
   */
  async allStudents(): Promise<RosterStudent[]> {
    return this.load()
  }
}
