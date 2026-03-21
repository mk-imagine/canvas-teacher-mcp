# Implementation Plan — Module 2: Template System Generalization

**Prepared by:** SoftwareTactician
**Date:** 2026-03-20
**Module:** 2 of canvas-mcp Roadmap
**Source brief:** `audit_trail/strategist/2026-03-20_module-brief_module-2-template-system-generalization.md`

---

## Ground-Truth Verification

All six specified files were read. Verified facts used in this plan:

| Claim | Actual | Status |
|---|---|---|
| `handlebars` already imported in `index.ts` | `import Handlebars from 'handlebars'` at line 1 | Confirmed |
| `renderTemplate` exported and imported in `modules.ts` | Lines 21–22 of import list | Confirmed |
| `listItemsSchema` enum has 9 values | `z.enum(['modules','assignments','quizzes','pages','discussions','announcements','rubrics','assignment_groups','module_items'])` line 238 | Confirmed |
| `list_items` handler calls `resolveCourseId` before any type branch | Lines 866–872 of `find.ts` | Confirmed — must short-circuit before line 866 |
| `registerFindTools` signature: `(server, client, configManager)` | Line 246–250 | Confirmed |
| `registerModuleTools` signature: `(server, client, configManager)` | Lines 215–219 | Confirmed |
| `ConfigManager.configPath` is private | `private readonly configPath: string` in `manager.ts` line 41 | Confirmed |
| `packages/core/src/templates/` contains only `index.ts` | Glob result | Confirmed — no `defaults/` dir exists |
| `packages/core/src/index.ts` re-exports templates via `export * from './templates/index.js'` | Line 32 | Confirmed |
| `solution` mode handler: ~50 lines | Lines 323–375 | Confirmed |
| `clone` mode handler: ~80 lines | Lines 377–503 | Confirmed |
| `modules.test.ts` calls `registerModuleTools(mcpServer, canvasClient, configManager)` | Line 145 | Confirmed — needs 4th `templateService` arg after task 2.3 |
| Default config path is `~/.config/mcp/canvas-mcp/config.json` | `manager.ts` lines 43–45 | Confirmed |

---

## Execution Packet EP-2.1 — Create `TemplateService` and Default Template Files

**Depends on:** None
**Objective:** Implement `TemplateService` in `packages/core/src/templates/service.ts` and create 12 default template files under `packages/core/src/templates/defaults/`.
**Execution mode:** Tool-Integrated

### Pre-conditions

1. `packages/core/src/templates/index.ts` is at the current 305-line state
2. `handlebars` (^4.7.8) is already in `packages/core/package.json` — no install needed
3. No `packages/core/src/templates/defaults/` directory exists
4. No `packages/core/src/templates/service.ts` exists

### Step 1 — Create `packages/core/src/templates/service.ts`

