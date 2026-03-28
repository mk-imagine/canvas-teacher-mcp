import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { createRequire } from 'node:module'

interface EncryptedEntry {
  iv: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/**
 * SecureStore: replaces student PII with opaque session tokens.
 *
 * AES-256-GCM encrypts each { canvasId, name } payload with a per-session key.
 * The key is generated fresh on construction and optionally pinned in RAM via
 * mlock (posix-node) to reduce swap-file exposure.
 *
 * Full core-dump protection requires an OS-level ulimit -c 0 / launchctl limit
 * core 0 in addition to mlock. Pass --secure-heap=65536 to Node to protect
 * OpenSSL's internal crypto buffers.
 */
export class SecureStore {
  readonly sessionId: string
  private readonly sessionKey: Buffer
  private readonly map: Map<string, EncryptedEntry>
  private readonly idToToken: Map<number, string>
  private counter: number
  private readonly encounterOrder: string[]

  constructor() {
    this.sessionId = randomUUID()
    this.sessionKey = randomBytes(32)
    this.map = new Map()
    this.idToToken = new Map()
    this.counter = 0
    this.encounterOrder = []

    // Attempt to lock the session key in RAM to prevent swap-file exposure.
    // Wrapped in try/catch — failure is non-fatal; encryption is still active.
    try {
      const req = createRequire(import.meta.url)
      const posixNode = req('posix-node') as { mlock?: (buf: Buffer) => void }
      if (typeof posixNode.mlock === 'function') {
        posixNode.mlock(this.sessionKey)
      }
    } catch {
      process.stderr.write(
        '[secure-store] Warning: mlock unavailable; session key may be swapped to disk.\n'
      )
    }
  }

  /**
   * Returns a stable `[STUDENT_NNN]` token for the given Canvas user.
   * Idempotent: the same canvasUserId always returns the same token.
   */
  tokenize(canvasUserId: number, name: string): string {
    const existing = this.idToToken.get(canvasUserId)
    if (existing !== undefined) return existing

    this.counter++
    const token = `[STUDENT_${String(this.counter).padStart(3, '0')}]`

    const plaintext = JSON.stringify({ canvasId: canvasUserId, name })
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.sessionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    this.map.set(token, { iv, authTag, ciphertext })
    this.idToToken.set(canvasUserId, token)
    this.encounterOrder.push(token)

    return token
  }

  /**
   * Decrypts and returns the PII for a token, or null if unknown / key destroyed.
   */
  resolve(token: string): { canvasId: number; name: string } | null {
    const normalized = /^\[.*\]$/.test(token) ? token : `[${token}]`
    const entry = this.map.get(normalized)
    if (entry === undefined) return null

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.sessionKey, entry.iv)
      decipher.setAuthTag(entry.authTag)
      const plaintext = Buffer.concat([
        decipher.update(entry.ciphertext),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext) as { canvasId: number; name: string }
    } catch {
      return null
    }
  }

  /** Returns all tokens in the order they were first encountered. */
  listTokens(): string[] {
    return [...this.encounterOrder]
  }

  /**
   * Pre-assigns tokens to a roster of students in order.
   * Idempotent: calling preload again with the same (or overlapping) list is a no-op
   * for already-tokenized IDs; new IDs receive the next counter values.
   */
  preload(students: Array<{ canvasUserId: number; name: string }>): void {
    for (const student of students) {
      this.tokenize(student.canvasUserId, student.name)
    }
  }

  /**
   * Zero-fills the session key and all encrypted entries, then clears the maps.
   * After destroy(), resolve() always returns null.
   */
  destroy(): void {
    this.sessionKey.fill(0)
    for (const entry of this.map.values()) {
      entry.iv.fill(0)
      entry.authTag.fill(0)
      entry.ciphertext.fill(0)
    }
    this.map.clear()
    this.idToToken.clear()
    this.encounterOrder.length = 0
  }
}
