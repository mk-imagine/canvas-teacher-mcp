# Implementation Plan: Config Cleanup and Template Migration

| Field | Value |
|-------|-------|
| **Project / Module Name** | config-cleanup-template-migration |
| **Scope Summary** | Remove dead config fields (`defaults`, `exitCardTemplate`, `assignmentDescriptionTemplate`, `ExitCardQuestion`) from `CanvasTeacherConfig` and `DEFAULT_CONFIG`. Migrate their functionality to hardcoded constants and manifest-driven templates. Clean config JSON files. Update all tests. |
| **Assumptions** | 1. The Strategist's recommendation to use hardcoded constants (rather than `TemplateService.renderFile()`) for assignment descriptions in `find.ts` is adopted -- the templates are two-line HTML strings, coupling `create_item` to `TemplateService` for this is unnecessary. 2. The `config` parameter can be removed entirely from `executeRenderables` since all its reads are from the dead fields. 3. The `defaults.assignmentGroup` field in test fixtures can be removed -- it is not read by any source code (only exists in DEFAULT_CONFIG and test fixtures). |
| **Constraints & NFRs** | Build order: core before teacher. Vitest alias bypasses dist. Tool schema: flat `z.object()`. Cross-file atomicity: schema.ts + consumers must be updated together to avoid compile errors. |
| **Repo Target** | `/Users/mark/Repos/personal/canvas-mcp` |
| **Primary Interfaces** | `CanvasTeacherConfig` (schema.ts), `RenderableItem` union (service.ts), `executeRenderables` (modules.ts), `create_item` handler (find.ts), `TemplateService._renderOne()` (service.ts) |
| **Definition of Done** | 1. `npm run build` passes. 2. `npm run test:unit` passes. 3-14: All 14 DoD items from brief satisfied. |

---

## Phasing Strategy

Due to the cross-file coupling (removing schema fields before updating consumers causes compile errors), the work is organized into 4 phases:

- **Phase 1: Foundation** -- Manifest updates + body_file rendering support + `.hbs` file creation (no compile breakage)
- **Phase 2: Atomic Migration** -- Simultaneously update `schema.ts`, `modules.ts`, `find.ts`, and `service.ts` (remove dead config fields + `exit_card_quiz`, inline constants)
- **Phase 3: Test Updates** -- Fix all unit and integration test config fixtures
- **Phase 4: Config File Cleanup** -- Clean JSON config files on disk

---

## Phase 1: Foundation (Non-Breaking Additions)

Milestone: All 4 default manifests updated with 3-question exit cards. Assignment `body_file` rendering added to `_renderOne()`. `.hbs` body template files created. No compile breakage.

Validation Gate:
  lint:        N/A
  unit:        `npm run test:unit`
  integration: N/A

Steps: 1.1, 1.2, 1.3

---

### Step 1.1: Update manifest exit card questions to full 3-question version

**Prerequisite State:** All 4 manifest files exist at `packages/core/src/templates/defaults/*/manifest.json` with 2-question exit cards.

**Outcome:** All 4 manifests contain the full 3-question exit card (Confidence, Muddiest Point, Most Valuable) with the same question text used in the current `DEFAULT_CONFIG.exitCardTemplate.questions`.

**Scope / Touch List:**
- `packages/core/src/templates/defaults/later-standard/manifest.json`
- `packages/core/src/templates/defaults/later-review/manifest.json`
- `packages/core/src/templates/defaults/earlier-standard/manifest.json`
- `packages/core/src/templates/defaults/earlier-review/manifest.json`

**Implementation Notes:**
- In each manifest's exit card Quiz entry, replace the 2-question array with:
```json
[
  { "question_name": "Confidence", "question_text": "Rate your confidence with this week's material (1 = very low, 5 = very high).", "question_type": "essay_question" },
  { "question_name": "Muddiest Point", "question_text": "What is still unclear or confusing from this week?", "question_type": "essay_question" },
  { "question_name": "Most Valuable", "question_text": "What was the most valuable thing you learned this week?", "question_type": "essay_question" }
]
```

**Tests:**
- Existing unit tests for `TemplateService.render()` (if any test exit card question count) should still pass. The manifests are loaded by `TemplateService` constructor and rendered via `render()`. Since tests mock templates or use fixture dirs, this change should not break existing tests.
- Verification: manual inspection that all 4 files have 3 questions.

**Validation Gate:**
- `npm run test:unit` (confirm no regressions)

**Commit:** `feat(core): update default manifest exit cards to full 3-question version`

**If It Fails:** Check for test assertions on question count in modules.test.ts; update those assertions.

**Carry Forward:** Manifests now have 3 questions.

---

### Step 1.2: Update user-directory manifest copies

**Prerequisite State:** Step 1.1 complete. User-directory manifests exist at `~/.config/mcp/canvas-mcp/templates/*/manifest.json`.

**Outcome:** User-directory manifest copies also contain the full 3-question exit card.

