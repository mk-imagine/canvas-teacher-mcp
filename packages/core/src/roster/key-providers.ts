import { execFile as execFileCb } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'

import type { RosterKeyProvider } from './types.js'

const execFileAsync = promisify(execFileCb)

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

// ---------------------------------------------------------------------------
// KeychainKeyProvider
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'canvas-mcp'
const KEYCHAIN_ACCOUNT = 'roster-key'

/**
 * Stores and retrieves a 32-byte AES-256 roster key in the macOS Keychain
 * via the `security` CLI.
 *
 * - First call: generates a random key, writes it to the Keychain with
 *   `add-generic-password -U` (idempotent update flag), and returns it.
 * - Subsequent calls: reads the hex-encoded key from the Keychain and
 *   returns the same 32 bytes.
 *
 * Requires macOS.  Throws if the `security` binary is not available.
 */
export class KeychainKeyProvider implements RosterKeyProvider {
  async deriveKey(): Promise<Buffer> {
    // (a) Attempt to read an existing key from the Keychain
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w',
      ])
      const hex = stdout.trim()
      return Buffer.from(hex, 'hex')
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string }

      // Binary not present on this OS
      if (e.code === 'ENOENT') {
        throw new Error('macOS Keychain not available (security command not found)')
      }

      // "could not be found" in stderr means the item doesn't exist yet — fall
      // through to generate a new key.  All other errors propagate as-is.
      const stderr: string = e.stderr ?? ''
      if (!stderr.includes('could not be found')) {
        throw err
      }
    }

    // (b) No existing entry — generate and store a new key
    const key = randomBytes(32)
    const hex = key.toString('hex')

    await execFileAsync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', KEYCHAIN_ACCOUNT,
      '-w', hex,
      '-U',
    ])

    return key
  }
}