```typescript
import Handlebars from 'handlebars'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Manifest types ───────────────────────────────────────────────────────────

export interface ManifestStructureItem {
  type: 'SubHeader' | 'Page' | 'Assignment' | 'Quiz' | 'ExternalUrl'
  title?: string
  body_file?: string
  for_each?: string
  points?: string | number
  quiz_type?: string
  time_limit?: number
  allowed_attempts?: number
  questions?: Array<{ question_text: string; question_name?: string; question_type?: string }>
  url?: string
  submission_types?: string[]
}

export interface TemplateManifest {
  version: 1
  name: string
  description: string
  variables_schema?: Record<string, { type: string; required?: boolean }>
  structure: ManifestStructureItem[]
}

export interface TemplateDescriptor {
  template_name: string
  name: string
  description: string
  variables_schema?: Record<string, { type: string; required?: boolean }>
}

// ─── RenderableItem types (shared with existing executeRenderables) ────────────

export interface QuizQuestionInput {
  question_name: string
  question_text: string
  question_type: string
  points_possible?: number
}

export type RenderableItem =
  | { kind: 'subheader'; title: string }
  | { kind: 'page'; title: string; body?: string }
  | { kind: 'assignment'; title: string; points: number; due_at: string; submission_types: string[]; description?: string }
  | { kind: 'exit_card_quiz'; week: number }
  | { kind: 'quiz'; title: string; points: number; due_at: string; quiz_type: string; time_limit?: number; allowed_attempts?: number; questions?: QuizQuestionInput[] }
  | { kind: 'external_url'; title: string; url: string }

// ─── TemplateService ──────────────────────────────────────────────────────────

interface CachedTemplate {
  manifest: TemplateManifest
  compiledBodies: Map<string, Handlebars.TemplateDelegate>
}

export class TemplateService {
  private readonly templatesDir: string
  private readonly cache: Map<string, CachedTemplate> = new Map()

  constructor(templatesDir: string) {
    this.templatesDir = templatesDir
    this._loadAll()
  }

  private _loadAll(): void {
    if (!existsSync(this.templatesDir)) return

    const entries = readdirSync(this.templatesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const templateName = entry.name
      const templateDir = join(this.templatesDir, templateName)
      const manifestPath = join(templateDir, 'manifest.json')

      if (!existsSync(manifestPath)) continue

      let manifest: TemplateManifest
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        manifest = JSON.parse(raw) as TemplateManifest
      } catch {
        continue
      }

      if (manifest.version !== 1) continue
      if (!manifest.name || !manifest.description || !Array.isArray(manifest.structure)) continue

      // Compile all body_file references
      const compiledBodies = new Map<string, Handlebars.TemplateDelegate>()
      let valid = true
      for (const item of manifest.structure) {
        if (item.body_file) {
          const bodyPath = join(templateDir, item.body_file)
          if (!existsSync(bodyPath)) {
            valid = false
            break
          }
          if (!compiledBodies.has(item.body_file)) {
            const src = readFileSync(bodyPath, 'utf-8')
            compiledBodies.set(item.body_file, Handlebars.compile(src))
          }
        }
      }

      if (!valid) continue

      this.cache.set(templateName, { manifest, compiledBodies })
    }
  }

  list(): TemplateDescriptor[] {
    const result: TemplateDescriptor[] = []
    for (const [templateName, { manifest }] of this.cache) {
      result.push({
        template_name: templateName,
        name: manifest.name,
        description: manifest.description,
        variables_schema: manifest.variables_schema,
      })
    }
    return result
  }

  render(templateName: string, variables: Record<string, unknown>): RenderableItem[] {
    const cached = this.cache.get(templateName)
    if (!cached) {
      throw new Error(`Unknown template: "${templateName}". Available: ${[...this.cache.keys()].join(', ') || 'none'}`)
    }

    const { manifest, compiledBodies } = cached
    const out: RenderableItem[] = []

    for (const item of manifest.structure) {
      if (item.for_each) {
        const arr = variables[item.for_each]
        if (!Array.isArray(arr)) {
          throw new Error(
            `Template "${templateName}": for_each key "${item.for_each}" is not an array in supplied variables (got ${typeof arr})`
          )
        }
        for (const element of arr) {
          const itemVars = { ...variables, item: element }
          out.push(...this._renderOne(item, itemVars, compiledBodies, templateName))
        }
      } else {
        out.push(...this._renderOne(item, variables, compiledBodies, templateName))
      }
    }

    return out
  }

  renderFile(templateName: string, bodyFile: string, variables: Record<string, unknown>): string {
    const cached = this.cache.get(templateName)
    if (!cached) {
      throw new Error(`Unknown template: "${templateName}"`)
    }
    const compiled = cached.compiledBodies.get(bodyFile)
    if (!compiled) {
      throw new Error(`Template "${templateName}": body file "${bodyFile}" not found or not compiled`)
    }
    return compiled(variables)
  }

  private _renderOne(
    item: ManifestStructureItem,
    variables: Record<string, unknown>,
    compiledBodies: Map<string, Handlebars.TemplateDelegate>,
    templateName: string
  ): RenderableItem[] {
    const title = item.title ? Handlebars.compile(item.title)(variables) : ''
    const due_at = (variables['due_date'] as string) ?? ''

    switch (item.type) {
      case 'SubHeader':
        return [{ kind: 'subheader', title }]

      case 'Page': {
        let body: string | undefined
        if (item.body_file) {
          const compiled = compiledBodies.get(item.body_file)
          if (!compiled) {
            throw new Error(`Template "${templateName}": body_file "${item.body_file}" not compiled`)
          }
          body = compiled(variables)
        }
        return [{ kind: 'page', title, body }]
      }

      case 'Assignment': {
        const rawPoints = item.points
        let points: number
        if (typeof rawPoints === 'number') {
          points = rawPoints
        } else if (typeof rawPoints === 'string') {
          const resolved = Handlebars.compile(rawPoints)(variables)
          points = Number(resolved)
          if (isNaN(points)) points = 0
        } else {
          points = 0
        }
        const submissionTypes = item.submission_types ?? ['online_url']
        return [{ kind: 'assignment', title, points, due_at, submission_types: submissionTypes }]
      }

      case 'Quiz': {
        const rawPoints = item.points
        let points: number
        if (typeof rawPoints === 'number') {
          points = rawPoints
        } else if (typeof rawPoints === 'string') {
          const resolved = Handlebars.compile(rawPoints)(variables)
          points = Number(resolved)
          if (isNaN(points)) points = 0
        } else {
          points = 0
        }
        const questions: QuizQuestionInput[] | undefined = item.questions?.map((q, i) => ({
          question_name: q.question_name ?? `Question ${i + 1}`,
          question_text: q.question_text,
          question_type: q.question_type ?? 'essay_question',
        }))
        return [{
          kind: 'quiz',
          title,
          points,
          due_at,
          quiz_type: item.quiz_type ?? 'assignment',
          time_limit: item.time_limit,
          allowed_attempts: item.allowed_attempts,
          questions,
        }]
      }

      case 'ExternalUrl': {
        const url = item.url ? Handlebars.compile(item.url)(variables) : ''
        return [{ kind: 'external_url', title, url }]
      }

      default:
        return []
    }
  }
}
```

### Step 2 — Create default template files

**Design decision on default templates:** The existing hardcoded templates use runtime logic to switch on item type. The manifests use pre-sorted variable keys (e.g. `coding_assignments`, `reading_pages`) instead of a single `items` array. This requires callers to pre-sort items by type, but allows the manifest to produce faithful output. The `for_each` mechanism handles each array independently.

