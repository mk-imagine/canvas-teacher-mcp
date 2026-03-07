# Testing Strategy: Monorepo Test Organization

This document identifies gaps and structural issues in the `canvas-mcp` monorepo test suite and outlines a plan to address them.

## 1. Overview

The current test suite has good coverage of `packages/teacher` tool logic but leaves `packages/core` — the shared library that teacher depends on — entirely untested in isolation. There are also three organizational issues that reduce clarity and discoverability.

### Issues Addressed

1. **`packages/core` has no tests** — substantial, independently-testable logic is covered only incidentally through teacher's tests.
2. **Integration tests live at the repo root** rather than alongside the package they test.
3. **`context.test.ts` tests a core-package function** but lives in teacher's unit test tree.
4. **`connectivity.test.ts` is a one-off environment check** with no corresponding source module, making it an outlier in the naming convention.

---

## 2. Issue 1: `packages/core` Has No Tests

### Problem

`packages/core` contains four independently-testable units with non-trivial logic:

- **`SecureStore`** (`security/secure-store.ts`) — AES-256-GCM encryption, token issuance, counter stability, and zeroing on destroy.
- **`SidecarManager`** (`security/sidecar-manager.ts`) — atomic file writes, skip-if-unchanged logic, purge, and the `enabled=false` short-circuit.
- **`ConfigManager`** (`config/manager.ts`) — deep merge with `DEFAULT_CONFIG`, `privacy` migration for legacy configs, `~` expansion, and validation errors for missing credentials.
- **`renderTemplate` / `validateItems`** (`templates/index.ts`) — pure functions with well-defined inputs and outputs covering four template branches and per-type field validation.

None of these require a live Canvas instance or an MCP server. Testing them through teacher's integration/unit tests obscures failures (a template bug surfaces as a module-creation failure), adds unnecessary coupling, and prevents running core tests independently.

### Plan

Add `packages/core/tests/unit/` with a `vitest.config.ts` that mirrors the teacher config. No MSW server is needed — none of these units make HTTP calls.

#### `secure-store.test.ts`

- **Tokenize — idempotency**: calling `tokenize(id, name)` twice with the same `id` returns the same token.
- **Tokenize — counter**: first call returns `[STUDENT_001]`, second new id returns `[STUDENT_002]`, etc.
- **Resolve — roundtrip**: `resolve(tokenize(id, name))` returns `{ canvasId: id, name }`.
- **Resolve — unknown token**: returns `null` for a token that was never issued.
- **listTokens — encounter order**: tokens appear in the order `tokenize` was first called, not alphabetically.
- **destroy — zeroes key**: after `destroy()`, `resolve()` returns `null` for all previously valid tokens.
- **destroy — clears lists**: `listTokens()` returns `[]` after `destroy()`.

#### `sidecar-manager.test.ts`

Uses `tmpdir()` to avoid touching the real filesystem path.

- **`enabled=false` is a no-op**: `sync()` returns `false` and writes no file.
- **First write**: `sync()` writes a valid JSON file with `session_id`, `last_updated`, and bidirectional `mapping`.
- **Skip if unchanged**: a second `sync()` with the same session and token count returns `false` and does not touch the file.
- **Write on new token**: a second `sync()` after a new `tokenize()` call returns `true` and updates the file.
- **Atomic write**: the `.pii_session.tmp` file is not present after `sync()` returns.
- **File permissions**: the written file has mode `0o600`.
- **Corrupt sidecar**: if the existing sidecar contains invalid JSON, `sync()` overwrites it rather than throwing.
- **`purge()` deletes the file**: after `sync()`, `purge()` removes the file.
- **`purge()` is safe when no file exists**: calling `purge()` on a path that does not exist does not throw.

#### `config-manager.test.ts`

Uses `tmpdir()` for all config file I/O.

- **Missing file**: `read()` on a non-existent path throws `ConfigError` (missing credentials).
- **Deep merge**: a config with only `canvas` set inherits all `defaults` and `privacy` values from `DEFAULT_CONFIG`.
- **`~` expansion**: `privacy.sidecarPath` values starting with `~/` are expanded to the real home directory.
- **Missing `instanceUrl`**: throws `ConfigError` with a message referencing `canvas.instanceUrl`.
- **Missing `apiToken`**: throws `ConfigError` with a message referencing `canvas.apiToken`.
- **Privacy migration**: a config file that has no `privacy` key gets `privacy.blindingEnabled` set to `true` and the migrated config is written back to disk.
- **No migration when `privacy` present**: a config with an explicit `privacy` key is not rewritten.
- **`write()` creates directories**: writing to a path whose parent does not exist creates the parent directories.
- **`update()` roundtrip**: `update({ program: { activeCourseId: 42 } })` persists only that field and leaves all others unchanged.

#### `templates.test.ts`