**Scope / Touch List:**
- `~/.config/mcp/canvas-mcp/templates/earlier-review/manifest.json`
- `~/.config/mcp/canvas-mcp/templates/earlier-standard/manifest.json`
- `~/.config/mcp/canvas-mcp/templates/later-review/manifest.json`
- `~/.config/mcp/canvas-mcp/templates/later-standard/manifest.json`

**Implementation Notes:**
- For each file: JSON.parse, update the `questions` array in the exit card Quiz structure entry, JSON.stringify with 2-space indent, write back.
- Must handle the case where user-dir manifests may have different structure from defaults (be surgical -- only update the questions array of the Quiz entry that matches the exit card pattern: `quiz_type === "graded_survey"` and title contains "Exit Card").

**Tests:** No automated tests -- these are user-machine files. Validate by reading files back.

**Validation Gate:** Read back each file, verify 3 questions in the exit card Quiz entry.

**Commit:** `chore: update user-directory manifest exit card questions`

**If It Fails:** If a manifest doesn't exist or has unexpected structure, skip it with a warning.

**Carry Forward:** User-dir manifests updated.

---

### Step 1.3: Add `body_file` rendering to Assignment case in `_renderOne()` and create `.hbs` body templates

**Prerequisite State:** `TemplateService._renderOne()` Assignment case exists (service.ts line 194-207). It currently does NOT render `body_file` content into `description`.

**Outcome:** Assignment case in `_renderOne()` renders `body_file` content into `description` field (matching the Page case pattern). Two new `.hbs` files exist for assignment descriptions.

**Scope / Touch List:**
- `packages/core/src/templates/service.ts` (Assignment case in `_renderOne`)
- `packages/core/src/templates/defaults/later-standard/assignment-description.hbs` (new)
- `packages/core/src/templates/defaults/later-standard/solution-description.hbs` (new)
- `packages/core/src/templates/defaults/earlier-standard/assignment-description.hbs` (new)
- `packages/core/src/templates/defaults/earlier-standard/solution-description.hbs` (new)
- `packages/core/src/templates/defaults/later-review/assignment-description.hbs` (new)
- `packages/core/src/templates/defaults/later-review/solution-description.hbs` (new)
- `packages/core/src/templates/defaults/earlier-review/assignment-description.hbs` (new)
- `packages/core/src/templates/defaults/earlier-review/solution-description.hbs` (new)

**Implementation Notes:**

1. In `_renderOne()` Assignment case (line 194-207), add body_file rendering before the return:
```typescript
case 'Assignment': {
  // ... existing points logic ...
  const submissionTypes = item.submission_types ?? ['online_url']
  let description: string | undefined
  if (item.body_file) {
    const compiled = compiledBodies.get(item.body_file)
    if (!compiled) {
      throw new Error(`Template "${templateName}": body_file "${item.body_file}" not compiled`)
    }
    description = compiled(variables)
  }
  return [{ kind: 'assignment', title, points, due_at, submission_types: submissionTypes, description }]
}
```

2. Create `.hbs` files:
   - `assignment-description.hbs`: `<h3><strong><a href="{{notebook_url}}">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>`
   - `solution-description.hbs`: `<h3><strong><a href="{{notebook_url}}">View Solution in Colab</a></strong></h3>`

Note: These `.hbs` files are placed in each template directory for completeness, but the brief's supplementary analysis recommends `create_item` in `find.ts` use hardcoded constants instead of `TemplateService.renderFile()`. The `.hbs` files exist for `build_module` blueprint mode if manifests reference them in the future, and for DoD item 12.

**Tests:**
- Test name: `_renderOne renders body_file for Assignment items`
  - Positive: Create a template with an Assignment item referencing a `body_file`. Call `render()`. Assert the resulting `RenderableItem` has `description` populated with the rendered content.
  - Negative: Assignment without `body_file` should have `description: undefined`.
  - Location: This is internal to `TemplateService`. Test via `render()` with a fixture template directory.
  - Since `_renderOne` is private, test through `render()` on a TemplateService constructed with a temp dir containing a manifest that has an Assignment with `body_file`.

**Validation Gate:**
- `npm run test:unit`
- `npm run build`

**Commit:** `feat(core): add body_file rendering for Assignment items in TemplateService`

**If It Fails:** Check that `.hbs` files are valid Handlebars syntax. Check that `body_file` key is correctly referenced in the manifest if testing via manifest.

**Carry Forward:** `_renderOne()` Assignment case now supports `body_file` -> `description`. `.hbs` files exist in all 4 template directories.

---

## Phase 2: Atomic Migration (Breaking Changes)

Milestone: `schema.ts` cleaned of dead fields. `exit_card_quiz` removed from `RenderableItem` union and `executeRenderables`. `create_item` uses hardcoded constants. `executeRenderables` no longer takes `config` parameter. Build passes.

Validation Gate:
  lint:        N/A
  unit:        `npm run test:unit` (will initially fail until Phase 3 fixes test fixtures)
  integration: N/A

Steps: 2.1 (single atomic step due to cross-file coupling)

