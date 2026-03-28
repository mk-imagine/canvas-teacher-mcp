import { describe, it, expect, beforeEach } from 'vitest'
import { SecureStore } from '../../../src/security/secure-store.js'

describe('SecureStore', () => {
  let store: SecureStore

  beforeEach(() => {
    store = new SecureStore()
  })

  // ── tokenize ────────────────────────────────────────────────────────────────

  it('tokenize — returns [STUDENT_001] for the first user', () => {
    const token = store.tokenize(100, 'Alice')
    expect(token).toBe('[STUDENT_001]')
  })

  it('tokenize — increments counter for new users', () => {
    store.tokenize(1, 'Alice')
    store.tokenize(2, 'Bob')
    const t3 = store.tokenize(3, 'Charlie')
    expect(t3).toBe('[STUDENT_003]')
  })

  it('tokenize — idempotent for same canvasUserId', () => {
    const t1 = store.tokenize(42, 'Alice')
    const t2 = store.tokenize(42, 'Alice')
    expect(t1).toBe(t2)
  })

  it('tokenize — same id does not increment counter', () => {
    store.tokenize(1, 'Alice')
    store.tokenize(1, 'Alice') // duplicate
    const t2 = store.tokenize(2, 'Bob')
    expect(t2).toBe('[STUDENT_002]')
  })

  // ── resolve ─────────────────────────────────────────────────────────────────

  it('resolve — roundtrips canvasId and name', () => {
    const token = store.tokenize(7, 'Jane Doe')
    const resolved = store.resolve(token)
    expect(resolved).toEqual({ canvasId: 7, name: 'Jane Doe' })
  })

  it('resolve — returns null for unknown token', () => {
    expect(store.resolve('[STUDENT_999]')).toBeNull()
  })

  it('resolve — normalizes token without brackets', () => {
    store.tokenize(1, 'Alice')
    const resolved = store.resolve('STUDENT_001')
    expect(resolved).toEqual({ canvasId: 1, name: 'Alice' })
  })

  // ── listTokens ─────────────────────────────────────────────────────────────

  it('listTokens — returns tokens in encounter order', () => {
    store.tokenize(3, 'Charlie')
    store.tokenize(1, 'Alice')
    store.tokenize(2, 'Bob')
    expect(store.listTokens()).toEqual([
      '[STUDENT_001]',
      '[STUDENT_002]',
      '[STUDENT_003]',
    ])
  })

  it('listTokens — returns empty array when no tokens issued', () => {
    expect(store.listTokens()).toEqual([])
  })

  it('listTokens — returns a copy, not the internal array', () => {
    store.tokenize(1, 'Alice')
    const list = store.listTokens()
    list.push('FAKE')
    expect(store.listTokens()).toHaveLength(1)
  })

  // ── destroy ─────────────────────────────────────────────────────────────────

  it('destroy — resolve returns null for all previously valid tokens', () => {
    const t1 = store.tokenize(1, 'Alice')
    const t2 = store.tokenize(2, 'Bob')
    store.destroy()
    expect(store.resolve(t1)).toBeNull()
    expect(store.resolve(t2)).toBeNull()
  })

  it('destroy — listTokens returns empty array', () => {
    store.tokenize(1, 'Alice')
    store.destroy()
    expect(store.listTokens()).toEqual([])
  })

  // ── sessionId ───────────────────────────────────────────────────────────────

  it('sessionId — is a valid UUID', () => {
    expect(store.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('sessionId — is unique per instance', () => {
    const store2 = new SecureStore()
    expect(store.sessionId).not.toBe(store2.sessionId)
  })

  // ── preload ─────────────────────────────────────────────────────────────────

  it('preload — assigns tokens in order and resolve returns correct PII', () => {
    store.preload([
      { canvasUserId: 10, name: 'Alice' },
      { canvasUserId: 20, name: 'Bob' },
      { canvasUserId: 30, name: 'Charlie' },
    ])
    expect(store.listTokens()).toEqual(['[STUDENT_001]', '[STUDENT_002]', '[STUDENT_003]'])
    expect(store.resolve('[STUDENT_001]')).toEqual({ canvasId: 10, name: 'Alice' })
    expect(store.resolve('[STUDENT_002]')).toEqual({ canvasId: 20, name: 'Bob' })
    expect(store.resolve('[STUDENT_003]')).toEqual({ canvasId: 30, name: 'Charlie' })
  })

  it('preload — empty array is a no-op; listTokens returns [] and counter stays 0', () => {
    store.preload([])
    expect(store.listTokens()).toEqual([])
    // counter still 0: next tokenize gets [STUDENT_001]
    expect(store.tokenize(1, 'Alice')).toBe('[STUDENT_001]')
  })

  it('preload — second call with same list is a no-op; listTokens length stays 2', () => {
    const roster = [
      { canvasUserId: 1, name: 'Alice' },
      { canvasUserId: 2, name: 'Bob' },
    ]
    store.preload(roster)
    store.preload(roster)
    expect(store.listTokens()).toHaveLength(2)
  })

  it('preload — tokenize for an already-preloaded id returns its assigned token, counter stays same', () => {
    store.preload([
      { canvasUserId: 1, name: 'Alice' },
      { canvasUserId: 2, name: 'Bob' },
    ])
    const token = store.tokenize(2, 'Bob')
    expect(token).toBe('[STUDENT_002]')
    // counter stays at 2; next new id gets [STUDENT_003]
    expect(store.tokenize(3, 'Charlie')).toBe('[STUDENT_003]')
  })

  it('preload — tokenize for a new id after preload returns next counter value', () => {
    store.preload([
      { canvasUserId: 1, name: 'Alice' },
      { canvasUserId: 2, name: 'Bob' },
    ])
    expect(store.tokenize(3, 'Charlie')).toBe('[STUDENT_003]')
  })

  it('preload — tokenize(X) then preload([X,Y]) keeps X token, assigns next to Y', () => {
    store.tokenize(10, 'Alice') // [STUDENT_001]
    store.preload([
      { canvasUserId: 10, name: 'Alice' },
      { canvasUserId: 20, name: 'Bob' },
    ])
    expect(store.resolve('[STUDENT_001]')).toEqual({ canvasId: 10, name: 'Alice' })
    expect(store.resolve('[STUDENT_002]')).toEqual({ canvasId: 20, name: 'Bob' })
    expect(store.listTokens()).toHaveLength(2)
  })
})