**`defaults/later-standard/manifest.json`:**
```json
{
  "version": 1,
  "name": "Later Standard Week",
  "description": "Standard lesson module: overview page, coding/reading/regular/manual assignments, and a wrap-up exit card quiz. Pass items pre-sorted by type.",
  "variables_schema": {
    "week": { "type": "number", "required": true },
    "due_date": { "type": "string", "required": true },
    "coding_assignments": { "type": "array", "required": false },
    "download_urls": { "type": "array", "required": false },
    "reading_pages": { "type": "array", "required": false },
    "regular_assignments": { "type": "array", "required": false },
    "manual_assignments": { "type": "array", "required": false }
  },
  "structure": [
    { "type": "SubHeader", "title": "OVERVIEW" },
    { "type": "Page", "title": "Week {{week}} | Overview" },
    { "type": "SubHeader", "title": "ASSIGNMENTS" },
    {
      "for_each": "coding_assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Coding Assignment | {{item.title}} ({{item.hours}} Hours)",
      "submission_types": ["online_url"]
    },
    {
      "for_each": "download_urls",
      "type": "ExternalUrl",
      "title": "DOWNLOAD: Week {{week}} Data Files",
      "url": "{{item.url}}"
    },
    {
      "for_each": "reading_pages",
      "type": "Page",
      "title": "Week {{week}} | Reading & Exercise | {{item.title}} ({{item.hours}} Hour)"
    },
    {
      "for_each": "regular_assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Assignment | {{item.title}} ({{item.mins}} min)",
      "submission_types": ["online_url"]
    },
    {
      "for_each": "manual_assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Manual Assignment | {{item.title}} ({{item.mins}} mins)",
      "submission_types": ["no_submission"]
    },
    { "type": "SubHeader", "title": "WRAP-UP" },
    {
      "type": "Quiz",
      "title": "Week {{week}} | Exit Card (5 mins)",
      "quiz_type": "graded_survey",
      "time_limit": 5,
      "points": 0.5,
      "questions": [
        { "question_name": "Confidence", "question_text": "Rate your confidence this week.", "question_type": "essay_question" },
        { "question_name": "Muddiest Point", "question_text": "What is still unclear?", "question_type": "essay_question" }
      ]
    }
  ]
}
```

**`defaults/later-review/manifest.json`:**
```json
{
  "version": 1,
  "name": "Later Review Week",
  "description": "Review lesson module: overview page, video pages, review assignments, supplemental pages, review quizzes, and a wrap-up exit card quiz.",
  "variables_schema": {
    "week": { "type": "number", "required": true },
    "due_date": { "type": "string", "required": true },
    "video_pages": { "type": "array", "required": false },
    "review_assignments": { "type": "array", "required": false },
    "supplemental_pages": { "type": "array", "required": false },
    "review_quizzes": { "type": "array", "required": false }
  },
  "structure": [
    { "type": "SubHeader", "title": "OVERVIEW" },
    { "type": "Page", "title": "Week {{week}} | Overview" },
    { "type": "SubHeader", "title": "ASSIGNMENTS" },
    {
      "for_each": "video_pages",
      "type": "Page",
      "title": "Week {{week}} | {{item.title}} Video (~{{item.mins}} mins)"
    },
    {
      "for_each": "review_assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Assignment | {{item.title}} ({{item.hours}} hours)",
      "submission_types": ["online_url"]
    },
    {
      "for_each": "supplemental_pages",
      "type": "Page",
      "title": "Week {{week}} | {{item.title}}"
    },
    {
      "for_each": "review_quizzes",
      "type": "Quiz",
      "title": "Week {{week}} | {{item.title}} ({{item.hours}} hour) - Can take {{item.attempts}}x",
      "quiz_type": "assignment"
    },
    { "type": "SubHeader", "title": "WRAP-UP" },
    {
      "type": "Quiz",
      "title": "Week {{week}} | Exit Card (5 mins)",
      "quiz_type": "graded_survey",
      "time_limit": 5,
      "points": 0.5,
      "questions": [
        { "question_name": "Confidence", "question_text": "Rate your confidence this week.", "question_type": "essay_question" },
        { "question_name": "Muddiest Point", "question_text": "What is still unclear?", "question_type": "essay_question" }
      ]
    }
  ]
}
```

**`defaults/earlier-standard/manifest.json`:**
```json
{
  "version": 1,
  "name": "Earlier Standard Week",
  "description": "Earlier-semester standard module: numbered assignments, reminder assignments, optional video pages, and an exit card quiz.",
  "variables_schema": {
    "week": { "type": "number", "required": true },
    "due_date": { "type": "string", "required": true },
    "assignments": { "type": "array", "required": false },
    "video_pages": { "type": "array", "required": false }
  },
  "structure": [
    { "type": "SubHeader", "title": "OVERVIEW" },
    { "type": "Page", "title": "Week {{week}} | Overview" },
    { "type": "SubHeader", "title": "TO-DO" },
    {
      "for_each": "assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Assignment | {{item.verb}}: {{item.description}}",
      "submission_types": ["online_url"]
    },
    {
      "type": "Assignment",
      "title": "Week {{week}} | Reminder | Attend Weekly Discussion",
      "points": 0,
      "submission_types": ["no_submission"]
    },
    {
      "type": "Assignment",
      "title": "Week {{week}} | Reminder | Check In With Your Instructor",
      "points": 0,
      "submission_types": ["no_submission"]
    },
    {
      "for_each": "video_pages",
      "type": "Page",
      "title": "Video {{week}}{{item.letter}} | {{item.title}} (~{{item.mins}} mins)"
    },
    {
      "type": "Quiz",
      "title": "Week {{week}} | Exit Card (5 mins)",
      "quiz_type": "graded_survey",
      "time_limit": 5,
      "points": 0.5,
      "questions": [
        { "question_name": "Confidence", "question_text": "Rate your confidence this week.", "question_type": "essay_question" },
        { "question_name": "Muddiest Point", "question_text": "What is still unclear?", "question_type": "essay_question" }
      ]
    }
  ]
}
```

