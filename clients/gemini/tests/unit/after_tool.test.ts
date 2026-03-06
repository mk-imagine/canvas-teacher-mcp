import { describe, it, expect } from 'vitest'
import { buildSummary } from '../../src/after_tool.js'

describe('after_tool hook', () => {
  describe('buildSummary', () => {
    it('should summarize missing submissions', () => {
      const data = { total_missing_submissions: 5 }
      const summary = buildSummary('get_submission_status', data)
      expect(summary).toBe('Found 5 missing submissions.')
    })

    it('should summarize late submissions', () => {
      const data = { total_late_submissions: 3 }
      const summary = buildSummary('get_submission_status', data)
      expect(summary).toBe('Found 3 late submissions.')
    })

    it('should summarize class grades', () => {
      const data = { student_count: 25 }
      const summary = buildSummary('get_grades', data)
      expect(summary).toBe('Fetched grades for 25 students.')
    })

    it('should summarize specific student grades', () => {
      const data = { 
        student_token: '[STUDENT_001]',
        assignments: [{}, {}, {}] 
      }
      const summary = buildSummary('get_grades', data)
      expect(summary).toBe('Fetched 3 assignments for [STUDENT_001].')
    })

    it('should summarize course assignments', () => {
      const data = {
        course_id: 123,
        assignments: [{}, {}]
      }
      // list_items is the current tool name; buildSummary matches on data shape, not tool name
      const summary = buildSummary('list_items', data)
      expect(summary).toBe('Found 2 assignments for course 123.')
    })

    it('should fallback to items count for generic lists', () => {
      const data = { items: [1, 2, 3, 4] }
      const summary = buildSummary('list_modules', data)
      expect(summary).toBe('Retrieved 4 items.')
    })

    it('should return null for unknown data structures', () => {
      const data = { unknown_field: 'value' }
      const summary = buildSummary('some_tool', data)
      expect(summary).toBeNull()
    })
  })
})
