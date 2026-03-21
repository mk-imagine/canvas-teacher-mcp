# canvas-mcp

A teacher-facing [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that wraps the Canvas LMS REST API. Designed for an instructor who wants to use an AI assistant (e.g., Claude) to create and manage course content across multiple Canvas courses.

**Security & Privacy:** When installed correctly (following the [step-by-step setup](#step-by-step-setup-first-time)), this MCP server automatically blinds Personally Identifiable Information (PII) from the AI assistant and provides robust security for your data in compliance with FERPA and institutional policies (including UC/CSU). See [FERPA.md](docs/FERPA.md) and [SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md) for details.

> **Note:** The Canvas API integration is general-purpose. Module templates are user-editable JSON/Handlebars files stored in `~/.config/mcp/canvas-mcp/templates/` — defaults are seeded on first run and can be customized or replaced for any course structure.

## Table of Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Step-by-step setup (first time)](#step-by-step-setup-first-time)
  1. [Install Node.js](#1-install-nodejs)
  2. [Install Git](#2-install-git)
  3. [Download the project](#3-download-the-project)
  4. [Install dependencies and build](#4-install-dependencies-and-build)
  5. [Get your Canvas API token](#5-get-your-canvas-api-token)
  6. [Create the configuration file](#6-create-the-configuration-file)
  7. [Connect to your AI Assistant](#7-connect-to-your-ai-assistant)
  8. [Start using it](#8-start-using-it)
- [Configuration reference](#configuration-reference)
- [Platform-Specific Setup](#platform-specific-setup)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code-anthropics-claude-cli)
  - [Gemini CLI](#gemini-cli-googles-gemini-cli)
  - [Codex CLI](#codex-cli-openais-codex-cli)
- [Tools](#tools)
- [Privacy / FERPA](#privacy--ferpa)
- [Canvas API notes](#canvas-api-notes)
- [Development](#development)
  - [Running tests](#running-tests)
  - [Setting up integration tests](#setting-up-integration-tests)
  - [Build](#build)
  - [Project structure](#project-structure)

## What it does

Connect this server to an AI assistant (like Claude Desktop) and ask it to:

- Switch between your courses (`"switch to my algorithms course"`)
- List your courses and see which one is active
- List modules, get grade summaries, report on missing and late assignments
- Create assignments, quizzes, pages, discussions, announcements, and files
- Create and associate rubrics with assignments
- Scaffold a full week's module from a template in one call
- Reset a sandbox course with a confirmation gate
- Find any item by name across pages, assignments, quizzes, modules, discussions, and announcements
- Search course content semantically using Canvas Smart Search (beta)

## Requirements

- Node.js 20+ ([nodejs.org](https://nodejs.org))
- Git ([git-scm.com](https://git-scm.com))
- A Canvas LMS account with teacher-level access to at least one course
- A Canvas API token (Profile → Settings → New Access Token)
- An MCP-compatible AI assistant: [Claude Code](https://code.claude.com), [Gemini CLI](https://geminicli.com/), [Codex (ChatGPT)](https://openai.com/codex/), [Claude Desktop](https://claude.com/download), etc.

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
git clone https://github.com/you/canvas-mcp
cd canvas-mcp
```

This creates a folder called `canvas-mcp` in your home directory and places you inside it.

### 4. Install dependencies and build

Still in Terminal, inside the `canvas-mcp` folder:

```bash
npm install
npm run build
```

`npm install` downloads the required packages (~1 minute, requires internet). `npm run build` compiles the TypeScript source to runnable JavaScript in `packages/teacher/dist/`. You should see no errors.

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
mkdir -p ~/.config/mcp/canvas-mcp
```

Then open a text editor and create the file `~/.config/mcp/canvas-mcp/config.json` with this content (substitute your real values):

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

### 7. Connect to your AI Assistant

The server works with any MCP-compatible AI client. Choose your preferred assistant for setup instructions:

- **[Claude Desktop](#claude-desktop)** (macOS)
- **[Claude Code](#claude-code-the-claude-cli)** (CLI)
- **[Gemini CLI](#gemini-cli-googles-gemini-cli)** (CLI)
- **[Codex CLI](#codex-cli-openais-codex-cli)** (CLI)

### 8. Start using it

In your assistant's chat window, try:

> "List my Canvas courses"

The assistant will call `list_courses` and show your courses. Then set the active course:

> "Switch to my ENG101 course"

---

## Configuration reference

The server reads `~/.config/mcp/canvas-mcp/config.json` on startup by default. The setup instructions in step 6 above use this default path.

### Using a custom config location

If you need to store the config file somewhere other than the default — for example, to maintain separate configs for different schools or environments — you can point the server at any path using the `--config` flag in the server `args`:

```json
"args": ["--secure-heap=65536", "/path/to/canvas-mcp/packages/teacher/dist/index.js", "--config", "/your/custom/path/config.json"]
```

If you use a custom location, replace `~/.config/mcp/canvas-mcp` with your chosen directory path everywhere it appears in the setup instructions — including the `mkdir` command in step 6 and the config file path you create there.

## Platform-Specific Setup

The `~/.config/mcp/canvas-mcp/config.json` file created in step 6 is shared across all clients — you only configure it once.

**NOTE:** Gemini-CLI is the preferred client at this point because it is one of the only clients out there which allows for seamless PII blinding to the LLM and unblinding to the console window.  If there are other clients that support this feature, I am not aware of them.

<details>
<summary><a id="gemini-cli-googles-gemini-cli"></a>Gemini CLI (Google's <code>gemini</code> CLI)</summary>

Edit `~/.gemini/settings.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "canvas-mcp": {
      "command": "node",
      "args": ["--secure-heap=65536", "/path/to/canvas-mcp/packages/teacher/dist/index.js"]
    }
  }
}
```

If you have other servers already configured, add the `"canvas-mcp"` entry inside the existing `"mcpServers"` object. Restart Gemini CLI after saving.

To limit the server to a single project instead of all sessions, place the same JSON in `.gemini/settings.json` inside that project's folder.

**Hooks (PII blinding):** To enable automatic student-name blinding in Gemini CLI — so real names never reach the model — set up the canvas-mcp hooks. See [clients/gemini/SETUP.md](clients/gemini/SETUP.md) for step-by-step instructions. **Note:** A local patch to Gemini CLI is currently required for the hooks to work correctly with student-specific queries — the setup guide covers this.
</details>

<details>
<summary><a id="claude-desktop"></a>Claude Desktop</summary>

1. Download and install [Claude Desktop](https://claude.ai/download) if you haven't already
2. Open Finder (macOS) and press ⌘+Shift+G, then paste:
   `~/Library/Application Support/Claude/`
3. Open (or create) the file `claude_desktop_config.json` in a text editor
4. Add the following, replacing `/path/to/canvas-mcp` with the actual path to the folder you cloned in step 3 (e.g., `/Users/yourname/canvas-mcp`):

```json
{
  "mcpServers": {
    "canvas-mcp": {
      "command": "node",
      "args": ["--secure-heap=65536", "/path/to/canvas-mcp/packages/teacher/dist/index.js"]
    }
  }
}
```

5. Save the file and **restart Claude Desktop** (quit completely and reopen)
6. Look for a hammer icon (🔨) in the Claude Desktop chat window — this confirms MCP tools are connected. Click it to see the tool list.

If Claude Desktop was already open with other MCP servers configured, merge the `"canvas-mcp"` entry into your existing `"mcpServers"` object rather than replacing it.
</details>

<details>
<summary><a id="claude-code-the-claude-cli"></a>Claude Code (Anthropic's <code>claude</code> CLI)</summary>

Add the server to your user-level MCP config with a single command:

```bash
claude mcp add canvas-mcp -- node --secure-heap=65536 /path/to/canvas-mcp/packages/teacher/dist/index.js
```

Replace `/path/to/canvas-mcp` with the actual folder path from step 3. This writes to `~/.claude.json` (user scope) and makes the server available in all Claude Code sessions.

To add it to a specific project only (so it isn't available globally), run the command from inside that project's folder and add `--scope project`:

```bash
claude mcp add --scope project canvas-mcp -- node --secure-heap=65536 /path/to/canvas-mcp/packages/teacher/dist/index.js
```

Verify the server was added:

```bash
claude mcp list
```
</details>

<details>
<summary><a id="codex-cli-openais-codex-cli"></a>Codex CLI (OpenAI's <code>codex</code> CLI)</summary>

Edit `~/.codex/config.toml` (create it if it doesn't exist):

```toml
[mcp_servers.canvas-mcp]
command = "node"
args = ["--secure-heap=65536", "/path/to/canvas-mcp/packages/teacher/dist/index.js"]
```

To limit it to a single project, place the same TOML in `.codex/config.toml` inside that project's folder (the project must be trusted).
</details>

## Tools

18 tools total. All tools accept an optional `course_id` to override the active course.

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
| `get_module_summary` | Full structure of a module: item types, titles, points, due dates. Accepts `module_id` or `module_name` (partial match). |
| `get_grades` | Grade data scoped by `scope`: `"class"` (every student's score + missing/late counts, supports `sort_by`), `"assignment"` (per-student breakdown for one assignment), or `"student"` (all assignments for one student via `student_token`). Student names replaced with session tokens. |
| `get_submission_status` | Missing or late assignments by student. `type: "missing"` supports an optional `since_date` filter. Student names replaced with session tokens. |
| `student_pii` | PII lookup. `action: "resolve"` reveals the real name and Canvas ID for a session token (shown to you only). `action: "list"` returns all tokens registered in the current session. |

### Create & list

| Tool | Description |
|------|-------------|
| `create_item` | Create a course item. `type`: `page`, `assignment`, `quiz`, `discussion`, `announcement`, `module`, or `module_item`. Supports optional `template_name`/`template_data` for template-rendered pages. Pass `dry_run: true` to preview the resolved inputs without calling Canvas. |
| `list_items` | List course items by type: `modules`, `assignments`, `quizzes`, `pages`, `discussions`, `announcements`, `rubrics`, `assignment_groups`, `module_items` (requires `module_name`), or `templates` (lists available module templates). |

### Find, update & delete

| Tool | Description |
|------|-------------|
| `find_item` | Find any course item by partial name and return its full details. Types: `page` (with body), `assignment` (with description), `quiz` (with questions), `module`, `module_item`, `discussion`, `announcement`, `syllabus`. Returns first case-insensitive partial match with a warning if multiple items matched. |
| `update_item` | Find a course item by name then update it. Types: `page`, `assignment`, `quiz`, `module`, `module_item`, `syllabus`. Provide only the fields to change. |
| `delete_item` | Find a course item by name then delete or remove it. Types: `page`, `assignment`, `quiz`, `module`, `module_item`, `discussion`, `announcement`. Deleting a `module_item` only removes it from the module — underlying content is not deleted. |

### Files & rubrics

| Tool | Description |
|------|-------------|
| `upload_file` | Upload a local file to the course Files section via Canvas's 3-step upload protocol. |
| `delete_file` | Permanently delete a file. Irreversible — no recycle bin via API. |
| `create_rubric` | Create a rubric and associate it with an assignment. See [rubric notes](#rubrics-require-an-assignment-canvas-limitation) below. |

### Module creation (high-level)

| Tool | Description |
|------|-------------|
| `build_module` | Build a module by `mode`: `"blueprint"` (render a named template from `~/.config/mcp/canvas-mcp/templates/`), `"manual"` (explicit item list), `"solution"` (solution module linked to a lesson module), or `"clone"` (copy a module from any course with optional week number substitution). |

### Destructive operations

| Tool | Description |
|------|-------------|
| `reset_course` | Preview or execute a full course content reset. |

#### **NOTES**

**`dry_run`:** Defaults to `dry_run=false`.  You will be provided with a token that expires after 5 minuets.  You must provide the token to the LLM to confirm reset.  If `dry_run=true`, no confirmation is required; returns counts of what would be deleted.

**Alternative confirmation:** The user may instead provide `confirmation_text` exactly matching the Canvas course name (case-sensitive), skipping the token flow entirely.

**Always preserved:** Enrollments, course settings, and navigation tabs are never touched.

### Smart search (Canvas beta feature)

| Tool | Description |
|------|-------------|
| `search_course` | Search course content using Canvas Smart Search (AI-powered semantic search). Returns results with distance scores — lower = closer match. Supports content type filtering, distance threshold, result limit, and optional body inclusion. Pass `save_threshold: true` to persist the threshold to config as the new default. Requires Canvas Smart Search beta to be enabled on your instance. |

---

## Privacy / FERPA

Student names and Canvas numeric IDs are FERPA-protected PII. When this server is used with cloud-hosted AI assistants (like Claude Desktop), every tool response passes through the assistant's infrastructure. To prevent student data from leaving your machine, all reporting tools automatically replace student identity information with opaque session tokens before the response reaches the AI:

- `[STUDENT_001]`, `[STUDENT_002]`, … are assigned in the order students are first seen, and reset on every server restart.
- The AI reasons about tokens only — it never sees real names or Canvas IDs.
- A human-readable lookup table (`[STUDENT_001] → Jane Smith`) is shown **to you** in the assistant's UI alongside the AI's response, so you always know who's who without needing to ask.
- To explicitly look up a token, call `student_pii(action='resolve', student_token='[STUDENT_001]')` — the result is shown to you only, not added to the AI's context.
- Blinding is always on and cannot be disabled.

The session key used to protect the in-memory token map is:
- Freshly generated at startup (never stored to disk)
- Pinned in RAM via `mlock` where the OS permits (prevents swap-file exposure)
- Zeroed on process exit (`SIGINT`, `SIGTERM`, `SIGHUP`)

The `--secure-heap=65536` flag in the AI assistant config allocates a locked memory region for cryptographic operation intermediates. Include it in your config as shown in the [Platform-Specific Setup](#platform-specific-setup).

For full details on the threat model and compliance posture, see [docs/FERPA.md](docs/FERPA.md), [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md), and [docs/PII_ARCHITECTURE.md](docs/PII_ARCHITECTURE.md).

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

**Other notes:**
- The front page is automatically unset before page deletion.
- File deletion is irreversible — the preview shows file counts explicitly.

---

## Development

### Running tests

```bash
# Unit tests (no credentials required)
npm run test:unit

# Integration tests (requires .env.test — see below)
npm run test:integration
```

Unit tests mock all HTTP with [msw](https://mswjs.io/). Integration tests run against a real Canvas instance.

### Setting up integration tests

Create `.env.test` in the project root:

```
# Core Canvas configuration
CANVAS_INSTANCE_URL=https://canvas.instructure.com
CANVAS_API_TOKEN=your_test_teacher_token
CANVAS_TEST_COURSE_ID=12345

# Student tokens for the seed script (requires 5 students)
STUDENT0_API_TOKEN=token_0
STUDENT1_API_TOKEN=token_1
STUDENT2_API_TOKEN=token_2
STUDENT3_API_TOKEN=token_3
STUDENT4_API_TOKEN=token_4
```

Use a free [canvas.instructure.com](https://canvas.instructure.com) account with a course named `TEST SANDBOX` — keep it completely separate from your production courses.

1. Create the `.env.test` file with the core and student tokens.
2. Run the seed script to establish the test state: `npm run seed`
3. The script automatically populates the remaining IDs (Module, Assignments, etc.) into your `.env.test` file.
4. Run the integration tests: `npm run test:integration`

### Token overhead analysis

```bash
npm run count-tokens                       # exact (requires ANTHROPIC_API_KEY)
npm run count-tokens -- --no-api           # estimate without API key
npm run count-tokens -- --dump             # also writes raw payloads to tmp/token-dump/
```

### Build

```bash
npm run build   # compiles packages/core and packages/teacher → their dist/ folders
```

### Project structure

```
clients/
└── gemini/                       # Gemini CLI hooks for PII blinding (see clients/gemini/SETUP.md)
    ├── src/
    │   ├── before_model.ts       # BeforeModel hook — blinds student names in prompt
    │   ├── after_model.ts        # AfterModel hook — unblinds tokens in model response
    │   └── after_tool.ts         # AfterTool hook — progress indicator for canvas-mcp tool calls
    ├── patches/
    │   └── gemini-cli-hookTranslator.patch.md  # Required local patch for Gemini CLI (see SETUP.md Step 2b)
    ├── SETUP.md                  # Step-by-step hook installation guide
    └── HOOK_REFERENCE.md         # Hook API reference & behavioral findings
packages/
├── core/                         # @canvas-mcp/core — shared Canvas API layer
│   ├── src/
│   │   ├── canvas/
│   │   │   ├── client.ts         # HTTP client (auth, pagination, rate limiting, retry)
│   │   │   ├── courses.ts        # Course & enrollment API calls
│   │   │   ├── modules.ts        # Module & module item API calls
│   │   │   ├── assignments.ts    # Assignment & assignment-group API calls
│   │   │   ├── quizzes.ts        # Classic Quiz API calls
│   │   │   ├── pages.ts          # Page API calls (CRUD + front page handling)
│   │   │   ├── discussions.ts    # Discussion topic & announcement API calls
│   │   │   ├── files.ts          # File upload (3-step Canvas/S3 flow) & delete
│   │   │   ├── rubrics.ts        # Rubric CRUD + association API calls
│   │   │   ├── submissions.ts    # Grade & submission API calls
│   │   │   └── search.ts         # Canvas Smart Search API
│   │   ├── config/
│   │   │   ├── schema.ts         # Config types and DEFAULT_CONFIG
│   │   │   └── manager.ts        # Read/write ~/.config/mcp/canvas-mcp/config.json
│   │   ├── security/
│   │   │   ├── secure-store.ts   # AES-256-GCM in-memory PII store (session tokens, mlock)
│   │   │   └── sidecar-manager.ts# Writes/deletes the PII sidecar file for Gemini CLI hooks
│   │   ├── templates/
│   │   │   ├── index.ts          # Re-exports from service.ts
│   │   │   ├── service.ts        # TemplateService — manifest parsing, Handlebars rendering
│   │   │   ├── seed.ts           # Seeds default templates to user config dir on first run
│   │   │   └── defaults/         # Bundled default templates (later-standard, later-review, etc.)
│   │   └── tools/
│   │       └── context.ts        # list_courses, set_active_course, get_active_course
│   └── tests/
│       ├── setup/
│       │   └── msw-server.ts     # Shared MSW server setup for core unit tests
│       └── unit/tools/
│           └── context.test.ts   # Tests for context tools (moved from teacher)
└── teacher/                      # @canvas-mcp/teacher — MCP server entry point
    ├── src/
    │   ├── index.ts              # MCP server wiring and startup
    │   └── tools/
    │       ├── content.ts        # upload_file, create_rubric, delete_file
    │       ├── modules.ts        # build_module (blueprint / manual / solution / clone)
    │       ├── reporting.ts      # get_module_summary, get_grades, get_submission_status, student_pii
    │       ├── reset.ts          # reset_course (dry_run + confirmation gate)
    │       └── find.ts           # create_item, list_items, find_item, update_item, delete_item, search_course
    └── tests/
        ├── setup/
        │   ├── msw-server.ts     # Shared MSW server setup for unit tests
        │   └── integration-env.ts# Integration test environment loader
        ├── unit/tools/
        │   ├── content.test.ts
        │   ├── find.test.ts
        │   ├── modules.test.ts
        │   ├── reporting.test.ts
        │   └── reset.test.ts
        └── integration/          # Real Canvas API tests, requires .env.test
```
