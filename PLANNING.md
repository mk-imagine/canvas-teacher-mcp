# Canvas Teacher MCP Server — Planning Document

> **Note:** This document contains design details, course codes, naming conventions, and template structures that are specific to a particular school and program. The Canvas API integration and tool architecture are general-purpose, but sections 1, 3–4, and 13 in particular reflect that specific instructional context.

> **Purpose of this document:** Serves as the authoritative design reference for working on this codebase. All tool definitions include explicit input/output contracts and Canvas API calls so that implementation can proceed without ambiguity.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Configuration Schema](#3-configuration-schema)
4. [Module Templates](#4-module-templates)
5. [Tool Reference](#5-tool-reference)
6. [Canvas API Endpoint Reference](#6-canvas-api-endpoint-reference)
7. [Key Data Models](#7-key-data-models)
8. [Implementation Phases](#8-implementation-phases)
9. [Error Handling Philosophy](#9-error-handling-philosophy)
10. [Safety & Destructive Operations](#10-safety--destructive-operations)
11. [Future Integrations Roadmap](#11-future-integrations-roadmap)
12. [Known Limitations](#12-known-limitations)
13. [Testing & Validation](#13-testing--validation)
14. [FERPA PII Blinding](#14-ferpa-pii-blinding)

---

## 1. Project Overview

### Purpose

A teacher-facing MCP (Model Context Protocol) server that wraps the Canvas LMS REST API to support course management workflows for a 5-course data science certificate program. The server is designed to be used by an AI assistant (e.g., Claude) to plan, create, and monitor Canvas course content on behalf of the instructor.

### Target User

A single instructor managing 5 sequential courses in a certificate program, often building content for multiple courses simultaneously and wanting cohesive structure across all courses.

### Program Courses

| Code    | Name (tentative)              | Template Family |
|---------|-------------------------------|-----------------|
| CSC 306 | Introduction to Programming   | `earlier`       |
| CSC 311 | Applied Data Structures       | `earlier`       |
| CSC 408 | Data Science for Personalized Medicine        | `later` |
| CSC 411 | Intermediate Machine Learning                 | `later` |
| CSC 509 | Machine Learning for Medical Image Analysis  | `later` |

### Scope

- **In scope:** Module creation, assignment/quiz/page management, discussion/announcement/file management, grade/submission reporting, complete course reset, course context switching.
- **Out of scope (for now):** Canvas Studio video embedding (manual), New Quizzes, LTI tool configuration, calendar events, learning outcomes.
- **Future scope:** Zoom MCP integration (attendance grading), YouTube MCP integration (video embedding), walkthrough video modules.

### Assignment Context

All graded coding assignments are **Google Colab notebooks** submitted as an `online_url` (share link). Solutions are also Colab notebooks served as external URLs. This is the default submission type throughout the program.

---

## 2. Architecture

### 2.1 Tech Stack

| Layer              | Choice                                    |
|--------------------|-------------------------------------------|
| Runtime            | Node.js (LTS)                             |
| Language           | TypeScript (strict mode)                  |
| MCP Framework      | `@modelcontextprotocol/sdk`               |
| HTTP Client        | `axios` or native `fetch` (Node 18+)      |
| Config persistence | Local JSON file (`~/.config/mcp/canvas-teacher-mcp/config.json`) |
| Template engine    | Handlebars (for HTML description templates) |

### 2.2 Project Structure

```
canvas-teacher-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── canvas/
│   │   ├── client.ts         # Canvas API client (auth, pagination, retry)
│   │   ├── modules.ts        # Module & module item API calls
│   │   ├── assignments.ts    # Assignment & assignment-group API calls
│   │   ├── quizzes.ts        # Classic Quiz API calls
│   │   ├── pages.ts          # Page API calls (CRUD + front page handling)
│   │   ├── discussions.ts    # Discussion topic & announcement API calls
│   │   ├── files.ts          # File upload (3-step Canvas/S3 flow) & delete
│   │   ├── rubrics.ts        # Rubric CRUD + association API calls
│   │   ├── submissions.ts    # Submission & grade API calls
│   │   └── courses.ts        # Course & enrollment API calls
│   ├── tools/
│   │   ├── context.ts        # Course management tools
│   │   ├── content.ts        # Low-level CRUD tools (assignments, quizzes, pages, modules, module items)
│   │   ├── modules.ts        # High-level module creation tools (lesson, solution, clone)
│   │   ├── reporting.ts      # Grade & submission reporting tools
│   │   └── reset.ts          # Destructive reset tools
│   ├── security/
│   │   └── secure-store.ts   # AES-256-GCM in-memory PII store (session tokens, mlock)
│   ├── templates/
│   │   ├── index.ts          # Template loader & renderer
│   └── config/
│       ├── schema.ts         # Config type definitions
│       └── manager.ts        # Read/write config file
├── PLANNING.md
├── package.json
└── tsconfig.json
```

### 2.3 Canvas API Client

The client wraps all HTTP calls and handles:

- **Authentication:** `Authorization: Bearer <token>` header on every request.
- **Pagination:** Canvas paginates at 10 items/page (max 100). The client follows `Link: <url>; rel="next"` headers automatically, collecting all pages before returning. All list operations use this.
- **Rate limiting:** Canvas returns `X-Rate-Limit-Remaining` headers. If remaining drops below 10, add a 500ms delay. On HTTP 429, retry with exponential backoff (max 3 attempts).
- **Error normalization:** All Canvas API errors are normalized to `{ status, code, message, canvasError }` before being returned to tools.

### 2.4 Configuration Management

Config is stored at `~/.config/mcp/canvas-teacher-mcp/config.json` and is read on server startup. Tools that modify config (e.g., `set_active_course`) write to this file immediately. The file is never checked into version control.

---

## 3. Configuration Schema

```jsonc
{
  "canvas": {
    "instanceUrl": "https://your-institution.instructure.com",  // no trailing slash
    "apiToken": "YOUR_CANVAS_API_TOKEN"
  },
  "program": {
    // The Canvas numeric ID of the currently active course.
    // Set automatically by set_active_course — do not hand-edit.
    "activeCourseId": 12345,
    // Known program course codes. Used to filter list_courses output so it
    // shows only your 5 courses rather than every Canvas course you've ever
    // been enrolled in. Hand-edit this once during initial setup.
    "courseCodes": ["CSC306", "CSC311", "CSC408", "CSC411", "CSC509"],
    // Auto-populated cache of resolved course lookups. Never hand-edited.
    // Key is the Canvas numeric course ID (as a string).
    // Populated the first time set_active_course resolves a given course.
    "courseCache": {
      "12345": { "code": "CSC408", "name": "Introduction to Machine Learning", "term": "Spring 2026" },
      "11111": { "code": "CSC408", "name": "Introduction to Machine Learning", "term": "Fall 2025" }
    }
  },
  "defaults": {
    "assignmentGroup": "Assignments",       // Canvas assignment group for new assignments
    "submissionType": "online_url",         // default for coding assignments (Google Colab URLs)
    "pointsPossible": 100,                  // default points for a new assignment
    "completionRequirement": "min_score",   // "min_score" | "must_submit" | "must_view"
    "minScore": 1,                          // minimum score for min_score completion (attempt-based)
    "exitCardPoints": 0.5                   // points for exit card quizzes (no time limit enforced)
  },
  "templates": {
    // See Section 4 — user-editable, overrides defaults
  },
  "assignmentDescriptionTemplate": {
    // Handlebars HTML template for assignment descriptions.
    // Variables: {{notebook_url}}, {{notebook_title}}, {{instructions}}
    // Default matches existing course format (H3, bold, linked).
    "default": "<h3><strong><a href=\"{{notebook_url}}\">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>",
    "solution": "<h3><strong><a href=\"{{notebook_url}}\">View Solution in Colab</a></strong></h3>"
  },
  "exitCardTemplate": {
    // Default exit card survey questions. User-editable.
    "title": "Week {{week}} | Exit Card (5 mins)",
    "quizType": "graded_survey",
    "questions": [
      {
        "question_name": "Confidence",
        "question_text": "Rate your confidence with this week's material (1 = very low, 5 = very high).",
        "question_type": "rating_question"
      },
      {
        "question_name": "Muddiest Point",
        "question_text": "What is still unclear or confusing from this week?",
        "question_type": "essay_question"
      },
      {
        "question_name": "Most Valuable",
        "question_text": "What was the most valuable thing you learned this week?",
        "question_type": "essay_question"
      }
    ]
  }
}
```

---

## 4. Module Templates

Templates define the ordered structure of Canvas module items. Each item in a template is a **slot** that maps to a Canvas module item type. Templates are stored in config and can be overridden per-use.

### 4.1 Template Item Types

| Slot Type        | Canvas `type`  | Notes |
|------------------|----------------|-------|
| `subheader`      | `SubHeader`    | Section divider label |
| `overview_page`  | `Page`         | Auto-created; title follows naming convention |
| `external_url`   | `ExternalUrl`  | Download links, resource links |
| `assignment`     | `Assignment`   | Graded; creates Assignment object + adds to module |
| `quiz`           | `Quiz`         | Graded quiz or survey; creates Quiz object + adds to module |
| `page`           | `Page`         | Reading, video shell (Canvas Studio embed done manually) |
| `reminder`       | `Assignment`   | submission_type: none; manually graded participation item |

### 4.2 `later-standard` — Advanced Courses, Regular Week

Used by: CSC 408, 411, 509 (standard content weeks)

```
SubHeader: OVERVIEW
  overview_page:   "Week {N} | Overview"
SubHeader: ASSIGNMENTS
  external_url:    "DOWNLOAD: Week {N} Data Files"           [optional]
  assignment:      "Week {N} | Coding Assignment | {title} ({hours} Hours)"  [online_url, repeatable]
  page:            "Week {N} | Reading & Exercise | {title} ({hours} Hour)"  [optional]
  assignment:      "Week {N} | Assignment | {title} ({mins} min)"             [optional]
  assignment:      "Week {N} | Manual Assignment | {title} ({mins} mins)"     [optional]
SubHeader: WRAP-UP
  quiz:            "Week {N} | Exit Card (5 mins)"           [graded_survey]
```

Completion requirement: `min_score: 1` on graded items.

### 4.3 `later-review` — Advanced Courses, Review/Integration Week

Used by: CSC 408, 411, 509 (review weeks, no new notebook submissions)

```
SubHeader: OVERVIEW
  overview_page:   "Week {N} | Overview"
SubHeader: ASSIGNMENTS
  page:            "Week {N} | {title} Video (~{mins} mins)"  [Canvas Studio shell — embed manually]
  assignment:      "Week {N} | Assignment | {title} ({hours} hours)"          [optional]
  page:            "Week {N} | {title}"                        [supplemental pages, optional, repeatable]
  quiz:            "Week {N} | {title} ({hours} hour) - Can take {attempts}x" [graded quiz]
SubHeader: WRAP-UP
  quiz:            "Week {N} | Exit Card (5 mins)"             [graded_survey]
```

Completion requirement: `min_score: 1` on graded items.

### 4.4 `earlier-standard` — Intro Courses, Regular Week

Used by: CSC 306, 311 (standard content weeks)

Note: Exit card lives inside TO-DO, not a separate WRAP-UP section. Video pages are in a dedicated section at the bottom.

```
SubHeader: OVERVIEW
  overview_page:   "Week {N} | Overview"
SubHeader: TO-DO
  assignment:      "Week {N} | Assignment {N}.1 | {Verb}: {description}"  [online_url]
  assignment:      "Week {N} | Assignment {N}.2 | {Verb}: {description}"  [online_url]
  assignment:      "Week {N} | Assignment {N}.3 | {Verb}: {description}"  [online_url, optional]
  reminder:        "Week {N} | Reminder | Attend Weekly Discussion"        [no_submission]
  reminder:        "Week {N} | Reminder | Check In With Your Instructor"   [no_submission]
  quiz:            "Week {N} | Exit Card"                                  [graded_survey]
SubHeader: QUICK ACCESS TO VIDEOS
  page:            "Video {N}a | {title} (~{mins} mins)"  [Canvas Studio shell, repeatable]
  page:            "Video {N}b | {title} (~{mins} mins)"
  page:            "Video {N}c | {title} (~{mins} mins)"
  ...
```

Completion requirement: `min_score: 1` on graded items.

### 4.5 `earlier-review` — Intro Courses, Review/Integration Week

Used by: CSC 306, 311 (review weeks)

```
SubHeader: OVERVIEW
  overview_page:   "Week {N} | Overview"
SubHeader: TO-DO
  assignment:      "Week {N} | Assignment {N}.1 | {description} (~{hours} hrs) [{pts} pts]"  [online_url]
  assignment:      "Week {N} | Assignment {N}.2 | {description} (~{hours} hrs) [{pts} pts]"  [online_url]
  assignment:      "Week {N} | Assignment {N}.3 | {description} (~{hours} hrs)"               [online_url, optional]
  reminder:        "Week {N} | Reminder | Attend Weekly Discussion"        [no_submission]
  reminder:        "Week {N} | Reminder | Check In With Your Instructor"   [no_submission]
  quiz:            "Week {N} | Exit Card"                                  [graded_survey]
```

Completion requirement: `min_score: 1` on graded items.

### 4.6 Solution Module Structure

Solution modules are not templated the same way — they are always:

```
[No SubHeaders]
  external_url:  "{title} | Solution Notebook"  [Colab share link, one per assignment]
  page:          "{title} | Walkthrough"         [optional — Canvas Studio or YouTube shell]
```

Lock strategy (both applied together):
- `unlock_at`: set to the due date/time of the corresponding lesson module's primary assignment.
- `prerequisite_module_ids`: set to the lesson module's ID.
- Per-item completion requirement on lesson module: `min_score: 1` (student's submission must be graded before prerequisite is satisfied).

---

## 5. Tool Reference

All tools accept an optional `course_id` parameter. If omitted, the active course from config is used. Tools that modify Canvas always report exactly what was created/changed.

---

### 5.1 Context & Course Management

---

#### `list_courses`

**Purpose:** List all Canvas courses where the user has a Teacher or TA enrollment. Filters to program courses by default (using `courseCodes` from config) and marks the currently active course. Pass `all: true` to show every teacher-enrolled course.

**Inputs:** *(none)*

**Output:** Array of `{ id, courseCode, name, term, isActive }`.

**Canvas API Calls:**
- `GET /api/v1/courses?enrollment_type=teacher&include[]=term`

---

#### `set_active_course`

**Purpose:** Set the active course by fuzzy-matching a natural language query (e.g., `"CSC408"`, `"CSC408 Spring 2026"`, `"intro ML"`) against the instructor's live Canvas course list. Resolves to a Canvas course ID, caches the mapping, and persists the active course to config.

**Inputs:**
- `query` (string, required): Any identifying string — course code, partial name, term, or combination. Examples: `"CSC408"`, `"CSC408 Spring 2026"`, `"408 spring"`, `"intro machine learning"`.

**Resolution logic:**
1. Call `GET /api/v1/courses?enrollment_type=teacher&include[]=term` to fetch all teacher-enrolled courses.
2. Filter to courses whose `course_code` or `name` contains any token from `query`, and whose `term.name` contains any term tokens (e.g., `"Spring"`, `"2026"`).
3. If exactly one match → set as active, add to `courseCache`, persist config.
4. If multiple matches → return the list and ask the user to be more specific.
5. If no matches → return all available courses filtered by `courseCodes` so the user can pick.

**Output:** Confirmation showing resolved course name, code, term, and Canvas ID.

**Canvas API Calls:**
- `GET /api/v1/courses?enrollment_type=teacher&include[]=term&per_page=100`

---

#### `get_active_course`

**Purpose:** Show the currently active course and all program courses with their IDs.

**Inputs:** *(none)*

**Output:** `{ activeCourse: { id, name, code }, programCourses: [...] }`

**Canvas API Calls:** *(none — reads config only)*

---

### 5.2 Module Tools — High-Level

---

#### `create_lesson_module`

**Purpose:** Create a full lesson module in one call using a named template. Creates the module, all sub-items (assignments, quizzes, pages, external URLs), and sets completion requirements.

**Inputs:**
- `week` (number, required): Week number used in naming and numbering.
- `title` (string, required): Module title suffix (e.g., `"Linear and Logistic Regression"`).
- `template` (string, required): One of `later-standard`, `later-review`, `earlier-standard`, `earlier-review`.
- `due_date` (ISO 8601 string, required): Due date/time for graded items.
- `items` (array, required): Ordered list of item descriptors matching the chosen template's slots. Each item has `type`, `title`, `points`, and type-specific fields (e.g., `url` for external_url, `hours` for assignments).
- `assignment_group_id` (number, optional): Canvas assignment group for graded items. Uses default if omitted.
- `completion_requirement` (string, optional): `"min_score"` | `"must_submit"` | `"must_view"`. Defaults to config value (`min_score`).
- `publish` (boolean, optional): Whether to publish the module immediately. Default: `false`.
- `course_id` (number, optional): Overrides active course.

**Output:**
```jsonc
{
  "module": { "id": 123, "name": "Week 2: Linear and Logistic Regression" },
  "items_created": [
    { "type": "SubHeader", "title": "OVERVIEW" },
    { "type": "Page", "title": "Week 2 | Overview", "page_url": "week-2-overview" },
    // ...
  ],
  "warnings": []  // e.g., items that had to be skipped due to API errors
}
```

**Canvas API Calls (sequential):**
1. `POST /api/v1/courses/:id/modules` — create the module
2. For each assignment slot: `POST /api/v1/courses/:id/assignments`
3. For each quiz slot: `POST /api/v1/courses/:id/quizzes`
4. For each page slot: `POST /api/v1/courses/:id/pages`
5. For each item: `POST /api/v1/courses/:id/modules/:module_id/items` (with completion_requirement)
6. If `publish=true`: `PUT /api/v1/courses/:id/modules/:module_id` `{ "module": { "published": true } }`

**Notes:**
- Steps are performed in order. If any step fails, the tool reports what was created so far and stops — it does not attempt rollback.
- Assignment descriptions are rendered from the `assignmentDescriptionTemplate.default` Handlebars template in config.
- The exit card quiz is created from the `exitCardTemplate` in config.

---

#### `create_solution_module`

**Purpose:** Create a solution module linked to an existing lesson module. Locks it until the lesson module's primary due date and sets the lesson module as a prerequisite.

**Inputs:**
- `lesson_module_id` (number, required): Canvas ID of the corresponding lesson module.
- `unlock_at` (ISO 8601 string, required): When the solution becomes globally visible. Should match the lesson module's assignment due date.
- `title` (string, required): Module name (e.g., `"Week 2 | Solutions | Linear and Logistic Regression"`).
- `solutions` (array, required): List of `{ title, url }` objects — each is a Colab solution notebook.
- `completion_requirement` (string, optional): Completion requirement that must be satisfied on the lesson module before this unlocks per-student. Default: `"min_score"` with `min_score: 1`.
- `publish` (boolean, optional): Default `false`.
- `course_id` (number, optional).

**Output:** `{ module: { id, name }, items_created: [...] }`

**Canvas API Calls (sequential):**
1. `GET /api/v1/courses/:id/modules/:lesson_module_id` — verify lesson module exists
2. `POST /api/v1/courses/:id/modules` with `{ prerequisite_module_ids: [lesson_module_id], unlock_at }`
3. For each solution: `POST /api/v1/courses/:id/modules/:solution_module_id/items` with `{ type: "ExternalUrl", external_url, title, new_tab: true }`
4. Update lesson module items to set completion requirements (if not already set): `PUT /api/v1/courses/:id/modules/:lesson_module_id/items/:item_id`

---

#### `get_module_summary`

**Purpose:** Read an existing module's full structure including item types, titles, points, due dates, and raw HTML description of assignments. Used to inspect existing course content as a style or structural reference.

**Inputs:**
- `module_id` (number, required): Canvas module ID.
- `include_html` (boolean, optional): If true, include raw `description` HTML for assignment/page items. Default: `false`.
- `course_id` (number, optional).

**Output:**
```jsonc
{
  "module": { "id": 123, "name": "Week 2: ...", "published": true, "unlock_at": null, "prerequisite_module_ids": [] },
  "items": [
    { "position": 1, "type": "SubHeader", "title": "OVERVIEW" },
    { "position": 2, "type": "Page", "title": "Week 2 | Overview" },
    { "position": 3, "type": "SubHeader", "title": "ASSIGNMENTS" },
    { "position": 4, "type": "Assignment", "title": "Week 2 | Coding Assignment | ...", "points": 10, "due_at": "...", "html": "<h3>..." }
    // ...
  ]
}
```

**Canvas API Calls:**
1. `GET /api/v1/courses/:id/modules/:module_id`
2. `GET /api/v1/courses/:id/modules/:module_id/items?include[]=content_details`
3. For each assignment item (if `include_html=true`): `GET /api/v1/courses/:id/assignments/:assignment_id` (parallel)

---

#### `clone_module`

**Purpose:** Copy the structure of an existing module from any course into the active (or specified) destination course. Creates new Canvas objects (assignments, quizzes, pages) in the destination. Does not copy student submissions or grades. Useful for replicating module structure from a previous term or sibling course.

**Inputs:**
- `source_module_id` (number, required): Module to copy from.
- `source_course_id` (number, required): Course the source module lives in.
- `week` (number, optional): If provided, replaces the week number in all item titles.
- `due_date` (ISO 8601 string, optional): If provided, updates all due dates in the cloned module.
- `dest_course_id` (number, optional): Destination course. Defaults to active course.

**Output:** Same shape as `create_lesson_module`.

**Canvas API Calls:**
1. `GET` source module and items (via `get_module_summary` with `include_html=true` internally)
2. Replay creation sequence as in `create_lesson_module`

**Notes:** Assignment descriptions (HTML) are copied verbatim from the source, then the notebook URL placeholder is left blank for the instructor to fill in, or replaced if a URL mapping is provided.

---

### 5.3 Module Tools — Low-Level

---

#### `list_modules`

**Purpose:** List all modules in a course with their published state, lock status, and item count.

**Inputs:**
- `course_id` (number, optional).

**Output:** Array of `{ id, name, published, unlock_at, prerequisite_module_ids, items_count }`.

**Canvas API Calls:**
- `GET /api/v1/courses/:id/modules?include[]=items`

---

#### `add_module_item`

**Purpose:** Add a single item to an existing module at a specified position.

**Inputs:**
- `module_id` (number, required).
- `type` (string, required): `"SubHeader"` | `"Page"` | `"Assignment"` | `"Quiz"` | `"ExternalUrl"`.
- `title` (string, required).
- `content_id` (number, conditional): Required for Assignment, Quiz, Page types — the ID of the existing Canvas object to link.
- `external_url` (string, conditional): Required for ExternalUrl type.
- `position` (number, optional): 1-based position in the module. Appends if omitted.
- `new_tab` (boolean, optional): Open in new tab. Default `true` for ExternalUrl.
- `completion_requirement` (object, optional): `{ type: "min_score" | "must_submit" | "must_view", min_score?: number }`.
- `course_id` (number, optional).

**Output:** The created module item object.

**Canvas API Calls:**
- `POST /api/v1/courses/:id/modules/:module_id/items`

---

#### `update_module_item`

**Purpose:** Update an existing module item (e.g., change position, title, or completion requirement).

**Inputs:**
- `module_id` (number, required).
- `item_id` (number, required).
- `title` (string, optional).
- `position` (number, optional).
- `completion_requirement` (object, optional).
- `course_id` (number, optional).

**Canvas API Calls:**
- `PUT /api/v1/courses/:id/modules/:module_id/items/:item_id`

---

#### `remove_module_item`

**Purpose:** Remove an item from a module. Does not delete the underlying Canvas object (assignment/page/quiz).

**Inputs:**
- `module_id` (number, required).
- `item_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/modules/:module_id/items/:item_id`

---

#### `update_module`

**Purpose:** Update a module's settings (name, published state, lock date, prerequisites, completion requirements).

**Inputs:**
- `module_id` (number, required).
- `name` (string, optional).
- `published` (boolean, optional).
- `unlock_at` (ISO 8601 string, optional).
- `prerequisite_module_ids` (number[], optional).
- `require_sequential_progress` (boolean, optional).
- `course_id` (number, optional).

**Canvas API Calls:**
- `PUT /api/v1/courses/:id/modules/:module_id`

---

#### `delete_module`

**Purpose:** Delete a module and its module items. Does NOT delete the underlying assignments, quizzes, or pages.

**Inputs:**
- `module_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/modules/:module_id`

---

### 5.4 Assignment & Quiz Tools

---

#### `create_assignment`

**Purpose:** Create a standalone graded assignment (without adding it to a module).

**Inputs:**
- `name` (string, required).
- `points_possible` (number, required).
- `due_at` (ISO 8601 string, optional).
- `submission_types` (string[], optional): Default `["online_url"]`.
- `assignment_group_id` (number, optional).
- `description` (string, optional): Raw HTML. If omitted and `notebook_url` is provided, rendered from config template.
- `notebook_url` (string, optional): Inserted into description template.
- `notebook_title` (string, optional): Used in description template link text.
- `instructions` (string, optional): Additional instructions inserted into description template.
- `published` (boolean, optional): Default `false`.
- `course_id` (number, optional).

**Canvas API Calls:**
- `POST /api/v1/courses/:id/assignments`

---

#### `update_assignment`

**Purpose:** Update an existing assignment's settings.

**Inputs:**
- `assignment_id` (number, required).
- `name` (string, optional).
- `points_possible` (number, optional).
- `due_at` (ISO 8601 string, optional).
- `submission_types` (string[], optional).
- `assignment_group_id` (number, optional).
- `description` (string, optional).
- `published` (boolean, optional).
- `course_id` (number, optional).

**Canvas API Calls:**
- `PUT /api/v1/courses/:id/assignments/:assignment_id`

---

#### `list_assignment_groups`

**Purpose:** List all assignment groups in a course. Used to look up group IDs before creating assignments.

**Inputs:**
- `course_id` (number, optional).

**Output:** Array of `{ id, name, group_weight, rules }`.

**Canvas API Calls:**
- `GET /api/v1/courses/:id/assignment_groups`

---

#### `create_quiz`

**Purpose:** Create a Classic Quiz (graded or survey). For exit cards, use `quiz_type: "graded_survey"`.

**Inputs:**
- `title` (string, required).
- `quiz_type` (string, required): `"practice_quiz"` | `"assignment"` | `"graded_survey"` | `"survey"`.
- `points_possible` (number, optional): Required for graded types.
- `due_at` (ISO 8601 string, optional).
- `time_limit` (number, optional): Minutes.
- `allowed_attempts` (number, optional): `-1` for unlimited.
- `assignment_group_id` (number, optional).
- `use_exit_card_template` (boolean, optional): If `true`, populates questions from `exitCardTemplate` in config, substituting `{{week}}`.
- `questions` (array, optional): Custom questions if not using template. Follows Canvas quiz question schema.
- `published` (boolean, optional): Default `false`.
- `course_id` (number, optional).

**Canvas API Calls:**
1. `POST /api/v1/courses/:id/quizzes`
2. For each question: `POST /api/v1/courses/:id/quizzes/:quiz_id/questions`

---

#### `update_quiz`

**Purpose:** Update an existing quiz's settings.

**Inputs:** Same optional fields as `create_quiz` minus `use_exit_card_template`.
- `quiz_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `PUT /api/v1/courses/:id/quizzes/:quiz_id`

---

#### `delete_assignment`

**Purpose:** Permanently delete an assignment.

**Inputs:**
- `assignment_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/assignments/:assignment_id`

---

#### `delete_quiz`

**Purpose:** Permanently delete a Classic Quiz.

**Inputs:**
- `quiz_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/quizzes/:quiz_id`

---

#### `create_discussion`

**Purpose:** Create a discussion topic in a course.

**Inputs:**
- `title` (string, required).
- `message` (string, optional): HTML body of the discussion prompt.
- `published` (boolean, optional): Default `false`.
- `course_id` (number, optional).

**Output:** `{ id, title, message, is_announcement, published, html_url }`

**Canvas API Calls:**
- `POST /api/v1/courses/:id/discussion_topics`

---

#### `create_announcement`

**Purpose:** Create an announcement. Announcements are discussion topics with `is_announcement: true` — they appear in the Announcements section and are auto-published.

**Inputs:**
- `title` (string, required).
- `message` (string, optional): HTML body of the announcement.
- `course_id` (number, optional).

**Output:** `{ id, title, message, is_announcement, published, html_url }`

**Canvas API Calls:**
- `POST /api/v1/courses/:id/discussion_topics` (with `is_announcement: true, published: true`)

---

#### `upload_file`

**Purpose:** Upload a local file to the course Files section using Canvas's 3-step file upload protocol.

**Inputs:**
- `file_path` (string, required): Absolute path to the file on disk.
- `name` (string, optional): Override the filename stored in Canvas. Defaults to the basename of `file_path`.
- `folder_path` (string, optional): Destination folder path within course files (e.g., `"Week 3/Data Files"`). Defaults to the course root.
- `course_id` (number, optional).

**Output:** `{ id, display_name, size, content-type, url }`

**Canvas API Calls (3-step file upload protocol):**
1. `POST /api/v1/courses/:id/files` with `{ name, size, content_type, parent_folder_path }` → `{ upload_url, upload_params }`
2. `POST <upload_url>` (external S3/CDN URL — no auth header) with multipart form containing `upload_params` fields + file binary
3. If step 2 returns a redirect (301/303): `GET <Location>` with Canvas auth to confirm upload; if step 2 returns 200/201 with file JSON, use that directly.

**Notes:**
- Step 2 POSTs to an S3-signed URL, not the Canvas server — do not include the `Authorization` header.
- MIME type is inferred from the file extension using a hardcoded map; falls back to `application/octet-stream` for unknown extensions.

---

#### `create_rubric`

**Purpose:** Create a rubric and immediately associate it with an assignment for grading.

> **Canvas limitation — rubrics require an assignment association:** Canvas does not support standalone rubrics. A rubric with no assignment association enters an inconsistent "zombie" state: it appears in the course rubric list but returns 404 on individual GET and 500 on DELETE. The only recovery is to create an assignment-level association first, then delete the rubric. To prevent zombie rubrics, `create_rubric` always requires an `assignment_id` and creates the rubric and its association in a single API call using Canvas's `rubric_association` params on the rubric creation endpoint.

**Inputs:**
- `title` (string, required): Rubric title.
- `assignment_id` (number, required): Canvas assignment ID to associate the rubric with. The rubric will be used for grading this assignment.
- `criteria` (array, required): Each criterion has `description` (string), `points` (number), and `ratings` (array of `{ description, points }`).
- `use_for_grading` (boolean, optional): Use the rubric for grading. Defaults to `true`.
- `course_id` (number, optional).

**Output:** `{ id, title, points_possible, association_id, assignment_id, use_for_grading }`

**Canvas API Calls:**
- `POST /api/v1/courses/:id/rubrics` (with both `rubric` and `rubric_association` params in the same request body)

**Notes:**
- Canvas's rubric criteria API uses numeric string keys (`"0"`, `"1"`, ...) for both criteria and ratings, not arrays. This conversion is handled internally.
- Canvas returns `{ rubric: {...}, rubric_association: {...} }` — both objects are extracted from the response.
- Deleting the associated assignment also removes the rubric (Canvas cascades this). `delete_assignment` pre-deletes the rubric before deleting the assignment to avoid Canvas 500 errors from the reverse ordering.

---

#### `associate_rubric`

**Purpose:** Associate an existing rubric with a different assignment. Useful when a rubric created for one assignment should also be used for grading another.

**Inputs:**
- `rubric_id` (number, required): Canvas rubric ID.
- `assignment_id` (number, optional): Canvas assignment ID. If omitted, associates at the course level (used for rubric-bank purposes only — not for grading).
- `use_for_grading` (boolean, optional): Defaults to `true` when `assignment_id` is provided.
- `course_id` (number, optional).

**Output:** `{ id, rubric_id, association_id, association_type, use_for_grading, purpose }`

**Canvas API Calls:**
- `POST /api/v1/courses/:id/rubric_associations`

**Notes:** Canvas wraps the response in `{ rubric_association: {...} }` — the tool unwraps this before returning.

---

#### `update_syllabus`

**Purpose:** Set or replace the course syllabus body with arbitrary HTML.

**Inputs:**
- `body` (string, required): HTML content for the syllabus.
- `course_id` (number, optional).

**Output:** `{ updated: true, course_id }`

**Canvas API Calls:**
- `PUT /api/v1/courses/:id` with `{ course: { syllabus_body: body } }`

---

#### `create_page`

**Purpose:** Create a new wiki page in a course.

**Inputs:**
- `title` (string, required): Page title.
- `body` (string, optional): HTML body content.
- `published` (boolean, optional): Whether to publish immediately. Default `false`.
- `course_id` (number, optional).

**Output:** `{ page_id, url, title, published, front_page }`

**Canvas API Calls:**
- `POST /api/v1/courses/:id/pages`

---

#### `delete_page`

**Purpose:** Permanently delete a wiki page. Refuses to delete the course front page — the user must reassign the front page in Canvas first.

**Inputs:**
- `page_url` (string, required): Page URL slug (e.g. `"week-2-overview"`). Returned by `create_page` as the `url` field.
- `course_id` (number, optional).

**Canvas API Calls:**
- `GET /api/v1/courses/:id/pages/:url` — fetch page to check `front_page` status
- `DELETE /api/v1/courses/:id/pages/:url`

**Front page guard:** If `page.front_page === true`, returns an error message instructing the user to reassign the front page first. This prevents accidental deletion of the course home page.

---

#### `delete_discussion`

**Purpose:** Permanently delete a discussion topic.

**Inputs:**
- `topic_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/discussion_topics/:topic_id`

**Note:** Graded discussion topics are also assignments. Deleting the discussion topic deletes its associated assignment (and vice versa).

---

#### `delete_announcement`

**Purpose:** Permanently delete an announcement. (Announcements are discussion topics with `is_announcement=true`.)

**Inputs:**
- `topic_id` (number, required).
- `course_id` (number, optional).

**Canvas API Calls:**
- `DELETE /api/v1/courses/:id/discussion_topics/:topic_id`

---

#### `delete_file`

**Purpose:** Permanently delete a file from the course.

**Inputs:**
- `file_id` (number, required).

**Canvas API Calls:**
- `DELETE /api/v1/files/:file_id`

**Note:** File deletion is irreversible — there is no trash/recycle bin via the API.

---

#### `clear_syllabus`

**Purpose:** Clear the course syllabus body (set to empty string).

**Inputs:**
- `course_id` (number, optional).

**Canvas API Calls:**
- `PUT /api/v1/courses/:id` with `{ course: { syllabus_body: '' } }`

---

### 5.5 Reporting Tools

All reporting tools return structured data suitable for display as a table or summary narrative. They join multiple Canvas API responses internally.

> **FERPA note:** Student names and Canvas IDs returned by reporting tools are PII subject to FERPA. Phase 6 will add a PII blinding layer that replaces this data with opaque tokens before it reaches the LLM. See [Section 14](#14-ferpa-pii-blinding) for full design details and the list of required tool changes.

---

#### `get_class_grade_summary`

**Purpose:** Show every enrolled student's current grade total, final grade total, missing assignment count, and late assignment count. Primary tool for a quick class health check. With `sort_by: "engagement"`, produces a student standing report ordered from most-at-risk to least — useful for prioritizing follow-up outreach.

**Inputs:**
- `course_id` (number, optional).
- `assignment_group_id` (number, optional): Filter submission counts to a specific assignment group.
- `sort_by` (string, optional): `"name"` (default) | `"engagement"` | `"grade"` | `"zeros"`.
  - `"engagement"`: `missing_count DESC`, then `late_count DESC`, then `current_score ASC` (nulls first), then `name ASC`. Produces a standing report where most-at-risk students appear first.
  - `"grade"`: `current_score ASC`, nulls first, then `name ASC`. Surfaces students with the lowest (or no) grade first.
  - `"zeros"`: `zeros_count DESC`, then `name ASC`. `zeros_count` is the number of submissions where `score === 0` (explicit zero grades — a signal of non-participation).

**Output:**
```jsonc
{
  "course": "CSC 408 — Introduction to Machine Learning",
  "as_of": "2025-02-21T14:30:00Z",
  "sort_by": "engagement",
  "students": [
    {
      "id": 1001,
      "name": "Jane Smith",
      "current_score": 87.4,
      "final_score": 82.1,
      "missing_count": 3,
      "late_count": 1,
      "ungraded_count": 0,
      "zeros_count": 1
    },
    {
      "id": 1002,
      "name": "John Doe",
      "current_score": 94.1,
      "final_score": 91.0,
      "missing_count": 0,
      "late_count": 2,
      "ungraded_count": 1,
      "zeros_count": 0
    }
    // ...
  ]
}
```

**Canvas API Calls:**
1. `GET /api/v1/courses/:id/enrollments?type[]=StudentEnrollment&include[]=current_points`
2. `GET /api/v1/courses/:id/students/submissions?student_ids[]=all&include[]=assignment`

**Notes:**
- No additional Canvas API calls are required for the `sort_by` parameter — sorting is applied client-side to data already fetched.
- The `"engagement"` sort is the recommended input when generating a student standing report or identifying students for follow-up.
- `zeros_count` counts submissions where `score === 0` (not `null`/missing). A zero score means the instructor explicitly graded the work as zero, often indicating non-submission or non-participation.

---

#### `get_assignment_breakdown`

**Purpose:** For a specific assignment, show every student's submission status, score, and whether it is missing or late.

**Inputs:**
- `assignment_id` (number, required).
- `course_id` (number, optional).

**Output:**
```jsonc
{
  "assignment": { "id": 5001, "name": "Week 2 | Coding Assignment | ...", "points_possible": 10, "due_at": "..." },
  "submissions": [
    { "student_name": "Jane Smith", "student_id": 1001, "score": 9.5, "submitted_at": "...", "late": false, "missing": false, "grade_url": "..." },
    { "student_name": "John Doe",   "student_id": 1002, "score": null, "submitted_at": null, "late": false, "missing": true }
  ],
  "summary": { "submitted": 18, "missing": 2, "late": 1, "ungraded": 3, "mean_score": 8.7 }
}
```

**Canvas API Calls:**
- `GET /api/v1/courses/:id/assignments/:assignment_id/submissions?include[]=user`

---

#### `get_student_report`

**Purpose:** Deep report on a single student — all assignments with scores, missing/late flags, and current grade. Used when following up on a specific student.

**Inputs:**
- `student_token` (string, required): Session token for the student (e.g. `"[STUDENT_003]"`), obtained from a prior call to `get_class_grade_summary` or another reporting tool. The tool resolves this internally to a Canvas user ID; the Canvas ID is never exposed in any tool output.
- `course_id` (number, optional).

> **Phase 6 change:** The original `student_id: number` input was replaced by `student_token: string` when PII blinding was added. The LLM only ever knows tokens, so it cannot supply a raw Canvas user ID.

**Output:**
```jsonc
{
  "student": { "student_token": "[STUDENT_003]" },
  "current_score": 87.4,
  "assignments": [
    { "name": "Week 1 | Coding Assignment | ...", "due_at": "...", "score": 10, "points_possible": 10, "late": false, "missing": false },
    { "name": "Week 2 | Coding Assignment | ...", "due_at": "...", "score": null, "points_possible": 10, "late": false, "missing": true }
  ],
  "summary": { "total_missing": 1, "total_late": 0, "total_ungraded": 0 }
}
```

**Canvas API Calls:**
- `GET /api/v1/courses/:id/students/submissions?student_ids[]={student_id}&include[]=assignment`
- `GET /api/v1/courses/:id/enrollments?user_id={student_id}&type[]=StudentEnrollment`

---

#### `get_missing_assignments`

**Purpose:** List all missing assignments grouped by student. Ideal for generating a follow-up list.

**Inputs:**
- `course_id` (number, optional).
- `since_date` (ISO 8601 string, optional): Only include assignments due after this date.

**Output:** Students with any missing work, each listing the specific assignments missing.

**Canvas API Calls:**
- `GET /api/v1/courses/:id/students/submissions?student_ids[]=all&include[]=user&include[]=assignment&workflow_state=unsubmitted`

---

#### `get_late_assignments`

**Purpose:** List all late (submitted after due date) assignments grouped by student.

**Inputs:**
- `course_id` (number, optional).

**Canvas API Calls:**
- `GET /api/v1/courses/:id/students/submissions?student_ids[]=all&include[]=user&include[]=assignment` (filter by `late: true` on client side)

---

### 5.6 Reset Tools

See [Section 10](#10-safety--destructive-operations) for the full safety protocol.

---

#### `preview_course_reset`

**Purpose:** Dry run — list all content that would be deleted by `reset_course`. Does not modify anything.

**Inputs:**
- `course_id` (number, optional).

**Output:**
```jsonc
{
  "course": { "id": 12345, "name": "CSC 408 Sandbox" },
  "would_delete": {
    "modules": 6,
    "assignments": 24,
    "quizzes": 12,
    "pages": 18,
    "discussions": 4,
    "announcements": 2,
    "files": 8,
    "rubrics": 6,
    "assignment_groups": 3
  },
  "would_clear": {
    "syllabus": true
  },
  "preserves": {
    "enrollments": "not touched",
    "sections": "not touched",
    "settings": "not touched",
    "navigation": "not touched",
    "external_tools": "not touched"
  },
  "warning": "This action cannot be undone. Run reset_course with confirmation_text = \"CSC 408 Sandbox\" to proceed."
}
```

**Canvas API Calls:**
- `GET /api/v1/courses/:id` (for course name + syllabus_body)
- `GET /api/v1/courses/:id/modules`
- `GET /api/v1/courses/:id/assignments`
- `GET /api/v1/courses/:id/quizzes`
- `GET /api/v1/courses/:id/pages`
- `GET /api/v1/courses/:id/discussion_topics`
- `GET /api/v1/courses/:id/discussion_topics?only_announcements=true`
- `GET /api/v1/courses/:id/files`
- `GET /api/v1/courses/:id/rubrics`
- `GET /api/v1/courses/:id/assignment_groups`

---

#### `reset_course`

**Purpose:** Permanently delete all content from a course, leaving it completely empty except for enrollments and configuration. Deletes: modules, assignments, quizzes, discussion topics, announcements, pages, files, rubrics, and custom assignment groups. Clears the syllabus body.

**Inputs:**
- `confirmation_text` (string, required): Must exactly match the course name as returned by the API. Case-sensitive.
- `course_id` (number, optional).

**Output:** Summary of what was deleted.

**Canvas API Calls (sequential, each paginated):**
1. `GET /api/v1/courses/:id` — fetch course name and validate `confirmation_text`
2. `GET /api/v1/courses/:id/modules` → `DELETE .../modules/:id` for each
3. `GET /api/v1/courses/:id/assignments` → `DELETE .../assignments/:id` for each (each assignment pre-deletes its associated rubric before deletion to avoid Canvas 500s)
4. `GET /api/v1/courses/:id/quizzes` → `DELETE .../quizzes/:id` for each (note: quiz-backed assignments already deleted in step 3 — most will 404, handled gracefully)
5a. `GET /api/v1/courses/:id/discussion_topics` → `DELETE .../discussion_topics/:id` for each (note: graded discussions already deleted in step 3 — some will 404, handled gracefully)
5b. `GET /api/v1/courses/:id/discussion_topics?only_announcements=true` → `DELETE .../discussion_topics/:id` for each
6. `GET /api/v1/courses/:id/pages` → for each page: if `front_page === true`, `PUT /pages/:url` with `{ front_page: false }` first, then `DELETE .../pages/:url`
7. `GET /api/v1/courses/:id/files` → `DELETE /api/v1/files/:id` for each
8. `GET /api/v1/courses/:id/rubrics` → for each rubric: attempt `DELETE .../rubrics/:id`; if that fails (zombie rubric — Canvas 500), create a temporary assignment, `POST .../rubric_associations` to associate the zombie, retry delete, then delete the temp assignment; if recovery also fails, track in `rubrics_failed`
9. `GET /api/v1/courses/:id/assignment_groups` → `DELETE .../assignment_groups/:id` for each (all empty after step 3; Canvas keeps at least one — skip if last deletion errors)
10. `PUT /api/v1/courses/:id` with `{ course: { syllabus_body: '' } }` — clear syllabus

**Notes:** Deletion happens in the order listed. Module deletion removes module structure but not underlying content objects; steps 3–10 clean those up. Several content types overlap (quizzes ↔ assignments, graded discussions ↔ assignments), so later steps will encounter 404s from content already removed in earlier steps — all handled gracefully. See Section 10 for additional safety guards. See Section 12 for the rubric zombie limitation.

**What is preserved (not deleted):**
- Enrollments and sections (the roster)
- Course settings and navigation tab layout
- External tools (LTI configurations — typically institutional)
- Grading standards (account-level, no course-level delete API)

---

## 6. Canvas API Endpoint Reference

| Method   | Endpoint                                                              | Used By |
|----------|-----------------------------------------------------------------------|---------|
| GET      | `/api/v1/courses`                                                     | `list_courses` |
| GET      | `/api/v1/courses/:id`                                                 | `set_active_course`, `reset_course` |
| GET      | `/api/v1/courses/:id/modules`                                         | `list_modules`, `preview_course_reset` |
| POST     | `/api/v1/courses/:id/modules`                                         | `create_lesson_module`, `create_solution_module` |
| PUT      | `/api/v1/courses/:id/modules/:module_id`                              | `update_module`, publish/unpublish |
| DELETE   | `/api/v1/courses/:id/modules/:module_id`                              | `delete_module`, `reset_course` |
| GET      | `/api/v1/courses/:id/modules/:module_id/items`                        | `get_module_summary` |
| POST     | `/api/v1/courses/:id/modules/:module_id/items`                        | `add_module_item`, `create_lesson_module` |
| PUT      | `/api/v1/courses/:id/modules/:module_id/items/:item_id`               | `update_module_item` |
| DELETE   | `/api/v1/courses/:id/modules/:module_id/items/:item_id`               | `remove_module_item` |
| GET      | `/api/v1/courses/:id/assignments`                                     | `preview_course_reset` |
| GET      | `/api/v1/courses/:id/assignments/:assignment_id`                      | `get_module_summary` (HTML) |
| POST     | `/api/v1/courses/:id/assignments`                                     | `create_assignment`, `create_lesson_module` |
| PUT      | `/api/v1/courses/:id/assignments/:assignment_id`                      | `update_assignment` |
| DELETE   | `/api/v1/courses/:id/assignments/:assignment_id`                      | `delete_assignment`, `reset_course` |
| GET      | `/api/v1/courses/:id/assignment_groups`                               | `list_assignment_groups`, `preview_course_reset` |
| DELETE   | `/api/v1/courses/:id/assignment_groups/:id`                           | `reset_course` |
| GET      | `/api/v1/courses/:id/quizzes`                                         | `preview_course_reset` |
| POST     | `/api/v1/courses/:id/quizzes`                                         | `create_quiz`, `create_lesson_module` |
| POST     | `/api/v1/courses/:id/quizzes/:quiz_id/questions`                      | `create_quiz` |
| PUT      | `/api/v1/courses/:id/quizzes/:quiz_id`                                | `update_quiz` |
| DELETE   | `/api/v1/courses/:id/quizzes/:quiz_id`                                | `delete_quiz`, `reset_course` |
| GET      | `/api/v1/courses/:id/pages`                                           | `preview_course_reset`, `reset_course` |
| GET      | `/api/v1/courses/:id/pages/:url`                                      | `delete_page` |
| POST     | `/api/v1/courses/:id/pages`                                           | `create_page`, `create_lesson_module` |
| PUT      | `/api/v1/courses/:id/pages/:url`                                      | `reset_course` (unset front page before delete) |
| DELETE   | `/api/v1/courses/:id/pages/:url`                                      | `delete_page`, `reset_course` |
| GET      | `/api/v1/courses/:id/discussion_topics`                               | `preview_course_reset`, `reset_course` |
| GET      | `/api/v1/courses/:id/discussion_topics?only_announcements=true`       | `preview_course_reset`, `reset_course` |
| POST     | `/api/v1/courses/:id/discussion_topics`                               | `create_discussion`, `create_announcement` |
| DELETE   | `/api/v1/courses/:id/discussion_topics/:id`                           | `delete_discussion`, `delete_announcement`, `reset_course` |
| GET      | `/api/v1/courses/:id/files`                                           | `preview_course_reset`, `reset_course` |
| POST     | `/api/v1/courses/:id/files`                                           | `upload_file` (step 1: initiate upload, get S3 URL) |
| POST     | `<S3 signed upload_url>`                                              | `upload_file` (step 2: upload binary to S3/CDN — no Canvas auth) |
| GET      | `<Location redirect from step 2>`                                     | `upload_file` (step 3: confirm upload with Canvas auth, if redirected) |
| DELETE   | `/api/v1/files/:id`                                                   | `delete_file`, `reset_course` |
| GET      | `/api/v1/courses/:id/rubrics`                                         | `preview_course_reset`, `reset_course` |
| POST     | `/api/v1/courses/:id/rubrics`                                         | `create_rubric` (creates rubric + association in one call) |
| POST     | `/api/v1/courses/:id/rubric_associations`                             | `associate_rubric`, `reset_course` (zombie recovery) |
| DELETE   | `/api/v1/courses/:id/rubrics/:id`                                     | `reset_course` |
| PUT      | `/api/v1/courses/:id`                                                 | `update_syllabus`, `clear_syllabus`, `reset_course` (clear syllabus_body) |
| GET      | `/api/v1/courses/:id/enrollments`                                     | `get_class_grade_summary`, `get_student_report` |
| GET      | `/api/v1/courses/:id/students/submissions`                            | `get_class_grade_summary`, `get_missing_assignments`, `get_late_assignments`, `get_student_report` |
| GET      | `/api/v1/courses/:id/assignments/:assignment_id/submissions`          | `get_assignment_breakdown` |

---

## 7. Key Data Models

These TypeScript interfaces describe the core internal types. Canvas API responses are mapped to these before being used by tools.

```typescript
interface CourseInfo {
  id: number;
  name: string;
  courseCode: string;       // e.g. "CSC408"
  term: string;
  isActive: boolean;
}

interface ModuleSummary {
  id: number;
  name: string;
  published: boolean;
  unlock_at: string | null;
  prerequisite_module_ids: number[];
  items: ModuleItemSummary[];
}

interface ModuleItemSummary {
  id: number;
  position: number;
  type: "SubHeader" | "Page" | "Assignment" | "Quiz" | "ExternalUrl";
  title: string;
  content_id?: number;
  url?: string;             // for ExternalUrl
  points_possible?: number;
  due_at?: string;
  html?: string;            // assignment description HTML, if requested
  completion_requirement?: CompletionRequirement;
}

interface CompletionRequirement {
  type: "min_score" | "must_submit" | "must_view" | "must_mark_done";
  min_score?: number;
}

interface StudentSubmission {
  student_id: number;
  student_name: string;
  assignment_id: number;
  assignment_name: string;
  score: number | null;
  points_possible: number;
  submitted_at: string | null;
  late: boolean;
  missing: boolean;
  workflow_state: "submitted" | "unsubmitted" | "graded" | "pending_review";
}

interface StudentGradeSummary {
  student_id: number;
  student_name: string;
  current_score: number | null;
  final_score: number | null;
  missing_count: number;
  late_count: number;
  ungraded_count: number;
}

// Template item slot — defines what goes in a module position
interface TemplateSlot {
  type: "subheader" | "overview_page" | "assignment" | "quiz" | "page" | "external_url" | "reminder";
  titlePattern: string;     // Handlebars pattern, e.g. "Week {{week}} | Overview"
  optional: boolean;
  repeatable: boolean;
  defaultPoints?: number;
  submissionType?: string;
  quizType?: string;
}
```

---

## 8. Implementation Phases

Phases are ordered to make the server immediately useful at each stage, prioritizing read-only tools first (safe) and destructive tools last (carefully tested). Each phase's exit criterion requires its associated tests to pass before moving forward.

---

### Pre-Phase A — Unit Test Framework - COMPLETE

**Do this before writing any implementation code.**

- Install and configure Vitest + msw
- Establish `tests/unit/` directory structure mirroring `src/`
- Write a passing smoke test to confirm the framework works
- Add `npm test` script (unit tests only, no credentials required)
- Add `npm run test:integration` script (gated behind `.env.test`)

**Deliverables:**
```
package.json
tsconfig.json
tsconfig.build.json
.gitignore
vitest.config.ts
vitest.integration.ts
tests/
├── unit/
│   └── smoke.test.ts        # 2 passing tests: basic assertion + msw interception
├── integration/
│   └── .gitkeep
└── setup/
    ├── msw-server.ts         # shared msw server, wired as setupFile for unit tests
    └── integration-env.ts    # loads .env.test, fails fast if required vars missing
```

**Exit criterion:** `npm test` runs and passes a smoke test. No Canvas credentials needed.

---

### Pre-Phase B — Minimal Canvas Test Environment - COMPLETE

**Do this before Phase 1 implementation, in parallel with Pre-Phase A.**

1. Create a teacher account at `https://canvas.instructure.com`
2. Create a course named exactly `"TEST SANDBOX"`
3. Generate an API token for the teacher account (Profile → Settings → New Access Token)
4. Create `.env.test` with initial values:
   ```
   CANVAS_INSTANCE_URL=https://canvas.instructure.com
   CANVAS_API_TOKEN=<teacher_token>
   CANVAS_TEST_COURSE_ID=<course_id>
   ```
5. Confirm `.env` and `.env.test` are in `.gitignore`
6. Run the connectivity integration test suite (see below) and confirm all checks pass.
7. If the Classic Quizzes check fails: go to Course Settings → Feature Options and disable "New Quizzes", then re-run the test.

**Connectivity test (`tests/integration/connectivity.test.ts`):**

This test suite ships with the repo and is the formal exit criterion for Pre-Phase B. It verifies:

| Test | What it checks |
|---|---|
| Authenticates with Canvas API | Token is valid; `GET /api/v1/users/self` returns 200 |
| Can access the test course | Course ID resolves; teacher has access |
| Has teacher-level access | Token belongs to an active TeacherEnrollment on the course |
| Can read and write assignments | Creates and immediately deletes a throwaway assignment to confirm write permissions |
| Classic Quizzes available | Checks `quizzes_next` feature flag; fails with instructions if New Quizzes is on |
| Pagination returns Link header | Confirms the instance returns `Link` headers for multi-page responses |

Run with:
```
npm run test:integration
```

**Exit criterion:** All 6 tests in `tests/integration/connectivity.test.ts` pass.

---

### Pre-Phase C — Full Integration Test Environment - COMPLETE

**Do this in parallel with Phase 1, must be complete before Phase 2.**

This stage adds student accounts and the seed script so that reporting tools have realistic data to work against.

1. Create 5 student accounts using email `+` addressing (e.g., `you+s1@gmail.com`)
2. Enroll all 5 as Students in `TEST SANDBOX`
3. Generate an API token for each student account
4. Add student tokens to `.env.test`:
   ```
   STUDENT0_API_TOKEN=<token>
   STUDENT1_API_TOKEN=<token>
   STUDENT2_API_TOKEN=<token>
   STUDENT3_API_TOKEN=<token>
   STUDENT4_API_TOKEN=<token>
   ```
5. Write `scripts/seed-test-data.ts` using raw `fetch` calls against the Canvas API — **not** the MCP tools. The seed script must be independent of the code it is testing.
6. The seed script establishes the state defined in Section 13.2 (varied submission/grade states across 5 students and 3 assignments).
7. Add `npm run seed` script that runs the seed against `CANVAS_INSTANCE_URL` from `.env.test`.

**Exit criterion:** `npm run seed` completes without errors. A manual call to `GET /api/v1/courses/:id/students/submissions` returns submissions matching the table in Section 13.2.

---

### Phase 1 — Foundation - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B

- Project scaffolding: TypeScript, `@modelcontextprotocol/sdk`, build pipeline.
- Canvas API client: auth, pagination, rate limiting, error normalization.
- Config manager: read/write `~/.canvas-teacher-mcp/config.json`, schema validation.
- Tools: `list_courses`, `set_active_course`, `get_active_course`.

**Tests written in this phase:**
- Unit: config manager read/write, fuzzy course resolution logic, API client pagination + retry + error normalization (all mocked)
- Integration: `list_courses` returns real courses, `set_active_course("TEST SANDBOX")` resolves correct ID, `courseCache` is written to `.env.test` config
- MCP protocol: tool list, schema validation for context tools

**Exit criterion:** Can authenticate to Canvas, list courses, and set/get active course. All Phase 1 tests pass.

---

### Phase 2 — Read-Only Reporting - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B + Pre-Phase C (seed must be run)

- Tools: `list_modules`, `get_module_summary`, `list_assignment_groups`.
- Tools: `get_class_grade_summary` (with `sort_by` parameter), `get_assignment_breakdown`, `get_student_report`, `get_missing_assignments`, `get_late_assignments`.

**Tests written in this phase:**
- Unit: grade/submission data transformations, missing/late flag filtering, pagination across large result sets (mocked)
- Unit: `get_class_grade_summary` with `sort_by: "engagement"` — student with highest `missing_count` appears first; ties broken by `late_count` then `name`
- Unit: `get_class_grade_summary` with `sort_by: "grade"` — lowest/null score first; `sort_by: "zeros"` — most zero-scored submissions first
- Unit: `zeros_count` field present on all rows; counts only `score === 0` submissions (not null)
- Integration: all reporting suites against seeded data — results verified against known seed state from Section 13.2
- Integration: `get_class_grade_summary` with `sort_by: "engagement"` — students are sorted by missing_count descending (sort-order assertion, not brittle "first student" check)
- Integration: `get_class_grade_summary` with `sort_by: "grade"` — null-score student first; `sort_by: "zeros"` — `zeros_count` field present
- MCP protocol: response format for all reporting tools

**Exit criterion:** Can generate a full grade health report for a class and identify students needing follow-up. `sort_by: "engagement"` produces a student standing report ordered from most-at-risk to least. All Phase 2 tests pass against seeded data.

---

### Phase 3 — Low-Level Content Creation - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B (reset before each integration run)

- Tools: `create_assignment`, `update_assignment`, `delete_assignment`, `create_quiz`, `update_quiz`, `delete_quiz`.
- Tools: `create_page`, `delete_page`.
- Tools: `add_module_item`, `update_module_item`, `remove_module_item`, `update_module`, `delete_module`.
- Assignment description HTML template rendering (Handlebars).
- Front page guard: `delete_page` checks `front_page` status and refuses deletion if the page is the course front page.

**Tests written in this phase:**
- Unit: Handlebars template rendering (H3 + bold + link structure), input validation for all tools, `dry_run` validation path, `delete_page` front page rejection
- Integration: `create_assignment` / `delete_assignment` round-trips, `create_quiz` / `delete_quiz` round-trips, `create_page` / `delete_page` round-trips (including front page rejection), module item CRUD sequence; `afterAll` cleanup via delete tools
- MCP protocol: write tool schema validation

**Exit criterion:** Can create and modify individual assignments and module items. All Phase 3 tests pass.

---

### Phase 4 — High-Level Module Creation - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B (reset before each integration run)

- Module template system: loader, renderer, slot validation.
- Tools: `create_lesson_module`, `create_solution_module`, `clone_module`.
- Exit card quiz creation with config-driven question template.

**New files:** `src/canvas/pages.ts`, `src/templates/index.ts`, `src/tools/modules.ts`, `tests/unit/tools/modules.test.ts`, `tests/integration/modules.test.ts`

**Modified files:** `src/canvas/modules.ts` (added `page_url`), `src/canvas/assignments.ts` (added `getAssignment`), `src/canvas/quizzes.ts` (added `getQuiz`, `listQuizQuestions`), `src/index.ts` (registered `registerModuleTools`)

**Tests written in this phase:**
- Unit: 12 tests — dry_run preview, later-standard full creation, Handlebars description rendering, exit card week substitution, partial failure reporting, create_solution_module with prerequisites, clone_module week substitution, no-active-course errors
- Integration: full lesson + solution module creation suites, clone module with week number substitution (requires CANVAS_TEST_MODULE_ID seed)
- MCP protocol: high-level tool schemas

**Exit criterion:** Can create a complete lesson module + solution module pair from a single high-level tool call. All Phase 4 tests pass.

**Result:** 110 unit tests passing (98 pre-phase + 12 new).

---

### Phase 5 — Destructive Operations - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B (integration tests rely on resetting the test course)

- Tools: `preview_course_reset`, `reset_course`.
- Full confirmation safety protocol (see Section 10).
- Front page auto-unset: `reset_course` calls `PUT /pages/:url` with `{ front_page: false }` before deleting any page marked as the front page.

**New files:** `src/tools/reset.ts`, `tests/unit/tools/reset.test.ts`, `tests/integration/reset.test.ts`

**Modified files:** `src/index.ts` (registerResetTools), `src/canvas/courses.ts` (getCourse), `src/canvas/pages.ts` (added `front_page` to `CanvasPage`, added `updatePage`, `getPage`)

**Tests written in this phase:**
- Unit: preview counts, confirmation text matching (case-sensitive), wrong text rejection, sandbox warning, no-active-course errors, front page auto-unset before deletion (9 tests)
- Integration: `preview_course_reset` counts match actual content; `reset_course` with wrong confirmation text rejected (verifies counts unchanged); `reset_course` with correct text deletes all content including explicitly created front page (verifies post-reset all zeros); `afterAll` reseeds test course via `npm run seed`

**Result:** 125 unit tests + 60 integration tests (all passing)

**Exit criterion:** Can safely clear a course with explicit confirmation, including front page handling. All Phase 5 tests pass.

---

### Phase 5b — Complete Course Reset (missed from original plan)

**Prerequisites:** Phase 5 complete.

Phase 5 implemented `reset_course` but only deletes modules, assignments, quizzes, and pages. Several course content types were missed from the original plan and must be added for a truly complete reset.

**Missing content types to add:**

| Content Type | Standalone Tool | Reset Step | API Endpoints | Notes |
|---|---|---|---|---|
| **Discussion Topics** | `delete_discussion` | Step 5 (after assignments) | `GET .../discussion_topics` → `DELETE .../discussion_topics/:id` | Graded discussions are also assignments — some will 404 after step 3, handle gracefully. Same overlap pattern as quizzes ↔ assignments. |
| **Announcements** | `delete_announcement` | Included in step 5 | `GET .../discussion_topics?only_announcements=true` → `DELETE .../discussion_topics/:id` | Announcements are discussion topics with `is_announcement=true`. A single pass over all discussion topics covers both. Preview should count them separately for clarity. |
| **Files** | `delete_file` | Step 6 (after pages) | `GET .../files` → `DELETE /api/v1/files/:id` | File deletion is **irreversible** — no trash/recycle bin via the API. |
| **Syllabus** | `clear_syllabus` | Step 9 (last) | `PUT /api/v1/courses/:id` with `{ course: { syllabus_body: '' } }` | Not a delete — clears the syllabus body to empty string. |
| **Rubrics** | `create_rubric`, `associate_rubric` (added Phase 5b+) | Step 7 (after files) | `GET .../rubrics` → `DELETE .../rubrics/:id` | MCP-created rubrics are always assignment-associated and are pre-deleted when their assignment is deleted (step 2). Step 7 sweeps any orphans (e.g., Canvas-UI-created rubrics). **Zombie state warning:** a rubric with no active associations returns 500 on DELETE — recovery added in Phase 5b+ (see Section 12). |
| **Assignment Groups** | — | Step 8 (after rubrics) | `GET .../assignment_groups` → `DELETE .../assignment_groups/:id` | All groups are empty after step 2. Canvas always keeps at least one group — skip error on last deletion. |

**New canvas/ module files:** `src/canvas/discussions.ts`, `src/canvas/files.ts`, `src/canvas/rubrics.ts`

**Modified files:**
- `src/canvas/courses.ts` — add `updateCourse` for syllabus clearing
- `src/canvas/assignments.ts` — add `listAssignmentGroups` (already has read), add `deleteAssignmentGroup`
- `src/tools/content.ts` — register `delete_discussion`, `delete_announcement`, `delete_file`, `clear_syllabus`
- `src/tools/reset.ts` — add steps 5–10 to `reset_course`; update `preview_course_reset` to count all new types

**Updated deletion order for `reset_course`:**
1. Modules (structure only)
2. Assignments (also removes graded discussions + quiz-backed assignments; each pre-deletes its associated rubric)
3. Quizzes (remaining; handle 404s)
4a. Discussion topics (remaining; handle 404s from graded discussions already deleted)
4b. Announcements (separate query: `?only_announcements=true`)
5. Pages (unset front page first)
6. Files
7. Rubrics (remaining orphans; zombie recovery added in Phase 5b+)
8. Assignment groups (all empty; skip last if Canvas errors)
9. Clear syllabus body

**Content type overlap diagram:**
```
assignments ←→ quizzes        (every quiz is an assignment)
assignments ←→ discussions    (graded discussions are assignments)
discussions ←→ announcements  (announcements are discussion topics)
```
Deleting assignments first cascades to quiz-backed and graded-discussion assignments. Steps 3–4 clean up the remaining standalone quizzes and discussions, handling 404s from already-deleted items.

**What is explicitly preserved:**
- Enrollments and sections (roster)
- Course settings and navigation tab layout
- External tools / LTI configurations (institutional config, not content)
- Grading standards (account-level, no course-level delete API)

**Exit criterion:** `reset_course` deletes all content types listed above. `preview_course_reset` counts all types. Post-reset preview shows all zeros. Standalone tools (`delete_discussion`, `delete_announcement`, `delete_file`, `clear_syllabus`) work independently.

---

### Phase 5b+ — Creation Tools & Rubric Architecture - COMPLETE

**Prerequisites:** Phase 5b complete.

Adds creation tools for the content types introduced in Phase 5b (which only added delete and reset support), plus a rubric association tool and syllabus update tool. Also enforces the correct Canvas rubric architecture to prevent zombie rubric state.

**New tools:**
- `create_discussion` — creates a discussion topic
- `create_announcement` — creates an announcement (discussion with `is_announcement: true`)
- `upload_file` — 3-step Canvas/S3 file upload protocol
- `create_rubric` — creates a rubric and immediately associates it with an assignment (required by Canvas — see Rubric Architecture below)
- `associate_rubric` — associates an existing rubric with a different assignment
- `update_syllabus` — sets the course syllabus body

**Rubric Architecture — Canvas Limitation:**

Canvas does not support standalone rubrics. A rubric must have at least one active assignment association or it enters an inconsistent "zombie" state: it is visible in `GET /courses/:id/rubrics` (the list endpoint) but returns `404` on `GET /courses/:id/rubrics/:id` (the individual endpoint) and `500` on `DELETE`. This is a Canvas-side bug — the rubric list and rubric detail APIs are inconsistent.

**Prevention:** `create_rubric` requires `assignment_id` and sends both `rubric` and `rubric_association` params in a single `POST /api/v1/courses/:id/rubrics` call. This guarantees every MCP-created rubric is associated from the moment it is created.

**Recovery during `reset_course`:** MCP-created rubrics are already deleted in step 3 (when their host assignment is deleted). Step 8 sweeps any remaining rubrics (e.g., rubrics created via the Canvas UI). If a rubric returns 500 on DELETE (zombie state), the recovery sequence is: (1) create a temporary assignment, (2) `POST /rubric_associations` to associate the zombie rubric with it, (3) retry `DELETE /rubrics/:id` (now succeeds), (4) delete the temp assignment. If recovery also fails, the rubric ID is tracked in `rubrics_failed` in the response and a warning is emitted — the reset continues.

**New/modified files:**
- `src/canvas/discussions.ts` — added `createDiscussionTopic`
- `src/canvas/files.ts` — added `uploadFile` (3-step protocol)
- `src/canvas/rubrics.ts` — updated `createRubric` to require `assignment_id` and send `rubric_association` params; added `createRubricAssociation`; `CreateRubricParams.assignment_id` is required
- `src/tools/content.ts` — added 6 new tool registrations; updated `create_rubric` schema to require `assignment_id`
- `src/tools/reset.ts` — updated step 8 with zombie recovery (create temp assignment + association, retry delete); updated step 5 to include announcements; added `createAssignment` and `createRubricAssociation` imports

**Tests written in this phase:**
- Unit: `create_discussion`, `create_announcement`, `upload_file` (3-step mock), `create_rubric` (verifies assignment_id in POST body + numeric-keyed criteria format + association response fields), `associate_rubric` (verifies wrapped response unwrapping), `update_syllabus` — 2 tests each (success + no-active-course)
- Integration: all 6 new tools verified against live Canvas; `associate_rubric` tests re-association of an existing rubric to a second assignment; reset integration updated to create assignment before rubric in test setup

**Result:** 148 unit tests passing (pre-Phase 6; Phase 6 added 35 more for a total of 183).

**Exit criterion:** All 6 creation tools work end-to-end. `create_rubric` always produces an associated rubric — no zombie state possible via MCP tools. `reset_course` handles pre-existing zombie rubrics via the recovery sequence. All Phase 5b+ tests pass.

---

### Phase 6 — FERPA / UC / CSU PII Blinding - COMPLETE

**Prerequisites:** Phase 2 complete (reporting tools must exist before adding the blinding layer).

**Regulatory context:** Student grade records, submission data, names, and Canvas IDs are FERPA-protected PII. UC and CSU system policies additionally require that student data not be transmitted to third-party systems without explicit consent. When this server is used with a cloud-hosted LLM (Claude Desktop → Anthropic API), every tool response containing student PII is transmitted to a third-party. Phase 6 eliminates that exposure.

**Core requirement:** Blinding is **always on and cannot be disabled**. There is no opt-in switch. The LLM sees only opaque session tokens; real student data never leaves the local machine.

See [Section 14](#14-ferpa-pii-blinding) for the full security architecture.

**Deliverables:**
- `src/security/secure-store.ts` — `SecureStore` class: AES-256-GCM in-memory encryption, mlocked session key, zero-fill on exit
- `src/tools/reporting.ts` — modified to accept `SecureStore`, blind all student PII in output, emit dual-audience MCP responses (`audience: ["assistant"]` for tokens, `audience: ["user"]` for the lookup table)
- `src/index.ts` — modified to instantiate `SecureStore` on startup, register `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handlers that call `secureStore.destroy()`, pass `SecureStore` to `registerReportingTools`
- New tools: `resolve_student`, `list_blinded_students`
- `get_student_report` input schema updated to accept `student_token` (string) in place of `student_id` (number)
- `package.json` — added `posix-node: ^0.12.0` native dependency (provides mlock; wraps POSIX mlock via Zig + node-gyp)
- Startup command includes `--secure-heap=65536` (recommended in Claude Desktop config)

> **Package note:** The original plan referenced `mlock` npm package (404 on npm). The actual implementation uses `posix-node` (v0.12.0, BSD-3-Clause, SageMath team) which provides `posixNode.mlock(buffer)` / `posixNode.munlock(buffer)`. mlock is wrapped in try/catch and is non-fatal on failure.

**No config additions.** The feature has no on/off switch and requires no persistent state.

**New files:** `src/security/secure-store.ts`, `tests/unit/security/secure-store.test.ts`

**Modified files:** `src/tools/reporting.ts`, `src/index.ts`, `package.json`, `tests/unit/tools/reporting.test.ts`, `tests/integration/reporting.test.ts`

**Tests written in this phase:**
- Unit (10 new in `tests/unit/security/secure-store.test.ts`): `SecureStore.tokenize()` returns consistent token for same Canvas ID within a session; different IDs get different tokens; `SecureStore.resolve()` decrypts correctly; `SecureStore.destroy()` zero-fills session key (resolve returns null after destroy); encounter order preserved; no duplicates in `listTokens()`
- Unit (updated `tests/unit/tools/reporting.test.ts`): reporting tool responses contain no raw student names or Canvas IDs in the `assistant`-audience content block; `audience` annotations are present and correct on both content blocks; `get_student_report` accepts a token and resolves it correctly; `resolve_student` and `list_blinded_students` tool tests
- Integration (updated `tests/integration/reporting.test.ts`): no real student names or Canvas IDs appear in any reporting tool's `assistant`-audience content; `resolve_student` response carries `audience: ["user"]`; `get_student_report` called with a token from a prior `get_class_grade_summary` call returns correct student data; sort-order assertion changed from "Student 4 appears first" to "students are sorted by missing_count descending" (more robust)

**Result:** 183 unit tests + 72 integration tests (all passing).

**Exit criterion:** No student name or Canvas numeric ID appears in any content block addressed to the LLM (`audience: ["assistant"]`). The `SecureStore` session key survives process startup, responds to decryption correctly, and is zeroed on process exit. All Phase 6 tests pass.

---

## 9. Error Handling Philosophy

### Principle: Partial Success is Better Than Silent Failure

For multi-step operations (`create_lesson_module`, `reset_course`), if an intermediate step fails:
- **Do not attempt rollback.** Rollback is complex, error-prone, and may itself fail.
- **Do not silently continue.** Skipping a failed item and proceeding can leave content in an inconsistent state.
- **Report exactly what was completed and where it stopped.** Include the Canvas IDs of everything created so far so the instructor can manually remediate or the AI can continue.

### Error Response Shape

```typescript
interface ToolError {
  tool: string;
  step: string;           // e.g., "Creating assignment: Week 2 | Coding Assignment"
  canvas_status: number;  // HTTP status from Canvas
  canvas_message: string; // Canvas error message
  completed_before_failure: ModuleItemSummary[];  // What was already created
}
```

### Validation Before Execution

High-level tools (`create_lesson_module`, `create_solution_module`) validate their full input before making any API calls. If the input is invalid (e.g., `template` name doesn't exist, `items` array doesn't match template slots), return an error immediately with no Canvas calls made.

---

## 10. Safety & Destructive Operations

### Scope of Destructive Tools

The following tools permanently delete course content: `reset_course`, `delete_module`, `delete_assignment`, `delete_quiz`, `delete_page`, `delete_discussion`, `delete_announcement`, `delete_file`, `clear_syllabus`.

### `reset_course` Safety Protocol

1. **Naming guard:** Before calling this tool, the AI must call `preview_course_reset` and show the output to the user.
2. **Confirmation text:** The tool requires `confirmation_text` to exactly match the Canvas course name (case-sensitive, character-for-character). The AI must ask the user to type the name explicitly.
3. **Enrollment preservation:** Student enrollment records, sections, and course settings are never touched.
4. **Front page handling:** Before deleting pages, `reset_course` automatically unsets any front page designation via `PUT /pages/:url` with `{ front_page: false }`. This is necessary because Canvas forbids deleting the front page directly.
5. **File deletion is irreversible:** Unlike other content, deleted files have no recycle bin in the Canvas API. The preview shows file counts explicitly so the user can confirm.

### `delete_page` Front Page Guard

`delete_page` fetches the page via `GET /pages/:url` before deletion. If `front_page === true`, the tool returns an error instructing the user to reassign the front page first. Unlike `reset_course` (which auto-unsets), the single-page tool requires explicit user action to avoid accidental front page removal.

### Example Safe Invocation Sequence (for AI assistants)

```
1. Call preview_course_reset(course_id=12345)
2. Show the user the full output including the warning message
3. Ask the user: "To confirm, please type the exact course name shown above."
4. User types: "CSC 408 Sandbox — Spring 2025"
5. Call reset_course(course_id=12345, confirmation_text="CSC 408 Sandbox — Spring 2025")
```

---

## 11. Future Integrations Roadmap

These are explicitly planned future capabilities, documented here so that design decisions in the current implementation do not inadvertently block them.

### Zoom MCP Integration — Attendance Grading

**Goal:** Cross-reference Zoom participant reports with Canvas "Reminder | Attend Weekly Discussion" and "Reminder | Check In With Your Instructor" assignments to automatically enter grades.

**Approach:**
- A separate Zoom MCP server retrieves participant reports (name, join time, leave time, duration) for a given meeting.
- The Canvas Teacher MCP server provides a tool (e.g., `grade_attendance_from_zoom`) that accepts a meeting ID, a Canvas assignment ID, and grading rules (e.g., `{ min_minutes: 45, full_credit: 60, partial_credit: 20 }`).
- The tool matches Zoom participants to Canvas students by name/email and submits grades via `PUT /api/v1/courses/:id/assignments/:assignment_id/submissions/:user_id`.

**Grading rules to support:**
- Weekly discussion sessions: graded by minutes participated, with configurable thresholds for full vs. partial credit.
- Instructor office hours: graded by presence above a minimum threshold.
- TA office hours: voluntary — not graded.

**Design consideration now:** The `reminder` slot type in module templates should store the `assignment_group_id` and default points in a way that a future Zoom tool can reference them without re-querying.

### YouTube MCP Integration — Video Page Creation

**Goal:** Instead of creating empty Page shells for Canvas Studio videos, pull a video from a YouTube channel or playlist by title/ID and insert an embedded player into the Page HTML.

**Approach:**
- A separate YouTube MCP server retrieves video metadata and embed URLs.
- The Canvas Teacher MCP server's `create_lesson_module` accepts an optional `youtube_video_id` per video page slot.
- If provided, the Page description is populated with a standard YouTube embed `<iframe>` block.

**Design consideration now:** The `page` slot in module templates should have an optional `embed_url` field in its item descriptor — currently unused, set to null — so the interface is stable when this is added.

### Canvas Studio Embed Support

**Goal:** Provide Canvas Studio media IDs directly in module creation, rather than embedding manually after the fact.

**Approach:** Canvas Studio has a separate API. If the media ID is known, the Page HTML can include the Canvas Studio embed iframe. Requires institution-specific Canvas Studio API access.

### Solution Walkthrough Videos

**Goal:** Add walkthrough video pages to solution modules, either as Canvas Studio embeds or YouTube links.

**Approach:** Extend the `solutions` array in `create_solution_module` to accept an optional `walkthrough_url` per solution item. If provided, a Page item is created after the ExternalUrl item.

---

## 12. Known Limitations

| Limitation | Detail |
|---|---|
| Classic Quizzes only | New Quizzes (Canvas Quiz Engine) has a different, less complete API. All quiz tools target Classic Quizzes. |
| Quiz creation returns 200, not 201 | `POST /api/v1/courses/:id/quizzes` returns HTTP 200 on success. Assignment creation returns 201. The API client must accept both — do not use a single status-code check across all POST calls. Verified against canvas.instructure.com. |
| `login_id` not exposed on free accounts | `GET /api/v1/users/self` does not return `login_id` on canvas.instructure.com free accounts. Not a functional issue — `id` is used for all API operations. |
| Canvas Studio | Videos must be embedded manually post-creation. The API does not expose a public endpoint for creating Studio media items programmatically. |
| Content Migrations async | The Canvas Content Migrations API (used for full course copy) is asynchronous — it returns a job ID and the result is available later. `clone_module` avoids this by re-creating objects directly via the item-level APIs, which is synchronous but slower for large modules. |
| `reset_content` endpoint | Canvas has a `POST /api/v1/courses/:id/reset_content` endpoint but it **changes the course ID** (deletes the course and creates a new one). This breaks external bookmarks, API integrations, and LTI configurations. The surgical deletion approach in `reset_course` preserves the course ID. Additionally, `reset_content` requires admin-level "Courses - Reset" permission. |
| File deletion is irreversible | `DELETE /api/v1/files/:id` has no undo — Canvas provides no recycle bin via the API. The `reset_course` preview explicitly shows file counts so the user can confirm. |
| Assignment group minimum | Canvas always keeps at least one assignment group per course. `reset_course` deletes all groups but handles the error on the last one gracefully. |
| Graded discussion ↔ assignment overlap | Graded discussions are also assignments. Deleting assignments in `reset_course` step 3 cascade-deletes their graded discussions. The discussion deletion step (step 5) handles the resulting 404s gracefully, same pattern as the quiz ↔ assignment overlap. |
| Rubric zombie state (Canvas bug) | Canvas rubrics with zero active assignment associations enter an inconsistent zombie state: they appear in the course rubric list (`GET /courses/:id/rubrics`) but return `404` on the individual GET and `500` on DELETE. This is caused by creating rubrics via the Canvas UI without linking them to an assignment, or by deleting all assignments associated with a rubric without first deleting the rubric. **Prevention:** `create_rubric` always requires `assignment_id` and creates the rubric + association atomically. **Recovery:** `reset_course` step 8 detects zombie rubrics (DELETE returns non-404 error) and revives them by creating a temporary assignment, associating the rubric, deleting the rubric, then deleting the temp assignment. Rubrics that cannot be recovered are reported in `rubrics_failed`. |
| `delete_assignment` pre-deletes rubric | When deleting an assignment that has an associated rubric (`rubric_settings.id` present), `delete_assignment` first calls `DELETE /courses/:id/rubrics/:id` before deleting the assignment. Canvas returns 500 when you try to delete an assignment whose rubric was already deleted separately; the pre-delete ensures the cleanup order is always safe. |
| Calendar events | Course-level calendar events (e.g., office hours, review sessions) are not deleted by `reset_course`. These are less common and considered optional cleanup. API: `GET /calendar_events?context_codes[]=course_X` → `DELETE /calendar_events/:id`. |
| Learning outcomes | Outcome groups/links are not deleted by `reset_course`. Often institution-level and shared across courses. API exists (`GET/DELETE .../outcome_groups/:id`) but rarely needed for a content reset. |
| Rate limits | Canvas imposes rate limits that vary by institution. The client applies conservative delays but very large batch operations (e.g., full sandbox reset on a large course) may hit limits and require retries. |
| Submission URL validation | Canvas does not validate that a submitted URL is actually a valid Colab notebook. The tool cannot enforce correct submission format. |
| Pagination maximum | Canvas caps per-page results at 100. Courses with more than 100 items of any type (assignments, students, etc.) require multiple paginated requests, which is handled automatically by the client. |

---

## 13. Testing & Validation

### 13.1 Test Environment

All integration tests run against a **free Instructure Canvas account** (`https://canvas.instructure.com`), completely separate from the institution's managed Canvas instance. This provides full API access with zero risk of touching live courses.

**Why this environment:**
- Isolated from institutional data and students
- Full account control — can create courses, users, and tokens freely
- Canvas REST API is identical across all hosted instances
- Destructive operations (sandbox reset) can run safely

**Initial setup steps (one-time):**
1. Create a teacher account at `https://canvas.instructure.com`
2. Create 4–5 student accounts using email `+` addressing (e.g., `you+s1@gmail.com` through `you+s5@gmail.com`)
3. Create a test course named `"TEST SANDBOX"` — enroll all student accounts as Students
4. Generate an API token for the teacher account (Profile → Settings → New Access Token)
5. Generate an API token for each student account (same flow, logged in as each student)
6. **Verify Classic Quizzes is available:** In the test course, go to Settings → Feature Options and confirm Classic Quizzes is enabled. New Quizzes may be the default on `canvas.instructure.com` and must be switched off.
7. Store all tokens in `.env.test` (see Section 13.4)

**What is NOT available on `canvas.instructure.com`:**
- Canvas Studio (separately licensed product) — does not affect testing since video pages are embedded manually

---

### 13.2 Testing Layers

#### Layer 1 — Unit Tests

**Purpose:** Test internal logic that does not require a real Canvas instance. All HTTP calls are mocked.

**Framework:** Vitest + `msw` (Mock Service Worker for fetch interception)

**What is unit tested:**

| Area | What is tested |
|---|---|
| Canvas API client | Pagination: follows `Link` headers across multiple pages |
| | Rate limiting: delays when `X-Rate-Limit-Remaining < 10` |
| | Retry: exponential backoff on HTTP 429, max 3 attempts |
| | Error normalization: Canvas error shapes → `ToolError` |
| Course resolution | Fuzzy match: `"408 spring"` matches `"CSC408 Spring 2026"` |
| | Disambiguation: multiple matches returns list, not first result |
| | No match: returns filtered course list from `courseCodes` |
| | Term token extraction: correctly splits code vs. term tokens |
| Template rendering | Handlebars assignment description → expected HTML structure |
| | H3 + bold + link rendered correctly for notebook URL |
| | Exit card title substitutes `{{week}}` correctly |
| | Missing optional variables degrade gracefully |
| Config manager | Read: parses valid config file, applies defaults for missing keys |
| | Write: `courseCache` populated after resolution, persisted to disk |
| | Validation: missing `instanceUrl` or `apiToken` returns clear error |
| Input validation | Tools reject missing required fields before any API call |
| | `dry_run: true` performs validation only, returns what would be created |
| Page tools | `create_page` returns `page_id`, `url`, `title`, `published`, `front_page` |
| | `delete_page` fetches page first to check `front_page` status |
| | `delete_page` returns error when page is the course front page |
| Reset tools | `preview_course_reset` returns correct counts |
| | `reset_course` confirmation text matching (case-sensitive) |
| | `reset_course` rejects wrong confirmation text |
| | `reset_course` auto-unsets front page designation before deleting pages |

**Run command:** `npm test` (runs on every push, no credentials required)

**Result:** 183 unit tests passing

---

#### Layer 2 — Integration Tests

**Purpose:** Verify correct end-to-end behavior against the real Canvas API. These tests create, read, and delete real content in the test environment.

**Framework:** Vitest with a separate config (`vitest.integration.ts`), tagged `integration`

**Run command:** `npm run test:integration` (requires `.env.test` — opt-in only)

**State management strategy:**
- Each test suite begins by calling `reset_course` on the test course to establish a clean slate
- The reset itself is validated as part of the suite setup (confirming the course is empty after reset)
- After reset, a **seed script** (`scripts/seed-test-data.ts`) creates a known content state
- Tests then run assertions against that known state
- No cleanup at the end — the next suite's reset handles it

**Seed script design (Option 3):**
- The seed script uses the **teacher API token** for all content creation (modules, assignments, quizzes)
- The seed script uses **student API tokens** to submit assignments on behalf of each student and to set varied submission states (submitted, missing, late)
- The seed script uses the **teacher API token** to grade a subset of submissions
- Once seeding is complete, student tokens are no longer used — all test assertions use the teacher token only
- Student tokens are stored in `.env.test` but are only read by `scripts/seed-test-data.ts`, never by the MCP server itself or the test assertions

**Seeded state after running seed script:**

Due dates: A1 = 2 weeks ago, A2 = 1 week ago, A3 = 1 week from now (future), Exit card = 2 weeks ago

| Student | Assignment 1 | Assignment 2 | Assignment 3 | Exit Card |
|---|---|---|---|---|
| Student 1 | Late + graded (10/10) | Late + graded (8/10) | On-time, ungraded | Submitted (late, auto-graded) |
| Student 2 | Late + graded (7/10) | Missing | On-time + graded (9/10) | Missing |
| Student 3 | Late + graded (9/10) | Late + graded (10/10) | Not yet due | Submitted (late, auto-graded) |
| Student 4 | Missing | Missing | Not yet due | Missing |
| Student 5 | Late + graded (5/10) | Late, ungraded | On-time + graded (0/10) | Submitted (late, auto-graded) |

A3's future due date introduces on-time submissions and "not yet due" (non-missing) non-submissions.
This state exercises late, on-time, missing, ungraded, graded, and zero-score combinations.

**Integration test suites:**

| Suite | What is verified |
|---|---|
| **Course resolution** | `set_active_course("TEST SANDBOX")` resolves to correct Canvas ID; fuzzy match works against real course list |
| **Module creation — lesson** | `create_lesson_module` with `later-standard` template produces correct module structure: right number of items, correct SubHeader names, correct item types in correct order, completion requirements set on each graded item |
| **Module creation — solution** | `create_solution_module` sets `unlock_at` and `prerequisite_module_ids` correctly on the Canvas object (verified via `GET /modules/:id`); ExternalUrl items have correct URLs and `new_tab: true` |
| **Module creation — earlier template** | Same as lesson suite but verifies TO-DO structure, reminder item submission type is `none`, video section SubHeader present |
| **Partial failure behavior** | Mock one mid-sequence Canvas call to return 500; verify tool reports exactly what was created before failure and halts |
| **Clone module** | Clones a module from a second test course; verifies item titles, types, and positions match source with week number substituted |
| **Grade reporting** | `get_class_grade_summary` returns correct scores and missing counts matching seeded state; `get_assignment_breakdown` shows correct per-student data; `get_student_report` for Student 4 shows all missing |
| **Missing/late reporting** | `get_missing_assignments` returns Students 2, 4 with correct assignment lists; `get_late_assignments` returns Students 3, 5 |
| **Page CRUD** | `create_page` round-trip verifies `page_id`, `title`, `published`, `front_page`, `url`; `delete_page` creates then deletes a page; `delete_page` returns error when page is the course front page (create → promote to front page → attempt delete → verify rejection → cleanup) |
| **Course reset** | `preview_course_reset` lists correct counts; `reset_course` with wrong confirmation text is rejected (counts unchanged); with correct text, deletes all content including explicitly created front page (auto-unset + delete); post-reset all counts zero; `afterAll` reseeds course via `npm run seed` |

**Run command:** `npm run test:integration` (requires `.env.test`)

**Result:** 72 integration tests passing (6 test files: connectivity, context, reporting, content, modules, reset)

---

#### Layer 3 — MCP Protocol Tests

**Purpose:** Verify the server correctly speaks the MCP protocol — tool discovery, schema validation, and response format.

**Tool:** `@modelcontextprotocol/inspector` (official Instructure MCP debugger)

**What is verified:**
- All tools appear in the tool list with correct names and descriptions
- Input schemas correctly reject invalid inputs (wrong types, missing required fields)
- Tool responses are valid MCP `CallToolResult` objects
- Error responses are properly formatted MCP errors, not uncaught exceptions

**Run command:** `npm run test:mcp` (starts the server and runs inspector against it with mocked Canvas responses)

**When to run:** Once per tool implementation, and as part of pre-release validation for each phase.

---

### 13.3 `dry_run` Parameter

`create_lesson_module` and `create_solution_module` both accept an optional `dry_run: true` parameter. When set:
- Full input validation runs (template slot matching, required field checks, ID resolution)
- No Canvas API write calls are made
- The tool returns a preview of what would be created: item list with types, titles, and resolved IDs
- Read-only Canvas calls (e.g., verifying a `lesson_module_id` exists for `create_solution_module`) are still made

This supports two use cases:
1. **Unit testing:** Input validation logic is fully exercisable without mocking write endpoints
2. **Instructor preview:** Before committing a large module creation, the instructor can confirm the structure looks right

---

### 13.4 Environment Files

```
# .env                  — production credentials (never committed)
CANVAS_INSTANCE_URL=https://your-institution.instructure.com
CANVAS_API_TOKEN=your_production_token

# .env.test             — test credentials (never committed)
CANVAS_INSTANCE_URL=https://canvas.instructure.com
CANVAS_API_TOKEN=your_test_teacher_token
CANVAS_TEST_COURSE_ID=12345
STUDENT0_API_TOKEN=student0_token
STUDENT1_API_TOKEN=student1_token
STUDENT2_API_TOKEN=student2_token
STUDENT3_API_TOKEN=student3_token
STUDENT4_API_TOKEN=student4_token
```

Both files are listed in `.gitignore`. The MCP server itself only ever reads `CANVAS_INSTANCE_URL` and `CANVAS_API_TOKEN`. Student tokens are read exclusively by `scripts/seed-test-data.ts`.

---

### 13.5 Test Coverage by Implementation Phase

Each phase's exit criterion includes passing its associated tests before moving to the next phase.

| Phase | Unit tests | Integration tests | MCP protocol |
|---|---|---|---|
| 1 — Foundation | Config manager, client pagination/retry/auth | Course resolution against real Canvas | Tool list, schema validation |
| 2 — Reporting | Grade/submission data transformations, missing/late logic, `sort_by: "engagement"` ordering | All reporting suites against seeded data | Response format for all reporting tools |
| 3 — Low-level creation | Input validation, template rendering | `add_module_item`, `create_assignment`, `create_quiz` round-trips | Write tool schema validation |
| 4 — High-level creation | `dry_run` validation, slot matching, partial failure | Lesson + solution module suites, clone suite | High-level tool schemas |
| 5 — Destructive ops | Confirmation text matching | Full sandbox reset suite | Destructive tool schemas |
| 6 — PII Blinding ✓ | `SecureStore` encrypt/decrypt roundtrip (10 tests), token consistency, zero-fill on destroy, `audience` annotations in reporting tool responses, token input resolution on `get_student_report`; `resolve_student`; `list_blinded_students` | No raw PII in `assistant`-audience content blocks; `resolve_student` carries `audience: ["user"]`; token round-trip from `get_class_grade_summary` → `get_student_report`; sort-order assertion (missing_count DESC) instead of brittle "Student 4 first" check | Blinded tool response format; `audience` annotation handling |

---

### 13.6 What is Not Tested

| Area | Reason | Mitigation |
|---|---|---|
| Canvas Studio embed HTML | Not available on test instance; embed is manual anyway | Manual verification against institutional Canvas |
| New Quizzes API | Out of scope | N/A |
| Institutional rate limits | Test instance has different limits than institution | Monitor `X-Rate-Limit-Remaining` in production; adjust client delays if needed |
| Multi-term course disambiguation at institution | Test instance may not replicate exact term structure | Manual verification of `set_active_course` during first institutional use |

---

## 14. FERPA / UC / CSU PII Blinding

### 14.1 Background and Regulatory Context

Student grade records, submission data, names, and Canvas numeric IDs are personally identifiable information (PII) regulated by:

- **FERPA** (Family Educational Rights and Privacy Act) — prohibits disclosure of student education records to third parties without consent.
- **UC and CSU system security policies** — require that student PII not be transmitted to external systems without explicit data-sharing agreements.

When this MCP server is used with a cloud-hosted AI assistant (Claude Desktop → Anthropic API), every tool response passes through the provider's infrastructure. A reporting tool that returns `"Jane Smith, score 87"` in its response sends that string to Anthropic's servers as part of the model context — regardless of the provider's data retention policy.

**This feature eliminates that exposure entirely.** The LLM operates only on opaque session tokens. Real student data never leaves the local machine in any form.

Blinding is **always on and cannot be disabled.** This is an architectural constraint, not a configuration option.

---

### 14.2 Design Principles

| Principle | Detail |
|---|---|
| **Always on** | No opt-in switch. Blinding is unconditional and cannot be disabled via config or code. |
| **Memory-only** | No PII map file is written to disk at any point. All token-to-identity mappings exist exclusively in volatile process RAM for the lifetime of the server process. |
| **Encrypted at rest in RAM** | PII is stored AES-256-GCM encrypted even in memory. The session key is the only secret; the ciphertext blobs are safe even if the OS pages them to swap. |
| **Session-scoped tokens** | Tokens (`[STUDENT_001]`) are assigned in encounter order within a process lifetime. Restarting the server resets the counter. There is no cross-session token persistence — this is intentional. |
| **Least-privilege display** | The LLM receives only blinded content (`audience: ["assistant"]`). The human user sees a decrypted lookup table in the UI (`audience: ["user"]`) via MCP content annotations. |
| **No changes to Canvas API layer** | Blinding is a presentation concern. `src/canvas/` is entirely unchanged. |
| **No config additions** | The feature requires no persistent state and no configuration entries. |

---

### 14.3 Threat Model

| Threat | Mitigation |
|---|---|
| Student PII transmitted to cloud LLM | Reporting tools emit only `[STUDENT_NNN]` tokens in `assistant`-audience content. Real names never appear in that content block. |
| PII map swapped to disk by OS | Session key is mlocked. PII values are AES-256-GCM encrypted; what reaches disk (if the OS swaps ciphertext pages before they are zeroed) is ciphertext, not plaintext. |
| Key material recoverable from process memory dump / core dump | Session key is zeroed (`Buffer.fill(0)`) on `SIGINT`, `SIGTERM`, `SIGHUP`, and `uncaughtException` before process exit. |
| Key material in OpenSSL internal buffers | `--secure-heap=65536` Node.js flag allocates an OpenSSL-internal mlocked heap for cryptographic operation intermediates. |
| Token guessing / reverse-engineering | Tokens are sequential integers with no relationship to any student property. Token assignment order changes on every server restart. |
| `audience` annotation ignored by MCP client | If a client ignores annotations, the human-visible lookup table would also reach the LLM. This is noted as a client-contract assumption. The LLM-visible blinded content remains tokens regardless. |

---

### 14.4 SecureStore Architecture (`src/security/secure-store.ts`)

The `SecureStore` class is a singleton instantiated once at server startup and held for the process lifetime.

#### Session key

```typescript
// 32-byte AES-256 key, generated fresh on each process start
const sessionKey = Buffer.allocUnsafe(32)
crypto.randomFillSync(sessionKey)

// Best-effort mlock: pin the key pages in RAM to prevent OS swap.
// Fails silently on platforms where mlock is unavailable or restricted.
// A 32-byte buffer is within the locked-memory limit on all platforms.
try { mlock(sessionKey) } catch { /* best-effort */ }
```

#### In-memory encrypted map

Each entry stores the AES-256-GCM ciphertext, IV, and auth tag — never plaintext:

```typescript
interface EncryptedEntry {
  iv: Buffer         // 12 bytes, random per entry
  ciphertext: Buffer // AES-256-GCM encrypted JSON: { canvasId: number, name: string }
  tag: Buffer        // 16-byte GCM authentication tag
}

private readonly map: Map<string, EncryptedEntry>   // token → encrypted entry
private readonly idToToken: Map<number, string>     // canvasUserId → token (no PII here)
```

#### Tokenization

```typescript
tokenize(canvasUserId: number, name: string): string {
  // Return existing token if this Canvas ID was seen before
  const existing = this.idToToken.get(canvasUserId)
  if (existing) return existing

  // Assign next sequential token
  const token = `[STUDENT_${String(++this.counter).padStart(3, '0')}]`

  // Encrypt { canvasId, name } with AES-256-GCM, fresh IV per entry
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', this.sessionKey, iv)
  const plain = JSON.stringify({ canvasId: canvasUserId, name })
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  this.map.set(token, { iv, ciphertext, tag })
  this.idToToken.set(canvasUserId, token)
  return token
}
```

#### On-demand decryption (for human display only)

```typescript
resolve(token: string): { canvasId: number; name: string } | null {
  const entry = this.map.get(token)
  if (!entry) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, entry.iv)
  decipher.setAuthTag(entry.tag)
  // Throws if auth tag mismatch — should never happen in normal operation
  const plain = Buffer.concat([decipher.update(entry.ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}
```

#### Process exit cleanup

```typescript
destroy(): void {
  this.sessionKey.fill(0)        // zero-fill the AES key
  for (const e of this.map.values()) {
    e.iv.fill(0)
    e.ciphertext.fill(0)
    e.tag.fill(0)
  }
  this.map.clear()
  this.idToToken.clear()
}
```

Signal handlers in `src/index.ts`:

```typescript
const cleanup = () => { secureStore.destroy(); process.exit(0) }
process.on('SIGINT',  cleanup)
process.on('SIGTERM', cleanup)
process.on('SIGHUP',  cleanup)
process.on('uncaughtException', (err) => { cleanup() })
```

---

### 14.5 Token Format

`[STUDENT_001]`, `[STUDENT_002]`, ... — sequential integers, zero-padded to 3 digits, assigned in the order students are first encountered during a session.

**Properties:**
- No relationship to Canvas IDs, names, or any student attribute — cannot be reverse-engineered.
- Consistent within a session: calling `get_class_grade_summary` twice in the same session gives `[STUDENT_001]` to the same person both times (via the `idToToken` map).
- Reset on restart: `[STUDENT_001]` in one session may refer to a different person in the next. This is a deliberate security property — stale tokens in LLM context from a previous session are simply unresolvable.

---

### 14.6 MCP `audience` Annotations — The Display Mechanism

The MCP protocol supports per-content-block `audience` annotations:

```typescript
interface TextContent {
  type: "text"
  text: string
  annotations?: {
    audience?: ("user" | "assistant")[]  // who this content block is for
    priority?: number
  }
}
```

Every reporting tool response that contains student data emits **two content blocks**:

```typescript
return {
  content: [
    {
      type: "text",
      text: JSON.stringify(blindedReport),           // tokens only
      annotations: { audience: ["assistant"] }       // LLM context
    },
    {
      type: "text",
      text: buildLookupTable(resolvedEntries),        // "[STUDENT_001] → Jane Smith\n..."
      annotations: { audience: ["user"] }            // human-visible in Claude Desktop UI
    }
  ]
}
```

**Result:** The LLM reasons about `[STUDENT_001]` with no knowledge of identity. The instructor sees the real name in Claude Desktop's UI alongside the LLM's output — no extra tool call needed for routine use.

**Client-contract assumption:** The `audience` annotation is part of the MCP specification. Claude Desktop is expected to honor it by excluding `user`-only content from the assistant's context window. This must be verified empirically during Phase 6 testing. If a client ignores annotations, the lookup table reaches the LLM — which is less than ideal but still safe, since the LLM would then know names but the Canvas numeric IDs remain absent from all tool inputs/outputs.

---

### 14.7 Impact on Reporting Tools

Five tools return student PII and require modification. No changes to `src/canvas/` are needed.

| Tool | PII in output | PII in input | Change |
|---|---|---|---|
| `list_modules` | None | None | None |
| `get_module_summary` | None | None | None |
| `list_assignment_groups` | None | None | None |
| `get_class_grade_summary` | `id`, `name` per student | None | Replace with token; emit dual-audience response |
| `get_assignment_breakdown` | `student_name`, `student_id` | None | Replace with token; emit dual-audience response |
| `get_student_report` | `id`, `name` | `student_id` (number) | Replace output PII with token; **input changed to `student_token` (string)** |
| `get_missing_assignments` | `id`, `name` per student | None | Replace with token; emit dual-audience response |
| `get_late_assignments` | `id`, `name` per student | None | Replace with token; emit dual-audience response |

**`get_student_report` input change:** With blinding always on, the LLM only knows tokens and cannot supply a raw Canvas user ID. The input schema changes `student_id: number` to `student_token: string`. The tool calls `store.resolve(token)` internally to get the Canvas ID, then proceeds with the normal Canvas API call. The Canvas ID is never exposed to the LLM — only the blinded report goes to the `assistant`-audience block.

The `registerReportingTools` function signature gains one parameter:

```typescript
export function registerReportingTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  secureStore: SecureStore,          // ← new
): void
```

---

### 14.8 New Tools (Phase 6)

#### `resolve_student`

**Purpose:** Explicitly unblind a token — decrypt and return the real name and Canvas ID for the current session. The response is marked `audience: ["user"]` so it appears in Claude Desktop's UI only, not in the LLM's context, preserving the zero-knowledge property even during intentional unblinding.

**Inputs:**
- `student_token` (string, required): A session token in `[STUDENT_NNN]` format.

**Output:** `{ student_token, name, canvas_id }` — with `audience: ["user"]` annotation.

**Notes:**
- Returns an error if the token is not found (e.g., from a previous session).
- No Canvas API call — resolves entirely from the in-memory `SecureStore`.
- Canonical use case: "Look up who `[STUDENT_003]` is so I can draft a follow-up email."

---

#### `list_blinded_students`

**Purpose:** List all tokens registered in the current session. Shows only tokens and counter positions — no PII. Lets the LLM enumerate students for batch operations without ever learning names.

**Inputs:** *(none)*

**Output:** Array of `{ token }` — ordered by encounter. Intentionally omits names and Canvas IDs.

---

### 14.9 Dependencies and Platform Requirements

#### `posix-node` native addon

The [`posix-node`](https://www.npmjs.com/package/posix-node) package (v0.12.0, BSD-3-Clause, SageMath team) provides Node.js bindings for POSIX system calls including `mlock()` / `munlock()`. It is written in Zig and compiled via node-gyp.

> **Note:** The original plan referenced an `mlock` npm package that does not exist on the npm registry (404). The implementation uses `posix-node` instead, which provides equivalent functionality.

```
npm install posix-node
```

This is a **native addon** — it requires compilation at install time:
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** `build-essential` (`sudo apt install build-essential` or equivalent)
- **Windows:** Not supported without WSL. The `mlock` call is skipped gracefully on failure.

`mlock` is called on the session key buffer only (32 bytes). This is within the unprivileged `RLIMIT_MEMLOCK` limit on all platforms and does not require root. If the call fails (e.g., unsupported platform, permission denied), the error is caught and a warning is logged to stderr — blinding continues fully functional via AES-256-GCM; the only degradation is that the key buffer is not pinned from swap.

#### `--secure-heap` Node.js flag

The startup command must include `--secure-heap=65536`:

```
node --secure-heap=65536 dist/index.js
```

This allocates a 64 KB mlocked OpenSSL-internal heap for cryptographic operation intermediates (cipher state, key schedule). This flag has no effect on the V8 heap where our `Map` lives, but it protects the key material during AES operations.

**Claude Desktop `mcp` config entry:**

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

#### Why not `mlockall()`

`mlockall(MCL_CURRENT | MCL_FUTURE)` locks all virtual memory pages for the entire process into RAM permanently — including the V8 heap, libuv buffers, and the full module graph. On macOS, this requires root and will fail with `EPERM` for unprivileged processes. On Linux, it can cause OOM conditions under memory pressure by removing all swappable pages from the system. We target `mlock()` on the 32-byte session key only — the narrowest possible lock request, guaranteed to succeed.
