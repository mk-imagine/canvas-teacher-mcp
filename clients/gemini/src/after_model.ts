/**
 * Gemini CLI after_model hook — Context-Aware Smart Buffering.
 *
 * FIX: Prevents metadata fields (like "role": "model") from consuming
 * or destroying the buffer intended for the actual text content.
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// --- Configuration ---
const DEFAULT_SIDECAR_PATH = join(homedir(), '.cache', 'canvas-mcp', 'pii_session.json')
const BUFFER_PATH = join(homedir(), '.cache', 'canvas-mcp', 'pii_buffer.txt')
const LOG_FILE = join(homedir(), 'aftermodel-hook-test.txt')

const sidecarPath = process.env['CANVAS_MCP_SIDECAR_PATH'] ?? DEFAULT_SIDECAR_PATH

const TOKEN_PATTERN = /\[STUDENT_\d{3}\]/g
const PARTIAL_PATTERN = /\[(?:S(?:T(?:U(?:D(?:E(?:N(?:T(?:_(?:\d{0,3})?)?)?)?)?)?)?)?)?$/

interface SidecarFile {
  mapping: Record<string, string>
}

// Global state for the duration of ONE hook execution
interface HookContext {
  inputBuffer: string;      // The buffer we started with (e.g. "[STUDENT_00")
  bufferConsumed: boolean;  // Have we successfully used it yet?
  nextBuffer: string;       // What we will save for the next turn
}

// --- Debug Helper ---
function log(message: string) {
  try {
    const timestamp = new Date().toISOString()
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`)
  } catch (e) {}
}

// --- Helpers ---

function loadMapping(): Record<string, string> | null {
  if (!existsSync(sidecarPath)) return null
  try {
    const data = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as SidecarFile
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

function processString(text: string, mapping: Record<string, string>, ctx: HookContext): string {
  let workingText = text

  // 1. Try to Apply Buffer (only if not already consumed)
  if (ctx.inputBuffer.length > 0 && !ctx.bufferConsumed) {
    const combined = ctx.inputBuffer + text
    
    // Check if combined text creates a valid token at the boundary
    const match = combined.match(TOKEN_PATTERN)
    if (match && combined.indexOf(match[0]) < ctx.inputBuffer.length) {
      log(`[BUFFER SUCCESS] Prepending "${ctx.inputBuffer}" to "${text.slice(0, 15)}..." formed token "${match[0]}"`)
      workingText = combined
      ctx.bufferConsumed = true // Mark as used so we don't apply it to other fields
    } else {
      // Buffer didn't fit here. 
      // We do NOT discard it yet; we let other fields try.
      // Just log for debugging.
      log(`[BUFFER SKIP] Buffer "${ctx.inputBuffer}" did not fit with "${text.slice(0, 20)}..."`)
    }
  }

  // 2. Perform Replacement
  const unblinded = workingText.replaceAll(TOKEN_PATTERN, (token) => {
    const val = mapping[token]
    if (val) {
      log(`[REPLACE] Success: ${token} -> ${val}`)
      return val
    }
    // Only log missing if it looks like a full token
    log(`[MISSING] No mapping for ${token}`)
    return token
  })

  // 3. Detect New Partial Token
  // We only update nextBuffer if we find something. 
  // (Last write wins strategy usually works for the streaming content field)
  const partialMatch = unblinded.match(PARTIAL_PATTERN)
  if (partialMatch && partialMatch[0].length > 0) {
    // If we find a partial match, we assume THIS is the streaming field
    ctx.nextBuffer = partialMatch[0]
    log(`[BUFFERING] Found partial token "${ctx.nextBuffer}" at end of field.`)
    return unblinded.slice(0, -ctx.nextBuffer.length)
  }

  return unblinded
}

function processValue(value: unknown, mapping: Record<string, string>, ctx: HookContext): unknown {
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

  // --- INITIALIZE CONTEXT ---
  const initialBuffer = readBufferFile()
  if (initialBuffer.length > 0) {
    log(`[HOOK START] Loaded buffer: "${initialBuffer}"`)
  }

  const ctx: HookContext = {
    inputBuffer: initialBuffer,
    bufferConsumed: false,
    nextBuffer: ''
  }

  // --- EXECUTE ---
  const unblindedResponse = processValue(llmResponse, mapping, ctx)

  // --- FINALIZE ---
  
  // Logic: If we had a buffer but NEVER consumed it, AND we didn't find a new one,
  // we might have processed a metadata-only chunk or the buffer is truly invalid.
  // Ideally, we keep the buffer if we haven't seen "conflicting" text? 
  // For now, standard behavior: whatever is in nextBuffer gets saved.
  // If nextBuffer is empty, we clear the file.
  
  if (ctx.nextBuffer !== initialBuffer) {
     // Log changes
     if (ctx.nextBuffer.length > 0) log(`[BUFFER SAVE] New buffer: "${ctx.nextBuffer}"`)
     else if (initialBuffer.length > 0) log(`[BUFFER CLEAR] Buffer consumed or cleared.`)
  }
  
  writeBufferFile(ctx.nextBuffer)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'AfterModel',
      llm_response: unblindedResponse,
    },
  }))
}

main().catch((err) => {
  log(`FATAL ERROR: ${(err as Error).message}`)
  process.exit(1)
})