---

### Step 2.1: Atomic migration -- remove dead config fields, `exit_card_quiz`, and inline constants

**Prerequisite State:** Phase 1 complete. `.hbs` files exist. Manifests updated.

**Outcome:** All dead config fields removed. `exit_card_quiz` variant removed. `executeRenderables` config parameter removed. `create_item` uses hardcoded constants. Build passes. (Unit tests may fail until Phase 3.)

**Scope / Touch List:**
- `packages/core/src/config/schema.ts`
- `packages/core/src/templates/service.ts`
- `packages/teacher/src/tools/modules.ts`
- `packages/teacher/src/tools/find.ts`

**Implementation Notes:**

**A) `packages/core/src/config/schema.ts`:**
1. Remove `ExitCardQuestion` interface (lines 7-12).
2. Remove `defaults` field from `CanvasTeacherConfig` (lines 24-31).
3. Remove `assignmentDescriptionTemplate` field (lines 39-42).
4. Remove `exitCardTemplate` field (lines 43-47).
5. Remove `defaults` section from `DEFAULT_CONFIG` (lines 64-71).
6. Remove `assignmentDescriptionTemplate` section from `DEFAULT_CONFIG` (lines 79-84).
7. Remove `exitCardTemplate` section from `DEFAULT_CONFIG` (lines 85-106).

Resulting `CanvasTeacherConfig`:
```typescript
export interface CanvasTeacherConfig {
  canvas: { instanceUrl: string; apiToken: string }
  program: {
    activeCourseId: number | null
    courseCodes: string[]
    courseCache: Record<string, CourseCacheEntry>
  }
  privacy: { blindingEnabled: boolean; sidecarPath: string }
  smartSearch: { distanceThreshold: number }
}
```

**B) `packages/core/src/templates/service.ts`:**
1. Remove `exit_card_quiz` variant from `RenderableItem` union (line 49).

**C) `packages/teacher/src/tools/modules.ts`:**
1. Remove `config` parameter from `executeRenderables` signature (line 65).
2. Replace `completionReq` computation (lines 70-72) with hardcoded constant:
   ```typescript
   const completionReq = { type: 'min_score' as const, min_score: 1 }
   ```
3. Remove entire `exit_card_quiz` branch (lines 114-138).
4. Remove `CanvasTeacherConfig` from imports if no longer needed (line 7 -- check if `resolveCourseId` still uses it. Yes, it does via `config.program.activeCourseId`). Keep the import.
5. Update all 4 call sites of `executeRenderables` to remove the `config` argument:
   - Line 298: `executeRenderables(client, courseId, mod.id, renderables, config, args.assignment_group_id)` -> `executeRenderables(client, courseId, mod.id, renderables, args.assignment_group_id)`
   - Line 316: same pattern
   - Line 487-488: same pattern (clone mode)
6. Remove `Handlebars` import if it is no longer used. Check: `Handlebars.compile` was used in the `exit_card_quiz` branch. After removal, scan for other uses in modules.ts. The `resolveCourseId` helper and `toJson`/`toolError` don't use it. The `clone` mode's `subWeek` function doesn't use it. So **remove the Handlebars import**.

**D) `packages/teacher/src/tools/find.ts`:**
1. Add constants at the top of the file (after imports, before `resolveCourseId`):
   ```typescript
   // ── Exit card / assignment defaults (migrated from config) ─────────────────
   const DEFAULT_POINTS_POSSIBLE = 100
   const DEFAULT_SUBMISSION_TYPE = 'online_url'
   const EXIT_CARD_TITLE_TEMPLATE = 'Week {{week}} | Exit Card (5 mins)'
   const EXIT_CARD_QUIZ_TYPE = 'graded_survey' as const
   const EXIT_CARD_POINTS = 0.5
   const EXIT_CARD_QUESTIONS = [
     { question_name: 'Confidence', question_text: "Rate your confidence with this week's material (1 = very low, 5 = very high).", question_type: 'essay_question' },
     { question_name: 'Muddiest Point', question_text: 'What is still unclear or confusing from this week?', question_type: 'essay_question' },
     { question_name: 'Most Valuable', question_text: 'What was the most valuable thing you learned this week?', question_type: 'essay_question' },
   ]
   const ASSIGNMENT_DESCRIPTION_TEMPLATE = '<h3><strong><a href="{{notebook_url}}">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>'
   const SOLUTION_DESCRIPTION_TEMPLATE = '<h3><strong><a href="{{notebook_url}}">View Solution in Colab</a></strong></h3>'
   ```

2. Update `create_item` assignment handler (lines 685-691):
   - `config.assignmentDescriptionTemplate.default` -> `ASSIGNMENT_DESCRIPTION_TEMPLATE`
   - `config.defaults.pointsPossible` -> `DEFAULT_POINTS_POSSIBLE` (lines 697, 708)
   - `config.defaults.submissionType` -> `DEFAULT_SUBMISSION_TYPE` (lines 699, 710)

