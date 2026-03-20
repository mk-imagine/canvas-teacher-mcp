# Implementation Plan: Module 1 — Test Suite Restructuring

**Prepared by:** SoftwareTactician
**Date:** 2026-03-20
**Based on:** Module Brief `2026-03-20_module-brief_module-1-test-suite-restructuring.md`

---

## Overview

Module 1 restructures the canvas-mcp test suite across four tasks executed in two commits:

- **Commit A (Tasks 1.1 + 1.3):** Create `packages/core` test infrastructure and move `context.test.ts` into it.
- **Commit B (Tasks 1.2 + 1.4):** Move all integration tests into `packages/teacher`, rename `connectivity.test.ts` to `environment.test.ts`, update the describe label, and delete the root `tests/` directory.

No source files under any `src/` directory are modified. No new test logic is introduced beyond what `TESTING.md` specifies (the four new test files are out of scope for Module 1 and are not addressed here).

---

## Execution Packet EP-1.1 — Create `packages/core` Test Infrastructure

**Depends on:** None
**Objective:** Establish the vitest configuration, MSW setup file, and package.json updates required to run unit tests in `packages/core`.
**Execution mode:** Tool-Integrated

### Pre-conditions

- `packages/core/package.json` exists with `"test": "echo 'No unit tests in core yet'"` and no `msw` devDependency.
- `packages/teacher/vitest.config.ts` exists (reference pattern).
- `packages/teacher/tests/setup/msw-server.ts` exists (source to copy verbatim).
- No `packages/core/vitest.config.ts` exists yet.
- No `packages/core/tests/` directory exists yet.

### Step-by-step Implementation

**Step 1 — Create directory structure**

Create the following directories (they do not exist yet):
- `packages/core/tests/`
- `packages/core/tests/unit/`
- `packages/core/tests/unit/tools/`
- `packages/core/tests/setup/`

**Step 2 — Create `packages/core/vitest.config.ts`**

Create the file at `packages/core/vitest.config.ts` with this exact content (modeled on `packages/teacher/vitest.config.ts`, with three differences: the alias is self-referential, the include path targets `tests/unit`, and the coverage exclude swaps `packages/core` for `packages/teacher`):

```typescript
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@canvas-mcp/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/msw-server.ts'],
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings'],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/unit',
      clean: true,
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '.history/**',
        'packages/teacher/**',
        'src/index.ts',
        'vitest.config.ts',
        '**/*.d.ts',
      ],
    },
  },
})
```

Key differences from teacher's config:
- `alias` value: `'./src/index.ts'` (self-referential, not `../core/...`)
- `test.include`: `['tests/unit/**/*.test.ts']`
- `coverage.exclude`: `'packages/teacher/**'` instead of `'packages/core/**'`

**Step 3 — Create `packages/core/tests/setup/msw-server.ts`**

Create the file at `packages/core/tests/setup/msw-server.ts` as an exact copy of `packages/teacher/tests/setup/msw-server.ts`:

