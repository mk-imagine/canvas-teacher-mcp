import { readFileSync, existsSync } from 'node:fs'
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

export function blindText(text: string, mapping: Record<string, string>): string {
  let result = text
  for (const [key, value] of Object.entries(mapping)) {
    if (!key.startsWith('[STUDENT_')) {
      result = result.replaceAll(key, value)
    }
  }
  return result
}

export function blindValue(value: unknown, mapping: Record<string, string>): unknown {
  if (typeof value === 'string') return blindText(value, mapping)
  if (Array.isArray(value)) return value.map((v) => blindValue(v, mapping))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = blindValue(v, mapping)
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

  const mapping = loadMapping()
  if (mapping === null) {
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

  const llmRequest = hookInput['llm_request']
  if (llmRequest === undefined) {
    process.stdout.write('{}')
    return
  }

  const blindedRequest = blindValue(llmRequest, mapping)

  const originalJson = JSON.stringify(llmRequest)
  const blindedJson = JSON.stringify(blindedRequest)
  const changed = originalJson !== blindedJson

  if (!changed) {
    process.stdout.write('{}')
    return
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'BeforeModel',
      llm_request: blindedRequest,
    },
  }))
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('before_model.ts')) {
  main().catch((err) => {
    process.stderr.write(`[canvas-mcp/before_model] Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
}

