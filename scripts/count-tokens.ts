/**
 * scripts/count-tokens.ts
 *
 * Measures the token overhead canvas-mcp adds to every Claude session by:
 *   1. Connecting to the built server via MCP stdio transport
 *   2. Fetching the full tool list (no Canvas API calls made)
 *   3a. [API mode]    Calling Anthropic's count_tokens endpoint (exact, no LLM call)
 *   3b. [--no-api]    Estimating via JSON character count (~4 chars/token)
 *   4. Printing total and per-tool token costs
 *
 * Token overhead breakdown (API mode):
 *   - Tool use system prompt: 346 tokens (fixed per API call, regardless of server count)
 *   - Tools array wrapper:    varies (JSON structure overhead)
 *   - Per-tool schema cost:   varies per tool
 *
 * The "tool use system prompt" (346 tokens for auto/none tool_choice, 313 for any/tool)
 * is a fixed one-time charge per API call. All MCP servers' tools are merged into one
 * tools array, so this is paid once total — not once per server.
 *
 * Usage:
 *   npm run count-tokens              # exact (requires ANTHROPIC_API_KEY)
 *   npm run count-tokens -- --no-api  # estimated, no API key needed
 *
 * Requirements:
 *   - Server must be built: npm run build
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Anthropic from '@anthropic-ai/sdk'
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

loadEnv()

const NO_API = process.argv.includes('--no-api')
const DUMP = process.argv.includes('--dump')

// Tool use system prompt added by Claude when tools are present.
// 346 for auto/none tool_choice (Claude Code default), 313 for any/tool.
const TOOL_USE_SYSTEM_PROMPT_TOKENS = 346

async function main() {
  // ─── Config ─────────────────────────────────────────────────────────────────

  const CONFIG_PATH =
    process.env.CANVAS_MCP_CONFIG ??
    resolve(homedir(), '.config/mcp/canvas-mcp/config.json')

  const SERVER_PATH = resolve(
    new URL('.', import.meta.url).pathname,
    '../packages/teacher/dist/index.js'
  )

  // ─── Validate prerequisites ──────────────────────────────────────────────────

  if (!NO_API && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is not set.')
    console.error('Tip: run with --no-api for a character-count estimate instead.')
    console.error('  npm run count-tokens -- --no-api')
    process.exit(1)
  }

  if (!existsSync(SERVER_PATH)) {
    console.error('Error: Server not built. Run: npm run build')
    console.error(`Expected: ${SERVER_PATH}`)
    process.exit(1)
  }

  // ─── Step 1: Connect to MCP server and list tools ───────────────────────────

  console.log('Connecting to canvas-mcp server...')

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH, '--config', CONFIG_PATH],
    stderr: 'pipe',
  })

  const mcp = new Client({ name: 'token-counter', version: '1.0' }, { capabilities: {} })
  await mcp.connect(transport)

  const { tools } = await mcp.listTools()
  await mcp.close()

  console.log(`Fetched ${tools.length} tools from server.\n`)

  // ─── Step 2: Convert MCP tool format → Anthropic tool format ────────────────

  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }))

  // ─── Step 3a: API mode — exact token counts ──────────────────────────────────

  let toolOverhead: number
  let wrapperOverhead: number
  let perTool: { name: string; tokens: number }[]
  let perToolSum: number
  let mode: string
  let rawPerToolTotal = 0
  let baselineTokens = 0
  let emptyToolTokens = 0

  if (!NO_API) {
    const anthropic = new Anthropic()
    const MODEL = 'claude-sonnet-4-6'
    const PROBE = [{ role: 'user' as const, content: 'hi' }]

    // A trivially empty tool — used to isolate the fixed framework + wrapper overhead.
    // This is the minimum possible tool: no description, empty input schema.
    const emptyTool: Anthropic.Tool = {
      name: 'x',
      description: '',
      input_schema: { type: 'object', properties: {} },
    }

    // Baseline: no tools at all
    const baseline = await anthropic.messages.countTokens({
      model: MODEL,
      messages: PROBE,
    })
    baselineTokens = baseline.input_tokens

    // Empty tool: captures framework (346) + wrapper JSON + trivial name cost
    const emptyToolCount = await anthropic.messages.countTokens({
      model: MODEL,
      tools: [emptyTool],
      messages: PROBE,
    })
    emptyToolTokens = emptyToolCount.input_tokens

    // Total: all tools loaded
    const total = await anthropic.messages.countTokens({
      model: MODEL,
      tools: anthropicTools,
      messages: PROBE,
    })

    toolOverhead = total.input_tokens - baseline.input_tokens
    wrapperOverhead = emptyToolCount.input_tokens - baseline.input_tokens

    // Per-tool marginal cost = individual count minus the empty-tool count.
    // This removes the fixed framework+wrapper so only the schema content remains.
    console.log('Counting tokens per tool (one API call per tool)...\n')
    perTool = []
    let rawPerToolTotal = 0
    for (const tool of anthropicTools) {
      const r = await anthropic.messages.countTokens({
        model: MODEL,
        tools: [tool],
        messages: PROBE,
      })
      rawPerToolTotal += r.input_tokens
      perTool.push({ name: tool.name, tokens: r.input_tokens - emptyToolCount.input_tokens })
    }

    mode = `exact  (Anthropic count_tokens, model: ${MODEL})`

    if (DUMP) {
      const dumpDir = resolve(new URL('.', import.meta.url).pathname, '../tmp/token-dump')
      mkdirSync(dumpDir, { recursive: true })

      const dump = (name: string, payload: object, tokens: number) => {
        const content = JSON.stringify({ tokens, payload }, null, 2)
        writeFileSync(resolve(dumpDir, `${name}.json`), content)
      }

      dump('baseline', { messages: PROBE }, baseline.input_tokens)
      dump('empty_tool', { tools: [emptyTool], messages: PROBE }, emptyToolCount.input_tokens)
      dump('total', { tools: anthropicTools, messages: PROBE }, total.input_tokens)
      for (const tool of anthropicTools) {
        dump(`tool_${tool.name}`, { tools: [tool], messages: PROBE }, perTool.find(t => t.name === tool.name)!.tokens + baseline.input_tokens)
      }

      console.log(`Payloads dumped to: tmp/token-dump/\n`)
    }

  // ─── Step 3b: --no-api mode — character-count estimate ──────────────────────

  } else {
    const CHARS_PER_TOKEN = 4

    const totalJson = JSON.stringify(anthropicTools)
    toolOverhead = Math.round(totalJson.length / CHARS_PER_TOKEN)
    wrapperOverhead = TOOL_USE_SYSTEM_PROMPT_TOKENS // rough stand-in; can't separate without API

    perTool = anthropicTools.map((tool) => {
      const chars = JSON.stringify(tool).length
      return { name: tool.name, tokens: Math.round(chars / CHARS_PER_TOKEN) }
    })

    mode = 'estimate (~4 chars/token, no API key needed)'
  }

  perTool.sort((a, b) => b.tokens - a.tokens)
  perToolSum = perTool.reduce((sum, t) => sum + t.tokens, 0)

  const schemaOnlyOverhead = toolOverhead - wrapperOverhead

  // ─── Display results ─────────────────────────────────────────────────────────

  const pad = (s: string, n: number) => s.padEnd(n)
  const rpad = (s: string, n: number) => s.padStart(n)
  const W = 52

  console.log('='.repeat(W))
  console.log('  canvas-mcp Token Overhead Report')
  console.log('='.repeat(W))
  console.log()
  console.log(`  Mode:               ${mode}`)
  console.log(`  Tools registered:   ${tools.length}`)
  console.log()
  console.log('  Token overhead breakdown:')
  if (!NO_API) {
    console.log(`    JSON array wrapper (measured):             ${wrapperOverhead} tokens`)
    console.log(`    Schema content (total − wrapper):          ${schemaOnlyOverhead} tokens`)
    console.log(`    ──────────────────────────────────────────────`)
    console.log(`    Subtotal (from count_tokens):              ${toolOverhead} tokens`)
    console.log()
    console.log(`    Tool use system prompt (auto-injected,`)
    console.log(`    separate from count_tokens):             + ${TOOL_USE_SYSTEM_PROMPT_TOKENS} tokens`)
    console.log(`      346 for auto/none tool_choice (Claude Code default)`)
    console.log(`      313 for any/tool tool_choice`)
    console.log(`      Fixed once per API call — same for 1 or 10 MCP servers`)
    console.log(`    ──────────────────────────────────────────────`)
    console.log(`    Estimated actual inference cost:           ${toolOverhead + TOOL_USE_SYSTEM_PROMPT_TOKENS} tokens`)
  } else {
    console.log(`    TOTAL overhead (estimated):                ${toolOverhead} tokens`)
  }
  console.log()
  console.log('  Per-tool schema cost (wrapper subtracted, for comparison):')
  console.log('  ' + '-'.repeat(46))
  console.log(`  ${pad('Tool', 32)} ${rpad('Tokens', 8)}`)
  console.log('  ' + '-'.repeat(46))
  for (const { name, tokens } of perTool) {
    const bar = '█'.repeat(Math.max(0, Math.round(tokens / 20)))
    console.log(`  ${pad(name, 32)} ${rpad(String(tokens), 8)}  ${bar}`)
  }
  console.log('  ' + '-'.repeat(46))
  console.log(`  ${pad('Sum', 32)} ${rpad(String(perToolSum), 8)}`)
  console.log()
  if (NO_API) {
    console.log('  Note: estimates use ~4 chars/token. Actual count may')
    console.log('  differ ±10%. Run without --no-api for exact counts.')
  } else {
    const emptyToolCost = Math.round((schemaOnlyOverhead - perToolSum) / tools.length)
    console.log(`  Note: per-tool values are relative costs useful for comparing`)
    console.log(`  tools against each other. They do not sum to the schema total`)
    console.log(`  because the empty-tool baseline (~${emptyToolCost} tokens) is over-subtracted`)
    console.log(`  once per tool (${tools.length} tools × ~${emptyToolCost} = ~${schemaOnlyOverhead - perToolSum} token gap).`)
  }
  console.log()
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
