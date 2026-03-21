import { describe, it, expect } from 'vitest'
import { blindText, blindValue, levenshtein } from '../../src/before_model.js'

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

  describe('levenshtein', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshtein('alice', 'alice')).toBe(0)
    })

    it('should return 1 for a single insertion', () => {
      expect(levenshtein('alice', 'alicee')).toBe(1)
    })

    it('should return 1 for a single deletion', () => {
      expect(levenshtein('alice', 'alce')).toBe(1)
    })

    it('should return 1 for a single substitution', () => {
      expect(levenshtein('alice', 'alxce')).toBe(1)
    })

    it('should return full length for completely different strings', () => {
      expect(levenshtein('abc', 'xyz')).toBe(3)
    })

    it('should handle empty vs non-empty strings', () => {
      expect(levenshtein('', 'abc')).toBe(3)
      expect(levenshtein('abc', '')).toBe(3)
    })

    it('should return 0 for both empty strings', () => {
      expect(levenshtein('', '')).toBe(0)
    })

    it('should be case-sensitive', () => {
      expect(levenshtein('Alice', 'alice')).toBe(1)
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
