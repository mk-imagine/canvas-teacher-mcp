import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CanvasClient,
  type ConfigManager,
  type CanvasTeacherConfig,
  getCourse,
  updateCourse,
  listModules,
  deleteModule,
  listAssignments,
  createAssignment,
  deleteAssignment,
  listAssignmentGroups,
  deleteAssignmentGroup,
  listQuizzes,
  deleteQuiz,
  listPages,
  deletePage,
  updatePage,
  listDiscussionTopics,
  listAnnouncements,
  deleteDiscussionTopic,
  listFiles,
  deleteFile,
  listRubrics,
  deleteRubric,
  createRubricAssociation,
} from '@canvas-mcp/core'

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

  // ── reset_course ──────────────────────────────────────────────────────────

  server.registerTool(
    'reset_course',
    {
      description: [
        'Reset a course by deleting all content: modules, assignments, quizzes, discussions, announcements,',
        'pages, files, rubrics, assignment groups, and syllabus. Preserves student enrollments.',
        'Use dry_run=true to preview what would be deleted and receive a confirmation_token.',
        'To execute: provide confirmation_token (from dry_run=true, must be supplied by the user) OR',
        'confirmation_text (exact course name, must be typed by the user).',
        'IMPORTANT: Do NOT automatically supply confirmation_token or confirmation_text.',
      ].join(' '),
      inputSchema: z.object({
        dry_run: z.boolean().default(false)
          .describe('Preview only — list what would be deleted and return a confirmation_token. Does not modify anything.'),
        confirmation_token: z.string().optional()
          .describe('One-time token from dry_run=true call. Must be provided by the user — do not auto-supply.'),
        confirmation_text: z.string().optional()
          .describe('Exact course name as an alternative to confirmation_token. Must be typed by the user.'),
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

      // ── dry_run branch ──────────────────────────────────────────────────────
      if (args.dry_run) {
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

      // ── destructive branch ─────────────────────────────────────────────────
      if (args.confirmation_token) {
        // Validate the confirmation token
        const pending = pendingTokens.get(args.confirmation_token)
        if (!pending) {
          return toolError(
            `Invalid confirmation token "${args.confirmation_token}". Run reset_course(dry_run=true) to generate a new token.`
          )
        }
        if (pending.courseId !== courseId) {
          return toolError(
            `Token was issued for a different course. Run reset_course(dry_run=true) again for this course.`
          )
        }
        if (Date.now() > pending.expiresAt) {
          pendingTokens.delete(args.confirmation_token)
          return toolError(
            `Confirmation token has expired. Run reset_course(dry_run=true) to generate a new token.`
          )
        }
        pendingTokens.delete(args.confirmation_token)
      } else if (args.confirmation_text) {
        // Validate course name matches exactly
        const course = await getCourse(client, courseId)
        if (args.confirmation_text !== course.name) {
          return toolError(
            `confirmation_text "${args.confirmation_text}" does not match course name "${course.name}". ` +
            `Provide the exact course name or use dry_run=true to get a confirmation_token.`
          )
        }
      } else {
        return toolError('Provide confirmation_token (from dry_run=true) or confirmation_text (exact course name).')
      }

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
      const assignments = await listAssignments(client, courseId)
      for (const asgn of assignments) {
        await deleteAssignment(client, courseId, asgn.id)
        deleted.assignments++
      }

      // 3. Delete quizzes (some may already be gone if their assignment was deleted above — 404 handled gracefully)
      const quizzes = await listQuizzes(client, courseId)
      for (const quiz of quizzes) {
        await deleteQuiz(client, courseId, quiz.id)
        deleted.quizzes++
      }

      // 4a. Delete discussion topics
      const discussions = await listDiscussionTopics(client, courseId)
      for (const topic of discussions) {
        await deleteDiscussionTopic(client, courseId, topic.id)
        deleted.discussions++
      }

      // 4b. Delete announcements
      const announcements = await listAnnouncements(client, courseId)
      for (const ann of announcements) {
        await deleteDiscussionTopic(client, courseId, ann.id)
        deleted.discussions++
      }

      // 5. Delete pages (front page must be unset first)
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

      // 7. Sweep any remaining rubrics
      const rubrics = await listRubrics(client, courseId)
      for (const rubric of rubrics) {
        try {
          await deleteRubric(client, courseId, rubric.id)
          deleted.rubrics++
        } catch {
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

      // 8. Delete assignment groups
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
