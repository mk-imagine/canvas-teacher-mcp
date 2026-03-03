# Canvas API Implementation Analysis: `canvas-teacher-mcp`

This document provides a comprehensive analysis of the Canvas API endpoints currently implemented in the `canvas-teacher-mcp` project versus the full Canvas LMS API.

## Executive Summary

The project covers the core "Teacher" workflows well: course navigation, content creation (Assignments, Modules, Pages, Quizzes), and read-only grade reporting. However, it lacks **active grading capabilities** (setting scores/comments), **communication tools** (Conversations/Inbox), and **administrative management** (Groups, Sections, Users).

---

## 1. Implementation Status by Category

### Courses
**Status:** High Coverage (Teacher-centric)
*   **Implemented:**
    *   `GET /api/v1/courses` (Teacher courses only)
    *   `GET /api/v1/courses/:id`
    *   `PUT /api/v1/courses/:id` (Updating syllabus)
    *   `GET /api/v1/courses/:id` with `include[]=syllabus_body`
*   **Missing:**
    *   `DELETE /api/v1/courses/:id` (Conclude/Delete)
    *   `GET /api/v1/courses/:id/settings`
    *   `PUT /api/v1/courses/:id/settings`
    *   `POST /api/v1/courses/:id/copy`
    *   Course-level activity stream, Todo list, and Analytics.

### Assignments & Assignment Groups
**Status:** Medium-High Coverage
*   **Implemented:**
    *   `GET /api/v1/courses/:id/assignments` (List/Search)
    *   `POST /api/v1/courses/:id/assignments` (Create)
    *   `GET /api/v1/courses/:id/assignments/:id` (Get)
    *   `PUT /api/v1/courses/:id/assignments/:id` (Update)
    *   `DELETE /api/v1/courses/:id/assignments/:id` (Delete)
    *   `GET /api/v1/courses/:id/assignment_groups` (List)
    *   `DELETE /api/v1/courses/:id/assignment_groups/:id` (Delete)
*   **Missing:**
    *   `POST /api/v1/courses/:id/assignment_groups` (Create)
    *   `PUT /api/v1/courses/:id/assignment_groups/:id` (Update)
    *   `POST /api/v1/courses/:id/assignments/:id/overrides` (Due date overrides)
    *   Bulk assignment updates.

### Submissions & Grading
**Status:** Low Coverage (Read-only)
*   **Implemented:**
    *   `GET /api/v1/courses/:id/students/submissions` (All students or single student)
    *   `GET /api/v1/courses/:id/assignments/:id/submissions` (By assignment)
*   **Missing (CRITICAL GAPS):**
    *   `PUT /api/v1/courses/:id/assignments/:id/submissions/:user_id` (**Grade submission**)
    *   `POST /api/v1/courses/:id/assignments/:id/submissions/:user_id/comments` (Add comments)
    *   `POST /api/v1/courses/:id/submissions/update_grades` (Bulk grading)
    *   Rubric assessment creation (actually using a rubric to grade).

### Modules & Module Items
**Status:** Very High Coverage
*   **Implemented:**
    *   Full CRUD for Modules (`GET`, `POST`, `PUT`, `DELETE`).
    *   Full CRUD for Module Items (`GET`, `POST`, `PUT`, `DELETE`).
    *   Support for all item types: `Assignment`, `Quiz`, `Page`, `File`, `ExternalUrl`, `SubHeader`.
*   **Missing:**
    *   `POST /api/v1/courses/:id/modules/reorder`
    *   `GET /api/v1/courses/:id/modules/:id/items/:id/done` (Mark as done)

### Pages (Wiki Pages)
**Status:** High Coverage
*   **Implemented:**
    *   Full CRUD for Pages (`GET`, `POST`, `PUT`, `DELETE`).
    *   Search functionality.
    *   Front page management.
*   **Missing:**
    *   `GET /api/v1/courses/:id/pages/:url/revisions` (History)
    *   `POST /api/v1/courses/:id/pages/:url/revisions/:id/restore`

### Quizzes & Quiz Questions
**Status:** High Coverage
*   **Implemented:**
    *   Full CRUD for Quizzes.
    *   Quiz Question creation and listing.
*   **Missing:**
    *   `PUT /api/v1/courses/:id/quizzes/:id/questions/:id` (Update question)
    *   `DELETE /api/v1/courses/:id/quizzes/:id/questions/:id` (Delete question)
    *   Quiz Submissions (Student-facing, but useful for teachers to view).
    *   New Quizzes (Engine 2.0) support.

### Discussion Topics & Announcements
**Status:** Medium Coverage
*   **Implemented:**
    *   List/Create/Delete for Topics and Announcements.
*   **Missing:**
    *   `PUT /api/v1/courses/:id/discussion_topics/:id` (Update)
    *   `GET /api/v1/courses/:id/discussion_topics/:id/view` (Get full thread)
    *   `POST /api/v1/courses/:id/discussion_topics/:topic_id/entries` (Reply)
    *   Entry management (Mark as read, delete entry, rate).

### Files & Folders
**Status:** Medium Coverage
*   **Implemented:**
    *   3-step File Upload process.
    *   List and Delete files.
*   **Missing:**
    *   Full Folder CRUD (`GET`, `POST`, `PUT`, `DELETE` folders).
    *   File move/rename.
    *   Public URL generation.

### Rubrics
**Status:** High Coverage (Structural)
*   **Implemented:**
    *   Create Rubric and Rubric Association.
    *   List and Delete Rubrics.
*   **Missing:**
    *   Rubric update.
    *   Rubric Assessment (as noted in Submissions).

### ⚪ Missing Major Categories
The following Canvas API categories are **completely or mostly missing**:

1.  **Users:** No general user search, profile viewing, or settings management.
2.  **Groups & Group Categories:** No management of student groups.
3.  **Course Sections:** No management of course sections.
4.  **Conversations (Inbox):** No ability to read, send, or manage messages.
5.  **Calendar Events:** No calendar management.
6.  **Analytics:** No access to Canvas analytics data.
7.  **Outcomes (Standards):** No management of learning outcomes.
8.  **External Tools (LTI):** No LTI tool management.
9.  **Webhooks:** No webhook subscription management.
10. **Content Migrations:** No support for importing/exporting course content.

---

## 2. Technical Implementation Notes

- **Client Logic:** All endpoints are wrapped in `src/canvas/client.ts` which handles pagination, retries, and rate limiting.
- **Security:** `src/tools/reporting.ts` uses a `SecureStore` to "tokenize" student PII, ensuring real names and IDs are not leaked to the LLM context.
- **Efficiency:** The project uses `per_page: '100'` and automatic pagination for list endpoints.
- **Smart Search:** Implements the newer `GET /api/v1/courses/:id/smartsearch` semantic search endpoint.

## 3. Recommended Generalization Strategy

To reach 100% coverage or a "generalized" state:

1.  **Implement Grading Tools:** Add `grade_submission` and `add_submission_comment`.
2.  **Add Inbox Support:** Implement `list_conversations`, `get_conversation`, and `create_conversation`.
3.  **Group/Section Management:** Add tools for managing student groups and course sections.
4.  **Complete Folder CRUD:** Expand the `files.ts` module to handle folder structures.
5.  **User Search:** Add a tool to search for users in the account/course.
