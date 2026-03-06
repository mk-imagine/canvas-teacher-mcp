# PII Blinding Architecture (Gemini CLI Add-on)

## 1. Overview

The privacy layer allows users to analyze student data without exposing PII to the LLM. The MCP server produces opaque session tokens; a sidecar mapping file enables client-side hooks to perform silent, automated unblinding in supported CLI environments.

This is an **opt-in feature** (`privacy.blindingEnabled: true` in `config.json`). The server is fully compatible with all MCP clients regardless of whether hooks are configured.

---

## 2. Core Principles

1. **Opt-In Blinding:** Disabled by default. Enabled via `config.json` (`privacy.blindingEnabled: true`) or `CANVAS_PII_BLINDING=true` environment variable.
2. **Fixed-Length Tokens:** Tokens use the `[STUDENT_NNN]` format. Length-matching is unnecessary because Gemini CLI uses a Markdown parser that handles uneven column widths automatically.
3. **Absolute Sidecar Path:** The mapping file is stored at a stable absolute path: `~/.cache/canvas-mcp/pii_session.json`.
4. **Client-Agnostic Server:** The server does not detect the client type. It produces tokens and a sidecar; client-side hooks handle all UI preferences.
5. **Lazy Sidecar Sync:** The sidecar is created on the first blinded tool call and refreshed whenever new students are tokenized. This ensures the file always reflects the full live session state.

---

## 3. Technical Architecture

### A. `SecureStore` (`packages/core/src/security/secure-store.ts`)

Manages in-memory PII encryption and tokenization:
- Generates a `sessionId` (UUID) once in the constructor.
- Maps Canvas user IDs → `[STUDENT_NNN]` tokens; encrypts real names with AES-256-GCM using a per-session key that never touches disk.
- Token format (`[STUDENT_NNN]`) is stable across calls.

### B. `SidecarManager` (`packages/core/src/security/sidecar-manager.ts`)

Handles all sidecar file I/O:

- **`sync(store: SecureStore): boolean`** — Compares the on-disk sidecar's `session_id` and token count to the live store. If unchanged, no-ops. Otherwise, writes the full token↔name mapping atomically (write to `.tmp`, then `rename`), sets `600` permissions, and returns `true`. The token count check ensures students tokenized in later tool calls (e.g., `get_submission_status`) are always written to the sidecar.
- **`purge()`** — Deletes the sidecar file. Called on all exit paths (`SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`).

**Sidecar format** (bidirectional — both directions stored for O(1) lookup by hooks):
```json
{
  "session_id": "uuid-v4",
  "last_updated": "2026-03-03T12:00:00.000Z",
  "mapping": {
    "[STUDENT_001]": "Jane Doe",
    "Jane Doe": "[STUDENT_001]"
  }
}
```

### C. Configuration (`packages/core/src/config/schema.ts`)

The `privacy` block in `CanvasTeacherConfig`:
```typescript
privacy: {
  blindingEnabled: boolean   // default: false
  sidecarPath: string        // default: "~/.cache/canvas-mcp/pii_session.json"
}
```

### D. Server Lifecycle (`packages/teacher/src/index.ts`)

- **Startup:** `SidecarManager` is instantiated alongside `SecureStore`. No file is written at startup.
- **Shutdown:** `SidecarManager.purge()` is registered on `SIGINT`, `SIGTERM`, `SIGHUP`, and `uncaughtException` handlers.

### E. Tool Call Lifecycle

When `blindingEnabled` is `true`, every reporting tool that tokenizes PII follows this sequence:

1. Tokenize students via `SecureStore` (existing behavior).
2. Call `SidecarManager.sync(store)`.
3. If `sync()` returned `true`, write a notification to **stderr** (server logs only, not visible in the MCP content stream):
   > `[canvas-mcp] PII sidecar updated — N students mapped to tokens.`
4. Return the blinded result as normal.

---

## 4. Gemini CLI Hooks (`clients/gemini/`)

All three scripts live in `clients/gemini/src/` and compile to `clients/gemini/dist/`. They read from the sidecar path (`~/.cache/canvas-mcp/pii_session.json` by default, or `CANVAS_MCP_SIDECAR_PATH`).

