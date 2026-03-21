import { describe, it, expect } from 'vitest'
import { blindText, blindValue, levenshtein, buildNameIndex, type NameIndex } from '../../src/before_model.js'

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

  describe('buildNameIndex', () => {
    const index = buildNameIndex(mockMapping)

    it('entries are sorted longest name first', () => {
      expect(index.entries.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < index.entries.length; i++) {
        expect(index.entries[i - 1].name.length).toBeGreaterThanOrEqual(index.entries[i].name.length)
      }
    })

    it('uniqueParts correctly maps unique parts to single-element token arrays and shared parts to multi-element arrays', () => {
      // "alice" only belongs to Alice Smith → single token (length >= 4)
      expect(index.uniqueParts.get('alice')).toEqual(['[STUDENT_001]'])
      // "bob" is only 3 chars, below the length >= 4 threshold → not in uniqueParts
      expect(index.uniqueParts.get('bob')).toBeUndefined()
      // "smith" only belongs to Alice Smith (length >= 4) → single token
      expect(index.uniqueParts.get('smith')).toEqual(['[STUDENT_001]'])
      // "jones" only belongs to Bob Jones → single token
      expect(index.uniqueParts.get('jones')).toEqual(['[STUDENT_002]'])
    })

    it('stopwords set contains all 19 required words', () => {
      const required = [
        'will', 'mark', 'grace', 'may', 'grant', 'chase', 'mason',
        'dean', 'hunter', 'frank', 'dawn', 'page', 'lane', 'drew',
        'dale', 'glen', 'cole', 'reed', 'wade'
      ]
      for (const word of required) {
        expect(index.stopwords.has(word)).toBe(true)
      }
      expect(index.stopwords.size).toBe(19)
    })
  })

  describe('Phase 1 - case-insensitive full-name', () => {
    const index = buildNameIndex(mockMapping)

    it('blindText matches lowercase full name', () => {
      const output = blindText('alice smith', mockMapping, index)
      expect(output).toContain('[STUDENT_001]')
    })

    it('blindText matches uppercase full name', () => {
      const output = blindText('ALICE SMITH', mockMapping, index)
      expect(output).toContain('[STUDENT_001]')
    })

    it('blindText matches mixed case and multiple names', () => {
      const output = blindText('Alice Smith and bob jones', mockMapping, index)
      expect(output).toBe('[STUDENT_001] and [STUDENT_002]')
    })

    it('longest-first matching prevents partial overlap', () => {
      const extendedMapping = {
        ...mockMapping,
        'Mary Jane Watson': '[STUDENT_010]',
        '[STUDENT_010]': 'Mary Jane Watson',
        'Jane Watson': '[STUDENT_011]',
        '[STUDENT_011]': 'Jane Watson',
      }
      const extIndex = buildNameIndex(extendedMapping)
      const output = blindText('Mary Jane Watson', extendedMapping, extIndex)
      expect(output).toBe('[STUDENT_010]')
    })
  })

  describe('Phase 2 - partial name match', () => {
    it('unique first name >= 4 chars matched', () => {
      const localMapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
        'Bob Jones': '[STUDENT_002]',
        '[STUDENT_002]': 'Bob Jones',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Alice did well', localMapping, index)).toBe('[STUDENT_001] did well')
    })

    it('short part skipped', () => {
      const localMapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
        'Bob Jones': '[STUDENT_002]',
        '[STUDENT_002]': 'Bob Jones',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Bob did well', localMapping, index)).toBe('Bob did well')
    })

    it('stopword skipped', () => {
      const localMapping: Record<string, string> = {
        'Mark Johnson': '[STUDENT_003]',
        '[STUDENT_003]': 'Mark Johnson',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Mark did well', localMapping, index)).toBe('Mark did well')
    })

    it('full-name still works for stopword names', () => {
      const localMapping: Record<string, string> = {
        'Mark Johnson': '[STUDENT_003]',
        '[STUDENT_003]': 'Mark Johnson',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Mark Johnson did well', localMapping, index)).toBe('[STUDENT_003] did well')
    })

    it('ambiguous expansion with possessive', () => {
      const localMapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
        'Alice Jacobs': '[STUDENT_002]',
        '[STUDENT_002]': 'Alice Jacobs',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText("alice's grades", localMapping, index)).toBe("[STUDENT_001] and [STUDENT_002]'s grades")
    })

    it('ambiguous expansion without possessive', () => {
      const localMapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
        'Alice Jacobs': '[STUDENT_002]',
        '[STUDENT_002]': 'Alice Jacobs',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('I spoke with alice today', localMapping, index)).toBe('I spoke with [STUDENT_001] and [STUDENT_002] today')
    })

    it('part not matched inside other words', () => {
      const localMapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Malice is not Alice', localMapping, index)).toBe('Malice is not [STUDENT_001]')
    })

    it('unique last name matched', () => {
      const localMapping: Record<string, string> = {
        'Alice Johnson': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Johnson',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText('Johnson submitted', localMapping, index)).toBe('[STUDENT_001] submitted')
    })

    it('possessive on single-token match', () => {
      const localMapping: Record<string, string> = {
        'Alice Johnson': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Johnson',
      }
      const index = buildNameIndex(localMapping)
      expect(blindText("Johnson's paper", localMapping, index)).toBe("[STUDENT_001]'s paper")
    })
  })

  describe('Phase 3 - fuzzy matching', () => {
    const singleAliceMapping: Record<string, string> = {
      'Alice Smith': '[STUDENT_001]',
      '[STUDENT_001]': 'Alice Smith',
    }

    it('full-name typo (insertion)', () => {
      const index = buildNameIndex(singleAliceMapping)
      const output = blindText('Alicee Smith did well', singleAliceMapping, index)
      expect(output).toBe('[STUDENT_001] did well')
    })

    it('full-name typo with long name', () => {
      const longMapping: Record<string, string> = {
        ...singleAliceMapping,
        'Christopher Reynolds': '[STUDENT_004]',
        '[STUDENT_004]': 'Christopher Reynolds',
      }
      const index = buildNameIndex(longMapping)
      const output = blindText('Christpher Reyonlds is here', longMapping, index)
      expect(output).toBe('[STUDENT_004] is here')
    })

    it('single-part typo (unique part)', () => {
      const index = buildNameIndex(singleAliceMapping)
      const output = blindText('Alce did well', singleAliceMapping, index)
      expect(output).toBe('[STUDENT_001] did well')
    })

    it('single-part over threshold', () => {
      const index = buildNameIndex(singleAliceMapping)
      const output = blindText('Axyz did well', singleAliceMapping, index)
      expect(output).toBe('Axyz did well')
    })

    it('full-name over threshold', () => {
      const index = buildNameIndex(singleAliceMapping)
      const output = blindText('Xxxxx Yyyyy likes coding', singleAliceMapping, index)
      expect(output).toBe('Xxxxx Yyyyy likes coding')
    })

    it('fuzzy does not match stopwords', () => {
      const markMapping: Record<string, string> = {
        'Mark Johnson': '[STUDENT_003]',
        '[STUDENT_003]': 'Mark Johnson',
      }
      const index = buildNameIndex(markMapping)
      const output = blindText('Marl did well', markMapping, index)
      expect(output).toBe('Marl did well')
    })

    it('fuzzy does not match short parts', () => {
      const bobMapping: Record<string, string> = {
        'Bob Jones': '[STUDENT_002]',
        '[STUDENT_002]': 'Bob Jones',
      }
      const index = buildNameIndex(bobMapping)
      const output = blindText('Bbb did well', bobMapping, index)
      expect(output).toBe('Bbb did well')
    })

    it('fuzzy + possessive', () => {
      const index = buildNameIndex(singleAliceMapping)
      const output = blindText("Alce's grades", singleAliceMapping, index)
      expect(output).toBe("[STUDENT_001]'s grades")
    })
  })

  describe('DoD verification - full pipeline', () => {
    it('pipeline through blindValue with case-insensitive, partial, and typo', () => {
      const mapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
        'Bob Jones': '[STUDENT_002]',
        '[STUDENT_002]': 'Bob Jones',
      }
      const index = buildNameIndex(mapping)
      const input = {
        messages: [
          { role: 'user', content: 'alice smith did great' },
          { role: 'assistant', content: "Jones's paper was good" },
          { role: 'user', content: 'What about Alce?' },
        ],
      }
      const output = blindValue(input, mapping, index) as any
      expect(output.messages[0].content).toBe('[STUDENT_001] did great')
      expect(output.messages[1].content).toBe("[STUDENT_002]'s paper was good")
      expect(output.messages[2].content).toBe('What about [STUDENT_001]?')
    })

    it('no-index exact-only', () => {
      const mapping: Record<string, string> = {
        'Alice Smith': '[STUDENT_001]',
        '[STUDENT_001]': 'Alice Smith',
      }
      const output = blindText('alice smith', mapping)
      expect(output).toBe('alice smith')
    })
  })

  describe('backward compatibility', () => {
    it('blindText without index returns same as before', () => {
      const output = blindText("What is Alice Smith's grade?", mockMapping)
      expect(output).toBe("What is [STUDENT_001]'s grade?")
    })

    it('blindValue without index returns same as before', () => {
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
