import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ReviewEntry } from './types.js'

const REVIEW_FILENAME = 'attendance-review.json'

/**
 * Writes ambiguous/unmatched attendance entries to a JSON file for human review.
 * Overwrites any existing file at the same path (ephemeral per-session).
 *
 * @param dir - Directory to write the review file into (must exist).
 * @param entries - Review entries to serialize.
 * @returns The full path to the written file.
 */
export function writeReviewFile(dir: string, entries: ReviewEntry[]): string {
  const filePath = path.join(dir, REVIEW_FILENAME)
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8')
  return filePath
}