### `before_model.ts` — Input Blinding
Intercepts the outgoing `llm_request`; replaces real student names with their tokens. Returns `{}` (no-op) if the sidecar doesn't exist or no names are present. **Critical:** only returns a modified `llm_request` when content actually changed — returning an identical copy triggers a tool-call loop in Gemini CLI.

### `after_model.ts` — Output Unblinding
Intercepts the `llm_response`; regex-replaces `[STUDENT_NNN]` tokens with real names. Uses a file-backed buffer (`pii_buffer.txt`) to handle tokens split across streaming chunks. Returns `{}` if nothing changed.

### `after_tool.ts` — Progress Indicator
Returns a `systemMessage` (e.g., `[canvas-mcp] Fetched grades for 5 students.`) shown to the user in the terminal. Does **not** return `hookSpecificOutput` — doing so causes tool-call loops. The `systemMessage` is user-terminal-only and never seen by `before_model`.

### Architectural Notes

- The tool result box in the Gemini CLI terminal (the `╭─╮` collapsible) always shows the raw MCP tool response. Hooks cannot suppress or modify this display — users will always see `[STUDENT_NNN]` tokens there; unblinding occurs only in the model's text response via `after_model`.
- Injecting real student names into `additionalContext` (model context) causes `before_model` to re-blind them in the next turn, producing nonsensical mappings and confusing the model.
- This directory is intentionally separate from `packages/` — these scripts run inside the Gemini CLI process, not the MCP server. Future client integrations (`clients/claude-code/`, `clients/cursor/`) would follow the same pattern.

---

## 5. Known Tradeoffs & Caveats

### 5.1 Sidecar is Plaintext on Disk
`SecureStore` holds PII encrypted in memory (AES-256-GCM). The sidecar is a plaintext copy of the same data. `600` permissions protect against other OS users but not root, forensic disk analysis, or backup tools.

`SidecarManager` is fully isolated — removing the sidecar in a future version requires deleting one class and the `sync()` call in reporting tools, with no changes to `SecureStore` or the blinding logic.

### 5.2 First-Message Blindspot
`before_model` can only blind names that are already in the sidecar. The sidecar doesn't exist until the first blinded tool call completes. If a user types a student's name in their very first message (before any Canvas tool has run), that name reaches the LLM unblinded.

**Mitigation:** Run a reporting tool first (e.g., "show me the class grades"). The `[canvas-mcp] Fetched grades for N students.` AfterTool notification confirms the sidecar is ready.

### 5.3 Opt-In Default vs. Existing Always-On Blinding
Phase 6 shipped always-on blinding. With opt-in blinding, an existing user who upgrades will have `privacy.blindingEnabled` default to `false`, silently disabling their existing protection. The `ConfigManager` migration detects a missing `privacy` key in the on-disk config and writes `blindingEnabled: true` on first run.

### 5.4 Concurrent Server Instances
Two simultaneous `canvas-mcp` processes will overwrite each other's sidecar. The atomic write prevents file corruption, but only the most recently started process's session will be in the file.

### 5.5 Tool Result Box Always Shows Blinded JSON
Gemini CLI renders the tool result box from the raw MCP server response before hooks run. There is no mechanism to suppress this. Unblinding occurs only in the model's text response.

---

## 6. Future Work

- **Server-start roster pre-fetch:** On startup (if `blindingEnabled`), silently fetch the enrollment list to populate `SecureStore` and write the initial sidecar. Eliminates the first-message blindspot (§5.2) entirely.
- **Per-session sidecar files:** Scope the sidecar filename to the session ID (e.g., `pii_<uuid>.json`) and pass the path to hooks via an environment variable. Resolves concurrent instance clobbering (§5.4).
- **Encrypted sidecar:** Replace plaintext JSON with an AES-256-GCM envelope, key stored in the OS keychain or derived from a user passphrase. Resolves the plaintext-on-disk risk (§5.1).
- **AfterTool unblinded systemMessage:** The `systemMessage` from `after_tool` is user-terminal-only and never reaches `before_model`, so it is safe to include real student names (e.g., "Fetched grades for Jane Smith, John Doe, ..."). Currently uses count-only messages for simplicity.