3. Update `create_item` quiz handler (lines 725-774):
   - `config.exitCardTemplate.title` -> `EXIT_CARD_TITLE_TEMPLATE` (line 728)
   - `config.exitCardTemplate.quizType` -> `EXIT_CARD_QUIZ_TYPE` (line 735)
   - `config.defaults.exitCardPoints` -> `EXIT_CARD_POINTS` (line 736)
   - `config.exitCardTemplate.questions` -> `EXIT_CARD_QUESTIONS` (line 764)

4. Note: `config` is still needed in `create_item` for `resolveCourseId(config, args.course_id)`. The `config` variable remains read via `configManager.read()`. Only the specific dead-field references are replaced.

**Tests:** Build verification: `npm run build`. Unit tests will fail in Phase 3 due to test fixtures still containing dead fields, but the build should pass since TypeScript will catch any remaining references to removed fields.

**Validation Gate:**
- `npm run build` must pass

**Commit:** `refactor(core,teacher): remove dead config fields and exit_card_quiz, inline constants`

**If It Fails:**
- Compile error in schema.ts: check for missed field references
- Compile error in modules.ts: check `executeRenderables` call sites for leftover `config` arg
- Compile error in find.ts: check for remaining `config.defaults` or `config.exitCardTemplate` references
- If `Handlebars` is still used elsewhere in modules.ts, keep the import

**Carry Forward:** `CanvasTeacherConfig` is now 4 top-level fields. `executeRenderables` takes 5 params (no config). `exit_card_quiz` gone from union. Constants defined in `find.ts`.

---

## Phase 3: Test Updates

Milestone: All unit and integration test config fixtures cleaned of dead fields. `npm run test:unit` passes.

Validation Gate:
  lint:        N/A
  unit:        `npm run test:unit`
  integration: N/A (integration tests require credentials)

Steps: 3.1, 3.2

---

### Step 3.1: Update unit test config fixtures

**Prerequisite State:** Phase 2 complete. `CanvasTeacherConfig` no longer has `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate` fields.

**Outcome:** All unit test `writeConfig` / config fixture functions produce valid `CanvasTeacherConfig` objects (no dead fields). All `exit_card_quiz` test assertions removed/updated.

**Scope / Touch List:**
- `packages/teacher/tests/unit/tools/find.test.ts`
- `packages/teacher/tests/unit/tools/modules.test.ts`
- `packages/teacher/tests/unit/tools/content.test.ts`
- `packages/teacher/tests/unit/tools/reset.test.ts`

**Implementation Notes:**

For each file's `writeConfig` function, remove:
- The entire `defaults: { ... }` block
- The entire `assignmentDescriptionTemplate: { ... }` block
- The entire `exitCardTemplate: { ... }` block

For `modules.test.ts`:
- Remove any test cases that test the `exit_card_quiz` renderable kind
- Update any assertions about `completionRequirement` to expect the hardcoded `{ type: 'min_score', min_score: 1 }` value (this is now a constant, not config-driven, so tests should verify the behavior rather than the config reading)
- Update `executeRenderables` call sites in test mocks to not pass `config`

For `find.test.ts`:
- Update assertions about assignment defaults to use the hardcoded values (100 points, 'online_url')
- Update exit card quiz test assertions to expect hardcoded values
- Update assignment description template assertions to expect hardcoded template output

**Tests:**
- All existing tests should continue to pass after fixture updates (same behavior, just driven by constants instead of config)
- Test name: verify `create_item` assignment uses `DEFAULT_POINTS_POSSIBLE` when no `points_possible` provided
  - Positive: call create_item with type='assignment', no points_possible -> expect 100
  - Already covered by existing tests; just update the fixture

**Validation Gate:**
- `npm run test:unit` must pass

**Commit:** `test: remove dead config fields from unit test fixtures`

**If It Fails:**
- Check for `config.defaults` references in test assertions
- Check for `exit_card_quiz` in mock data or assertions
- Grep for `exitCardTemplate` in test files

**Carry Forward:** Unit tests pass.

---

### Step 3.2: Update integration test config fixtures

**Prerequisite State:** Step 3.1 complete. Unit tests pass.

**Outcome:** All integration test config fixtures cleaned of dead fields.

**Scope / Touch List:**
- `packages/teacher/tests/integration/find.test.ts`
- `packages/teacher/tests/integration/modules.test.ts`
- `packages/teacher/tests/integration/reset.test.ts`
- `packages/teacher/tests/integration/content.test.ts`
- `packages/teacher/tests/integration/context.test.ts`
- `packages/teacher/tests/integration/reporting.test.ts`

**Implementation Notes:**

For each file's `makeConfig` function, remove:
- The entire `defaults: { ... }` block (or `defaults: { assignmentGroup: ..., submissionType: ..., pointsPossible: ... }` for shorter versions)
- The `assignmentDescriptionTemplate: { ... }` block (if present)
- The `exitCardTemplate: { ... }` block (if present)

