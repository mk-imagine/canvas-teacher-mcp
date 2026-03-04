# Implementation Plan: MCP Privacy Preservation (Gemini CLI Add-on)

## 1. Objective
To implement an opt-in privacy layer that allows users (e.g., "Jake") to analyze student data without exposing PII to the LLM. The server produces fixed-length opaque tokens; a sidecar mapping file enables client-side hooks to perform silent, automated unblinding in supported CLI environments.

---

## 2. Core Principles
1.  **Opt-In Blinding:** Disabled by default. Enabled via `config.json` (`privacy.blindingEnabled: true`) or `CANVAS_PII_BLINDING=true` environment variable.
2.  **Fixed-Length Tokens:** Tokens use the existing `[STUDENT_NNN]` format. Length-matching is unnecessary because Gemini CLI (and other target clients) use a Markdown parser that handles uneven column widths automatically.
3.  **Absolute Sidecar Path:** The mapping file is stored at a stable absolute path: `~/.cache/canvas-mcp/pii_session.json`.
4.  **Client-Agnostic Server:** The server does not detect the client type. It produces tokens and a sidecar; client-side hooks handle all UI preferences.
5.  **Lazy Sidecar Sync:** The sidecar is not written at startup. It is created on the first blinded tool call and refreshed whenever new students are tokenized (i.e., when the token count in the store grows). This ensures the file always reflects the full live session state without requiring startup ordering.

---

## 3. Technical Architecture

### A. `SecureStore` (`packages/core/src/security/secure-store.ts`)
Minimal changes to the existing implementation:
- Add a `sessionId` property: a UUID generated once in the constructor.
- Token format (`[STUDENT_NNN]`) is **unchanged**.

### B. `SidecarManager` (new: `packages/core/src/security/sidecar-manager.ts`)
A new utility class responsible for all sidecar I/O:

- **`sync(store: SecureStore): boolean`**
  1. If `blindingEnabled` is `false`, no-op.
  2. Read the existing sidecar (if present) and compare its `session_id` field to `store.sessionId` AND its token count to `store.listTokens().length`.
  3. If the session ID matches AND the token count is unchanged, no-op — return `false`.
  4. Otherwise, write the full current token↔name mapping from `SecureStore` to disk atomically (write to `.tmp`, then `rename`). Set file permissions to `600`. Return `true`.

  > **Why token count matters:** Subsequent tool calls (e.g., `get_submission_status`) may tokenize students not seen in the first call (e.g., `get_grades`). Without the count check, those students would never appear in the sidecar and could not be unblinded by hooks.

- **`purge()`:** Deletes the sidecar file. Called on all exit paths.

- **Sidecar format** (bidirectional mapping — both directions stored for O(1) lookup):
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
Add a `privacy` block to `CanvasTeacherConfig`:
```typescript
privacy: {
  blindingEnabled: boolean   // default: false
  sidecarPath: string        // default: "~/.cache/canvas-mcp/pii_session.json"
}
```

### D. Server Lifecycle (`packages/teacher/src/index.ts`)
- **Startup:** `SidecarManager` is instantiated alongside `SecureStore`. No file is written at this point.
- **Shutdown:** `SidecarManager.purge()` is added to the existing `SIGINT`, `SIGTERM`, `SIGHUP`, and `uncaughtException` handlers.

### E. Tool Call Lifecycle (per blinded tool invocation)
When `blindingEnabled` is `true`, every reporting tool that tokenizes PII follows this sequence:

1. Tokenize students via `SecureStore` (existing behavior — no change).
2. Call `SidecarManager.sync(store)`.
3. If `sync()` returned `true` (file was written or refreshed), write a one-line notification to **stderr**:
   > `[canvas-mcp] PII sidecar updated — N students mapped to tokens.`

   This appears in server debug logs but not in the MCP content stream or the user's terminal. The user-facing progress indicator is provided by the `after_tool` Gemini CLI hook (§4, item 3).
4. Return the blinded result as normal.

After the first blinded tool call of a session, the sidecar is guaranteed to exist before any Gemini CLI hook needs to read it.

---

## 4. Gemini CLI Hooks (`clients/gemini/`)
All three scripts live in `clients/gemini/src/` and are compiled to `clients/gemini/dist/`. They read from the **same absolute sidecar path** (`~/.cache/canvas-mcp/pii_session.json` by default, or the path in `CANVAS_MCP_SIDECAR_PATH`):

1.  **`before_model.ts`** — Input blinding. Reads the sidecar; replaces real student names in the outgoing `llm_request` with their tokens. Returns `{}` (no-op) if the sidecar does not yet exist or if the request contains no student names to blind. **Critical:** returning an unchanged `llm_request` in `hookSpecificOutput` — even byte-for-byte identical — causes Gemini CLI to re-trigger the model and create a tool-call loop. Only return the modified request when the content actually changed.

2.  **`after_model.ts`** — Output unblinding. Reads the sidecar; performs a regex replace of `[STUDENT_NNN]` tokens with real names in the `llm_response`. Returns `{}` (no-op) if nothing changed. The same loop risk applies as `before_model`: only return the modified `llm_response` when tokens were actually replaced.

