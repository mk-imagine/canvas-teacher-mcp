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

- **In scope:** Module creation, assignment/quiz management, grade/submission reporting, sandbox reset, course context switching.
- **Out of scope (for now):** Canvas Studio video embedding (manual), New Quizzes, student communication/messaging, LTI tool configuration.
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
│   │   ├── assignments.ts    # Assignment API calls
│   │   ├── quizzes.ts        # Classic Quiz API calls
│   │   ├── submissions.ts    # Submission & grade API calls
│   │   └── courses.ts        # Course & enrollment API calls
│   ├── tools/
│   │   ├── context.ts        # Course management tools
│   │   ├── modules.ts        # High-level & low-level module tools
│   │   ├── assignments.ts    # Assignment & quiz tools
│   │   ├── reporting.ts      # Grade & submission reporting tools
│   │   └── sandbox.ts        # Destructive reset tools
│   ├── templates/
│   │   ├── index.ts          # Template loader & renderer
│   │   └── defaults.ts       # Default template definitions
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
- `student_id` (number, required): Canvas user ID.
- `course_id` (number, optional).

**Output:**
```jsonc
{
  "student": { "id": 1001, "name": "Jane Smith" },
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

### 5.6 Sandbox Tools

See [Section 10](#10-safety--destructive-operations) for the full safety protocol.

---

#### `preview_course_reset`

**Purpose:** Dry run — list all content that would be deleted by `reset_course_sandbox`. Does not modify anything.

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
    "pages": 18
  },
  "preserves": {
    "enrollments": 22,
    "files": "not touched"
  },
  "warning": "This action cannot be undone. Run reset_course_sandbox with confirmation_text = \"CSC 408 Sandbox\" to proceed."
}
```

**Canvas API Calls:**
- `GET /api/v1/courses/:id/modules`
- `GET /api/v1/courses/:id/assignments`
- `GET /api/v1/courses/:id/quizzes`
- `GET /api/v1/courses/:id/pages`

---

#### `reset_course_sandbox`

**Purpose:** Permanently delete all modules, assignments, quizzes, and pages from a course. Preserves student enrollments and files.

**Inputs:**
- `confirmation_text` (string, required): Must exactly match the course name as returned by the API. Case-sensitive.
- `course_id` (number, optional).

**Output:** Summary of what was deleted.

**Canvas API Calls (sequential, each paginated):**
1. `GET /api/v1/courses/:id` — fetch course name and validate `confirmation_text`
2. `GET /api/v1/courses/:id/modules` → `DELETE /api/v1/courses/:id/modules/:id` for each
3. `GET /api/v1/courses/:id/assignments` → `DELETE /api/v1/courses/:id/assignments/:id` for each
4. `GET /api/v1/courses/:id/quizzes` → `DELETE /api/v1/courses/:id/quizzes/:id` for each
5. `GET /api/v1/courses/:id/pages` → `DELETE /api/v1/courses/:id/pages/:url` for each

**Notes:** Deletion happens in the order listed. Module deletion removes module structure but not underlying content objects; Steps 3–5 clean those up. See Section 10 for additional safety guards.

---

## 6. Canvas API Endpoint Reference