**`defaults/earlier-review/manifest.json`:**
```json
{
  "version": 1,
  "name": "Earlier Review Week",
  "description": "Earlier-semester review module: numbered review assignments, reminder assignments, and an exit card quiz.",
  "variables_schema": {
    "week": { "type": "number", "required": true },
    "due_date": { "type": "string", "required": true },
    "assignments": { "type": "array", "required": false }
  },
  "structure": [
    { "type": "SubHeader", "title": "OVERVIEW" },
    { "type": "Page", "title": "Week {{week}} | Overview" },
    { "type": "SubHeader", "title": "TO-DO" },
    {
      "for_each": "assignments",
      "type": "Assignment",
      "title": "Week {{week}} | Assignment | {{item.verb}}: {{item.description}}",
      "submission_types": ["online_url"]
    },
    {
      "type": "Assignment",
      "title": "Week {{week}} | Reminder | Attend Weekly Discussion",
      "points": 0,
      "submission_types": ["no_submission"]
    },
    {
      "type": "Assignment",
      "title": "Week {{week}} | Reminder | Check In With Your Instructor",
      "points": 0,
      "submission_types": ["no_submission"]
    },
    {
      "type": "Quiz",
      "title": "Week {{week}} | Exit Card (5 mins)",
      "quiz_type": "graded_survey",
      "time_limit": 5,
      "points": 0.5,
      "questions": [
        { "question_name": "Confidence", "question_text": "Rate your confidence this week.", "question_type": "essay_question" },
        { "question_name": "Muddiest Point", "question_text": "What is still unclear?", "question_type": "essay_question" }
      ]
    }
  ]
}
```

**Note:** No `.hbs` body files are needed for the four default manifests — none of the structure items specify `body_file`. Pages are created with empty bodies by default; teachers add `.hbs` files to their seeded copies.

### Acceptance Test

1. `new TemplateService('/path/to/defaults')` — `list()` returns 4 entries.
2. `render('later-standard', { week: 2, due_date: '2026-03-01T23:59:00Z', coding_assignments: [{ title: 'ML Basics', hours: 3 }], download_urls: [], reading_pages: [], regular_assignments: [], manual_assignments: [] })` — returns 6 items: 2 subheaders, 1 page, 1 assignment, 1 quiz.
3. `render('unknown-template', {})` — throws "Unknown template".
4. Manifest with `body_file: 'missing.hbs'` — skipped at load time (not in `list()` output).
5. `render('later-standard', { ..., coding_assignments: 'not-an-array' })` — throws "not an array".

### Rollback

Delete `packages/core/src/templates/service.ts` and the four `defaults/` subdirectories.

---

## Execution Packet EP-2.2 — Seeding and Server-Startup Wiring

**Depends on:** EP-2.1
**Objective:** Create `seed.ts` and wire `TemplateService` construction into `packages/teacher/src/index.ts`.
**Execution mode:** Tool-Integrated

### Pre-conditions

1. EP-2.1 complete: `service.ts` and `defaults/` exist
2. `packages/teacher/src/index.ts` is at the verified 63-line state

### Step 1 — Additive exports in `packages/core/src/index.ts`

Find (lines 31–32):
```typescript
// template system
export * from './templates/index.js'
```

Replace with:
```typescript
// template system
export * from './templates/index.js'
export { TemplateService } from './templates/service.js'
export { seedDefaultTemplates } from './templates/seed.js'
export type { TemplateDescriptor, TemplateManifest, ManifestStructureItem } from './templates/service.js'
```

This is additive — no removals. EP-2.6 will clean up redundancy later.

### Step 2 — Create `packages/core/src/templates/seed.ts`

```typescript
import { existsSync, readdirSync, cpSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Seeds the user's templates directory with the bundled defaults if it is
 * empty or does not exist. Never overwrites existing files.
 */
export function seedDefaultTemplates(templatesDir: string): void {
  const needsSeed = !existsSync(templatesDir) || readdirSync(templatesDir).length === 0

  if (!needsSeed) return

  const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), 'defaults')

  if (!existsSync(defaultsDir)) {
    process.stderr.write(`[canvas-mcp] Warning: default templates directory not found at ${defaultsDir}\n`)
    return
  }

  mkdirSync(templatesDir, { recursive: true })
  cpSync(defaultsDir, templatesDir, { recursive: true })
  process.stderr.write(`[canvas-mcp] Seeded default templates to ${templatesDir}\n`)
}
```

**Note:** `import.meta.url` resolves to `dist/templates/seed.js` at runtime. The `defaults/` directory must be copied to `dist/templates/defaults/` during build (see Step 4).

### Step 3 — Update `packages/teacher/src/index.ts`

**Add imports at the top (new lines before line 1):**
```typescript
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
```

