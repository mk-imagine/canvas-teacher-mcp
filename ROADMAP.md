# canvas-mcp Roadmap

This document is the top-level index of planned work. Items with dedicated design documents link to them; all others are specified here.

**Status legend:** `[ ]` planned · `[~]` in progress · `[x]` complete (kept for history)

---

## 1. Test Suite Restructuring

> Full specification: [TESTING.md](TESTING.md)

Four discrete issues, each independently actionable:

| # | Status | Issue |
|---|--------|-------|
| 1.1 | `[ ]` | `packages/core` has no unit tests — add `packages/core/tests/unit/` covering `SecureStore`, `SidecarManager`, `ConfigManager`, and `renderTemplate` |
| 1.2 | `[x]` | Integration tests live at the repo root — move `tests/integration/` into `packages/teacher/tests/integration/` and consolidate vitest configs |
| 1.3 | `[x]` | `context.test.ts` tests a core-package function but lives in teacher's unit tree — move to `packages/core/tests/unit/tools/` |
| 1.4 | `[x]` | `connectivity.test.ts` is a one-off environment check with a misleading name — rename to `environment.test.ts` |

---

## 2. Template System Generalization

> Full specification: [docs/TEMPLATE_SYSTEM_ROADMAP.md](docs/TEMPLATE_SYSTEM_ROADMAP.md)

Move program-specific scaffolding out of source code and into a user-editable template directory (`~/.config/mcp/canvas-mcp/templates/`). Introduces a JSON manifest format, Handlebars rendering, and a `blueprint` / `manual` dual-mode interface for `build_module`.

| # | Status | Task |
|---|--------|------|
| 2.1 | `[x]` | Create `TemplateService` — directory scanning, manifest parsing, version validation, Handlebars rendering |
| 2.2 | `[x]` | Convert hardcoded templates to default JSON/HBS files under `src/templates/defaults/`; seed to user config dir on first run |
| 2.3 | `[x]` | Update `build_module` schema: replace `template` discriminant with `mode: blueprint \| manual` |
| 2.4 | `[x]` | Update `create_item`: add optional `template_name` / `template_data` fields |
| 2.5 | `[x]` | Add `type: 'templates'` to `list_items` for LLM introspection |
| 2.6 | `[x]` | Remove hardcoded scaffolding logic from `src/templates/index.ts` |

---

## 3. PII / Privacy Improvements

> Context and tradeoffs: [docs/PII_ARCHITECTURE.md §5–6](docs/PII_ARCHITECTURE.md)

### 3.1 Eliminate the Disk Sidecar — Volatile Memory Only

**Status:** `[ ]` *(privacy-beyond-compliance exercise)*

**Compliance note:** FERPA requires that PII not be disclosed to third parties (the AI provider) — a requirement the current system already fully satisfies. FERPA imposes no requirements on local storage. The `0600` sidecar is FERPA-sufficient in practice. This item is a **privacy-beyond-compliance** engineering exercise: eliminating plaintext PII from disk entirely, going further than any regulatory mandate requires. It is a good candidate for a technical projects abstract.

**Goal:** Remove all PII from disk entirely. Currently `SidecarManager` writes a plaintext `pii_session.json` sidecar so that Gemini CLI hooks (separate processes) can read the token→name mapping. Even with `0600` permissions and an atomic write, this is plaintext PII on the filesystem — readable by backup tools, cloud sync, or forensic disk analysis.

**Why inter-process communication is required:** Gemini CLI hooks (`before_model`, `after_model`) are spawned fresh as short-lived subprocesses on every turn — they share no memory with the MCP server process and hold no state between turns. Any solution must allow an unrelated subprocess to retrieve the live mapping on demand. This rules out passing the encrypted structure in-band through the MCP protocol: `before_model` and `after_model` don't receive tool results, only LLM message turns, so they have no access to anything embedded in a tool response content block.

**Preferred approach — Unix domain socket:**

