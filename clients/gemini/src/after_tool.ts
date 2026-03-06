/**
 * Minimal Debug AfterTool Hook
 * Verifies that tool outputs are intercepted correctly.
 * Logs verbose heartbeat to: ~/aftertool-hook-test.txt
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_FILE = join(homedir(), 'aftertool-hook-test.txt')

function log(message: string) {
  try {
    const timestamp = new Date().toISOString()
    appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`)
  } catch (e) {}
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')

  log(`[HOOK START] Received input of size ${raw.length} bytes`)

  let hookInput: Record<string, unknown>
  try {
    hookInput = JSON.parse(raw)
  } catch {
    log(`[ERROR] Failed to parse input JSON.`)
    process.stdout.write('{}')
    return
  }
  
  const toolName = hookInput['tool_name']
  
  if (toolName) {
      log(`[TOOL DETECTED] Name: "${toolName}"`)
      // Optional: Log a snippet of the response to verify content availability
      const response = hookInput['tool_response']
      const snippet = JSON.stringify(response).slice(0, 100)
      log(`[TOOL CONTENT] Response snippet: ${snippet}...`)
  } else {
      log(`[WARNING] No 'tool_name' field found in hook input.`)
  }

  // Always return no-op for this test phase
  process.stdout.write('{}')
  log(`[HOOK END] Completed execution.`)
}

main().catch((err) => {
  log(`FATAL ERROR: ${(err as Error).message}`)
  process.exit(1)
})