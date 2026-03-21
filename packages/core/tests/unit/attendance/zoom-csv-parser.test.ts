import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseZoomCsv } from '../../../src/attendance/zoom-csv-parser.js'

const FIXTURE_PATH = join(__dirname, '../../fixtures/zoom-report-sample.csv')

const STANDARD_CSV = `Name (original name),Email,Duration (minutes),Guest,Consent
Alice Johnson,alice@example.com,45,No,Yes
Bob Smith (Robert Smith),bob@example.com,60,No,Yes
Charlie Brown,charlie@example.com,30,No,Yes`

describe('parseZoomCsv', () => {
  it('parses a standard Zoom CSV with 3 participants', () => {
    const result = parseZoomCsv(STANDARD_CSV)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      name: 'Alice Johnson',
      originalName: null,
      duration: 45,
    })
    expect(result[1]).toEqual({
      name: 'Robert Smith',
      originalName: 'Robert Smith',
      duration: 60,
    })
    expect(result[2]).toEqual({
      name: 'Charlie Brown',
      originalName: null,
      duration: 30,
    })
  })

  it('handles BOM prefix', () => {
    const csvWithBom = '\uFEFF' + STANDARD_CSV
    const result = parseZoomCsv(csvWithBom)
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('Alice Johnson')
  })

  it('handles CRLF line endings', () => {
    const csvCrlf = STANDARD_CSV.replace(/\n/g, '\r\n')
    const result = parseZoomCsv(csvCrlf)
    expect(result).toHaveLength(3)
    expect(result[0].duration).toBe(45)
    expect(result[2].name).toBe('Charlie Brown')
  })

  it('extracts original name from parentheses in Name column', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Display Name (Real Name),test@test.com,30`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Real Name')
    expect(result[0].originalName).toBe('Real Name')
  })

  it('returns empty array for header-only CSV', () => {
    const csv = `Name (original name),Email,Duration (minutes)`
    const result = parseZoomCsv(csv)
    expect(result).toEqual([])
  })

  it('returns empty array for empty string', () => {
    const result = parseZoomCsv('')
    expect(result).toEqual([])
  })

  it('throws descriptive error when Duration column is missing', () => {
    const csv = `Name (original name),Email,Guest
Alice Johnson,alice@example.com,No`
    expect(() => parseZoomCsv(csv)).toThrow(/Duration/i)
  })

  it('throws descriptive error when Name column is missing', () => {
    const csv = `Email,Duration (minutes),Guest
alice@example.com,45,No`
    expect(() => parseZoomCsv(csv)).toThrow(/Name/i)
  })

  it('filters out host entry when hostName is provided', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Prof Smith (Host),prof@example.com,90
Alice Johnson,alice@example.com,45
Bob Smith,bob@example.com,60`
    const result = parseZoomCsv(csv, { hostName: 'Prof Smith' })
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Alice Johnson')
    expect(result[1].name).toBe('Bob Smith')
  })

  it('filters host rows without (Host) suffix — e.g. rejoin rows', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Prof Smith (Host),prof@example.com,60
Prof Smith,prof@example.com,30
Alice Johnson,alice@example.com,45`
    const result = parseZoomCsv(csv, { hostName: 'Prof Smith' })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Alice Johnson')
  })

  it('filters host case-insensitively', () => {
    const csv = `Name (original name),Email,Duration (minutes)
prof smith,prof@example.com,90
Alice Johnson,alice@example.com,45`
    const result = parseZoomCsv(csv, { hostName: 'Prof Smith' })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Alice Johnson')
  })

  it('does not filter host when hostName is not provided', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Prof Smith (Host),prof@example.com,90
Alice Johnson,alice@example.com,45`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(2)
  })

  it('treats (he/him) as pronouns, not original name', () => {
    const csv = `Name (original name),Email,Duration (minutes)
John Smith (he/him),john@example.com,45`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('John Smith')
    expect(result[0].originalName).toBeNull()
  })

  it('treats (she/her/ella) as pronouns, not original name', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Maria Garcia (she/her/ella),maria@example.com,50`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Maria Garcia')
    expect(result[0].originalName).toBeNull()
  })

  it('treats (they/them) as pronouns, not original name', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Alex Jones (they/them),alex@example.com,30`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Alex Jones')
    expect(result[0].originalName).toBeNull()
  })

  it('preserves legitimate original name in parentheses', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Bobby (Robert Smith),bob@example.com,60`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Robert Smith')
    expect(result[0].originalName).toBe('Robert Smith')
  })
})

describe('parseZoomCsv — real Zoom fixture', () => {
  const csv = readFileSync(FIXTURE_PATH, 'utf-8')

  it('parses all participants from a real Zoom export', () => {
    const result = parseZoomCsv(csv)
    // 8 rows total: 1 host + 7 students, host not filtered without hostName
    expect(result).toHaveLength(8)
  })

  it('filters host by exact name match', () => {
    const result = parseZoomCsv(csv, { hostName: 'sample teacher' })
    expect(result).toHaveLength(7)
    expect(result.every((p) => p.name !== 'sample teacher')).toBe(true)
  })

  it('resolves duplicate Name/Duration columns correctly', () => {
    // The real CSV has "Host name" (col 3) and "Name (original name)" (col 16),
    // plus "Duration (minutes)" at col 8 (meeting) and col 20 (participant).
    // Parser must use the participant columns, not the meeting-level ones.
    const result = parseZoomCsv(csv, { hostName: 'sample teacher' })
    // If the parser used col 3/8, every name would be "sample teacher" with duration 131
    expect(result[0].name).not.toBe('sample teacher')
    // Jane Smith has participant duration 125, not meeting duration 131
    const jane = result.find((p) => p.name === 'Jane Smith')
    expect(jane).toBeDefined()
    expect(jane!.duration).toBe(125)
  })

  it('extracts original name from parentheses in real data', () => {
    const result = parseZoomCsv(csv, { hostName: 'sample teacher' })
    // "Carlos R (Carlos Rivera-Garcia)" → name should be "Carlos Rivera-Garcia"
    const carlos = result.find((p) => p.name === 'Carlos Rivera-Garcia')
    expect(carlos).toBeDefined()
    expect(carlos!.originalName).toBe('Carlos Rivera-Garcia')
    // "김민준 (Minjun Kim)" → name should be "Minjun Kim"
    const minjun = result.find((p) => p.name === 'Minjun Kim')
    expect(minjun).toBeDefined()
    expect(minjun!.originalName).toBe('Minjun Kim')
  })

  it('preserves display name when no original name in parens', () => {
    const result = parseZoomCsv(csv, { hostName: 'sample teacher' })
    const bchen = result.find((p) => p.name === 'bchen42')
    expect(bchen).toBeDefined()
    expect(bchen!.originalName).toBeNull()
    const aisha = result.find((p) => p.name === 'Aisha')
    expect(aisha).toBeDefined()
    expect(aisha!.originalName).toBeNull()
  })

  it('captures short-duration and guest participants', () => {
    const result = parseZoomCsv(csv, { hostName: 'sample teacher' })
    const priya = result.find((p) => p.name === 'Priya P.')
    expect(priya).toBeDefined()
    expect(priya!.duration).toBe(15)
    const iphone = result.find((p) => p.name === 'iPhone')
    expect(iphone).toBeDefined()
    expect(iphone!.duration).toBe(2)
  })
})
