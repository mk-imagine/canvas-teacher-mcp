import { describe, it, expect } from 'vitest'
import { parseZoomCsv } from '../../../src/attendance/zoom-csv-parser.js'

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

  it('does not filter host when hostName is not provided', () => {
    const csv = `Name (original name),Email,Duration (minutes)
Prof Smith (Host),prof@example.com,90
Alice Johnson,alice@example.com,45`
    const result = parseZoomCsv(csv)
    expect(result).toHaveLength(2)
  })
})
