import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeReviewFile } from '../../../src/attendance/review-file.js'
import type { ReviewEntry } from '../../../src/attendance/types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('writeReviewFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const sampleEntries: ReviewEntry[] = [
    {
      zoomName: 'Jon Smith',
      status: 'ambiguous',
      candidates: [
        { canvasName: 'John Smith', canvasUserId: 101, distance: 1 },
        { canvasName: 'Jon Smyth', canvasUserId: 102, distance: 2 },
      ],
    },
    {
      zoomName: 'Unknown Person',
      status: 'unmatched',
    },
  ]

  it('writes valid JSON to the expected path', () => {
    const result = writeReviewFile(tmpDir, sampleEntries)
    expect(result).toBe(path.join(tmpDir, 'attendance-review.json'))
    expect(fs.existsSync(result)).toBe(true)

    const content = fs.readFileSync(result, 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  it('overwrites existing file', () => {
    const firstEntries: ReviewEntry[] = [
      { zoomName: 'First', status: 'unmatched' },
    ]
    const secondEntries: ReviewEntry[] = [
      { zoomName: 'Second', status: 'ambiguous', candidates: [] },
    ]

    writeReviewFile(tmpDir, firstEntries)
    writeReviewFile(tmpDir, secondEntries)

    const filePath = path.join(tmpDir, 'attendance-review.json')
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].zoomName).toBe('Second')
  })

  it('contains the expected entries', () => {
    const filePath = writeReviewFile(tmpDir, sampleEntries)
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

    expect(parsed).toEqual(sampleEntries)
  })
})
