import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { RosterStudent } from './types.js'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * RosterCrypto: AES-256-GCM encrypt/decrypt of the students array.
 *
 * Blob format: base64(IV[12 bytes] + authTag[16 bytes] + ciphertext[variable])
 *
 * The constructor accepts a 32-byte Buffer used as the AES-256 key.
 * The same key must be supplied to decrypt a blob produced by encrypt().
 * A wrong key or corrupted blob causes decrypt() to throw an actionable error.
 */
export class RosterCrypto {
  private readonly key: Buffer

  constructor(key: Buffer) {
    this.key = key
  }

  /**
   * Encrypts the given students array to a base64 blob.
   * Each call generates a fresh random IV, so two calls with identical input
   * produce different output.
   */
  encrypt(students: RosterStudent[]): string {
    const plaintext = JSON.stringify(students)
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
  }

  /**
   * Decrypts a base64 blob produced by encrypt() and returns the students array.
   * Throws an actionable error if decryption fails (wrong key, corrupted blob, etc.).
   */
  decrypt(encrypted: string): RosterStudent[] {
    try {
      const buf = Buffer.from(encrypted, 'base64')
      const iv = buf.subarray(0, IV_BYTES)
      const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
      const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES)
      const decipher = createDecipheriv(ALGORITHM, this.key, iv)
      decipher.setAuthTag(authTag)
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext) as RosterStudent[]
    } catch {
      throw new Error(
        "Roster decryption failed. The encryption key may have changed. Run 'canvas-mcp roster rekey' to re-encrypt with the current key."
      )
    }
  }
}
