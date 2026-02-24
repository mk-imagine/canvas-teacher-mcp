# canvas-teacher-mcp

A teacher-facing [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that wraps the Canvas LMS REST API. Designed for an instructor who wants to use an AI assistant (e.g., Claude) to create and manage course content across multiple Canvas courses.

> **Note:** In its current state, this server is tailored to the workflows and course structure of a particular school and program. The underlying Canvas API integration is general-purpose, but some defaults, templates, and naming conventions (Phases 3–4) reflect that specific context. Generalizing these is planned.

## What it does

Connect this server to Claude Desktop and ask it to:

- Switch between your courses (`"switch to my algorithms course"`)
- List your courses and see which one is active
- *(Phase 2+)* List modules, get grade summaries, report on missing assignments
- *(Phase 3+)* Create assignments, quizzes, and module items
- *(Phase 4+)* Scaffold a full week's module from a template in one call
- *(Phase 5+)* Reset a sandbox course with a confirmation gate

**Currently implemented:** Phase 1 — course context tools (`list_courses`, `set_active_course`, `get_active_course`), Canvas API client with pagination/retry, and config management.

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

### `list_courses`

List your Canvas courses. Filters to `program.courseCodes` by default; pass `all: true` to see everything.

**Input:** `{ all?: boolean }`

**Output:** JSON array of `{ id, courseCode, name, term, isActive }`

---

### `set_active_course`

Set the active course by fuzzy-matching a query string against course code, name, and term. The server fetches your live Canvas course list, scores each course by how many query tokens it matches, and selects the top scorer if it's unambiguous.

**Input:** `{ query: string }` — e.g. `"ENG101"`, `"english spring"`, `"intro writing"`

**Resolution behavior:**
- One clear winner → sets `activeCourseId`, caches course info, confirms
- Tie at the top score → returns disambiguation list, does not set active
- No matches → returns your filtered course list so you can pick

**Output:** Confirmation with course name, code, term, and Canvas ID

---

### `get_active_course`

Returns the currently active course from local config. No Canvas API call.

**Input:** `{}`

**Output:** `{ activeCourseId, courseCode, name, term }` — or a guidance message if no active course is set

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
│   └── courses.ts        # Course API calls
├── config/
│   ├── schema.ts         # Config types and DEFAULT_CONFIG
│   └── manager.ts        # Read/write ~/.canvas-teacher-mcp/config.json
└── tools/
    └── context.ts        # list_courses, set_active_course, get_active_course
tests/
├── unit/                 # Vitest + msw, no credentials required
└── integration/          # Real Canvas API, requires .env.test
```

## Canvas API notes

- **Pagination** is handled automatically — all list operations follow `Link: rel="next"` headers.
- **Rate limiting** — the client watches `X-Rate-Limit-Remaining` and adds a 500ms delay when it drops below 10.
- **Retries** — HTTP 429 responses trigger exponential backoff, up to 3 attempts.
- **Classic Quizzes only** — New Quizzes (Canvas Quiz Engine) has a different API and is out of scope.
- **Quiz creation returns 200**, not 201 — a known Canvas API quirk the client handles correctly.

## Roadmap

| Phase | Status | Contents |
|---|---|---|
| 1 — Foundation | Complete | `list_courses`, `set_active_course`, `get_active_course`, Canvas client, config manager |
| 2 — Reporting | Planned | `list_modules`, `get_module_summary`, grade summaries, missing/late assignment reports |
| 3 — Low-level creation | Planned | `create_assignment`, `create_quiz`, module item CRUD, Handlebars description templates |
| 4 — High-level creation | Planned | `create_lesson_module`, `create_solution_module`, `clone_module`, template system |
| 5 — Destructive ops | Planned | `preview_course_reset`, `reset_course_sandbox` (with confirmation gate) |
