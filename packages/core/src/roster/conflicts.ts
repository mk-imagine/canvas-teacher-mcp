import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A recorded alias/name collision.
 *
 * Example: the roster has an alias "steve" pointing to Jun Dang (177419).
 * A new student Steve Martinez (999) joins a teacher's section. The sync
 * step records a conflict here so that attendance import does not silently
 * auto-match "steve" in the Zoom CSV to Jun Dang — it is pushed to review
 * instead, so the teacher disambiguates manually.
 */
export interface AliasConflict {
  alias: string
  aliasUserId: number
  aliasUserName: string
  newUserId: number
  newUserName: string
  courseId: number
  detectedAt: string
}

export interface ConflictFile {
  version: number
  conflicts: AliasConflict[]
}

const FILE_NAME = 'roster-conflicts.json'
const CURRENT_VERSION = 1

/**
 * ConflictStore: persists alias/name collisions detected during roster sync.
 *
 * File lives at `<configDir>/roster-conflicts.json`, mode 0600. The file is
 * small (a list of conflict records), so we load it fully on each call.
 *
 * Attendance import consults `hasConflict(alias)` at Step 1 (alias lookup) to
 * decide whether to auto-match or push the entry to the review file.
 */
export class ConflictStore {
  private readonly path: string

  constructor(configDir: string) {
    this.path = join(configDir, FILE_NAME)
  }

  load(): AliasConflict[] {
    if (!existsSync(this.path)) {
      return []
    }
    try {
      const raw = readFileSync(this.path, 'utf-8')
      const file = JSON.parse(raw) as ConflictFile
      return Array.isArray(file.conflicts) ? file.conflicts : []
    } catch {
      return []
    }
  }

  save(conflicts: AliasConflict[]): void {
    const file: ConflictFile = { version: CURRENT_VERSION, conflicts }
    const content = JSON.stringify(file, null, 2)
    const dir = join(this.path, '..')
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, content, { mode: 0o600, encoding: 'utf-8' })
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // Non-fatal — mode was already set on write
    }
  }

  /**
   * Add a conflict if no equivalent entry (same alias + newUserId) is already recorded.
   * Returns true if a new conflict was persisted.
   */
  add(conflict: AliasConflict): boolean {
    const existing = this.load()
    const key = (c: AliasConflict) => `${c.alias.toLowerCase()}|${c.newUserId}`
    if (existing.some((c) => key(c) === key(conflict))) {
      return false
    }
    this.save([...existing, conflict])
    return true
  }

  /** Returns true if the given zoom-alias string has any recorded conflict. */
  hasConflict(alias: string): boolean {
    const aliasLower = alias.toLowerCase()
    return this.load().some((c) => c.alias.toLowerCase() === aliasLower)
  }

  /** Returns all conflicts for a given alias. */
  forAlias(alias: string): AliasConflict[] {
    const aliasLower = alias.toLowerCase()
    return this.load().filter((c) => c.alias.toLowerCase() === aliasLower)
  }

  /** Removes all conflicts matching the given alias. */
  clearAlias(alias: string): void {
    const aliasLower = alias.toLowerCase()
    const remaining = this.load().filter((c) => c.alias.toLowerCase() !== aliasLower)
    this.save(remaining)
  }
}