**Update line 3 (existing core import):**
```typescript
// Old:
import { ConfigManager, CanvasClient, SecureStore, SidecarManager, registerContextTools } from '@canvas-mcp/core'
// New:
import { ConfigManager, CanvasClient, SecureStore, SidecarManager, registerContextTools, TemplateService, seedDefaultTemplates } from '@canvas-mcp/core'
```

**Insert after `const config = configManager.read()` (line 16):**
```typescript
  // 2.2 — Template Service initialization
  const defaultConfigDir = join(homedir(), '.config', 'mcp', 'canvas-mcp')
  const configDir = configPath != null ? dirname(configPath) : defaultConfigDir
  const templatesDir = join(configDir, 'templates')
  seedDefaultTemplates(templatesDir)
  const templateService = new TemplateService(templatesDir)
```

**Update `registerModuleTools` call:**
```typescript
// Old:
  registerModuleTools(server, client, configManager)
// New:
  registerModuleTools(server, client, configManager, templateService)
```

**Update `registerFindTools` call:**
```typescript
// Old:
  registerFindTools(server, client, configManager)
// New:
  registerFindTools(server, client, configManager, templateService)
```

### Step 4 — Update build script in `packages/core/package.json`

Read the current build script, then append the `defaults/` copy step:

```json
"build": "tsc && cp -r src/templates/defaults dist/templates/defaults"
```

(If `cp` is not available in CI, use `node -e "require('fs').cpSync('src/templates/defaults', 'dist/templates/defaults', { recursive: true })"` instead.)

### Acceptance Test

1. Delete `~/.config/mcp/canvas-mcp/templates/` and start the server — four template directories appear.
2. Start again without deleting — no re-seed (only one log line total).
3. `TemplateService` constructed and passed to tool registrations without error.

### Rollback

Revert `packages/teacher/src/index.ts` (63-line version). Revert the three new export lines in `packages/core/src/index.ts`. Delete `seed.ts`. Revert build script.

---

## Execution Packet EP-2.3 — Update `build_module`: `blueprint` and `manual` Modes

**Depends on:** EP-2.2
**Objective:** Refactor `modules.ts` to replace `template='lesson'` with `mode='blueprint'`, add `mode='manual'`, and carry forward `solution`/`clone` verbatim.
**Execution mode:** Tool-Integrated

### Pre-conditions

1. EP-2.2 complete: `TemplateService` exported from `@canvas-mcp/core`, entry point passes `templateService`
2. `modules.ts` is at the verified 505-line state

### Step 1 — Update imports in `modules.ts`

Remove `renderTemplate` from the import block. Add `type TemplateService`:

```typescript
// Remove: renderTemplate,
// Add:    type TemplateService,
```

The import block becomes:
```typescript
import {
  type CanvasClient,
  type ConfigManager,
  type CanvasTeacherConfig,
  type TemplateService,
  createPage,
  getPage,
  createAssignment,
  getAssignment,
  createQuiz,
  createQuizQuestion,
  getQuiz,
  listQuizQuestions,
  createModule,
  updateModule,
  getModule,
  listModuleItems,
  createModuleItem,
  type RenderableItem,
  type QuizQuestionInput,
} from '@canvas-mcp/core'
```

(`Handlebars` import is kept — `executeRenderables` uses it.)

### Step 2 — Update `registerModuleTools` signature

```typescript
// Old:
export function registerModuleTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {

// New:
export function registerModuleTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  templateService: TemplateService
): void {
```

### Step 3 — Replace the `build_module` tool schema and handler

Replace the entire `server.registerTool('build_module', ...)` block (lines 220–504) with:

**Schema:**
```typescript
  server.registerTool(
    'build_module',
    {
      description: [
        'Build a Canvas module using one of four modes:',
        'mode="blueprint" — render a named template with supplied variables.',
        'mode="manual" — create a module from an explicit ordered list of items.',
        'mode="solution" — create a solution module gated on a prerequisite lesson module.',
        'mode="clone" — clone a module from one course into the active (or specified) destination course.',
        'Use list_items(type="templates") to discover available template names and their variable schemas.',
      ].join(' '),
      inputSchema: z.object({
        mode: z.enum(['blueprint', 'manual', 'solution', 'clone'])
          .describe('Module creation mode.'),
        // blueprint
        template_name: z.string().optional()
          .describe('For mode="blueprint": name of the template directory (required).'),
        variables: z.record(z.unknown()).optional()
          .describe('For mode="blueprint": key/value pairs matching the template variables_schema (required).'),
        // manual
        module_name: z.string().optional()
          .describe('For mode="manual": name of the Canvas module to create (required).'),
        items: z.array(z.object({
          kind: z.enum(['subheader', 'page', 'assignment', 'quiz', 'external_url']),
          title: z.string().optional(),
          body: z.string().optional(),
          points: z.number().optional(),
          due_at: z.string().optional(),
          submission_types: z.array(z.string()).optional(),
          description: z.string().optional(),
          url: z.string().optional(),
          quiz_type: z.string().optional(),
          time_limit: z.number().optional(),
          allowed_attempts: z.number().optional(),
          questions: z.array(z.object({
            question_name: z.string(),
            question_text: z.string(),
            question_type: z.string(),
            points_possible: z.number().optional(),
          })).optional(),
        })).optional()
          .describe('For mode="manual": ordered list of items to create in the module (required).'),
        // blueprint + manual shared
        assignment_group_id: z.number().optional()
          .describe('Assignment group ID for all assignments created.'),
        // solution
        title: z.string().optional()
          .describe('For mode="solution": full module title (required). For mode="blueprint": module title override.'),
        lesson_module_id: z.number().optional()
          .describe('For mode="solution": ID of the prerequisite lesson module (required).'),
        unlock_at: z.string().optional()
          .describe('For mode="solution": ISO 8601 date when this module unlocks (required).'),
        solutions: z.array(z.object({ title: z.string(), url: z.string() })).optional()
          .describe('For mode="solution": solution links to add as module items (required).'),
        // clone
        source_module_id: z.number().optional()
          .describe('For mode="clone": Canvas module ID to clone (required).'),
        source_course_id: z.number().optional()
          .describe('For mode="clone": course ID containing the source module (required).'),
        dest_course_id: z.number().optional()
          .describe('For mode="clone": destination course ID. Defaults to active course.'),
        // blueprint + clone shared
        week: z.number().optional()
          .describe('Week number. For blueprint: passed as template variable. For clone: replaces "Week N" in titles.'),
        due_date: z.string().optional()
          .describe('ISO 8601 due date. For blueprint: passed as template variable. For clone: overrides all graded item due dates.'),
        // shared
        publish: z.boolean().optional()
          .describe('Publish the module after creation. Default false.'),
        dry_run: z.boolean().optional()
          .describe('For mode="blueprint" or "solution": preview without creating anything in Canvas.'),
        course_id: z.number().optional()
          .describe('Canvas course ID. Defaults to active course.'),
      }),
    },
```

