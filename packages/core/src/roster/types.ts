/**
 * A student record stored in the shared roster.
 *
 * - `canvasUserId`: the Canvas user ID
 * - `name`: display name as returned by Canvas
 * - `sortable_name`: last, first format as returned by Canvas
 * - `emails`: known email addresses for this student
 * - `courseIds`: Canvas course IDs the student is enrolled in
 * - `zoomAliases`: known Zoom display names for attendance matching
 * - `created`: ISO 8601 timestamp when this record was first created
 */
export interface RosterStudent {
  canvasUserId: number
  name: string
  sortable_name: string
  emails: string[]
  courseIds: number[]
  zoomAliases: string[]
  created: string
}

/**
 * The on-disk roster file format.
 *
 * - `version`: schema version number for forward/backward compatibility
 * - `last_updated`: ISO 8601 timestamp of the last write
 * - `encrypted`: AES-256-GCM encrypted JSON payload containing the roster data
 */
export interface RosterFile {
  version: number
  last_updated: string
  encrypted: string
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
