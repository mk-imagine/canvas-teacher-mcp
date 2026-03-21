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

  // Phase 3a: full-name sliding window fuzzy matching (runs before Phase 2
  // so that partial-name matching doesn't break multi-word fuzzy windows)
  interface WordToken { text: string; start: number; end: number; consumed: boolean }
  const extractWords = (s: string): WordToken[] => {
    const pattern = /[a-zA-Z'-]+/g
    const tokens: WordToken[] = []
    let m: RegExpExecArray | null
    while ((m = pattern.exec(s)) !== null) {
      // skip words that are inside a [STUDENT_...] token
      const bracketOpen = s.lastIndexOf('[', m.index)
      const bracketClose = s.indexOf(']', m.index)
      if (bracketOpen !== -1 && bracketClose !== -1 && bracketOpen < m.index && bracketClose >= m.index + m[0].length) continue
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length, consumed: false })
    }
    return tokens
  }

  let words = extractWords(result)
  let offsetDelta = 0

  for (const entry of index.entries) {
    const n = entry.parts.length
    for (let i = 0; i <= words.length - n; i++) {
      if (words.slice(i, i + n).some(w => w.consumed)) continue
      const windowWords = words.slice(i, i + n)
      const windowText = windowWords.map(w => w.text).join(' ')
      const dist = levenshtein(windowText.toLowerCase(), entry.name.toLowerCase())
      if (dist === 0) continue // already handled by Phase 1
      const threshold = entry.name.length <= 12 ? 2 : 3
      if (dist <= threshold) {
        const spanStart = windowWords[0].start + offsetDelta
        const spanEnd = windowWords[n - 1].end + offsetDelta
        let possessive = ''
        if (result.substring(spanEnd).startsWith("'s")) {
          possessive = "'s"
        }
        const replacement = entry.token + possessive
        const replaceLen = (spanEnd - spanStart) + possessive.length
        result = result.substring(0, spanStart) + replacement + result.substring(spanStart + replaceLen)
        offsetDelta += replacement.length - replaceLen
        for (let j = i; j < i + n; j++) words[j].consumed = true
      }
    }
  }

  // Phase 2: partial-name matching (unique parts, ambiguous expansion)
  for (const [part, regex] of index.partRegexes) {
    if (index.stopwords.has(part)) continue
    const tokens = index.uniqueParts.get(part)
    if (!tokens) continue
    if (tokens.length === 1) {
      result = result.replace(regex, (_match, possessive: string | undefined) => tokens[0] + (possessive || ''))
    } else {
      result = result.replace(regex, (_match, possessive: string | undefined) => [...tokens].sort().join(' and ') + (possessive || ''))
    }
  }

  // Phase 3b: single-part fuzzy matching
  const words2 = extractWords(result)
  let offsetDelta2 = 0

  for (const word of words2) {
    // Strip possessive suffix for comparison
    let bareText = word.text
    let hasPossessive = false
    if (bareText.endsWith("'s")) {
      bareText = bareText.slice(0, -2)
      hasPossessive = true
    }
    if (bareText.length < 4) continue
    let bestDist = Infinity
    let bestTokens: string[] | undefined
    for (const [partKey, tokens] of index.uniqueParts) {
      if (index.stopwords.has(partKey)) continue
      if (partKey.length < 4) continue
      // Require first character match to avoid false positives (e.g. "Malice" -> "alice")
      if (bareText[0].toLowerCase() !== partKey[0]) continue
      const dist = levenshtein(bareText.toLowerCase(), partKey)
      if (dist === 0) continue // already handled by Phase 2
      const threshold = partKey.length >= 9 ? 2 : 1
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist
        bestTokens = tokens
      }
    }
    if (bestTokens) {
      const adjStart = word.start + offsetDelta2
      const adjEnd = word.end + offsetDelta2
      // Check for possessive either embedded in the word or immediately after
      let possessive = ''
      if (hasPossessive) {
        possessive = "'s"
      } else if (result.substring(adjEnd).startsWith("'s")) {
        possessive = "'s"
      }
      const tokenStr = bestTokens.length === 1
        ? bestTokens[0]
        : [...bestTokens].sort().join(' and ')
      const replacement = tokenStr + possessive
      // If possessive was embedded in word.text, it's already within adjStart..adjEnd
      // If possessive is after the word, we need to include it in the replacement span
      const extraPossessiveLen = (!hasPossessive && possessive) ? possessive.length : 0
      const replaceLen = (adjEnd - adjStart) + extraPossessiveLen
      result = result.substring(0, adjStart) + replacement + result.substring(adjStart + replaceLen)
      offsetDelta2 += replacement.length - replaceLen
    }
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

  const index = buildNameIndex(mapping)

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

  const blindedRequest = blindValue(llmRequest, mapping, index)

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

