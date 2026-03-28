import { execFile as execFileCb } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { CanvasTeacherConfig } from '../config/schema.js'
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

// ---------------------------------------------------------------------------
// SshAgentKeyProvider
// ---------------------------------------------------------------------------

// ssh2 is a CJS-only package; use createRequire to load it in this ESM module.
const _require = createRequire(import.meta.url)
const { OpenSSHAgent } = _require('ssh2') as typeof import('ssh2')

const SSH_AGENT_CHALLENGE = 'canvas-mcp:roster-key:v1'
const SSH_AGENT_TIMEOUT_MS = 5_000

// Type guard: OpenSSHAgent always returns ParsedKey entries, but the @types/ssh2
// IdentityCallback is typed as KnownPublicKeys<T> = Array<T | PublicKeyEntry>.
// This guard narrows to ParsedKey so we can access .type and .getPublicSSH().
function isParsedKey(k: import('ssh2').ParsedKey | import('ssh2').PublicKeyEntry): k is import('ssh2').ParsedKey {
  return typeof (k as import('ssh2').ParsedKey).type === 'string'
}

/**
 * Derives a deterministic AES-256 key by signing a fixed challenge string
 * via the SSH agent.
 *
 * Key derivation:
 *   challenge = UTF-8 Buffer of "canvas-mcp:roster-key:v1"
 *   signature = SSH agent signs challenge with the selected key
 *   AES key   = SHA-256(signature bytes)  →  32-byte Buffer
 *
 * Key selection:
 *   - If `fingerprint` is provided, the matching key is used.
 *   - Otherwise: first Ed25519 key is preferred; first RSA key is the fallback.
 *   - ECDSA keys are rejected.
 *
 * Requires `SSH_AUTH_SOCK` to be set.
 */
export class SshAgentKeyProvider implements RosterKeyProvider {
  private readonly fingerprint: string | null

  constructor(fingerprint?: string | null) {
    this.fingerprint = fingerprint ?? null
  }

  async deriveKey(): Promise<Buffer> {
    const socketPath = process.env['SSH_AUTH_SOCK']
    if (!socketPath) {
      throw new Error('SSH agent not available (SSH_AUTH_SOCK not set)')
    }

    // Wrap the callback-based agent API in a Promise with a timeout.
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSH agent connection timed out (socket: ${socketPath})`))
      }, SSH_AGENT_TIMEOUT_MS)

      const done = (err: Error | null, result?: Buffer) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(result!)
      }

      let agent: InstanceType<typeof OpenSSHAgent>
      try {
        agent = new OpenSSHAgent(socketPath)
      } catch (err) {
        done(new Error(`SSH agent socket error (${socketPath}): ${String(err)}`))
        return
      }

      agent.getIdentities((err, keys) => {
        if (err) {
          done(new Error(`SSH agent socket error (${socketPath}): ${err.message}`))
          return
        }

        // Narrow all keys to ParsedKey — OpenSSHAgent always returns ParsedKey
        // entries at runtime; the union with PublicKeyEntry is a @types/ssh2
        // over-approximation on the base class callback type.
        const allKeys = (keys ?? []).filter(isParsedKey)

        if (allKeys.length === 0) {
          done(new Error('No keys found in SSH agent'))
          return
        }

        // Fingerprint matching — SHA-256 of the raw public key blob, formatted
        // as "SHA256:<base64>", matching the output of `ssh-keygen -lf`.
        let selectedKey: import('ssh2').ParsedKey | undefined

        if (this.fingerprint !== null) {
          selectedKey = allKeys.find((k) => {
            const raw = k.getPublicSSH()
            const fp = 'SHA256:' + createHash('sha256').update(raw).digest('base64')
            return fp === this.fingerprint
          })
          if (!selectedKey) {
            done(new Error(`No SSH key matching fingerprint ${this.fingerprint} found`))
            return
          }
        } else {
          // Prefer first Ed25519, then first RSA; reject if only ECDSA present.
          const ed25519 = allKeys.find((k) => k.type === 'ssh-ed25519')
          const rsa = allKeys.find((k) => k.type === 'ssh-rsa')
          const hasNonEcdsa = ed25519 ?? rsa

          if (!hasNonEcdsa) {
            // All keys are ECDSA (or ssh-dss) — check specifically for ECDSA
            const hasEcdsa = allKeys.some((k) => k.type.startsWith('ecdsa-sha2-'))
            if (hasEcdsa) {
              done(new Error(
                'ECDSA keys are not supported for roster encryption. Use Ed25519 or RSA.',
              ))
              return
            }
            // No supported key type at all — report no usable keys
            done(new Error('No keys found in SSH agent'))
            return
          }

          selectedKey = ed25519 ?? rsa!
        }

        // Check that the selected key is not ECDSA (relevant for fingerprint path)
        if (selectedKey.type.startsWith('ecdsa-sha2-')) {
          done(new Error(
            'ECDSA keys are not supported for roster encryption. Use Ed25519 or RSA.',
          ))
          return
        }

        const challenge = Buffer.from(SSH_AGENT_CHALLENGE, 'utf-8')

        agent.sign(selectedKey, challenge, (signErr, signature) => {
          if (signErr) {
            done(new Error(`SSH agent signing failed: ${signErr.message}`))
            return
          }

          if (!signature) {
            done(new Error('SSH agent returned empty signature'))
            return
          }

          // SHA-256 of the raw signature bytes → 32-byte AES key
          const aesKey = createHash('sha256').update(signature).digest()
          done(null, aesKey)
        })
      })
    })
  }
}

// ---------------------------------------------------------------------------
// createKeyProvider factory
// ---------------------------------------------------------------------------

/**
 * Walks the SSH agent → macOS Keychain → file key provider chain and returns
 * the first available provider.
 *
 * Selection order:
 *   1. SSH agent (`SSH_AUTH_SOCK` set, agent has a valid Ed25519/RSA key)
 *   2. macOS Keychain (darwin only, `security` CLI accessible)
 *   3. File fallback: `<configDir>/roster.key` (returned without validation)
 *
 * Logs exactly one line to stderr indicating which provider was selected.
 */
export async function createKeyProvider(
  config: CanvasTeacherConfig,
  configDir: string,
): Promise<RosterKeyProvider> {
  // Step 1: SSH agent
  if (process.env['SSH_AUTH_SOCK']) {
    try {
      const provider = new SshAgentKeyProvider(config.security?.rosterKeyFingerprint ?? null)
      await provider.deriveKey()
      process.stderr.write('[roster] Using SSH agent key provider\n')
      return provider
    } catch {
      // fall through to next provider
    }
  }

  // Step 2: macOS Keychain (darwin only)
  if (process.platform === 'darwin') {
    try {
      const provider = new KeychainKeyProvider()
      await provider.deriveKey()
      process.stderr.write('[roster] Using macOS Keychain key provider\n')
      return provider
    } catch {
      // fall through to file provider
    }
  }

  // Step 3: File fallback (not validated — caller validates on use)
  const fp = new FileKeyProvider(join(configDir, 'roster.key'))
  process.stderr.write('[roster] Using file key provider\n')
  return fp
}
