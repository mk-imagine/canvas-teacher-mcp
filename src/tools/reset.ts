import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient } from '../canvas/client.js'
import { type ConfigManager } from '../config/manager.js'
import { type CanvasTeacherConfig } from '../config/schema.js'
import { getCourse, updateCourse } from '../canvas/courses.js'
import { listModules, deleteModule } from '../canvas/modules.js'
import { listAssignments, createAssignment, deleteAssignment, listAssignmentGroups, deleteAssignmentGroup } from '../canvas/assignments.js'
import { listQuizzes, deleteQuiz } from '../canvas/quizzes.js'
import { listPages, deletePage, updatePage } from '../canvas/pages.js'
import { listDiscussionTopics, listAnnouncements, deleteDiscussionTopic } from '../canvas/discussions.js'
import { listFiles, deleteFile } from '../canvas/files.js'
import { listRubrics, deleteRubric, createRubricAssociation } from '../canvas/rubrics.js'

function resolveCourseId(config: CanvasTeacherConfig, override?: number): number {
  const id = override ?? config.program.activeCourseId
  if (id === null) {
    throw new Error('No active course set. Call set_active_course first.')
  }
  return id
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }] }
}

function toJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

// Token store: keyed by token string, holds the courseId it was issued for and an expiry timestamp.
// Tokens are single-use and expire after 5 minutes.
interface PendingToken {
  courseId: number
  expiresAt: number
}