3.  **`after_tool.ts`** — Progress indicator. Returns only a `systemMessage` (e.g., `[canvas-mcp] Fetched grades for 5 students.`) shown to the user in the terminal. **No `hookSpecificOutput` is returned** — returning `hookSpecificOutput` (even with a benign `additionalContext`) was found to cause tool-call loops. `systemMessage` is user-terminal-only and is never seen by `before_model`, so it is safe to include real student names in it if needed.

**Architectural notes discovered during implementation:**
- The tool result box in the Gemini CLI terminal (the `╭─╮` box) always shows the raw MCP tool response. Hooks cannot suppress or modify this display — it is rendered by Gemini CLI independently of hook output.
- Injecting real student names into `additionalContext` (model context) caused `before_model` to re-blind them in the next model call, producing nonsensical mappings (`[STUDENT_001] = [STUDENT_001]`) and confusing the model.
- `after_model`'s `llm_response` replacement updates the displayed model response in the terminal.

This directory is intentionally separate from `packages/` — these scripts run inside the Gemini CLI process, not the MCP server. Future client integrations (e.g., `clients/claude-code/`, `clients/cursor/`) would follow the same pattern.

---

## 5. Roadmap

### Phase 1: Foundation & Lifecycle
- [x] **Step 1:** Implement `SidecarManager` (`sync()`, `purge()`, atomic write, `600` permissions, directory creation).
- [x] **Step 2:** Add `sessionId` to `SecureStore`.
- [x] **Step 3:** Integrate `SidecarManager` into `index.ts`; verify `purge()` is called on all exit paths.
- [x] **Step 4:** Update `schema.ts` and `ConfigManager` for `privacy.blindingEnabled` and `privacy.sidecarPath`.

### Phase 2: Blinding Integration
- [x] **Step 5:** Update reporting tools to gate blinding on `blindingEnabled`, call `sync()` after tokenizing, and write the sidecar update notification to stderr.

### Phase 3: Client Extensions
- [x] **Step 6:** Create `clients/gemini/` with its own `package.json` and `tsconfig.json`; implement `before_model`, `after_model`, and `after_tool`.
- [x] **Step 7:** End-to-end validation: verified token blinding and automated unblinding in Gemini CLI. Fixed hook loop conditions, sidecar staleness, and AfterTool output format.

---

## 6. Known Tradeoffs & Caveats

### 6.1 Sidecar is Plaintext on Disk
`SecureStore` holds PII encrypted in memory (AES-256-GCM). The sidecar is a plaintext copy of the same data. This is an intentional tradeoff for PoC usability: `600` permissions protect against other OS users but not root, forensic disk analysis, or backup tools.

`SidecarManager` is fully isolated — removing the sidecar in a future version requires deleting one class and the `sync()` call in reporting tools, with no changes to `SecureStore` or the blinding logic.

### 6.2 First-Message Blindspot
`before_model.js` can only blind names that are in the sidecar. The sidecar does not exist until the first blinded tool call completes. If a user types a student's name in their very first message (before any Canvas tool has run), that name reaches the LLM unblinded.

**Mitigation:** Document in setup instructions that users should run a data-fetching tool (e.g., ask "show me the class grades") before asking questions that reference specific students. The `[canvas-mcp] Fetched grades for N students.` AfterTool notification confirms readiness.

### 6.3 Opt-In Default Removes Existing Phase 6 Protection on Upgrade
Phase 6 shipped always-on blinding. This plan makes blinding conditional on `privacy.blindingEnabled`. An existing user who upgrades will have the new `privacy` block deep-merged at its default (`false`), silently disabling their existing protection.

**Mitigation:** In the `ConfigManager` migration step (Step 4), detect whether a `privacy` key is absent from the user's on-disk config. If absent, infer the user was on always-on blinding and write `blindingEnabled: true` on first run. Include a CHANGELOG notice.

### 6.4 Concurrent Server Instances
Two simultaneous `canvas-mcp` processes will clobber each other's sidecar. The atomic write prevents file corruption but not session ID collisions.

### 6.5 Tool Result Box Always Shows Blinded JSON
Gemini CLI renders the tool result box (the `╭─╮` collapsible) from the raw MCP server response before hooks run. Hooks have no mechanism to suppress or replace this display. Users will always see `[STUDENT_NNN]` tokens in the tool box; unblinding occurs only in the model's text response via `after_model`.

---

## 7. Future Implementation Notes

- **Server-start roster pre-fetch:** On startup (if `blindingEnabled`), silently fetch the course enrollment list to populate `SecureStore` and write the initial sidecar. Eliminates the first-message blindspot (§6.2) entirely.
- **Per-session sidecar files:** Scope the sidecar filename to the session ID (e.g., `pii_<uuid>.json`) and pass the path to hooks via an environment variable. Resolves concurrent instance clobbering (§6.4).
- **Encrypted sidecar:** Replace plaintext JSON with an AES-256-GCM envelope, with the key stored in the OS keychain or derived from a user passphrase. Resolves the plaintext-on-disk risk (§6.1).
- **Default-on migration:** Once client-side hook support is widespread, flip `blindingEnabled` to `true` by default and remove the migration shim from §6.3.
- **AfterTool unblinded systemMessage:** The `systemMessage` from `after_tool` is user-terminal-only and never reaches `before_model`. It is therefore safe to include real student names there (e.g., "Fetched grades for Jane Smith, John Doe, ..."). Currently deferred in favour of simpler count-only messages.
