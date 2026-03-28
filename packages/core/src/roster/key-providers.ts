import { readFileSync, statSync } from 'node:fs'

import type { RosterKeyProvider } from './types.js'

// ---------------------------------------------------------------------------
// FileKeyProvider
// ---------------------------------------------------------------------------

/**
 * Reads a hex-encoded 32-byte AES-256 key from a file on disk.
 *
 * The file must:
 *   - contain exactly 64 hex characters (upper or lower case), optionally
 *     surrounded by whitespace
 *   - be readable only by the owner (permissions `0600`)
 *
 * Generate a key with:
 *   openssl rand -hex 32 > <path> && chmod 600 <path>
 */
export class FileKeyProvider implements RosterKeyProvider {
  private readonly keyPath: string

  constructor(keyPath: string) {
    this.keyPath = keyPath
  }

  async deriveKey(): Promise<Buffer> {
    // (a) Stat the file — ENOENT → friendly error with generation instructions
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.keyPath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(
          `Key file not found: ${this.keyPath}\n` +
            `Generate one with: openssl rand -hex 32 > ${this.keyPath} && chmod 600 ${this.keyPath}`,
        )
      }
      throw err
    }

    // (b) Permission check — must be exactly 0600
    if ((stat.mode & 0o777) !== 0o600) {
      const actual = (stat.mode & 0o777).toString(8).padStart(3, '0')
      throw new Error(
        `insecure permissions on key file ${this.keyPath} (${actual}); ` +
          `run: chmod 600 ${this.keyPath}`,
      )
    }

    // (c) Read and trim
    const hex = readFileSync(this.keyPath, 'utf-8').trim()

    // (d) Validate: exactly 64 hex chars
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `invalid key format in ${this.keyPath}: expected 64 hex characters (32 bytes)`,
      )
    }

    // (e) Return as Buffer
    return Buffer.from(hex, 'hex')
  }
}
