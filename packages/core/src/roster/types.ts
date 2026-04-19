/**
 * A student record stored in the shared roster.
 *
 * - `canvasUserId`: the Canvas user ID
 * - `name`: display name as returned by Canvas
 * - `sortable_name`: last, first format as returned by Canvas
 * - `emails`: known email addresses for this student
 * - `courseIds`: Canvas course IDs the student is enrolled in
 * - `sectionIds`: Canvas section IDs the student is enrolled in (only
 *   populated for sections the current teacher teaches; cross-listed
 *   sections taught by other instructors are excluded at sync time)
 * - `zoomAliases`: known Zoom display names for attendance matching
 * - `created`: ISO 8601 timestamp when this record was first created
 */
export interface RosterStudent {
  canvasUserId: number
  name: string
  sortable_name: string
  emails: string[]
  courseIds: number[]
  sectionIds: number[]
  zoomAliases: string[]
  created: string
}

/**
 * The on-disk roster file format.
 *
 * - `version`: schema version number.
 *   - v1 = legacy encrypted (`encrypted` field present)
 *   - v2 = plaintext (`students` field present, file mode 0600)
 * - `last_updated`: ISO 8601 timestamp of the last write
 * - `students`: plaintext roster array (v2)
 * - `encrypted`: AES-256-GCM encrypted JSON payload (v1 legacy)
 *
 * Encryption-at-rest is currently disabled; the crypto machinery is retained as
 * dead wiring for future re-enablement. FERPA protection relies on 0600 perms.
 */
export interface RosterFile {
  version: number
  last_updated: string
  students?: RosterStudent[]
  encrypted?: string
}

/**
 * Provides a derived encryption key for roster file operations.
 *
 * Implementors derive a key from a passphrase or secret material.
 * The returned Buffer is used directly as an AES-256 key (32 bytes).
 */
export interface RosterKeyProvider {
  deriveKey(): Promise<Buffer>
}