Note: `context.test.ts` and `reporting.test.ts` have simpler configs with just `defaults: { assignmentGroup: ..., submissionType: ..., pointsPossible: ... }` -- remove those too.

**Tests:** Integration tests cannot be run without credentials, but the fixtures should produce valid configs. Verify with `npm run build` (TypeScript will catch type errors in integration test files if they import the config type).

**Validation Gate:**
- `npm run build`
- `npm run test:unit` (confirm no regression)

**Commit:** `test: remove dead config fields from integration test fixtures`

**If It Fails:** Check for `defaults` references in test assertions (not just fixtures).

**Carry Forward:** All test fixtures clean.

---

## Phase 4: Config File Cleanup

Milestone: All JSON config files on disk cleaned of dead fields. DoD items 13-14 satisfied.

Validation Gate:
  lint:        N/A
  unit:        `npm run test:unit`
  integration: N/A

Steps: 4.1, 4.2

---

### Step 4.1: Clean `clients/gemini/config.json`

**Prerequisite State:** Phase 3 complete.

**Outcome:** `clients/gemini/config.json` contains no `defaults`, `assignmentDescriptionTemplate`, or `exitCardTemplate` fields.

**Scope / Touch List:**
- `clients/gemini/config.json`

**Implementation Notes:**
- Read the file, JSON.parse, delete the three keys, JSON.stringify with 2-space indent + trailing newline, write back.

**Tests:** Verify by reading back and checking keys are absent.

**Validation Gate:**
- `npm run build`
- `npm run test:unit`

**Commit:** `chore: remove dead config fields from gemini client config`

**If It Fails:** Syntax error in JSON -- verify proper formatting.

**Carry Forward:** Gemini config clean.

---

### Step 4.2: Clean user-directory config files

**Prerequisite State:** Step 4.1 complete.

**Outcome:** `~/.config/mcp/canvas-mcp/config.json` and `config.sfsu.json` contain no `defaults`, `assignmentDescriptionTemplate`, or `exitCardTemplate` fields.

**Scope / Touch List:**
- `~/.config/mcp/canvas-mcp/config.json`
- `~/.config/mcp/canvas-mcp/config.sfsu.json`

**Implementation Notes:**
- For each file: read, JSON.parse, delete the three keys (`defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate`), JSON.stringify with 2-space indent + trailing newline, write back.
- If a file doesn't exist, skip it (no error).
- These are live config files -- preserve all other fields exactly.

**Tests:** Verify by reading back and checking dead keys are absent.

**Validation Gate:**
- Start the MCP server to verify config still loads: `npm run build && node packages/teacher/dist/index.js --help` (or similar quick smoke test)

**Commit:** `chore: remove dead config fields from user config files`

**If It Fails:** If config.sfsu.json doesn't exist, skip. If JSON parse fails, the file may have been manually edited with syntax errors -- report and skip.

**Carry Forward:** All config files clean. Module complete.

---

## Execution Packets

---

### Packet 1.1

| Field | Value |
|-------|-------|
| **Packet ID** | 1.1 |
| **Depends On** | none |
| **Prerequisite State** | 4 manifest files exist at `packages/core/src/templates/defaults/*/manifest.json`, each with a 2-question exit card Quiz entry. |
| **Objective** | Update all 4 default manifest exit card questions to the full 3-question version (Confidence, Muddiest Point, Most Valuable) with the production question text from `DEFAULT_CONFIG`. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `packages/core/src/templates/defaults/later-standard/manifest.json`, `packages/core/src/templates/defaults/later-review/manifest.json`, `packages/core/src/templates/defaults/earlier-standard/manifest.json`, `packages/core/src/templates/defaults/earlier-review/manifest.json` |
| **Tests** | No new tests. Run `npm run test:unit` to confirm no regression. |
| **Checklist** | 1. In each of the 4 manifest files, locate the Quiz entry with `"quiz_type": "graded_survey"` and title containing "Exit Card". 2. Replace its `questions` array with the 3-question version: `[{ "question_name": "Confidence", "question_text": "Rate your confidence with this week's material (1 = very low, 5 = very high).", "question_type": "essay_question" }, { "question_name": "Muddiest Point", "question_text": "What is still unclear or confusing from this week?", "question_type": "essay_question" }, { "question_name": "Most Valuable", "question_text": "What was the most valuable thing you learned this week?", "question_type": "essay_question" }]`. 3. Verify each file is valid JSON. |
| **Commands** | `npm run test:unit` |
| **Pass Condition** | All 4 manifests have 3-question exit cards. `npm run test:unit` passes. |
| **Commit Message** | `feat(core): update default manifest exit cards to full 3-question version` |
| **Stop / Escalate If** | A manifest has an unexpected structure (no Quiz entry with graded_survey). |

---

### Packet 1.2

