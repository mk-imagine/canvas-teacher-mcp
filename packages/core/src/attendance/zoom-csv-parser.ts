import type { ZoomParticipant, ZoomCsvOptions } from './types.js'

/**
 * Participant-level columns we extract from Zoom CSVs.
 * All other columns (Topic, Host Name, meeting-level Duration, etc.) are ignored.
 */
const PARTICIPANT_COLUMNS = {
  name: 'name (original name)',
  duration: 'duration (minutes)',
} as const

/**
 * Parse a Zoom participant report CSV and return structured participant records.
 *
 * Only reads the participant-level columns listed in PARTICIPANT_COLUMNS.
 * All other columns (Topic, Host Name, meeting-level Duration, etc.) are
 * ignored entirely, which avoids the host name appearing in non-name columns
 * from interfering with matching.
 *
 * Handles:
 * - BOM (`\uFEFF`) at start of file
 * - `\r\n` (CRLF) and `\n` (LF) line endings
 * - `Name (original name)` column format: `Display Name` or `Display Name (Original Name)`
 * - Duplicate column names (uses last occurrence for duration to prefer participant-level)
 * - Optional host filtering via `options.hostName`
 *
 * @throws Error if required columns (Name, Duration) are not found in the header row
 */
export function parseZoomCsv(csvContent: string, options?: ZoomCsvOptions): ZoomParticipant[] {
  // Strip BOM
  const content = csvContent.replace(/^\uFEFF/, '')

  // Split on CRLF or LF
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')

  if (lines.length === 0) {
    return []
  }

  // Parse header row and locate only the columns we need.
  // For "name (original name)", use first exact match (falls back to any "name*" column).
  // For "duration (minutes)", use LAST occurrence to prefer participant-level over meeting-level.
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())

  let nameIdx = headers.findIndex((h) => h === PARTICIPANT_COLUMNS.name)
  if (nameIdx === -1) {
    nameIdx = headers.findIndex((h) => h.startsWith('name'))
  }
  let durationIdx = headers.lastIndexOf(PARTICIPANT_COLUMNS.duration)
  if (durationIdx === -1) {
    durationIdx = headers.findIndex((h) => h.includes('duration'))
  }

  if (nameIdx === -1) {
    throw new Error(
      `Missing required column: Name. Expected "${PARTICIPANT_COLUMNS.name}" in the CSV header.`,
    )
  }
  if (durationIdx === -1) {
    throw new Error(
      `Missing required column: Duration. Expected "${PARTICIPANT_COLUMNS.duration}" in the CSV header.`,
    )
  }

  // Only read from these column indices — everything else is ignored.
  const maxRequiredIdx = Math.max(nameIdx, durationIdx)

  const participants: ZoomParticipant[] = []

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',').map((f) => f.trim())
    if (fields.length <= maxRequiredIdx) {
      continue // skip malformed rows
    }

    const rawName = fields[nameIdx]
    const duration = parseInt(fields[durationIdx], 10)

    if (!rawName || isNaN(duration)) {
      continue
    }

    // Parse "Display Name (Original Name)" format
    const { displayName, originalName } = parseNameField(rawName)

    // Filter host entry: remove any row whose display name or original name
    // matches the configured hostName (case-insensitive).
    if (options?.hostName) {
      const hostLower = options.hostName.toLowerCase()
      if (displayName.toLowerCase() === hostLower || originalName?.toLowerCase() === hostLower) {
        continue
      }
    }

    participants.push({
      name: originalName ?? displayName,
      originalName,
      duration,
    })
  }

  return participants
}

/** Matches parenthesized content containing a forward slash — pronouns like "he/him", "she/her/ella". */
const PRONOUN_PARENS_PATTERN = /^.+\/.*$/

/**
 * Parse the Name column value. Zoom uses the format:
 *   "Display Name" or "Display Name (Original Name)"
 *
 * Parenthesised content that is a Zoom role marker "(Host)" or looks like
 * pronouns "(he/him)", "(she/her/ella)" is NOT treated as an original name.
 */
function parseNameField(raw: string): { displayName: string; originalName: string | null } {
  // Match the last parenthesised group
  const match = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (match) {
    const parenContent = match[2].trim()
    // "(Host)" is a Zoom role marker, not an original name
    if (parenContent.toLowerCase() === 'host') {
      return { displayName: match[1].trim(), originalName: null }
    }
    // Pronoun-like content (contains a forward slash) — not an original name
    if (PRONOUN_PARENS_PATTERN.test(parenContent)) {
      return { displayName: match[1].trim(), originalName: null }
    }
    return { displayName: match[1].trim(), originalName: parenContent }
  }
  return { displayName: raw.trim(), originalName: null }
}