- **`validateItems` — unknown template**: returns an error string for an unrecognised template name.
- **`validateItems` — wrong type for template**: returns an error string when an item's `type` is not in the template's accepted set.
- **`validateItems` — missing required field**: each item type enforces its required fields (e.g. `coding_assignment` requires `title` and `hours`).
- **`validateItems` — valid inputs**: returns `null` for a correct item list on each of the four templates.
- **`renderTemplate` — throws on invalid items**: throws the error string from `validateItems` rather than returning a partial result.
- **`renderTemplate` — `later-standard` structure**: output starts with an OVERVIEW subheader + overview page, then an ASSIGNMENTS subheader, then item renderables, then a WRAP-UP subheader + exit card quiz.
- **`renderTemplate` — `later-review` structure**: same shape as `later-standard`.
- **`renderTemplate` — `earlier-standard` with assignments and videos**: TO-DO subheader precedes assignment renderables; reminder assignments are auto-appended; QUICK ACCESS TO VIDEOS subheader and video pages appear when video items are present; exit card quiz is last.
- **`renderTemplate` — `earlier-standard` without videos**: QUICK ACCESS TO VIDEOS section is omitted entirely.
- **`renderTemplate` — `earlier-review` structure**: TO-DO subheader, assignment renderables, two auto-generated reminder assignments, exit card quiz.
- **`renderTemplate` — numbering**: week number appears in generated titles; assignment indices (`N.1`, `N.2`) increment correctly.
- **`renderTemplate` — `config.defaults.pointsPossible` fallback**: items without an explicit `points` field use the config default.

---

## 3. Issue 2: Integration Tests Live at the Repo Root

### Problem

`tests/integration/` is at the monorepo root, but all integration tests import from `packages/teacher/src/tools/` and exercise teacher-package tools exclusively. The root-level `tests/vitest.config.ts` duplicates the `@canvas-mcp/core` alias already defined in `packages/teacher/vitest.config.ts`. This means the integration tests have no logical home in the workspace — `npm test` inside `packages/teacher` does not run them, and they are invisible to any package-level tooling.

### Plan

Move `tests/` into `packages/teacher/tests/integration/` and consolidate the vitest configs.

```
packages/teacher/
  tests/
    setup/
      msw-server.ts          (existing)
      integration-env.ts     (moved from tests/setup/)
    unit/
      tools/                 (existing, unchanged)
    integration/
      connectivity.test.ts   (moved)
      content.test.ts        (moved)
      context.test.ts        (moved)
      find.test.ts           (moved)
      modules.test.ts        (moved)
      reporting.test.ts      (moved)
      reset.test.ts          (moved)
  vitest.config.ts           (unit tests, existing)
  vitest.integration.config.ts  (new, replaces root tests/vitest.config.ts)
```

The root `tests/` directory and its `vitest.config.ts` are then deleted. The `test:integration` npm script in the root `package.json` is updated to point to the new config path.

---

## 4. Issue 3: `context.test.ts` Tests a Core-Package Function

### Problem

`packages/teacher/tests/unit/tools/context.test.ts` tests `registerContextTools`, which is exported from `packages/core/src/tools/context.ts`, not from any file in `packages/teacher/src/tools/`. It spins up a full `McpServer` + `InMemoryTransport` + `Client` stack to call the tool over the MCP protocol.

This placement creates two awkward outcomes:

1. The file name implies it belongs to a teacher tool file, but there is no `packages/teacher/src/tools/context.ts`.
2. If `registerContextTools` changes, the relevant test is in teacher, not core — the wrong package for the code under test.

### Plan

Once `packages/core/tests/` exists (Issue 1), move `context.test.ts` there as `packages/core/tests/unit/tools/context.test.ts`. The test itself does not need to change — `McpServer` and `InMemoryTransport` are dev dependencies available in core's test environment. Update `packages/core/vitest.config.ts` to include the test.

This means the teacher unit test tree will have exactly one test file per source file in `packages/teacher/src/tools/`: `content.test.ts`, `find.test.ts`, `modules.test.ts`, `reporting.test.ts`, `reset.test.ts`.

---

## 5. Issue 4: `connectivity.test.ts` Is a One-Off Environment Check

### Problem

`tests/integration/connectivity.test.ts` directly calls the Canvas REST API using raw `fetch` and hard-coded credential env vars — it does not use `CanvasClient` or any teacher tool. Its describe block is named `'Pre-Phase B: Canvas API connectivity'`, a historical artifact from early development. It stands apart from every other integration test file, which all follow the pattern of importing a `register*Tools` function and exercising it via MCP.

The file serves a legitimate purpose: verifying that the test environment has correct credentials, course access, and API permissions before running destructive tests. But its name does not signal this role.

### Plan

Rename the file to `environment.test.ts` to make its role self-documenting. Update the describe block label to `'Test environment: Canvas API connectivity and permissions'`. No code changes are needed beyond the rename and label — the tests themselves are correct and valuable.

After the move in Issue 2, this file lands at `packages/teacher/tests/integration/environment.test.ts`.

---

## 6. Resulting Structure

After all four changes:

```
packages/
  core/
    tests/
      unit/
        secure-store.test.ts
        sidecar-manager.test.ts
        config-manager.test.ts
        templates.test.ts
        tools/
          context.test.ts
    vitest.config.ts
  teacher/
    tests/
      setup/
        msw-server.ts
        integration-env.ts
      unit/
        tools/
          content.test.ts
          find.test.ts
          modules.test.ts
          reporting.test.ts
          reset.test.ts
      integration/
        environment.test.ts
        content.test.ts
        context.test.ts
        find.test.ts
        modules.test.ts
        reporting.test.ts
        reset.test.ts
    vitest.config.ts
    vitest.integration.config.ts
clients/
  gemini/
    tests/             (see clients/gemini/TESTING.md)
```

Each package owns its tests. `npm run test:unit` and `npm run test:integration` continue to work from the repo root via updated script paths.