**Handlers:**
```typescript
    async (args) => {
      // ── blueprint ─────────────────────────────────────────────────────────
      if (args.mode === 'blueprint') {
        const config = configManager.read()
        let courseId: number
        try { courseId = resolveCourseId(config, args.course_id) }
        catch (err) { return toolError((err as Error).message) }

        let renderables: RenderableItem[]
        try {
          const vars: Record<string, unknown> = {
            ...(args.variables ?? {}),
            ...(args.week != null ? { week: args.week } : {}),
            ...(args.due_date != null ? { due_date: args.due_date } : {}),
          }
          renderables = templateService.render(args.template_name!, vars)
        } catch (err) { return toolError(String(err)) }

        if (args.dry_run) return toJson({ items_preview: renderables, dry_run: true })

        const moduleName = args.title
          ? (args.week != null ? `Week ${args.week} | ${args.title}` : args.title)
          : (args.week != null ? `Week ${args.week}` : args.template_name!)
        const mod = await createModule(client, courseId, { name: moduleName })
        const result = await executeRenderables(client, courseId, mod.id, renderables, config, args.assignment_group_id)

        if (result.error) return toJson({ module: { id: mod.id, name: mod.name }, completed_before_failure: result.completed_before_failure, error: result.error })
        if (args.publish) await updateModule(client, courseId, mod.id, { published: true })
        return toJson({ module: { id: mod.id, name: mod.name }, items_created: result.items_created, dry_run: false })
      }

      // ── manual ────────────────────────────────────────────────────────────
      if (args.mode === 'manual') {
        const config = configManager.read()
        let courseId: number
        try { courseId = resolveCourseId(config, args.course_id) }
        catch (err) { return toolError((err as Error).message) }

        const renderables = (args.items ?? []) as RenderableItem[]
        if (args.dry_run) return toJson({ items_preview: renderables, dry_run: true })

        const mod = await createModule(client, courseId, { name: args.module_name! })
        const result = await executeRenderables(client, courseId, mod.id, renderables, config, args.assignment_group_id)

        if (result.error) return toJson({ module: { id: mod.id, name: mod.name }, completed_before_failure: result.completed_before_failure, error: result.error })
        if (args.publish) await updateModule(client, courseId, mod.id, { published: true })
        return toJson({ module: { id: mod.id, name: mod.name }, items_created: result.items_created, dry_run: false })
      }

      // ── solution and clone: copy verbatim from current file ───────────────
      // Replace `args.template` with `args.mode` in the condition checks.
      // All other logic is unchanged from the existing solution/clone branches.
      // [IMPLEMENTER: paste the existing solution branch (lines 323–375) here,
      //  changing `args.template === 'solution'` to `args.mode === 'solution'`]
      // [IMPLEMENTER: paste the existing clone branch (lines 377–503) here,
      //  changing `args.template === 'clone'` to the else branch as the final case]
    }
  )
```

**Note for implementer:** The solution and clone handler code is ~130 lines of working code that must be copied verbatim from the current file. The only change is substituting `args.mode` for `args.template` in the condition check. Read `modules.ts` lines 323–503 and paste them in.

Also remove the `itemSchema` constant (lines 193–211) — it was used only by the old `lesson` mode schema.

### Acceptance Test

1. `npm run test:unit -- --testPathPattern modules` — `solution` and `clone` tests pass.
2. `build_module({ mode: 'blueprint', template_name: 'later-standard', variables: {...}, dry_run: true })` — returns `{ dry_run: true, items_preview: [...] }`.
3. Unknown `template_name` — response text contains "Unknown template".
4. `build_module({ mode: 'manual', module_name: 'Custom', items: [...] })` — module created.

### Rollback

`git checkout packages/teacher/src/tools/modules.ts`

---

## Execution Packet EP-2.4 — Update `create_item`: `template_name` / `template_data` Fields

