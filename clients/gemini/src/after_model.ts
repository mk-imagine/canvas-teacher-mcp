import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CACHE_DIR = join(homedir(), '.cache', 'canvas-mcp')
const DEFAULT_SIDECAR_PATH = join(CACHE_DIR, 'pii_session.json')
const BUFFER_PATH = join(CACHE_DIR, 'pii_buffer.txt')

const sidecarPath = process.env['CANVAS_MCP_SIDECAR_PATH'] ?? DEFAULT_SIDECAR_PATH

export const TOKEN_PATTERN = /\[STUDENT_\d{3}\]/g
const PARTIAL_PATTERN = /\[(?:S(?:T(?:U(?:D(?:E(?:N(?:T(?:_(?:\d{0,3})?)?)?)?)?)?)?)?)?$/

interface SidecarFile {
  mapping: Record<string, string>
}

export interface HookContext {
  inputBuffer: string
  nextBuffer: string
}

export function loadMapping(path: string = sidecarPath): Record<string, string> | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as SidecarFile
    return data.mapping
  } catch {
    return null
  }
}

function readBufferFile(): string {
  if (!existsSync(BUFFER_PATH)) return ''
  try {
    return readFileSync(BUFFER_PATH, 'utf-8')
  } catch {
    return ''
  }
}

function writeBufferFile(content: string) {
  try {
    writeFileSync(BUFFER_PATH, content, 'utf-8')
  } catch { }
}

export function processString(text: string, mapping: Record<string, string>, ctx: HookContext): string {
  let workingText = text

  if (ctx.inputBuffer.length > 0) {
    const combined = ctx.inputBuffer + text
    const match = combined.match(TOKEN_PATTERN)
    if (match && combined.indexOf(match[0]) < ctx.inputBuffer.length) {
      workingText = combined
    }
  }

  const unblinded = workingText.replaceAll(TOKEN_PATTERN, (token) => {
    return mapping[token] ?? token
  })

  const partialMatch = unblinded.match(PARTIAL_PATTERN)
  if (partialMatch && partialMatch[0].length > 0) {
    ctx.nextBuffer = partialMatch[0]
    return unblinded.slice(0, -ctx.nextBuffer.length)
  }

  return unblinded
}

export function processValue(value: unknown, mapping: Record<string, string>, ctx: HookContext): unknown {
  if (typeof value === 'string') return processString(value, mapping, ctx)
  if (Array.isArray(value)) return value.map((v) => processValue(v, mapping, ctx))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = processValue(v, mapping, ctx)
    }
    return result
  }
  return value
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')

  let hookInput: Record<string, unknown>
  try {
    hookInput = JSON.parse(raw)
  } catch {
    process.stdout.write('{}')
    return
  }

  const llmResponse = hookInput['llm_response']
  if (llmResponse === undefined) {
    process.stdout.write('{}')
    return
  }

  const mapping = loadMapping()
  if (mapping === null) {
    process.stdout.write('{}')
    return
  }

  const ctx: HookContext = {
    inputBuffer: readBufferFile(),
    nextBuffer: '',
  }

  const unblindedResponse = processValue(llmResponse, mapping, ctx)
  writeBufferFile(ctx.nextBuffer)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'AfterModel',
      llm_response: unblindedResponse,
    },
  }))
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('after_model.ts')) {
  main().catch((err) => {
    process.stderr.write(`[canvas-mcp/after_model] Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
}

