# Testing Strategy: Gemini CLI Hooks

This document outlines the plan for ensuring the reliability, security, and correctness of the `canvas-mcp` Gemini CLI hooks.

## 1. Overview

The Gemini CLI hooks (`before_model`, `after_model`, `after_tool`) are critical for the PII privacy layer. They operate as standalone Node.js scripts communicating via `stdin`/`stdout`.

### Testing Challenges

- **Process-based I/O**: Hooks rely on `process.stdin` and `process.stdout`.
- **Sidecar Dependency**: Hooks read mapping files from the local filesystem (default: `~/.cache/canvas-mcp/pii_session.json`). The `CANVAS_MCP_SIDECAR_PATH` environment variable must be used to redirect reads/writes to a temp directory during tests.
- **Streaming Artifacts**: `after_model` must handle tokens split across multiple execution chunks (e.g., `[STUD` followed by `ENT_001]`).

## 2. Phase 1: Environment & Setup

- **Tooling**: Use `vitest` for unit and integration testing. Add a `vitest.config.ts` to `clients/gemini/` with coverage configured (provider: `v8`, output: `coverage/`).
- **Testability Refactor**: Extract core logic from the `main()` functions in `src/*.ts` into named exports. This allows unit tests to import functions directly without spawning processes. The refactor is a prerequisite — no unit tests can be written until it is complete.
  - `after_model.ts`: Export `processValue`, `processString`.
  - `before_model.ts`: Export `blindValue`, `blindText`.
  - `after_tool.ts`: `buildSummary` is already a named export — no change needed.

## 3. Phase 2: Unit Testing (`tests/unit/`)

Unit tests import the exported functions directly and supply mock sidecar data in-memory — no processes are spawned.

### `after_model.test.ts` (Unblinding & Streaming)

- **Basic Mapping**: Verify `[STUDENT_001]` is replaced with the real name from a mock sidecar.
- **Nested Replacement**: Verify replacement inside deeply nested Gemini response shapes — both `llm_response.text` and `llm_response.candidates[0].content.parts[0].text` are updated.
- **Multiple Tokens**: Verify all tokens in a single string are replaced when the mapping contains more than one student.
- **Unknown Token**: Verify an unrecognised token (e.g. `[STUDENT_099]` not in the mapping) is left as-is rather than erased.
- **Split Token Buffering**:
  - Input `[STU` → output empty, buffer holds `[STU`.
  - Input `DENT_001] is here` (with `[STU` in buffer) → output `Alice is here`, buffer cleared.
  - Token split exactly at the bracket boundary: `[` alone, then `STUDENT_001]`.
- **Edge Cases**:
  - Missing sidecar file → original text passed through unchanged.
  - Malformed JSON sidecar → original text passed through unchanged.
  - No `[STUDENT_NNN]` tokens present → returns `{}` (no-op).
  - No `llm_response` key in hook input → returns `{}`.
  - Malformed JSON stdin → returns `{}`.

### `before_model.test.ts` (Reverse Blinding)

- **Prompt Blinding**: A prompt containing a real student name (e.g. `"What is Alice's grade?"`) is replaced with the corresponding token (`[STUDENT_001]`) using the sidecar mapping.
- **Multiple Names**: All student names present in a single prompt are replaced.
- **No Names Present**: Prompt contains no names from the mapping → returns `{}` (no-op, does not re-trigger model).
- **Missing Sidecar**: No sidecar file exists yet → returns `{}`.
- **No `llm_request` Key**: Hook input lacks the expected key → returns `{}`.
- **Malformed JSON stdin**: Returns `{}`.

### `after_tool.test.ts` (Summarization)

- **Tool Summaries**: Verify the correct `systemMessage` is generated for:
  - `get_grades` class scope (`student_count` field present).
  - `get_grades` student scope (`assignments` array + `student_token` field present).
  - `get_submission_status` missing (`total_missing_submissions` field present).
  - `get_submission_status` late (`total_late_submissions` field present).
  - `list_items` with an `items` array (generic fallback path — `list_assignments` no longer exists as a tool; use the current `list_items` response shape with an `items` array).
- **Generic Fallback**: Any tool response with an `items` array but no recognised summary fields → `Retrieved N items.`
- **Unknown Tool / Unrecognised Shape**: Tool output matches no known pattern → returns `{}`.
- **Missing `tool_response`**: Hook input lacks `tool_response` → returns `{}`.
- **Malformed JSON inside `llmContent`**: Returns `{}`.
- **Malformed JSON stdin**: Returns `{}`.

## 4. Phase 3: Integration Testing (`tests/integration/`)

Integration tests spawn the compiled hook scripts as child processes and verify end-to-end stdin→stdout behaviour against a real sidecar file written to a temp directory.

### Setup

```typescript
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function runHook(scriptPath: string, input: object, sidecarPath?: string): object {
  const env = { ...process.env }
  if (sidecarPath) env['CANVAS_MCP_SIDECAR_PATH'] = sidecarPath
  const result = spawnSync('node', [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env,
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout || '{}')
}
```

### Hook-Server Loop

- Use `@canvas-mcp/core`'s `SidecarManager` to write a real sidecar file to a temporary directory.
- Point hooks at the temp sidecar via `CANVAS_MCP_SIDECAR_PATH`.
- Execute each compiled hook script (`dist/before_model.js`, `dist/after_model.js`, `dist/after_tool.js`) via `spawnSync`.
- Verify exit code is `0` and stdout matches expected output.
- Verify hooks return `{}` when the sidecar path points to a non-existent file.

### Test Cases

- **Round-trip**: Write a sidecar with `SidecarManager`, run `before_model` with a prompt containing a student name, confirm name is replaced with the correct token.
- **Round-trip**: Write a sidecar with `SidecarManager`, run `after_model` with a response containing a token, confirm token is replaced with the correct name.
- **Purge**: Call `SidecarManager.purge()`, then run a hook — confirm it returns `{}`.
- **Atomic write safety**: Confirm the `.pii_session.tmp` file is not left behind after `SidecarManager.sync()`.

## 5. Phase 4: Verification & Coverage

- Achieve >90% code coverage for the `clients/gemini` package.
- Ensure all tests pass without a live Canvas instance or Gemini CLI installation.
- Add a `test` script to `clients/gemini/package.json` so `npm test` runs the full suite.
