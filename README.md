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

- Node.js 20+ ([nodejs.org](https://nodejs.org))
- Git ([git-scm.com](https://git-scm.com))
- A Canvas LMS account with teacher-level access to at least one course
- A Canvas API token (Profile → Settings → New Access Token)
- Claude Desktop ([claude.ai/download](https://claude.ai/download))

## Step-by-step setup (first time)

These instructions assume no prior developer experience. Follow each step in order.

### 1. Install Node.js

Go to [nodejs.org](https://nodejs.org) and download the **LTS** version (the left-hand button). Run the installer and accept all defaults. To confirm it worked, open Terminal (macOS: press ⌘+Space, type "Terminal") and run:

```
node --version
```

You should see something like `v22.0.0`. Any version 20 or higher is fine.

### 2. Install Git

On macOS, Git is often already installed. Run `git --version` in Terminal to check. If you see a version number, skip to step 3. If not, download Git from [git-scm.com](https://git-scm.com) and install it.

### 3. Download the project

In Terminal, run:

```bash
git clone https://github.com/you/canvas-teacher-mcp
cd canvas-teacher-mcp
```

This creates a folder called `canvas-teacher-mcp` in your home directory and places you inside it.

### 4. Install dependencies and build

Still in Terminal, inside the `canvas-teacher-mcp` folder:

```bash
npm install
npm run build
```

`npm install` downloads the required packages (~1 minute, requires internet). `npm run build` compiles the TypeScript source to runnable JavaScript in the `dist/` folder. You should see no errors.

### 5. Get your Canvas API token

1. Log in to your institution's Canvas (e.g., `https://yourschool.instructure.com`)
2. Click your profile picture → **Account** → **Settings**
3. Scroll down to **Approved Integrations** and click **New Access Token**
4. Give it a name (e.g., "Claude MCP") and set an expiration date
5. Click **Generate Token** and copy the token — you won't see it again

### 6. Create the configuration file

Create the directory and file the server reads on startup. In Terminal:

**macOS/Linux:**
```bash
mkdir -p ~/.canvas-teacher-mcp
```

Then open a text editor and create the file `~/.canvas-teacher-mcp/config.json` with this content (substitute your real values):

```json
{
  "canvas": {
    "instanceUrl": "https://yourschool.instructure.com",
    "apiToken": "YOUR_CANVAS_API_TOKEN_HERE"
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

Replace `yourschool.instructure.com` with your school's Canvas domain and `YOUR_CANVAS_API_TOKEN_HERE` with the token from step 5. Update `courseCodes` to your actual course codes (or leave the array empty to see all your courses).

**`canvas.instanceUrl`** and **`canvas.apiToken`** are required — the server exits immediately with a clear error if either is missing.

**`program.courseCodes`** filters `list_courses` to show only matching courses (e.g., `"ENG101"` matches `"ENG101-003"`). Leave it empty (`[]`) to see all teacher-enrolled courses.

**`program.activeCourseId`** and **`program.courseCache`** are managed automatically by `set_active_course` — do not hand-edit them.

### 7. Connect to Claude Desktop

1. Download and install [Claude Desktop](https://claude.ai/download) if you haven't already
2. Open Finder (macOS) and press ⌘+Shift+G, then paste:
   `~/Library/Application Support/Claude/`
3. Open (or create) the file `claude_desktop_config.json` in a text editor
4. Add the following, replacing `/path/to/canvas-teacher-mcp` with the actual path to the folder you cloned in step 3 (e.g., `/Users/yourname/canvas-teacher-mcp`):

```json
{
  "mcpServers": {
    "canvas-teacher-mcp": {
      "command": "node",
      "args": ["--secure-heap=65536", "/path/to/canvas-teacher-mcp/dist/index.js"]
    }
  }
}
```

5. Save the file and **restart Claude Desktop** (quit completely and reopen)
6. Look for a hammer icon (🔨) in the Claude Desktop chat window — this confirms MCP tools are connected. Click it to see the tool list.

If Claude Desktop was already open with other MCP servers configured, merge the `"canvas-teacher-mcp"` entry into your existing `"mcpServers"` object rather than replacing it.

### 8. Start using it

In a Claude Desktop chat, try:

> "List my Canvas courses"

Claude will call `list_courses` and show your courses. Then set the active course:

> "Switch to my ENG101 course"

---

## Configuration reference

The server reads `~/.canvas-teacher-mcp/config.json` on startup. See the full schema in [PLANNING.md](PLANNING.md#3-configuration-schema). The key fields are listed in step 6 above.

## Other AI assistants

The server works with any MCP-compatible AI client, not just Claude Desktop. The `~/.canvas-teacher-mcp/config.json` file is shared across all clients — you only configure it once.

### Claude Code (the `claude` CLI)

Add the server to your user-level MCP config with a single command:

```bash
claude mcp add canvas-teacher-mcp -- node --secure-heap=65536 /path/to/canvas-teacher-mcp/dist/index.js
```

Replace `/path/to/canvas-teacher-mcp` with the actual folder path from step 3. This writes to `~/.claude.json` (user scope) and makes the server available in all Claude Code sessions.

To add it to a specific project only (so it isn't available globally), run the command from inside that project's folder and add `--scope project`:

```bash
claude mcp add --scope project canvas-teacher-mcp -- node --secure-heap=65536 /path/to/canvas-teacher-mcp/dist/index.js
```

Verify the server was added:

```bash
claude mcp list
```

### Gemini CLI (Google's `gemini` CLI)

Edit `~/.gemini/settings.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "canvas-teacher-mcp": {
      "command": "node",
      "args": ["--secure-heap=65536", "/path/to/canvas-teacher-mcp/dist/index.js"]
    }
  }
}
```

If you have other servers already configured, add the `"canvas-teacher-mcp"` entry inside the existing `"mcpServers"` object. Restart Gemini CLI after saving.

To limit the server to a single project instead of all sessions, place the same JSON in `.gemini/settings.json` inside that project's folder.

### Codex CLI (OpenAI's `codex` CLI)

Edit `~/.codex/config.toml` (create it if it doesn't exist):

```toml
[mcp_servers.canvas-teacher-mcp]
command = "node"
args = ["--secure-heap=65536", "/path/to/canvas-teacher-mcp/dist/index.js"]
```

To limit it to a single project, place the same TOML in `.codex/config.toml` inside that project's folder (the project must be trusted).

## Tools

### Course context

| Tool | Description |
|------|-------------|
| `list_courses` | List your Canvas courses. Filters to `program.courseCodes` by default; pass `all: true` to see everything. |
| `set_active_course` | Set the active course by fuzzy-matching a query string (e.g. `"ENG101"`, `"english spring"`). |
| `get_active_course` | Returns the currently active course from local config. No Canvas API call. |

### Reporting

Student names and Canvas IDs in reporting tool responses are automatically replaced with session tokens (`[STUDENT_001]`, `[STUDENT_002]`, …) before they reach the AI. See [Privacy](#privacy--ferpa) below.

| Tool | Description |
|------|-------------|
| `list_modules` | List all modules in the active course. |
| `get_module_summary` | Full structure of a module: item types, titles, points, due dates. |
| `list_assignment_groups` | List all assignment groups in the active course. |
| `get_class_grade_summary` | Every student's current score, missing count, late count. Student names replaced with session tokens. Supports `sort_by: "engagement"` to surface most-at-risk students first. |
| `get_assignment_breakdown` | Per-student submission status and score for a single assignment. Student names replaced with session tokens. |
| `get_student_report` | Deep report for a single student — all assignments with scores and missing/late flags. Input: `student_token` (e.g. `"[STUDENT_003]"`) from a prior reporting call. |
| `get_missing_assignments` | All missing assignments grouped by student. Student names replaced with session tokens. |
| `get_late_assignments` | All late assignments grouped by student. Student names replaced with session tokens. |
| `resolve_student` | Look up the real name and Canvas ID for a session token. Response is shown to you only — not passed to the AI. |
| `list_blinded_students` | List all session tokens registered so far in the current session. No names included. |

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

## Privacy / FERPA

Student names and Canvas numeric IDs are FERPA-protected PII. When this server is used with Claude Desktop (cloud-hosted AI), every tool response passes through Anthropic's infrastructure. To prevent student data from leaving your machine, all reporting tools automatically replace student identity information with opaque session tokens before the response reaches the AI:

- `[STUDENT_001]`, `[STUDENT_002]`, … are assigned in the order students are first seen, and reset on every server restart.
- The AI reasons about tokens only — it never sees real names or Canvas IDs.
- A human-readable lookup table (`[STUDENT_001] → Jane Smith`) is shown **to you** in the Claude Desktop UI alongside the AI's response, so you always know who's who without needing to ask.
- To explicitly look up a token, call `resolve_student` — the result is shown to you only, not added to the AI's context.
- Blinding is always on and cannot be disabled.

The session key used to protect the in-memory token map is:
- Freshly generated at startup (never stored to disk)
- Pinned in RAM via `mlock` where the OS permits (prevents swap-file exposure)
- Zeroed on process exit (`SIGINT`, `SIGTERM`, `SIGHUP`)

The `--secure-heap=65536` flag in the Claude Desktop config allocates a locked memory region for cryptographic operation intermediates. Include it in your config as shown in the [setup guide](#7-connect-to-claude-desktop).

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
├── security/
│   └── secure-store.ts   # AES-256-GCM in-memory PII store (session tokens, mlock)
├── templates/
│   └── index.ts          # Module template renderer (Handlebars)
└── tools/
    ├── context.ts        # list_courses, set_active_course, get_active_course
    ├── content.ts        # Low-level CRUD tools
    ├── modules.ts        # High-level module creation tools
    ├── reporting.ts      # Grade & submission reporting tools (with PII blinding)
    └── reset.ts          # preview_course_reset, reset_course
tests/
├── unit/                 # Vitest + msw, no credentials required (183 tests)
└── integration/          # Real Canvas API, requires .env.test (72 tests)
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
| 6 — FERPA PII blinding | Complete | Always-on blinding of student names/IDs in all reporting tools; session tokens; `resolve_student`, `list_blinded_students` |
