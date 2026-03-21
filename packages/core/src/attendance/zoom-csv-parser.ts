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

  const nameIdx = headers.findIndex((h) => h.startsWith('name'))
  const durationIdx = headers.findIndex((h) => h.includes('duration'))

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

    // Filter host entry: Zoom appends " (Host)" to the host's display name
    if (options?.hostName) {
      // The display name in CSV may be "Prof Smith (Host)" -- strip the (Host) suffix for comparison
      const nameWithoutHost = displayName.replace(/\s*\(Host\)\s*$/, '')
      if (nameWithoutHost === options.hostName) {
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

/**
 * Parse the Name column value. Zoom uses the format:
 *   "Display Name" or "Display Name (Original Name)"
 *
 * When "(Host)" is the parenthesised part, it is NOT treated as an original name.
 */
function parseNameField(raw: string): { displayName: string; originalName: string | null } {
  // Match the last parenthesised group
  const match = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (match) {
    const parenContent = match[2].trim()
    // "(Host)" is a Zoom role marker, not an original name
    if (parenContent.toLowerCase() === 'host') {
      return { displayName: raw, originalName: null }
    }
    return { displayName: match[1].trim(), originalName: parenContent }
  }
  return { displayName: raw.trim(), originalName: null }
}
