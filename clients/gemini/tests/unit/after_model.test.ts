import { describe, it, expect, beforeEach } from 'vitest'
import { processString, processValue, HookContext } from '../../src/after_model.js'

describe('after_model hook', () => {
  const mockMapping = {
    '[STUDENT_001]': 'Alice Smith',
    '[STUDENT_002]': 'Bob Jones',
  }

  let ctx: HookContext

  beforeEach(() => {
    ctx = {
      inputBuffer: '',
      nextBuffer: '',
    }
  })

  describe('processString', () => {
    it('should unblind a single token', () => {
      const input = 'Hello [STUDENT_001]!'
      const output = processString(input, mockMapping, ctx)
      expect(output).toBe('Hello Alice Smith!')
      expect(ctx.nextBuffer).toBe('')
    })

    it('should unblind multiple tokens', () => {
      const input = '[STUDENT_001] and [STUDENT_002] are here.'
      const output = processString(input, mockMapping, ctx)
      expect(output).toBe('Alice Smith and Bob Jones are here.')
    })

    it('should handle unknown tokens gracefully', () => {
      const input = 'Hello [STUDENT_999]!'
      const output = processString(input, mockMapping, ctx)
      expect(output).toBe('Hello [STUDENT_999]!')
    })

    it('should buffer partial tokens at the end of string', () => {
      const input = 'This is [STUD'
      const output = processString(input, mockMapping, ctx)
      expect(output).toBe('This is ')
      expect(ctx.nextBuffer).toBe('[STUD')
    })

    it('should complete a partial token from the input buffer', () => {
      ctx.inputBuffer = '[STUD'
      const input = 'ENT_001] is Alice.'
      const output = processString(input, mockMapping, ctx)
      expect(output).toBe('Alice Smith is Alice.')
      expect(ctx.nextBuffer).toBe('')
    })

    it('should handle multiple split boundaries', () => {
      // First chunk
      const out1 = processString('Student: [STUDENT_', mockMapping, ctx)
      expect(out1).toBe('Student: ')
      expect(ctx.nextBuffer).toBe('[STUDENT_')

      // Second chunk
      ctx.inputBuffer = ctx.nextBuffer
      ctx.nextBuffer = ''
      const out2 = processString('001] is Bob.', mockMapping, ctx)
      expect(out2).toBe('Alice Smith is Bob.')
    })
  })

  describe('processValue', () => {
    it('should unblind nested objects (standard Gemini CLI response)', () => {
      const input = {
        text: 'Grade for [STUDENT_001]: A',
        candidates: [
          {
            content: {
              // Real Gemini response shape: parts is an array of objects with a text field
              parts: [{ text: 'Grade for [STUDENT_001]: A' }]
            }
          }
        ]
      }

      const output = processValue(input, mockMapping, ctx) as any
      expect(output.text).toBe('Grade for Alice Smith: A')
      expect(output.candidates[0].content.parts[0].text).toBe('Grade for Alice Smith: A')
    })

    it('should handle arrays', () => {
      const input = ['[STUDENT_001]', { name: '[STUDENT_002]' }]
      const output = processValue(input, mockMapping, ctx) as any
      expect(output[0]).toBe('Alice Smith')
      expect(output[1].name).toBe('Bob Jones')
    })
  })
})