| Field | Value |
|-------|-------|
| **Packet ID** | 1.2 |
| **Depends On** | 1.1 |
| **Prerequisite State** | Default manifests updated with 3 questions. User-directory template dirs exist at `~/.config/mcp/canvas-mcp/templates/{earlier-review,earlier-standard,later-review,later-standard}/manifest.json`. |
| **Objective** | Update user-directory manifest copies to match the 3-question exit card. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `~/.config/mcp/canvas-mcp/templates/earlier-review/manifest.json`, `~/.config/mcp/canvas-mcp/templates/earlier-standard/manifest.json`, `~/.config/mcp/canvas-mcp/templates/later-review/manifest.json`, `~/.config/mcp/canvas-mcp/templates/later-standard/manifest.json` |
| **Tests** | No automated tests. Read each file back and verify 3 questions in the exit card Quiz entry. |
| **Checklist** | 1. For each of the 4 user-dir manifest files: read, JSON.parse. 2. Find the Quiz structure entry with `quiz_type === "graded_survey"`. 3. Replace its `questions` array with the same 3-question array used in Packet 1.1. 4. JSON.stringify with 2-space indent, write back. 5. If a file doesn't exist, skip it. |
| **Commands** | N/A (manual verification by reading files back) |
| **Pass Condition** | All existing user-dir manifests have 3-question exit cards. |
| **Commit Message** | `chore: update user-directory manifest exit card questions` |
| **Stop / Escalate If** | A user-dir manifest has a completely different structure than expected (e.g., different version). |

---

### Packet 1.3

| Field | Value |
|-------|-------|
| **Packet ID** | 1.3 |
| **Depends On** | none (parallel with 1.1, 1.2) |
| **Prerequisite State** | `TemplateService._renderOne()` Assignment case at `packages/core/src/templates/service.ts` lines 194-207 does not render `body_file`. |
| **Objective** | Add `body_file` rendering to the Assignment case in `_renderOne()` so that assignments can have template-driven descriptions. Create `.hbs` body template files in all 4 default template directories. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `packages/core/src/templates/service.ts`, `packages/core/src/templates/defaults/later-standard/assignment-description.hbs` (new), `packages/core/src/templates/defaults/later-standard/solution-description.hbs` (new), `packages/core/src/templates/defaults/later-review/assignment-description.hbs` (new), `packages/core/src/templates/defaults/later-review/solution-description.hbs` (new), `packages/core/src/templates/defaults/earlier-standard/assignment-description.hbs` (new), `packages/core/src/templates/defaults/earlier-standard/solution-description.hbs` (new), `packages/core/src/templates/defaults/earlier-review/assignment-description.hbs` (new), `packages/core/src/templates/defaults/earlier-review/solution-description.hbs` (new) |
| **Tests** | Test through `TemplateService.render()` with a fixture template dir containing a manifest with an Assignment item that has `body_file: "test-body.hbs"` and a corresponding `.hbs` file. Assert the rendered `RenderableItem` has `description` set to the rendered body content. Also test that an Assignment WITHOUT `body_file` produces `description: undefined`. If a dedicated test file for TemplateService doesn't exist, add these tests to an appropriate location (e.g., `packages/core/tests/unit/templates/service.test.ts` or inline in an existing test file). |
| **Checklist** | 1. In `_renderOne()` Assignment case (service.ts), add body_file rendering: after computing `submissionTypes`, check `item.body_file`. If present, get compiled template from `compiledBodies`, render with `variables`, assign to `description`. If not present, `description` remains `undefined`. 2. Update the return statement to include `description`. 3. Create `assignment-description.hbs` in all 4 template dirs with content: `<h3><strong><a href="{{notebook_url}}">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>` 4. Create `solution-description.hbs` in all 4 template dirs with content: `<h3><strong><a href="{{notebook_url}}">View Solution in Colab</a></strong></h3>` 5. Write tests. |
| **Commands** | `npm run test:unit`, `npm run build` |
| **Pass Condition** | `npm run build` passes. Tests pass showing Assignment body_file rendering works. `.hbs` files exist in all 4 dirs. |
| **Commit Message** | `feat(core): add body_file rendering for Assignment items in TemplateService` |
| **Stop / Escalate If** | The `RenderableItem` assignment variant's type definition doesn't already have an optional `description` field. (It does -- verified: `description?: string` on line 48 of service.ts.) |

---

### Packet 2.1