**Depends on:** EP-2.2
**Objective:** Add `template_name` and `template_data` to `createItemSchema` and wire `renderFile()` into the page handler.
**Execution mode:** Tool-Integrated

### Pre-conditions

1. EP-2.2 complete: `TemplateService` exported from `@canvas-mcp/core`
2. `find.ts` is at the verified 1073-line state

### Step 1 — Add `TemplateService` to `find.ts` imports

Add `type TemplateService` to the `@canvas-mcp/core` import block.

### Step 2 — Update `registerFindTools` signature

```typescript
export function registerFindTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  templateService: TemplateService
): void {
```

### Step 3 — Add fields to `createItemSchema`

After the `body` field (around line 168–169), insert:
```typescript
  template_name: z.string().optional()
    .describe('For type="page": name of a template in the config templates directory. Mutually exclusive with body. The template must contain a "page.hbs" file.'),
  template_data: z.record(z.unknown()).optional()
    .describe('For type="page" with template_name: variables to pass to the template renderer.'),
```

### Step 4 — Update the `type='page'` handler

**Current (lines 652–662):**
```typescript
      if (args.type === 'page') {
        if (args.dry_run) {
          return toJson({ dry_run: true, type: 'page', preview: { title: args.title!, body: args.body, published: args.published ?? false } })
        }
        const page = await createPage(client, courseId, {
          title: args.title!,
          body: args.body,
          published: args.published ?? false,
        })
        return toJson({ id: page.page_id, url: page.url, title: page.title, published: page.published })
      }
```

**Replace with:**
```typescript
      if (args.type === 'page') {
        if (args.template_name != null && args.body != null) {
          return toolError('template_name and body are mutually exclusive for type="page". Provide one or the other.')
        }

        let pageBody: string | undefined = args.body
        if (args.template_name != null) {
          try {
            pageBody = templateService.renderFile(args.template_name, 'page.hbs', args.template_data ?? {})
          } catch (err) {
            return toolError(`Template render error: ${String(err)}`)
          }
        }

        if (args.dry_run) {
          return toJson({ dry_run: true, type: 'page', preview: { title: args.title!, body: pageBody, published: args.published ?? false } })
        }
        const page = await createPage(client, courseId, {
          title: args.title!,
          body: pageBody,
          published: args.published ?? false,
        })
        return toJson({ id: page.page_id, url: page.url, title: page.title, published: page.published })
      }
```

### Acceptance Test

1. `create_item({ type: 'page', title: 'Test', template_name: 'x', body: '<p>hi</p>' })` → toolError "mutually exclusive".
2. `create_item({ type: 'page', title: 'Test', template_name: 'nonexistent', template_data: {} })` → toolError "Unknown template".
3. All existing `create_item` tests pass.

### Rollback

`git checkout packages/teacher/src/tools/find.ts`

---

## Execution Packet EP-2.5 — Update `list_items`: `type='templates'`

**Depends on:** EP-2.4 (both modify `find.ts` — run sequentially)
**Objective:** Add `'templates'` to `listItemsSchema` and handle it before `resolveCourseId`.
**Execution mode:** Tool-Integrated

### Pre-conditions

EP-2.4 complete: `find.ts` has `TemplateService` in its signature and imports.

### Step 1 — Update `listItemsSchema` enum

Change the 9-value enum to 10 values by appending `'templates'`:
```typescript
type: z.enum(['modules', 'assignments', 'quizzes', 'pages', 'discussions', 'announcements', 'rubrics', 'assignment_groups', 'module_items', 'templates'])
  .describe('Content type to list. "templates" returns local template descriptors (no active course required).'),
```

### Step 2 — Update `list_items` description string

Update to mention 10 types and the templates case.

### Step 3 — Add `templates` short-circuit before `resolveCourseId`

In the `list_items` handler, insert before line 866:
```typescript
      // Short-circuit for local-only types (no active course required)
      if (args.type === 'templates') {
        return toJson(templateService.list())
      }
```

### Acceptance Test

1. `list_items({ type: 'templates' })` with no active course → returns array, no "No active course" error.
2. `list_items({ type: 'modules' })` without active course → still returns toolError.
3. All existing `list_items` tests pass.

### Rollback

`git checkout packages/teacher/src/tools/find.ts`

---

## Execution Packet EP-2.6 — Remove Hardcoded Logic, Update Core Exports

**Depends on:** EP-2.3, EP-2.4, EP-2.5
**Objective:** Replace `packages/core/src/templates/index.ts` with re-exports from `service.ts`, removing all hardcoded template logic.
**Execution mode:** Tool-Integrated

### Pre-conditions

**Verification gate before executing:**
```bash
grep -r "renderTemplate\|validateItems\|TemplateItemInput\|ACCEPTED_TYPES" packages/teacher/src/
```
Must return zero results. If any remain, fix the consuming file first.

### Step 1 — Replace `packages/core/src/templates/index.ts`

Replace the entire 305-line file with:
```typescript
// Re-export types and classes from the TemplateService implementation.
export type { RenderableItem, QuizQuestionInput } from './service.js'
export { TemplateService } from './service.js'
export type {
  TemplateManifest,
  TemplateDescriptor,
  ManifestStructureItem,
} from './service.js'
```

### Step 2 — Clean up redundant exports in `packages/core/src/index.ts`