| Method   | Endpoint                                                              | Used By |
|----------|-----------------------------------------------------------------------|---------|
| GET      | `/api/v1/courses`                                                     | `list_courses` |
| GET      | `/api/v1/courses/:id`                                                 | `set_active_course`, `reset_course_sandbox` |
| GET      | `/api/v1/courses/:id/modules`                                         | `list_modules`, `preview_course_reset` |
| POST     | `/api/v1/courses/:id/modules`                                         | `create_lesson_module`, `create_solution_module` |
| PUT      | `/api/v1/courses/:id/modules/:module_id`                              | `update_module`, publish/unpublish |
| DELETE   | `/api/v1/courses/:id/modules/:module_id`                              | `delete_module`, `reset_course_sandbox` |
| GET      | `/api/v1/courses/:id/modules/:module_id/items`                        | `get_module_summary` |
| POST     | `/api/v1/courses/:id/modules/:module_id/items`                        | `add_module_item`, `create_lesson_module` |
| PUT      | `/api/v1/courses/:id/modules/:module_id/items/:item_id`               | `update_module_item` |
| DELETE   | `/api/v1/courses/:id/modules/:module_id/items/:item_id`               | `remove_module_item` |
| GET      | `/api/v1/courses/:id/assignments`                                     | `preview_course_reset` |
| GET      | `/api/v1/courses/:id/assignments/:assignment_id`                      | `get_module_summary` (HTML) |
| POST     | `/api/v1/courses/:id/assignments`                                     | `create_assignment`, `create_lesson_module` |
| PUT      | `/api/v1/courses/:id/assignments/:assignment_id`                      | `update_assignment` |
| DELETE   | `/api/v1/courses/:id/assignments/:assignment_id`                      | `delete_assignment` |
| DELETE   | `/api/v1/courses/:id/assignments/:assignment_id`                      | `reset_course_sandbox` |
| GET      | `/api/v1/courses/:id/assignment_groups`                               | `list_assignment_groups` |
| GET      | `/api/v1/courses/:id/quizzes`                                         | `preview_course_reset` |
| POST     | `/api/v1/courses/:id/quizzes`                                         | `create_quiz`, `create_lesson_module` |
| POST     | `/api/v1/courses/:id/quizzes/:quiz_id/questions`                      | `create_quiz` |
| PUT      | `/api/v1/courses/:id/quizzes/:quiz_id`                                | `update_quiz` |
| DELETE   | `/api/v1/courses/:id/quizzes/:quiz_id`                                | `delete_quiz` |
| DELETE   | `/api/v1/courses/:id/quizzes/:quiz_id`                                | `reset_course_sandbox` |
| GET      | `/api/v1/courses/:id/pages`                                           | `preview_course_reset` |
| POST     | `/api/v1/courses/:id/pages`                                           | `create_lesson_module` |
| DELETE   | `/api/v1/courses/:id/pages/:url`                                      | `reset_course_sandbox` |
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
- Integration: `get_class_grade_summary` with `sort_by: "engagement"` — Student 4 (most missing) appears first
- Integration: `get_class_grade_summary` with `sort_by: "grade"` — null-score student first; `sort_by: "zeros"` — `zeros_count` field present
- MCP protocol: response format for all reporting tools

**Exit criterion:** Can generate a full grade health report for a class and identify students needing follow-up. `sort_by: "engagement"` produces a student standing report ordered from most-at-risk to least. All Phase 2 tests pass against seeded data.

---

### Phase 3 — Low-Level Content Creation - COMPLETE

**Test environment required:** Pre-Phase A + Pre-Phase B (reset before each integration run)

- Tools: `create_assignment`, `update_assignment`, `delete_assignment`, `create_quiz`, `update_quiz`, `delete_quiz`.
- Tools: `add_module_item`, `update_module_item`, `remove_module_item`, `update_module`, `delete_module`.
- Assignment description HTML template rendering (Handlebars).

**Tests written in this phase:**
- Unit: Handlebars template rendering (H3 + bold + link structure), input validation for all tools, `dry_run` validation path
- Integration: `create_assignment` / `delete_assignment` round-trips, `create_quiz` / `delete_quiz` round-trips, module item CRUD sequence; `afterAll` cleanup via delete tools
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

### Phase 5 — Destructive Operations

**Test environment required:** Pre-Phase A + Pre-Phase B (integration tests rely on resetting the test course)

- Tools: `preview_course_reset`, `reset_course_sandbox`.
- Full confirmation safety protocol (see Section 10).

**Tests written in this phase:**
- Unit: confirmation text matching (case-sensitive), wrong text rejection
- Integration: `preview_course_reset` counts match actual content; `reset_course_sandbox` with wrong confirmation text rejected; with correct text, all modules/assignments/quizzes/pages deleted; enrollments and files preserved
- MCP protocol: destructive tool schemas

**Exit criterion:** Can safely clear a sandbox course with explicit confirmation. All Phase 5 tests pass.

---

### Phase 6 — FERPA PII Blinding

**Prerequisites:** Phase 2 complete (reporting tools must exist before adding blinding middleware).

Student names and Canvas user IDs returned by the Phase 2 reporting tools are FERPA-protected PII. When the MCP server is used with a cloud-hosted AI assistant (e.g., Claude), that data passes through a third-party model context. Phase 6 adds an opt-in blinding layer that intercepts reporting tool responses before they reach the LLM, replacing student-identifiable fields with deterministic opaque tokens, and writes a local sidecar map file that the LLM cannot read.

