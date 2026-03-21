import type { ZoomParticipant, ZoomCsvOptions } from './types.js'

/**
 * Parse a Zoom participant report CSV and return structured participant records.
 *
 * Handles:
 * - BOM (`\uFEFF`) at start of file
 * - `\r\n` (CRLF) and `\n` (LF) line endings
 * - `Name (original name)` column format: `Display Name` or `Display Name (Original Name)`
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

  // Parse header row
  const headerLine = lines[0]
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase())

  // Zoom CSVs have duplicate column names: "host name" (col 3) vs "name (original name)" (col 16),
  // and "duration (minutes)" appears twice (meeting-level col 8, participant-level col 20).
  // Prefer the specific participant columns; fall back to generic matches for simpler CSVs.
  let nameIdx = headers.findIndex((h) => h === 'name (original name)')
  if (nameIdx === -1) {
    nameIdx = headers.findIndex((h) => h.startsWith('name'))
  }
  let durationIdx = headers.lastIndexOf('duration (minutes)')
  if (durationIdx === -1) {
    durationIdx = headers.findIndex((h) => h.includes('duration'))
  }

  if (nameIdx === -1) {
    throw new Error('Missing required column: Name. Expected a column starting with "Name" in the CSV header.')
  }
  if (durationIdx === -1) {
    throw new Error(
      'Missing required column: Duration. Expected a column containing "Duration" in the CSV header.',
    )
  }

  const participants: ZoomParticipant[] = []

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',').map((f) => f.trim())
    if (fields.length <= Math.max(nameIdx, durationIdx)) {
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
      const displayLower = displayName.toLowerCase()
      if (displayLower === hostLower || originalName?.toLowerCase() === hostLower) {
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