Remove the three lines added in EP-2.2 Step 1 (they are now redundant via `export *`):
```typescript
// Remove:
export { TemplateService } from './templates/service.js'
export type { TemplateDescriptor, TemplateManifest, ManifestStructureItem } from './templates/service.js'
```

Keep:
```typescript
export * from './templates/index.js'
export { seedDefaultTemplates } from './templates/seed.js'
```

(`seedDefaultTemplates` must remain explicit since it's in `seed.ts`, not `index.ts`.)

### Acceptance Test

1. `npm run build` completes without TypeScript errors.
2. `@canvas-mcp/core` exports: `RenderableItem` ✓, `QuizQuestionInput` ✓, `TemplateService` ✓, `TemplateDescriptor` ✓, `seedDefaultTemplates` ✓.
3. `renderTemplate`, `TemplateItemInput`, `validateItems` — TypeScript error if any consumer imports them.
4. `npm run test:unit` passes all tests.

### Rollback

`git checkout packages/core/src/templates/index.ts packages/core/src/index.ts` — but this will cause TypeScript errors in `modules.ts` and `find.ts` since they no longer import the old symbols. Full rollback requires reverting EPs 2.3–2.5 as well.

---

## Unit Test Files

### New: `packages/core/tests/unit/templates/service.test.ts`

(Create this file after EP-2.1 is complete. It lives at `packages/core/tests/unit/templates/service.test.ts` and is picked up by the core vitest config established in Module 1.)

The test file covers:
- `list()` with valid manifests, invalid JSON, unsupported version, missing `body_file`, empty directory
- `render()` simple structure, unknown template, `for_each` with 0/1/3 items, `for_each` non-array error, `body_file` rendering
- `renderFile()` known file, unknown template, unknown body file

Full test code is included in the Tactician's output above (see "Unit Test Updates → New: service.test.ts").

### Modified: `packages/teacher/tests/unit/tools/modules.test.ts`

- Add `makeMockTemplateService()` helper and pass to `registerModuleTools` in `makeTestClient`
- Replace `template='lesson'` tests with `mode='blueprint'` equivalents
- Add `mode='manual'` test
- Rename `template=` to `mode=` in `solution` and `clone` tests

### Modified: `packages/teacher/tests/unit/tools/find.test.ts`

- Add `templateService` mock to `registerFindTools` call in `makeTestClient`
- Add `list_items(type='templates')` test (no active course required)
- Add `create_item(type='page', template_name=...)` tests (success + mutual exclusivity)

---

## Execution Ordering Summary

```
EP-2.1  (service.ts + defaults/)
  └─► EP-2.2  (seed.ts + index.ts wiring + additive core exports)
        ├─► EP-2.3  (modules.ts — blueprint/manual)      [independent of 2.4/2.5]
        └─► EP-2.4  (find.ts — create_item template)
              └─► EP-2.5  (find.ts — list_items templates)
                    └─► EP-2.6  (index.ts — remove old exports)
```

## Execution Packet Summary

| Packet | Depends on | Objective | Mode |
|---|---|---|---|
| EP-2.1 | None | Create `TemplateService` + default manifests | Tool-Integrated |
| EP-2.2 | EP-2.1 | Create `seed.ts`, wire into `index.ts` | Tool-Integrated |
| EP-2.3 | EP-2.2 | Update `build_module`: blueprint + manual modes | Tool-Integrated |
| EP-2.4 | EP-2.2 | Update `create_item`: template_name/template_data | Tool-Integrated |
| EP-2.5 | EP-2.4 | Update `list_items`: type='templates' | Tool-Integrated |
| EP-2.6 | EP-2.3 + EP-2.4 + EP-2.5 | Remove hardcoded logic, clean up exports | Tool-Integrated |

**6 of 6 packets are Tool-Integrated (100%).** Suitable for automated dispatch.

---

## Known Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `import.meta.url` in `seed.ts` resolves incorrectly | Build script copies `defaults/` to `dist/templates/defaults/` adjacent to compiled `seed.js` |
| `for_each` key missing from variables | Pre-flight error thrown before Canvas calls; callers must pass empty arrays for unused keys |
| `registerModuleTools` called without 4th arg in tests | `modules.test.ts` `makeTestClient` must be updated in same PR as EP-2.3 |
| `quiz` points default differs from config-driven exit card | Blueprint mode exit cards have hardcoded points in manifest (not config-driven). Documented trade-off. |
| `solution` and `clone` code verbatim copy | Read lines 323–503 of current `modules.ts` during EP-2.3 execution to get exact current code |

---

## Critical Files for Implementation

| File | Role |
|---|---|
| `packages/core/src/templates/service.ts` | New: core `TemplateService` class |
| `packages/core/src/templates/seed.ts` | New: seeding function |
| `packages/core/src/templates/defaults/*/manifest.json` | New: 4 default manifests |
| `packages/teacher/src/tools/modules.ts` | Modified: `build_module` schema + blueprint/manual handlers |
| `packages/teacher/src/tools/find.ts` | Modified: `create_item` + `list_items` |
| `packages/teacher/src/index.ts` | Modified: startup wiring |
| `packages/core/src/templates/index.ts` | Modified last: gutted + re-exports (EP-2.6) |
| `packages/core/src/index.ts` | Modified twice: additive in EP-2.2, cleaned up in EP-2.6 |