| Field | Value |
|-------|-------|
| **Packet ID** | 2.1 |
| **Depends On** | 1.1, 1.3 |
| **Prerequisite State** | Phase 1 complete. Manifests updated. `.hbs` files exist. `_renderOne()` renders `body_file` for assignments. |
| **Objective** | Atomically remove dead config fields (`defaults`, `exitCardTemplate`, `assignmentDescriptionTemplate`, `ExitCardQuestion`) from schema.ts, remove `exit_card_quiz` from RenderableItem and executeRenderables, remove config param from executeRenderables, and inline constants in find.ts. Build must pass. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `packages/core/src/config/schema.ts`, `packages/core/src/templates/service.ts`, `packages/teacher/src/tools/modules.ts`, `packages/teacher/src/tools/find.ts` |
| **Tests** | No new tests in this packet (tests are updated in Phase 3). Validation is build-only. |
| **Checklist** | 1. **schema.ts**: Remove `ExitCardQuestion` interface. Remove `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate` from `CanvasTeacherConfig` interface. Remove corresponding sections from `DEFAULT_CONFIG`. 2. **service.ts**: Remove `{ kind: 'exit_card_quiz'; week: number }` from `RenderableItem` union (line 49). 3. **modules.ts**: (a) Remove `Handlebars` import. (b) Remove `config: CanvasTeacherConfig` parameter from `executeRenderables` (line 65). (c) Replace `completionReq` computation (lines 70-72) with `const completionReq = { type: 'min_score' as const, min_score: 1 }`. (d) Remove entire `exit_card_quiz` branch (lines 114-138). (e) Update all `executeRenderables` call sites to remove `config` argument (lines 298, 316, 487-488). 4. **find.ts**: (a) Add constants block after imports: `DEFAULT_POINTS_POSSIBLE = 100`, `DEFAULT_SUBMISSION_TYPE = 'online_url'`, `EXIT_CARD_TITLE_TEMPLATE`, `EXIT_CARD_QUIZ_TYPE`, `EXIT_CARD_POINTS = 0.5`, `EXIT_CARD_QUESTIONS` (3 questions), `ASSIGNMENT_DESCRIPTION_TEMPLATE`, `SOLUTION_DESCRIPTION_TEMPLATE`. (b) Replace `config.assignmentDescriptionTemplate.default` with `ASSIGNMENT_DESCRIPTION_TEMPLATE` (line 686). (c) Replace `config.defaults.pointsPossible` with `DEFAULT_POINTS_POSSIBLE` (lines 697, 708). (d) Replace `config.defaults.submissionType` with `DEFAULT_SUBMISSION_TYPE` (lines 699, 710). (e) Replace `config.exitCardTemplate.title` with `EXIT_CARD_TITLE_TEMPLATE` (line 728). (f) Replace `config.exitCardTemplate.quizType` with `EXIT_CARD_QUIZ_TYPE` (line 735). (g) Replace `config.defaults.exitCardPoints` with `EXIT_CARD_POINTS` (line 736). (h) Replace `config.exitCardTemplate.questions` with `EXIT_CARD_QUESTIONS` (line 764). |
| **Commands** | `npm run build` |
| **Pass Condition** | `npm run build` passes with no TypeScript errors. No references to `config.defaults`, `config.exitCardTemplate`, or `config.assignmentDescriptionTemplate` remain in `find.ts` or `modules.ts`. |
| **Commit Message** | `refactor(core,teacher): remove dead config fields and exit_card_quiz, inline constants` |
| **Stop / Escalate If** | (1) `executeRenderables` uses `config` for anything other than `defaults` or `exitCardTemplate` -- escalate to verify. (2) `Handlebars` is used elsewhere in `modules.ts` beyond the `exit_card_quiz` branch -- keep the import. (3) Any compile error that suggests a missed reference. |

---

### Packet 3.1

| Field | Value |
|-------|-------|
| **Packet ID** | 3.1 |
| **Depends On** | 2.1 |
| **Prerequisite State** | `CanvasTeacherConfig` no longer has `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate` fields. Build passes. Unit tests fail due to stale fixtures. |
| **Objective** | Update all unit test config fixtures to remove dead fields. All unit tests pass. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `packages/teacher/tests/unit/tools/find.test.ts`, `packages/teacher/tests/unit/tools/modules.test.ts`, `packages/teacher/tests/unit/tools/content.test.ts`, `packages/teacher/tests/unit/tools/reset.test.ts` |
| **Tests** | All existing unit tests must pass after fixture updates. No new tests needed -- this is a fixture cleanup. Specific attention: (1) `modules.test.ts` may have `exit_card_quiz` test cases -- remove them. (2) `find.test.ts` may assert config-driven values -- update assertions to expect hardcoded constant values. |
| **Checklist** | 1. In each file's `writeConfig` function, remove the `defaults: { ... }` block, `assignmentDescriptionTemplate: { ... }` block, and `exitCardTemplate: { ... }` block. 2. In `modules.test.ts`: search for and remove any test cases or mock data that reference `exit_card_quiz` kind. Update any assertions about `completionRequirement` to expect the hardcoded `{ type: 'min_score', min_score: 1 }`. Remove `config` from any direct `executeRenderables` calls in tests (if the function is tested directly). 3. In `find.test.ts`: update any assertions that reference `config.defaults.pointsPossible` (100), `config.defaults.submissionType` ('online_url'), `config.exitCardTemplate`, or `config.assignmentDescriptionTemplate` to use the hardcoded values. 4. Run `npm run test:unit`. |
| **Commands** | `npm run test:unit` |
| **Pass Condition** | `npm run test:unit` passes. No references to `defaults:`, `assignmentDescriptionTemplate:`, or `exitCardTemplate:` remain in unit test config fixtures. |
| **Commit Message** | `test: remove dead config fields from unit test fixtures` |
| **Stop / Escalate If** | A test asserts behavior that depended on config-driven values being different from the hardcoded constants (e.g., a test that set `pointsPossible: 50` in config to verify the config was read). In that case, the test should be updated to verify the hardcoded value is used regardless of config. |

