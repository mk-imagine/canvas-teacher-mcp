import { describe, it, expect } from 'vitest'
import { SecureStore } from '../../../src/security/secure-store.js'

describe('SecureStore', () => {
  it('tokenize() returns [STUDENT_001] for the first call', () => {
    const store = new SecureStore()
    const token = store.tokenize(1001, 'Jane Smith')
    expect(token).toBe('[STUDENT_001]')
    store.destroy()
  })

  it('same Canvas ID returns same token (idempotent)', () => {
    const store = new SecureStore()
    const t1 = store.tokenize(1001, 'Jane Smith')
    const t2 = store.tokenize(1001, 'Jane Smith')
    expect(t1).toBe(t2)
    store.destroy()
  })

  it('different Canvas IDs get different tokens', () => {
    const store = new SecureStore()
    const t1 = store.tokenize(1001, 'Jane Smith')
    const t2 = store.tokenize(1002, 'Bob Adams')
    expect(t1).not.toBe(t2)
    expect(t1).toBe('[STUDENT_001]')
    expect(t2).toBe('[STUDENT_002]')
    store.destroy()
  })

  it('resolve() returns correct { canvasId, name } after tokenize', () => {
    const store = new SecureStore()
    const token = store.tokenize(1001, 'Jane Smith')
    const resolved = store.resolve(token)
    expect(resolved).toEqual({ canvasId: 1001, name: 'Jane Smith' })
    store.destroy()
  })

  it('resolve() returns null for unknown token', () => {
    const store = new SecureStore()
    expect(store.resolve('[STUDENT_999]')).toBeNull()
    store.destroy()
  })

  it('listTokens() returns tokens in encounter order', () => {
    const store = new SecureStore()
    store.tokenize(1003, 'Carol')
    store.tokenize(1001, 'Alice')
    store.tokenize(1002, 'Bob')
    expect(store.listTokens()).toEqual(['[STUDENT_001]', '[STUDENT_002]', '[STUDENT_003]'])
    store.destroy()
  })

  it('listTokens() does not re-add token on repeated tokenize call', () => {
    const store = new SecureStore()
    store.tokenize(1001, 'Jane Smith')
    store.tokenize(1001, 'Jane Smith')
    store.tokenize(1002, 'Bob Adams')
    expect(store.listTokens()).toEqual(['[STUDENT_001]', '[STUDENT_002]'])
    store.destroy()
  })

  it('destroy() causes resolve() to return null (map cleared)', () => {
    const store = new SecureStore()
    const token = store.tokenize(1001, 'Jane Smith')
    store.destroy()
    expect(store.resolve(token)).toBeNull()
  })

  it('destroy() causes listTokens() to return empty array', () => {
    const store = new SecureStore()
    store.tokenize(1001, 'Jane Smith')
    store.destroy()
    expect(store.listTokens()).toEqual([])
  })

  it('tokens use 3-digit zero-padded sequential numbering', () => {
    const store = new SecureStore()
    for (let i = 1; i <= 12; i++) {
      store.tokenize(1000 + i, `Student ${i}`)
    }
    const tokens = store.listTokens()
    expect(tokens[0]).toBe('[STUDENT_001]')
    expect(tokens[9]).toBe('[STUDENT_010]')
    expect(tokens[11]).toBe('[STUDENT_012]')
    store.destroy()
  })
})
