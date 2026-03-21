import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_SIDECAR_PATH = join(homedir(), '.cache', 'canvas-mcp', 'pii_session.json')
const sidecarPath = process.env['CANVAS_MCP_SIDECAR_PATH'] ?? DEFAULT_SIDECAR_PATH

interface SidecarFile {
  session_id: string
  last_updated: string
  mapping: Record<string, string>
}

function loadMapping(): Record<string, string> | null {
  if (!existsSync(sidecarPath)) return null
  try {
    const content = readFileSync(sidecarPath, 'utf-8')
    const data = JSON.parse(content) as SidecarFile
    return data.mapping
  } catch {
    return null
  }
}

export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)

  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[n]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface NameIndex {
  entries: Array<{ name: string; token: string; regex: RegExp; parts: string[] }>
  uniqueParts: Map<string, string[]>
  stopwords: Set<string>
  partRegexes: Map<string, RegExp>
}

export function buildNameIndex(mapping: Record<string, string>): NameIndex {
  const entries: NameIndex['entries'] = []
  for (const [key, value] of Object.entries(mapping)) {
    if (!key.startsWith('[STUDENT_')) {
      entries.push({
        name: key,
        token: value,
        regex: new RegExp('(?<!\\w)' + escapeRegex(key) + '(?!\\w)', 'gi'),
        parts: key.toLowerCase().split(' '),
      })
    }
  }
  entries.sort((a, b) => b.name.length - a.name.length)

  const stopwords = new Set([
    'will', 'mark', 'grace', 'may', 'grant', 'chase', 'mason',
    'dean', 'hunter', 'frank', 'dawn', 'page', 'lane', 'drew',
    'dale', 'glen', 'cole', 'reed', 'wade',
  ])

  const uniqueParts = new Map<string, string[]>()
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.length < 4) continue
      const existing = uniqueParts.get(part)
      if (existing) {
        existing.push(entry.token)
      } else {
        uniqueParts.set(part, [entry.token])
      }
    }
  }

  const partRegexes = new Map<string, RegExp>()
  for (const key of uniqueParts.keys()) {
    if (!stopwords.has(key)) {
      partRegexes.set(key, new RegExp("(?<!\\w)" + escapeRegex(key) + "('s)?(?!\\w)", 'gi'))
    }
  }

  return { entries, uniqueParts, stopwords, partRegexes }
}

export function blindText(text: string, mapping: Record<string, string>, index?: NameIndex): string {
  if (index === undefined) {
    let result = text
    for (const [key, value] of Object.entries(mapping)) {
      if (!key.startsWith('[STUDENT_')) {
        result = result.replaceAll(key, value)
      }
    }
    return result
  }

  // Phase 1: case-insensitive full-name regex matching
  let result = text
  for (const entry of index.entries) {
    result = result.replace(entry.regex, entry.token)
  }
  return result
}

export function blindValue(value: unknown, mapping: Record<string, string>, index?: NameIndex): unknown {
  if (typeof value === 'string') return blindText(value, mapping, index)
  if (Array.isArray(value)) return value.map((v) => blindValue(v, mapping, index))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = blindValue(v, mapping, index)
    }
    return result
  }
  return value
}

const DEBUG = process.env['CANVAS_MCP_DEBUG'] === '1'
const DEBUG_LOG = join(homedir(), '.cache', 'canvas-mcp', 'hook-debug.log')

function debugLog(label: string, data: unknown) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const line = `[${ts}] ${label}: ${JSON.stringify(data, null, 2)}\n`
  process.stderr.write(`[canvas-mcp/before_model] ${label}\n`)
  try { appendFileSync(DEBUG_LOG, line) } catch { /* ignore */ }
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')

  const mapping = loadMapping()
  if (mapping === null) {
    debugLog('NO_MAPPING', 'sidecar not found')
    process.stdout.write('{}')
    return
  }

  let hookInput: Record<string, unknown>
  try {
    hookInput = JSON.parse(raw)
  } catch {
    process.stdout.write('{}')
    return
  }

  debugLog('INPUT_KEYS', Object.keys(hookInput))

  const llmRequest = hookInput['llm_request']
  if (llmRequest === undefined) {
    debugLog('NO_LLM_REQUEST', 'llm_request missing from input')
    process.stdout.write('{}')
    return
  }

  debugLog('LLM_REQUEST', llmRequest)

  const blindedRequest = blindValue(llmRequest, mapping)

  const originalJson = JSON.stringify(llmRequest)
  const blindedJson = JSON.stringify(blindedRequest)
  const changed = originalJson !== blindedJson

  debugLog('CHANGED', { changed })

  if (!changed) {
    debugLog('OUTPUT', '{}')
    process.stdout.write('{}')
    return
  }

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'BeforeModel',
      llm_request: blindedRequest,
    },
  })
  debugLog('OUTPUT', JSON.parse(output))
  process.stdout.write(output)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('before_model.ts')) {
  main().catch((err) => {
    process.stderr.write(`[canvas-mcp/before_model] Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
}