---

### Packet 3.2

| Field | Value |
|-------|-------|
| **Packet ID** | 3.2 |
| **Depends On** | 3.1 |
| **Prerequisite State** | Unit tests pass. Integration test fixtures still contain dead fields. |
| **Objective** | Update all integration test config fixtures to remove dead fields. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `packages/teacher/tests/integration/find.test.ts`, `packages/teacher/tests/integration/modules.test.ts`, `packages/teacher/tests/integration/reset.test.ts`, `packages/teacher/tests/integration/content.test.ts`, `packages/teacher/tests/integration/context.test.ts`, `packages/teacher/tests/integration/reporting.test.ts` |
| **Tests** | Cannot run integration tests without credentials. Verify with `npm run build` (TypeScript catches type errors). |
| **Checklist** | 1. In each file's `makeConfig` function, remove `defaults: { ... }`, `assignmentDescriptionTemplate: { ... }`, and `exitCardTemplate: { ... }` blocks. 2. For `context.test.ts` and `reporting.test.ts`, the config is shorter -- just remove the `defaults: { ... }` line. 3. Run `npm run build` to verify no type errors. 4. Run `npm run test:unit` to confirm no regression. |
| **Commands** | `npm run build`, `npm run test:unit` |
| **Pass Condition** | `npm run build` passes. `npm run test:unit` still passes. No references to dead fields in integration test fixtures. |
| **Commit Message** | `test: remove dead config fields from integration test fixtures` |
| **Stop / Escalate If** | An integration test file imports `ExitCardQuestion` type directly. |

---

### Packet 4.1

| Field | Value |
|-------|-------|
| **Packet ID** | 4.1 |
| **Depends On** | 3.2 |
| **Prerequisite State** | All tests pass. Build passes. |
| **Objective** | Remove dead config fields from `clients/gemini/config.json`. |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `clients/gemini/config.json` |
| **Tests** | Read file back, verify no `defaults`, `assignmentDescriptionTemplate`, or `exitCardTemplate` keys. |
| **Checklist** | 1. Read `clients/gemini/config.json`. 2. Remove the `defaults` key/value. 3. Remove the `assignmentDescriptionTemplate` key/value. 4. Remove the `exitCardTemplate` key/value. 5. Ensure valid JSON with 2-space indent and trailing newline. |
| **Commands** | `npm run build`, `npm run test:unit` |
| **Pass Condition** | File contains no dead fields. Build and unit tests still pass. |
| **Commit Message** | `chore: remove dead config fields from gemini client config` |
| **Stop / Escalate If** | File doesn't exist or has unexpected format. |

---

### Packet 4.2

| Field | Value |
|-------|-------|
| **Packet ID** | 4.2 |
| **Depends On** | 4.1 |
| **Prerequisite State** | Gemini config cleaned. |
| **Objective** | Remove dead config fields from user-directory config files (`~/.config/mcp/canvas-mcp/config.json` and `config.sfsu.json`). |
| **Execution Mode** | Tool-Integrated |
| **Allowed Files** | `~/.config/mcp/canvas-mcp/config.json`, `~/.config/mcp/canvas-mcp/config.sfsu.json` |
| **Tests** | Read each file back, verify no dead keys. |
| **Checklist** | 1. For each file (`config.json`, `config.sfsu.json`): (a) Check if file exists; skip if not. (b) Read and JSON.parse. (c) Delete keys: `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate`. (d) JSON.stringify with 2-space indent + trailing newline. (e) Write back. 2. Verify by reading back. |
| **Commands** | `npm run build`, `npm run test:unit` |
| **Pass Condition** | Both files (if they exist) contain no dead keys. Build and tests still pass. |
| **Commit Message** | `chore: remove dead config fields from user config files` |
| **Stop / Escalate If** | JSON parse error (file has been manually edited with syntax errors). |

---

## Summary

| Phase | Packets | Execution Mode | Key Risk |
|-------|---------|---------------|----------|
| 1 - Foundation | 1.1, 1.2, 1.3 | All Tool-Integrated | Low -- additive changes only |
| 2 - Atomic Migration | 2.1 | Tool-Integrated | Medium -- 4-file atomic edit, compile errors if incomplete |
| 3 - Test Updates | 3.1, 3.2 | All Tool-Integrated | Low -- mechanical fixture cleanup |
| 4 - Config Cleanup | 4.1, 4.2 | All Tool-Integrated | Low -- JSON file editing |

**Total packets:** 8. **All Tool-Integrated** (100%). Fully automatable.

**Parallelism:** Packets 1.1 and 1.3 can run in parallel. Packet 1.2 depends on 1.1. All other packets are sequential.
