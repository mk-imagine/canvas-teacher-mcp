/**
 * A single participant record extracted from a Zoom participant report CSV.
 *
 * - `name`: the best available name for roster matching -- the original name
 *   (from parentheses) if present, otherwise the display name.
 * - `originalName`: the parenthesised original name, or null if absent.
 * - `duration`: attendance duration in minutes.
 */
export interface ZoomParticipant {
  name: string
  originalName: string | null
  duration: number
}

/**
 * Options for parsing a Zoom CSV.
 */
export interface ZoomCsvOptions {
  /** If provided, rows whose display name matches this value are filtered out (host). */
  hostName?: string
}