See [Section 14](#14-ferpa-pii-blinding) for full design details.

**Deliverables:**
- `src/pii/tokenizer.ts` — deterministic token generation
- `src/pii/map.ts` — sidecar map file read/write
- `src/pii/middleware.ts` — wraps reporting tool handlers: blinds output PII, resolves token inputs
- Config additions: `piiBlinding.enabled`, `piiBlinding.installationSecret`, `piiBlinding.mapPath`
- New tools: `resolve_student`, `list_blinded_students`
- `.claudeignore` file in the project root documenting the map file location
- Updated `get_student_report` input schema: accepts `student_token` (string) in addition to `student_id` (number)

**Tests written in this phase:**
- Unit: tokenizer is deterministic (same inputs always produce same token), produces different tokens for different Canvas IDs, map file read/write roundtrip, middleware correctly replaces `id`/`name`/`sortable_name` with tokens, token input resolution on `get_student_report`
- Integration: with `piiBlinding.enabled=true`, no real student names or Canvas IDs appear in any reporting tool output; `resolve_student` correctly resolves a token to the real Canvas ID; `get_student_report` with a token input works end-to-end

**Exit criterion:** With `piiBlinding.enabled=true`, no student-identifiable data appears in any reporting tool response. Tokens are stable across server restarts. `resolve_student` unblínds correctly. All Phase 6 tests pass.

---

## 9. Error Handling Philosophy

### Principle: Partial Success is Better Than Silent Failure

For multi-step operations (`create_lesson_module`, `reset_course_sandbox`), if an intermediate step fails:
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

Only `reset_course_sandbox`, `delete_module`, `delete_assignment`, and `delete_quiz` are considered destructive. All other tools create or update but do not permanently delete course content.

### `reset_course_sandbox` Safety Protocol

1. **Naming guard:** Before calling this tool, the AI must call `preview_course_reset` and show the output to the user.
2. **Confirmation text:** The tool requires `confirmation_text` to exactly match the Canvas course name (case-sensitive, character-for-character). The AI must ask the user to type the name explicitly.
3. **Sandbox hint:** The tool logs a warning if the course name does not contain the word "sandbox" or "Sandbox", but does not block execution — the confirmation text is the only enforcement gate.
4. **Enrollment preservation:** Student enrollment records and file uploads are never touched.
5. **No cascade to files:** Canvas file objects in the Files section are not deleted.

### Example Safe Invocation Sequence (for AI assistants)

```
1. Call preview_course_reset(course_id=12345)
2. Show the user the full output including the warning message
3. Ask the user: "To confirm, please type the exact course name shown above."
4. User types: "CSC 408 Sandbox — Spring 2025"
5. Call reset_course_sandbox(course_id=12345, confirmation_text="CSC 408 Sandbox — Spring 2025")
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
| `reset_content` endpoint | Canvas has a `DELETE /api/v1/courses/:id/reset_content` endpoint but it typically requires admin permissions and resets enrollments too. The surgical deletion approach in `reset_course_sandbox` is used instead. |
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

**Run command:** `npm test` (runs on every push, no credentials required)

---

#### Layer 2 — Integration Tests

**Purpose:** Verify correct end-to-end behavior against the real Canvas API. These tests create, read, and delete real content in the test environment.

**Framework:** Vitest with a separate config (`vitest.integration.ts`), tagged `integration`

**Run command:** `npm run test:integration` (requires `.env.test` — opt-in only)

**State management strategy:**
- Each test suite begins by calling `reset_course_sandbox` on the test course to establish a clean slate
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
| **Sandbox reset** | `preview_course_reset` lists correct counts; `reset_course_sandbox` with wrong confirmation text is rejected; with correct text, all modules/assignments/quizzes/pages deleted; enrollments preserved |

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
| 6 — PII Blinding | Tokenizer determinism, map file I/O, middleware output/input interception | End-to-end blinding with real Canvas data, `resolve_student` unblinding | Blinded tool response format |

---

### 13.6 What is Not Tested

| Area | Reason | Mitigation |
|---|---|---|
| Canvas Studio embed HTML | Not available on test instance; embed is manual anyway | Manual verification against institutional Canvas |
| New Quizzes API | Out of scope | N/A |
| Institutional rate limits | Test instance has different limits than institution | Monitor `X-Rate-Limit-Remaining` in production; adjust client delays if needed |
| Multi-term course disambiguation at institution | Test instance may not replicate exact term structure | Manual verification of `set_active_course` during first institutional use |

---

## 14. FERPA PII Blinding

### 14.1 Background and Motivation

Student grade records, submission data, and attendance are personally identifiable information (PII) regulated by FERPA (Family Educational Rights and Privacy Act). When the MCP server is used with a cloud-hosted AI assistant such as Claude, tool responses containing student names and Canvas IDs are transmitted to and processed by a third-party model. Even if data is not retained by the provider, the act of transmission may constitute a FERPA disclosure risk.

The PII Blinding feature addresses this by:

1. Intercepting reporting tool responses **before** they reach the LLM and replacing student names and Canvas IDs with deterministic, opaque tokens (e.g., `STU-3F9A1C2D`).
2. Maintaining a **local sidecar map file** that maps tokens back to real student data — this file is never transmitted to the LLM.
3. Hiding the map file from the AI assistant via `.claudeignore` (or equivalent ignore mechanism).
4. Providing **controlled unblinding tools** that allow the instructor to intentionally surface a real student name when needed (e.g., to send a follow-up email), creating a clear audit boundary.

---

### 14.2 Design Principles

| Principle | Detail |
|---|---|
| **Deterministic tokens** | A given Canvas user ID in a given course always maps to the same token, across sessions and server restarts. |
| **Local-only PII** | The sidecar map file lives in the MCP config directory (`~/.canvas-teacher-mcp/`) and is never included in any API call or tool response. |
| **Opt-in** | PII blinding is disabled by default. Existing workflows are unaffected unless the instructor explicitly enables it in config. |
| **Controlled unblinding** | A dedicated `resolve_student` tool returns real PII for a given token. Its use is explicit and intentional. |
| **No changes to Canvas API layer** | Blinding is a presentation concern. The underlying Canvas API calls, data models, and business logic in `src/canvas/` are unchanged. |

---

### 14.3 Token Format

Tokens take the form `STU-XXXXXXXX`, where `XXXXXXXX` is the first 8 hex characters (uppercase) of:

```
SHA-256( courseId + ":" + canvasUserId + ":" + installationSecret )
```

- `installationSecret` is a random 32-byte hex string generated once on first use and stored in config. It ensures tokens are unguessable from Canvas IDs alone and are unique per installation.
- The same (courseId, canvasUserId) pair always produces the same token for a given installation, making tokens stable across server restarts and sessions.

Example output: `STU-3F9A1C2D`

---

### 14.4 Sidecar Map File

**Default location:** `~/.canvas-teacher-mcp/pii-map.json`
**Configurable via:** `piiBlinding.mapPath` in config

```jsonc
{
  "STU-3F9A1C2D": {
    "canvas_id": 12345,
    "course_id": 67890,
    "name": "Jane Smith",
    "sortable_name": "Smith, Jane",
    "first_seen": "2026-02-01T10:00:00Z",
    "last_seen": "2026-02-21T14:30:00Z"
  },
  "STU-A7C2F1B8": {
    "canvas_id": 12346,
    "course_id": 67890,
    "name": "John Doe",
    "sortable_name": "Doe, John",
    "first_seen": "2026-02-01T10:00:00Z",
    "last_seen": "2026-02-18T09:15:00Z"
  }
}
```

The map file is **additive** — entries are written on first encounter and `last_seen` is updated on subsequent encounters. Existing entries are never deleted automatically.

---

### 14.5 Hiding the Map File from the LLM

The map file must be excluded from AI assistant context. Two mechanisms apply:

**`.claudeignore` (Claude Code / Claude Desktop):**
A `.claudeignore` file in the working project directory or home directory can list the map file path. Absolute paths are supported. Example:

```
# FERPA PII map — never expose to AI
~/.canvas-teacher-mcp/pii-map.json
```

**`.gitignore`:**
The map file must also be excluded from version control since it contains real student PII. Add to `.gitignore`:

```
# FERPA PII sidecar map
~/.canvas-teacher-mcp/pii-map.json
```

**Setup tool (optional):**
A `setup_pii_blinding` tool (or a one-time CLI script) can automate writing the correct ignore entries to the appropriate files in the instructor's working directory.

---

### 14.6 Impact on Phase 2 Reporting Tools

Five of the eight reporting tools return student PII and require blinding when the feature is enabled. No changes are needed to the tools' internal logic or Canvas API calls — the blinding layer is implemented as middleware that wraps the tool handlers.

| Tool | PII in output | PII in input | Blinding action |
|---|---|---|---|
| `list_modules` | None | None | No change |
| `get_module_summary` | None | None | No change |
| `list_assignment_groups` | None | None | No change |
| `get_class_grade_summary` | `id`, `name`, `sortable_name` per student | None | Replace with token; write to map |
| `get_assignment_breakdown` | `student_name`, `student_id` per submission | None | Replace with token; write to map |
| `get_student_report` | `id`, `name` in student field | `student_id` (number) | Replace output PII with token; **input extended to accept token** |
| `get_missing_assignments` | `id`, `name`, `sortable_name` per student | None | Replace with token; write to map |
| `get_late_assignments` | `id`, `name`, `sortable_name` per student | None | Replace with token; write to map |

**The `get_student_report` input change** is the most significant:
Currently the tool takes `student_id: number` (a raw Canvas user ID). When blinding is active, the LLM only has tokens and cannot supply a Canvas ID. The input schema must be extended to accept either a Canvas ID (number) or a PII token (string in `STU-XXXXXXXX` format). The middleware resolves a token to its Canvas ID via the map file before the underlying tool logic executes.

This is a **non-breaking addition**: the Canvas ID path continues to work unchanged. The token path is new.

---

### 14.7 Architecture

The blinding layer is implemented as middleware that wraps `registerReportingTools`. No changes to `src/canvas/` or the underlying tool handlers are required.

```
Tool input (from LLM)
        ↓
  [PII Middleware — Input]        ← Phase 6 addition
  - If student_token present:
      resolve token → canvas_id via map file
  - Forward resolved input to tool handler
        ↓
  [Tool handler — unchanged]
  - Fetches from Canvas API
  - Returns raw data with real names/IDs
        ↓
  [PII Middleware — Output]       ← Phase 6 addition
  - For each student record:
      generate/lookup token for (courseId, canvasUserId)
      replace id/name/sortable_name with token
      update map file entry (last_seen)
  - Return blinded response to LLM
        ↓
  LLM context (tokens only, no real PII)
```

**Implementation sketch (`src/pii/middleware.ts`):**

```typescript
// Wraps registerReportingTools with blinding when piiBlinding.enabled = true
export function registerReportingToolsWithBlinding(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  tokenizer: PiiTokenizer,
  mapStore: PiiMapStore,
): void {
  // Intercept each student-facing tool handler
  // Apply blinding on output, token resolution on input
}
```

---

### 14.8 New Tools (Phase 6)

#### `resolve_student`

**Purpose:** Unblind a PII token — return the real name and Canvas ID for a given token. This tool intentionally transmits PII to the LLM context; its use should be purposeful (e.g., "Look up the real name for STU-3F9A1C2D so I can compose a follow-up email").

**Inputs:**
- `token` (string, required): A PII token in `STU-XXXXXXXX` format.
- `course_id` (number, optional): Disambiguates if the same token exists in multiple courses (rare).

**Output:** `{ token, canvas_id, name, course_id }`

**Notes:**
- Returns an error if the token is not found in the local map file.
- Does not make any Canvas API calls — reads from the local map file only.
- Future enhancement: write an audit log entry (`~/.canvas-teacher-mcp/unblind-log.jsonl`) with timestamp and context.

---

#### `list_blinded_students`

**Purpose:** List all known tokens for a course without revealing the underlying PII. Lets the instructor see which tokens are active and when they were last seen — useful for auditing or for asking the LLM to work with a specific student by token.

**Inputs:**
- `course_id` (number, optional).

**Output:** Array of `{ token, first_seen, last_seen }` — deliberately omits names and Canvas IDs.

---

### 14.9 Config Schema Additions

```jsonc
{
  "piiBlinding": {
    // Enable PII blinding for all student-facing reporting tools.
    // Default: false (opt-in).
    "enabled": false,

    // Path to the sidecar PII map file.
    // Default: null (resolves to ~/.canvas-teacher-mcp/pii-map.json).
    "mapPath": null,

    // Random secret used as a salt in token generation.
    // Auto-generated on first use; never change this — doing so invalidates
    // all existing tokens and breaks cross-session consistency.
    "installationSecret": "auto-generated-32-byte-hex-string"
  }
}
```
