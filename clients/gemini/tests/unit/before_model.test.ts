import { describe, it, expect } from 'vitest'
import { blindText, blindValue } from '../../src/before_model.js'

describe('before_model hook', () => {
  // The sidecar mapping is bidirectional: both token→name and name→token entries are present.
  // blindText only acts on non-[STUDENT_ keys (the name→token direction).
  const mockMapping = {
    '[STUDENT_001]': 'Alice Smith',
    'Alice Smith': '[STUDENT_001]',
    '[STUDENT_002]': 'Bob Jones',
    'Bob Jones': '[STUDENT_002]',
  }

  describe('blindText', () => {
    it('should blind a real name back to a token', () => {
      const input = "What is Alice Smith's grade?"
      const output = blindText(input, mockMapping)
      expect(output).toBe("What is [STUDENT_001]'s grade?")
    })

    it('should handle multiple names', () => {
      const input = 'Compare Alice Smith and Bob Jones.'
      const output = blindText(input, mockMapping)
      expect(output).toBe('Compare [STUDENT_001] and [STUDENT_002].')
    })

    it('should ignore tokens themselves (only blind reverse values)', () => {
      const input = '[STUDENT_001] is Alice Smith.'
      const output = blindText(input, mockMapping)
      expect(output).toBe('[STUDENT_001] is [STUDENT_001].')
    })
  })

  describe('blindValue', () => {
    it('should blind text in nested prompt objects', () => {
      const input = {
        messages: [
          {
            role: 'user',
            content: "Alice Smith's status?"
          }
        ]
      }
      const output = blindValue(input, mockMapping) as any
      expect(output.messages[0].content).toBe("[STUDENT_001]'s status?")
    })
  })
})