function generateToken(): string {
  // Unambiguous characters (no 0/O, 1/I/L)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export function registerResetTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {
  const pendingTokens = new Map<string, PendingToken>()

  // ── preview_course_reset ──────────────────────────────────────────────────

  server.registerTool(
    'preview_course_reset',
    {
      description: 'Dry run — list all content that would be deleted by reset_course. Does not modify anything.',
      inputSchema: z.object({
        course_id: z.number().int().positive().optional()
          .describe('Canvas course ID. Defaults to active course.'),
      }),
    },
    async (args) => {
      const config = configManager.read()
      let courseId: number
      try {
        courseId = resolveCourseId(config, args.course_id)
      } catch (err) {
        return toolError((err as Error).message)
      }

      const [course, modules, assignments, quizzes, pages, discussions, announcements, files, rubrics, assignmentGroups] = await Promise.all([
        getCourse(client, courseId),
        listModules(client, courseId),
        listAssignments(client, courseId),
        listQuizzes(client, courseId),
        listPages(client, courseId),
        listDiscussionTopics(client, courseId),
        listAnnouncements(client, courseId),
        listFiles(client, courseId),
        listRubrics(client, courseId),
        listAssignmentGroups(client, courseId),
      ])

      const token = generateToken()
      pendingTokens.set(token, { courseId, expiresAt: Date.now() + 5 * 60 * 1000 })

      return toJson({
        course: { id: course.id, name: course.name },
        would_delete: {
          modules: modules.length,
          assignments: assignments.length,
          quizzes: quizzes.length,
          discussions: discussions.length,
          announcements: announcements.length,
          pages: pages.length,
          files: files.length,
          rubrics: rubrics.length,
          assignment_groups: assignmentGroups.length,
        },
        would_clear: {
          syllabus: true,
        },
        preserves: {
          enrollments: 'not touched',
        },
        confirmation_token: token,
        instructions: `IMPORTANT: Do NOT call reset_course automatically. Show the user this preview and the confirmation token "${token}", and ask them to explicitly provide the token back to you before proceeding. The token expires in 5 minutes.`,
      })
    }
  )

  // ── reset_course ──────────────────────────────────────────────────────────

  server.registerTool(
    'reset_course',
    {
      description: 'Permanently delete all content from a course: modules, assignments, quizzes, discussions, announcements, pages, files, rubrics, assignment groups, and syllabus. Preserves student enrollments. Requires a confirmation_token from preview_course_reset that the user has explicitly approved.',
      inputSchema: z.object({
        confirmation_token: z.string()
          .describe('The one-time token returned by preview_course_reset. Must be provided by the user — do not supply this automatically.'),
        course_id: z.number().int().positive().optional()
          .describe('Canvas course ID. Defaults to active course.'),
      }),
    },
    async (args) => {
      const config = configManager.read()
      let courseId: number
      try {
        courseId = resolveCourseId(config, args.course_id)
      } catch (err) {
        return toolError((err as Error).message)
      }

      // Validate the confirmation token
      const pending = pendingTokens.get(args.confirmation_token)
      if (!pending) {
        return toolError(
          `Invalid confirmation token "${args.confirmation_token}". Run preview_course_reset to generate a new token.`
        )
      }
      if (pending.courseId !== courseId) {
        return toolError(
          `Token was issued for a different course. Run preview_course_reset again for this course.`
        )
      }
      if (Date.now() > pending.expiresAt) {
        pendingTokens.delete(args.confirmation_token)
        return toolError(
          `Confirmation token has expired. Run preview_course_reset to generate a new token.`
        )
      }
      pendingTokens.delete(args.confirmation_token)

      const course = await getCourse(client, courseId)

      // Sandbox hint — warning only, not a blocker after token validation
      const sandboxWarning = !course.name.toLowerCase().includes('sandbox')
        ? `Warning: course name "${course.name}" does not contain "sandbox". Proceeding anyway.`
        : null

      const deleted = {
        modules: 0,
        assignments: 0,
        quizzes: 0,
        discussions: 0,
        pages: 0,
        files: 0,
        rubrics: 0,
        rubrics_failed: [] as number[],
        assignment_groups: 0,
        syllabus_cleared: false,
      }

      // 1. Delete modules (structure only — underlying content remains until later steps)
      const modules = await listModules(client, courseId)
      for (const mod of modules) {
        await deleteModule(client, courseId, mod.id)
        deleted.modules++
      }

      // 2. Delete assignments — deleteAssignment pre-deletes any associated rubric
      //    (Canvas 500s on orphaned rubrics whose assignment was already deleted)
      const assignments = await listAssignments(client, courseId)
      for (const asgn of assignments) {
        await deleteAssignment(client, courseId, asgn.id)
        deleted.assignments++
      }

      // 3. Delete quizzes (some may already be gone if their assignment was deleted above — 404 handled gracefully by client.delete)
      const quizzes = await listQuizzes(client, courseId)
      for (const quiz of quizzes) {
        await deleteQuiz(client, courseId, quiz.id)
        deleted.quizzes++
      }

      // 4a. Delete discussion topics (some may already be gone if they were graded discussions deleted in step 2 — 404 handled gracefully)
      const discussions = await listDiscussionTopics(client, courseId)
      for (const topic of discussions) {
        await deleteDiscussionTopic(client, courseId, topic.id)
        deleted.discussions++
      }

      // 4b. Delete announcements (separate API query — Canvas doesn't return them with regular discussions)
      const announcements = await listAnnouncements(client, courseId)
      for (const ann of announcements) {
        await deleteDiscussionTopic(client, courseId, ann.id)
        deleted.discussions++
      }

      // 5. Delete pages (front page must be unset first — Canvas forbids deleting it directly)
      const pages = await listPages(client, courseId)
      for (const page of pages) {
        if (page.front_page) {
          await updatePage(client, courseId, page.url, { front_page: false })
        }
        await deletePage(client, courseId, page.url)
        deleted.pages++
      }

      // 6. Delete files
      const files = await listFiles(client, courseId)
      for (const file of files) {
        await deleteFile(client, file.id)
        deleted.files++
      }

      // 7. Sweep any remaining rubrics (safety net for rubrics created outside our tools,
      //    e.g. via the Canvas UI without an assignment association).
      //    MCP-created rubrics are always assignment-associated and were already removed
      //    in step 2 via deleteAssignment. Canvas returns 500 when deleting a rubric with
      //    no active associations (zombie rubric). Recovery: create a temporary assignment,
      //    associate the zombie rubric with it, delete the rubric, then delete the temp assignment.
      const rubrics = await listRubrics(client, courseId)
      for (const rubric of rubrics) {
        try {
          await deleteRubric(client, courseId, rubric.id)
          deleted.rubrics++
        } catch {
          // Zombie rubric — attempt revival via a temporary assignment association
          try {
            const tempAssignment = await createAssignment(client, courseId, {
              name: `__tmp_rubric_cleanup_${rubric.id}`,
              points_possible: 0,
              published: false,
            })
            await createRubricAssociation(client, courseId, {
              rubric_id: rubric.id,
              assignment_id: tempAssignment.id,
            })
            await deleteRubric(client, courseId, rubric.id)
            deleted.rubrics++
            await deleteAssignment(client, courseId, tempAssignment.id).catch(() => {})
          } catch {
            deleted.rubrics_failed.push(rubric.id)
          }
        }
      }

      // 8. Delete assignment groups (all should be empty; Canvas keeps at least one, so handle errors on last group)
      const groups = await listAssignmentGroups(client, courseId)
      for (const group of groups) {
        try {
          await deleteAssignmentGroup(client, courseId, group.id)
          deleted.assignment_groups++
        } catch {
          // Canvas may refuse to delete the last assignment group — that's OK
        }
      }

      // 9. Clear syllabus
      await updateCourse(client, courseId, { syllabus_body: '' })
      deleted.syllabus_cleared = true

      const result: Record<string, unknown> = {
        course: { id: course.id, name: course.name },
        deleted,
      }
      if (sandboxWarning) {
        result.sandbox_warning = sandboxWarning
      }
      if (deleted.rubrics_failed.length > 0) {
        result.warning = `Canvas returned 500 for ${deleted.rubrics_failed.length} rubric(s) and could not delete them: [${deleted.rubrics_failed.join(', ')}]. This is a Canvas-side issue; the rubric list may show stale entries.`
      }

      return toJson(result)
    }
  )
}