The MCP server creates a Unix domain socket at a stable path (e.g. `~/.cache/canvas-mcp/pii.sock`) at startup. A single request/response protocol over that socket allows hooks to fetch the live token→name mapping on demand. No TCP stack, no port numbers, no firewall surface. The socket *file* in the filesystem is a kernel IPC descriptor — it contains no data and no PII. Data flows kernel-to-kernel in memory. The socket file is removed on process exit via the same `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handlers already used by `SidecarManager.purge()`.

Hooks authenticate with a per-session bearer token (a random UUID written to a tiny non-PII coordination file `~/.cache/canvas-mcp/session.json` containing only `{ "socketPath": "...", "token": "uuid" }`). No PII ever touches disk.

**Alternative considered — loopback HTTP (`127.0.0.1:<port>`):** Functionally equivalent but rejected as the preferred approach — requires binding a TCP port (risk of port conflicts, potential macOS firewall prompts) and involves the full TCP stack when a Unix socket is simpler and more appropriate for local IPC.

**Tradeoffs vs. current sidecar:**
- Pro: No PII ever written to disk under any circumstances
- Pro: Mapping is always live/current — no sync lag between tool calls
- Pro: Resolves the concurrent-instance clobbering issue (§5.4) — each instance has its own socket path
- Pro: No TCP port binding or firewall surface
- Con: Real engineering work — timeout handling, graceful no-op fallback when server is unavailable, updates to all three hooks
- Con: Overkill relative to actual compliance requirements

**Implementation:** `SidecarManager` is replaced by a `PiiServer` class. `SecureStore` is unchanged.

### 3.2 Server-Start Roster Pre-Fetch

**Status:** `[x]`

On startup (when `blindingEnabled` is true), silently fetch the course enrollment list to populate `SecureStore` before any tool call. Eliminates the first-message blindspot (§5.2) where a user typing a student name before any Canvas tool runs sends that name to the LLM unblinded.

### 3.3 AfterTool Unblinded System Message

**Status:** `[ ]` *(someday)*

The `systemMessage` from `after_tool.ts` is user-terminal-only and never reaches `before_model`, so it is safe to include real student names (e.g., `"Fetched grades for Jane Smith, John Doe, ..."`). Currently uses count-only messages for simplicity.

---

## 4. Distribution

### 4.1 HTTP/SSE Transport

**Status:** `[ ]` *(someday)*

Add HTTP/SSE as an alternative transport alongside stdio. Required for containerized distribution and enables a persistent-server model (one container, many client connections) rather than per-session process spawning.

The MCP SDK supports `StreamableHTTPServerTransport`. This would be an opt-in mode (`--transport http --port 3000`) with stdio remaining the default.

### 4.2 Docker Image and Containerized Distribution

**Status:** `[ ]` *(someday)*

Package canvas-mcp as a Docker image for distribution to other teachers. Target workflow: `docker compose up`, then point the AI client at `http://localhost:3000`. Eliminates the Node.js install requirement for end users.

**Prerequisites:** HTTP/SSE transport (4.1) must land first. The `docker run --rm -i` pattern for stdio-over-Docker is functional but too awkward to recommend to non-technical instructors.

**Scope when ready:**
- Publish image to Docker Hub
- Ship a `docker-compose.yml` with volume mounts for `~/.config/mcp/canvas-mcp/` (config and templates)
- Update README setup instructions with a Docker path alongside the current bare-metal path

---

## 5. MCP SDK Discriminated Union Workaround Revert

> Full specification: [docs/MCP_SDK_DISCRIMINATED_UNION_WORKAROUND.md](docs/MCP_SDK_DISCRIMINATED_UNION_WORKAROUND.md)

> **Blocked:** This item cannot proceed until the MCP SDK fixes `normalizeObjectSchema()` to handle discriminated unions. The upstream fix timeline is unknown — track [issue #1643](https://github.com/modelcontextprotocol/typescript-sdk/issues/1643). No action required in this repo until then.

The MCP SDK silently drops `z.discriminatedUnion()` schemas. Eight tools were refactored to flat `z.object()` as a workaround. When the SDK ships a fix:

| # | Status | Task |
|---|--------|------|
| 5.1 | `[ ]` | Check out commit `0ae3e39`, restore `z.discriminatedUnion()` schemas in `find.ts`, `reporting.ts`, `modules.ts` |
| 5.2 | `[ ]` | Remove `!` non-null assertions added to handler code |
| 5.3 | `[ ]` | Run `npm run build && npm run test:unit` to verify |
