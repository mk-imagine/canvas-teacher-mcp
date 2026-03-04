# Gemini CLI Hooks for canvas-mcp

Provides automatic PII blinding/unblinding when using canvas-mcp with the Gemini CLI. Student names never reach the model — only opaque `[STUDENT_NNN]` tokens do — and the model's responses are transparently unblinded in your terminal before you see them.

Three hooks are involved:

| Hook | Event | What it does |
|------|-------|--------------|
| `before_model` | `BeforeModel` | Replaces real student names in your prompt with session tokens |
| `after_model` | `AfterModel` | Replaces tokens in the model's response with real names |
| `after_tool` | `AfterTool` | Writes a one-line progress summary to the terminal for canvas-mcp tool calls |

---

## Prerequisites

- **Node.js 20+**
- **Gemini CLI v0.26.0 or later** (hooks were introduced in this release)
- **canvas-mcp** installed and configured with a valid `canvas.instanceUrl` and `canvas.apiToken`

---

## Step 1 — Enable blinding in canvas-mcp

Open your canvas-mcp config (default: `~/.config/mcp/canvas-mcp/config.json`) and add or update the `privacy` block:

```json
{
  "canvas": { "...": "..." },
  "privacy": {
    "blindingEnabled": true,
    "sidecarPath": "~/.cache/canvas-mcp/pii_session.json"
  }
}
```

`sidecarPath` can be omitted — the default shown above is used automatically. The path is where the server writes the live token↔name mapping that the hooks read.

> **Upgrading from an earlier canvas-mcp version?** If your config file already exists but has no `privacy` key, the server will automatically add `"blindingEnabled": true` on first run and write it back to disk, preserving the always-on blinding behaviour from before this feature was introduced.

---

## Step 2 — Build the hooks

From the repo root:

```bash
cd clients/gemini
npm install
npm run build
```

This compiles the TypeScript sources in `src/` to `dist/`. The three hook scripts end up at:

```
clients/gemini/dist/before_model.js
clients/gemini/dist/after_model.js
clients/gemini/dist/after_tool.js
```

---

## Step 3 — Configure Gemini CLI

Add the following to your Gemini CLI user settings at **`~/.gemini/settings.json`** (create the file if it doesn't exist). Replace `/absolute/path/to` with the actual absolute path to the repo on your machine.

```json
{
  "hooks": {
    "BeforeModel": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/canvas-mcp/clients/gemini/dist/before_model.js",
            "name": "canvas-mcp: blind student names in prompt",
            "timeout": 5000
          }
        ]
      }
    ],
    "AfterModel": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/canvas-mcp/clients/gemini/dist/after_model.js",
            "name": "canvas-mcp: unblind tokens in response",
            "timeout": 5000
          }
        ]
      }
    ],
    "AfterTool": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/canvas-mcp/clients/gemini/dist/after_tool.js",
            "name": "canvas-mcp: progress indicator",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

**`AfterTool` matcher:** No `matcher` is needed. Gemini CLI passes the bare tool name (e.g. `get_grades`) in the `tool_name` field — not `servername__toolname`. There is no way to filter by server name via the matcher. `after_tool.js` returns `{}` (no-op) for any tool it doesn't recognise, so firing on non-canvas-mcp tools is harmless.

**`BeforeModel` and `AfterModel`** apply to every model call but return `{}` (no-op) when the sidecar doesn't exist yet, or when the prompt/response contains no names or tokens to replace.

> **Project-level override:** You can also place a `.gemini/settings.json` inside a specific project directory. Project settings take precedence over user settings.

---

## Step 4 — Verify

1. Start a Gemini CLI session with canvas-mcp connected.
2. Ask a question that triggers a grade or submission tool, for example:
   ```
   who is at most risk?
   ```
3. After the tool call completes, you should see a progress notification from AfterTool:
   ```
   [canvas-mcp] Fetched grades for 32 students.
   ```
4. Confirm the sidecar file was written:
   ```bash
   cat ~/.cache/canvas-mcp/pii_session.json
   ```
   It should contain a JSON object with `session_id`, `last_updated`, and a `mapping` object of `[STUDENT_NNN]` ↔ real name pairs.
5. The tool result box in the terminal will show blinded JSON (tokens). This is expected — it reflects exactly what the model receives.
6. The model's text response will show real student names, unblinded by `after_model` before it reaches your terminal.
7. In subsequent prompts that mention a student by name, `before_model` will replace that name with its token before the model sees it.

---

## Custom sidecar path

If you set a non-default `privacy.sidecarPath` in the canvas-mcp config, you need to tell the hooks where to find it via an environment variable. Add `CANVAS_MCP_SIDECAR_PATH` to the Gemini CLI environment or prepend it to each hook command:

```json
"command": "CANVAS_MCP_SIDECAR_PATH=/your/custom/path.json node /absolute/path/to/.../before_model.js"
```

---

## How the sidecar works

```
canvas-mcp server                          Gemini CLI process
─────────────────                          ──────────────────
get_grades called
  → tokenize students                      before_model hook
  → write sidecar ──────────────────────→    reads sidecar
  → return blinded JSON                      blinds names in prompt (or {} if none)
                                           model sees only [STUDENT_NNN]
                                           after_tool hook
                                             shows progress systemMessage to user
                                           after_model hook
                                             reads sidecar
                                             replaces tokens with names (or {} if none)
                                           you see real names in model response
```

The sidecar is written on the first blinded tool call of a session, and again whenever additional students are tokenized in subsequent calls (e.g., `get_submission_status` tokenizes students not seen in `get_grades`). The file is deleted automatically when the server shuts down.

**Important:** `before_model` and `after_model` return `{}` (no-op) when there is nothing to replace. Returning an unchanged request or response would cause Gemini CLI to re-trigger the model, creating a tool-call loop.

**Tool result boxes** always display the raw blinded JSON from the MCP server — this is by design and cannot be suppressed via hooks. It reflects exactly what the model receives. The model's *text response* (the `✦` section) is where unblinding occurs.

---

## Known limitations

**First-message blindspot:** `before_model` can only replace names that are already in the sidecar. The sidecar doesn't exist until the first canvas-mcp tool call completes. If you type a student's name in your very first message — before running any tool — that name will reach the model unblinded. To avoid this, run a reporting tool (e.g., ask "show me the class grades") before asking questions that reference specific students by name. The `[canvas-mcp] Fetched grades for N students.` notification confirms the sidecar is ready.

**Single server instance:** Two simultaneous canvas-mcp processes will overwrite each other's sidecar. The atomic write prevents file corruption, but only the most recently started process's session will be in the file.

**Plaintext on disk:** The sidecar is unencrypted JSON, protected only by `600` file permissions. `SecureStore` holds the same data encrypted in memory. The sidecar is deleted on server shutdown. See `docs/SECURITY.md` for the full threat model.