```typescript
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

// Shared msw server instance for all unit tests.
// Imported by vitest.config.ts as a setupFile — runs before every test file.
export const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

**Step 4 — Update `packages/core/package.json`**

Two changes:

(a) Replace the `"test"` script:
- Old: `"test": "echo 'No unit tests in core yet'"`
- New: `"test": "node --no-warnings ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts"`

(b) Add `"msw": "^2.0.0"` to `devDependencies`.

### Acceptance Test

1. `packages/core/vitest.config.ts` exists and is syntactically valid TypeScript.
2. `packages/core/tests/setup/msw-server.ts` exists and matches the teacher copy.
3. `packages/core/package.json` `"test"` script invokes vitest (not the echo stub).
4. `packages/core/package.json` `devDependencies` contains `"msw": "^2.0.0"`.
5. `npm run test -w packages/core` from repo root exits 0 (vitest exits 0 with no matching test files).

### Rollback

- Delete `packages/core/vitest.config.ts`.
- Delete `packages/core/tests/` directory (recursive).
- Revert `packages/core/package.json` to previous content.

---

## Execution Packet EP-1.3 — Move `context.test.ts` from Teacher to Core

**Depends on:** EP-1.1
**Objective:** Relocate `context.test.ts` to the `packages/core` test tree where it logically belongs, with no content changes.
**Execution mode:** Tool-Integrated

### Pre-conditions

- EP-1.1 is complete: `packages/core/tests/unit/tools/` directory exists, `packages/core/vitest.config.ts` is present.
- `packages/teacher/tests/unit/tools/context.test.ts` exists.
- The MSW import on line 10 of that file is: `import { server as mswServer } from '../../setup/msw-server.js'`

### Step-by-step Implementation

**Step 1 — Copy file to new location**

Copy `packages/teacher/tests/unit/tools/context.test.ts` to `packages/core/tests/unit/tools/context.test.ts` with byte-for-byte identical content. Do not edit any line.

Why no edits are needed: After the move, the import `../../setup/msw-server.js` resolves from `packages/core/tests/unit/tools/context.test.ts` up two levels to `packages/core/tests/setup/msw-server.ts` — which is precisely the file created in EP-1.1 Step 3.

**Step 2 — Delete the source file from teacher**

Delete `packages/teacher/tests/unit/tools/context.test.ts`.

### Acceptance Test

1. `packages/core/tests/unit/tools/context.test.ts` exists with content identical to the original.
2. `packages/teacher/tests/unit/tools/context.test.ts` does not exist.
3. `npm run test -w packages/core` runs `context.test.ts` and all tests pass.
4. `npm run test -w packages/teacher` completes without including the context test.

### Rollback

- Copy `packages/core/tests/unit/tools/context.test.ts` back to `packages/teacher/tests/unit/tools/context.test.ts`.
- Delete `packages/core/tests/unit/tools/context.test.ts`.

---

## Execution Packet EP-1.2+1.4 — Move Integration Tests + Rename/Update `environment.test.ts`

**Depends on:** None (parallel with EP-1.1)
**Objective:** Relocate all integration tests from the repo root `tests/` into `packages/teacher/tests/integration/`, rename `connectivity.test.ts` to `environment.test.ts` with an updated describe label, create the new integration vitest config, update root `package.json` scripts, and delete the root `tests/` directory.
**Execution mode:** Tool-Integrated

### Pre-conditions

- `tests/integration/` directory exists at repo root containing exactly 7 files: `connectivity.test.ts`, `content.test.ts`, `context.test.ts`, `find.test.ts`, `modules.test.ts`, `reporting.test.ts`, `reset.test.ts`.
- `tests/setup/integration-env.ts` exists at repo root.
- `tests/vitest.config.ts` exists at repo root.
- `packages/teacher/tests/` directory exists (contains `setup/` and `unit/`).
- Root `package.json` `test:integration` script points to `tests/vitest.config.ts`.
- `packages/teacher/tests/integration/` does not yet exist.
- `packages/teacher/vitest.integration.config.ts` does not yet exist.

### Step-by-step Implementation

**Step 1 — Create `packages/teacher/tests/integration/` directory**

**Step 2 — Copy `integration-env.ts` to new location**

Copy `tests/setup/integration-env.ts` to `packages/teacher/tests/setup/integration-env.ts` with byte-for-byte identical content. No edits needed.

**Step 3 — Copy integration test files**

Copy the following files verbatim (content unchanged):

| Source | Destination |
|---|---|
| `tests/integration/content.test.ts` | `packages/teacher/tests/integration/content.test.ts` |
| `tests/integration/context.test.ts` | `packages/teacher/tests/integration/context.test.ts` |
| `tests/integration/find.test.ts` | `packages/teacher/tests/integration/find.test.ts` |
| `tests/integration/modules.test.ts` | `packages/teacher/tests/integration/modules.test.ts` |
| `tests/integration/reporting.test.ts` | `packages/teacher/tests/integration/reporting.test.ts` |
| `tests/integration/reset.test.ts` | `packages/teacher/tests/integration/reset.test.ts` |

For `connectivity.test.ts` → `packages/teacher/tests/integration/environment.test.ts` (renamed), make exactly one content edit:

- **Old:** `describe('Pre-Phase B: Canvas API connectivity', () => {`
- **New:** `describe('Test environment: Canvas API connectivity and permissions', () => {`

No other lines change.

**Step 4 — Create `packages/teacher/vitest.integration.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@canvas-mcp/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share Canvas state — run files sequentially
    fileParallelism: false,
    setupFiles: ['tests/setup/integration-env.ts'],
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings'],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/integration',
      clean: true,
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        'scripts/**',
        '.history/**',
        'packages/teacher/**',
        '**/coverage/**',
        'vitest.integration.config.ts',
        '**/*.d.ts',
      ],
    },
  },
})
```

Key differences from the source `tests/vitest.config.ts`:
- `alias` value: `'../core/src/index.ts'` (relative to `packages/teacher/` — same as unit config)
- `test.include` and `test.setupFiles`: unchanged as strings, but now resolve relative to `packages/teacher/`
- `coverage.exclude`: updated `'vitest.config.ts'` to `'vitest.integration.config.ts'`

**Step 5 — Update root `package.json` scripts**

- **`test:integration`:** `...--config tests/vitest.config.ts` → `...--config packages/teacher/vitest.integration.config.ts`
- **`test:integration:coverage`:** same path substitution

**Step 6 — Delete the root `tests/` directory**

Use `git rm -r tests/` to stage the deletions properly, or delete recursively and then `git add -u tests/` to stage.

### Acceptance Test

1. `packages/teacher/tests/integration/` contains exactly 7 files: `environment.test.ts`, `content.test.ts`, `context.test.ts`, `find.test.ts`, `modules.test.ts`, `reporting.test.ts`, `reset.test.ts`.
2. `packages/teacher/tests/setup/integration-env.ts` exists with identical content to the original.
3. `packages/teacher/vitest.integration.config.ts` exists and is syntactically valid TypeScript.
4. Root `tests/` directory does not exist.
5. Root `package.json` `test:integration` script references `packages/teacher/vitest.integration.config.ts`.
6. `packages/teacher/tests/integration/environment.test.ts` line 18 reads: `describe('Test environment: Canvas API connectivity and permissions', () => {`
7. With valid `.env.test`, `npm run test:integration` from repo root runs all 7 integration test files.

### Rollback

- Copy all 7 files from `packages/teacher/tests/integration/` back to `tests/integration/`, renaming `environment.test.ts` back to `connectivity.test.ts` and reverting the describe label.
- Copy `packages/teacher/tests/setup/integration-env.ts` back to `tests/setup/integration-env.ts`.
- Delete `packages/teacher/vitest.integration.config.ts` and restore `tests/vitest.config.ts`.
- Revert root `package.json` script changes.

---

## Commit Strategy

**Commit A** (after EP-1.1 + EP-1.3):
```
test(core): add vitest infrastructure and move context.test.ts from teacher
```
Staged: `packages/core/vitest.config.ts` (new), `packages/core/tests/setup/msw-server.ts` (new), `packages/core/tests/unit/tools/context.test.ts` (new), `packages/core/package.json` (modified), `packages/teacher/tests/unit/tools/context.test.ts` (deleted)

**Commit B** (after EP-1.2+1.4):
```
test(teacher): move integration tests into package, rename connectivity → environment
```
Staged: `packages/teacher/vitest.integration.config.ts` (new), `packages/teacher/tests/setup/integration-env.ts` (new), 7 test files in `packages/teacher/tests/integration/` (new), root `tests/` (deleted), root `package.json` (modified)

---

## Dependency Graph

```
EP-1.1 (core infra)
  |
  v
EP-1.3 (move context.test.ts)

EP-1.2+1.4 (move integration tests + rename/relabel)
  [no dependency — parallel with EP-1.1]
```

---

## Execution Packet Summary

| Packet | Depends on | Objective | Mode |
|---|---|---|---|
| EP-1.1 | None | Create `packages/core` vitest infrastructure | Tool-Integrated |
| EP-1.3 | EP-1.1 | Move `context.test.ts` from teacher to core | Tool-Integrated |
| EP-1.2+1.4 | None | Move integration tests, rename + relabel environment test | Tool-Integrated |

**3 of 3 packets are Tool-Integrated (100%).** Suitable for automated dispatch.

---

## Risk Register

| Risk | Mitigation |
|---|---|
| `msw` not installed when core tests run | `msw` is hoisted to root `node_modules` via workspace; adding to `packages/core/package.json` is declarative — no `npm install` needed |
| `process.cwd()` in `integration-env.ts` after move | Confirmed safe: root-invoked `npm run test:integration` preserves cwd at repo root |
| `context.test.ts` MSW import path after move | Confirmed correct: `../../setup/msw-server.js` resolves to the new `packages/core/tests/setup/msw-server.ts` |
| Root `tests/` deletion leaves orphaned git tracking | Use `git rm -r tests/` to stage deletions, not filesystem-only deletion |

---

## Critical Files for Implementation

| File | Role |
|---|---|
| `packages/core/package.json` | Add `msw` devDependency + update test script (EP-1.1) |
| `packages/teacher/vitest.config.ts` | Reference pattern for `packages/core/vitest.config.ts` |
| `tests/vitest.config.ts` | Source config migrated into `packages/teacher/vitest.integration.config.ts` then deleted |
| `packages/teacher/tests/unit/tools/context.test.ts` | Moved to core; import on line 10 resolves correctly without edits |
| `package.json` (root) | `test:integration` + `test:integration:coverage` scripts updated (EP-1.2+1.4) |
