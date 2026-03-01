# canvas-teacher-mcp

A teacher-facing [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that wraps the Canvas LMS REST API. Designed for an instructor who wants to use an AI assistant (e.g., Claude) to create and manage course content across multiple Canvas courses.

> **Note:** In its current state, this server is tailored to the workflows and course structure of a particular school and program. The underlying Canvas API integration is general-purpose, but some defaults, templates, and naming conventions reflect that specific instructional context. Generalizing these is planned.

## What it does

Connect this server to Claude Desktop and ask it to:

- Switch between your courses (`"switch to my algorithms course"`)
- List your courses and see which one is active
- List modules, get grade summaries, report on missing and late assignments
- Create assignments, quizzes, pages, discussions, announcements, and files
- Create and associate rubrics with assignments
- Scaffold a full week's module from a template in one call
- Reset a sandbox course with a confirmation gate

## Requirements

- Node.js 20+
- A Canvas LMS account with teacher-level access to at least one course
- A Canvas API token (Profile → Settings → New Access Token)

## Installation

```bash
git clone https://github.com/you/canvas-teacher-mcp
cd canvas-teacher-mcp
npm install
npm run build
```

## Configuration

The server reads `~/.canvas-teacher-mcp/config.json` on startup. Create this file before connecting to Claude:

```json
{
  "canvas": {
    "instanceUrl": "https://your-institution.instructure.com",
    "apiToken": "YOUR_CANVAS_API_TOKEN"
  },
  "program": {
    "activeCourseId": null,
    "courseCodes": ["ENG101", "ENG102"],
    "courseCache": {}
  },
  "defaults": {
    "assignmentGroup": "Assignments",
    "submissionType": "online_url",
    "pointsPossible": 100
  }
}
```

**`canvas.instanceUrl`** and **`canvas.apiToken`** are required — the server exits immediately with a clear error if either is missing.

**`program.courseCodes`** is optional but recommended. When set, `list_courses` filters to only show courses whose code contains one of these strings (e.g., `"ENG101"` matches `"ENG101-003"`). Set it once to your program's course codes so the tool list stays tidy. Leave it empty to show all your teacher-enrolled courses.

**`program.activeCourseId`** and **`program.courseCache`** are managed automatically by `set_active_course` — do not hand-edit them.

## Claude Desktop integration

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "canvas-teacher-mcp": {
      "command": "node",
      "args": ["/path/to/canvas-teacher-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The server will appear under Connected MCP Servers.

## Tools

### Course context

| Tool | Description |
|------|-------------|
| `list_courses` | List your Canvas courses. Filters to `program.courseCodes` by default; pass `all: true` to see everything. |
| `set_active_course` | Set the active course by fuzzy-matching a query string (e.g. `"ENG101"`, `"english spring"`). |
| `get_active_course` | Returns the currently active course from local config. No Canvas API call. |

### Reporting

| Tool | Description |
|------|-------------|
| `list_modules` | List all modules in the active course. |
| `get_module_summary` | Full structure of a module: item types, titles, points, due dates. |
| `list_assignment_groups` | List all assignment groups in the active course. |
| `get_class_grade_summary` | Every student's current score, missing count, late count. Supports `sort_by: "engagement"` to surface most-at-risk students first. |
| `get_assignment_breakdown` | Per-student submission status and score for a single assignment. |
| `get_student_report` | Deep report for a single student — all assignments with scores and missing/late flags. |
| `get_missing_assignments` | All missing assignments grouped by student. |
| `get_late_assignments` | All late assignments grouped by student. |

### Content creation (low-level)

| Tool | Description |
|------|-------------|
| `create_assignment` | Create a graded assignment. Supports Handlebars description templates for Colab notebook URLs. |
| `update_assignment` | Update assignment settings. |
| `delete_assignment` | Permanently delete an assignment. Pre-deletes any associated rubric first. |
| `create_quiz` | Create a Classic Quiz or graded survey. Supports exit card question templates. |
| `update_quiz` | Update quiz settings. |
| `delete_quiz` | Permanently delete a Classic Quiz. |
| `create_page` | Create a wiki page. |
| `delete_page` | Delete a wiki page. Refuses to delete the front page without explicit reassignment. |
| `create_discussion` | Create a discussion topic. |
| `create_announcement` | Create an announcement (auto-published). |
| `delete_discussion` | Permanently delete a discussion topic. |
| `delete_announcement` | Permanently delete an announcement. |
| `upload_file` | Upload a local file to the course Files section via Canvas's 3-step upload protocol. |
| `delete_file` | Permanently delete a file. Irreversible — no recycle bin via API. |
| `create_rubric` | Create a rubric and associate it with an assignment. See rubric notes below. |
| `associate_rubric` | Associate an existing rubric with a different assignment. |
| `update_syllabus` | Set or replace the course syllabus body. |
| `clear_syllabus` | Clear the syllabus body (set to empty). |

### Module items (low-level)

| Tool | Description |
|------|-------------|
| `add_module_item` | Add a single item to an existing module. |
| `update_module_item` | Update a module item's position, title, or completion requirement. |
| `remove_module_item` | Remove an item from a module (does not delete the underlying content). |
| `update_module` | Update module settings (name, lock date, prerequisites, published state). |
| `delete_module` | Delete a module and its items. Does not delete underlying assignments/pages/quizzes. |

### Module creation (high-level)

| Tool | Description |
|------|-------------|
| `create_lesson_module` | Create a full lesson module from a named template in one call. Creates module, all content items, and completion requirements. |
| `create_solution_module` | Create a solution module linked to a lesson module. Sets unlock date and prerequisite. |
| `clone_module` | Copy a module from any course into the active course, with optional week number substitution. |

### Destructive operations

| Tool | Description |
|------|-------------|
| `preview_course_reset` | Dry run — list all content that would be deleted by `reset_course`. Does not modify anything. |
| `reset_course` | Permanently delete all content from a course. Requires `confirmation_text` to exactly match the course name. See safety notes below. |

---

## Canvas API notes

- **Pagination** is handled automatically — all list operations follow `Link: rel="next"` headers.
- **Rate limiting** — the client watches `X-Rate-Limit-Remaining` and adds a 500ms delay when it drops below 10.
- **Retries** — HTTP 429 responses trigger exponential backoff, up to 3 attempts.
- **Classic Quizzes only** — New Quizzes (Canvas Quiz Engine) has a different API and is out of scope.
- **Quiz creation returns 200**, not 201 — a known Canvas API quirk the client handles correctly.

### Rubrics require an assignment (Canvas limitation)

Canvas does not support standalone rubrics. A rubric **must** be associated with at least one assignment, or it enters a broken "zombie" state: it appears in the course rubric list but returns `404` on individual GET and `500` on DELETE.

To prevent this, `create_rubric` always requires an `assignment_id` and creates the rubric and its association in a single API call. You cannot create a rubric without linking it to an assignment.

During `reset_course`, the rubric cleanup step (step 8) handles any pre-existing zombie rubrics (e.g., created manually via the Canvas UI) by creating a temporary assignment, associating the zombie rubric with it, deleting the rubric (now deletable), and then deleting the temp assignment. Rubrics that cannot be recovered are reported in the response under `rubrics_failed`.

### `reset_course` safety protocol

1. Always call `preview_course_reset` first and show the output to the user.
2. The tool requires `confirmation_text` to exactly match the Canvas course name (case-sensitive).
3. Enrollments, course settings, and navigation tabs are never touched.
4. The front page is automatically unset before page deletion.
5. File deletion is irreversible — the preview shows file counts explicitly.

---

## Development

### Running tests

```bash
# Unit tests (no credentials required)
npm test

# Integration tests (requires .env.test — see below)
npm run test:integration
```

Unit tests mock all HTTP with [msw](https://mswjs.io/). Integration tests run against a real Canvas instance.

### Setting up integration tests

Create `.env.test` in the project root:

```
CANVAS_INSTANCE_URL=https://canvas.instructure.com
CANVAS_API_TOKEN=your_test_teacher_token
CANVAS_TEST_COURSE_ID=12345
```

Use a free [canvas.instructure.com](https://canvas.instructure.com) account with a course named `TEST SANDBOX` — keep it completely separate from your production courses.

### Build

```bash
npm run build   # compiles src/ → dist/
npm start       # runs dist/index.js
```

### Project structure

```
src/
├── index.ts              # MCP server entry point
├── canvas/
│   ├── client.ts         # HTTP client (auth, pagination, rate limiting, retry)
│   ├── courses.ts        # Course & enrollment API calls
│   ├── modules.ts        # Module & module item API calls
│   ├── assignments.ts    # Assignment & assignment-group API calls
│   ├── quizzes.ts        # Classic Quiz API calls
│   ├── pages.ts          # Page API calls (CRUD + front page handling)
│   ├── discussions.ts    # Discussion topic & announcement API calls
│   ├── files.ts          # File upload (3-step Canvas/S3 flow) & delete
│   └── rubrics.ts        # Rubric CRUD + association API calls
├── config/
│   ├── schema.ts         # Config types and DEFAULT_CONFIG
│   └── manager.ts        # Read/write ~/.canvas-teacher-mcp/config.json
├── templates/
│   └── index.ts          # Module template renderer (Handlebars)
└── tools/
    ├── context.ts        # list_courses, set_active_course, get_active_course
    ├── content.ts        # Low-level CRUD tools
    ├── modules.ts        # High-level module creation tools
    ├── reporting.ts      # Grade & submission reporting tools
    └── reset.ts          # preview_course_reset, reset_course
tests/
├── unit/                 # Vitest + msw, no credentials required (148 tests)
└── integration/          # Real Canvas API, requires .env.test
```

## Roadmap

| Phase | Status | Contents |
|---|---|---|
| 1 — Foundation | Complete | `list_courses`, `set_active_course`, `get_active_course`, Canvas client, config manager |
| 2 — Reporting | Complete | `list_modules`, `get_module_summary`, grade summaries, missing/late assignment reports |
| 3 — Low-level creation | Complete | `create_assignment`, `create_quiz`, module item CRUD, Handlebars description templates |
| 4 — High-level creation | Complete | `create_lesson_module`, `create_solution_module`, `clone_module`, template system |
| 5 — Destructive ops | Complete | `preview_course_reset`, `reset_course` with confirmation gate |
| 5b — Complete reset | Complete | Full content sweep: discussions, announcements, files, rubrics, assignment groups, syllabus |
| 5b+ — Creation tools | Complete | `create_discussion`, `create_announcement`, `upload_file`, `create_rubric`, `associate_rubric`, `update_syllabus`; rubric zombie recovery in `reset_course` |
| 6 — FERPA PII blinding | Planned | Opt-in blinding layer for student names/IDs in reporting tools |
