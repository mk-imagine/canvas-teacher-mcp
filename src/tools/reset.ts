import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient } from '../canvas/client.js'
import { type ConfigManager } from '../config/manager.js'
import { type CanvasTeacherConfig } from '../config/schema.js'
import { getCourse } from '../canvas/courses.js'
import { listModules, deleteModule } from '../canvas/modules.js'
import { listAssignments, deleteAssignment } from '../canvas/assignments.js'
import { listQuizzes, deleteQuiz } from '../canvas/quizzes.js'
import { listPages, deletePage, updatePage } from '../canvas/pages.js'

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

export function registerResetTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {
  // ── preview_course_reset ──────────────────────────────────────────────────

  server.registerTool(
    'preview_course_reset',
    {
      description: 'Dry run — list all content that would be deleted by reset_course_sandbox. Does not modify anything.',
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

      const [course, modules, assignments, quizzes, pages] = await Promise.all([
        getCourse(client, courseId),
        listModules(client, courseId),
        listAssignments(client, courseId),
        listQuizzes(client, courseId),
        listPages(client, courseId),
      ])

      return toJson({
        course: { id: course.id, name: course.name },
        would_delete: {
          modules: modules.length,
          assignments: assignments.length,
          quizzes: quizzes.length,
          pages: pages.length,
        },
        preserves: {
          enrollments: 'not touched',
          files: 'not touched',
        },
        warning: `This action cannot be undone. Run reset_course with confirmation_text = "${course.name}" to proceed.`,
      })
    }
  )

  // ── reset_course_sandbox ──────────────────────────────────────────────────

  server.registerTool(
    'reset_course',
    {
      description: 'Permanently delete all modules, assignments, quizzes, and pages from a course. Preserves student enrollments and files. Requires confirmation_text to exactly match the Canvas course name (case-sensitive).',
      inputSchema: z.object({
        confirmation_text: z.string()
          .describe('Must exactly match the course name as returned by preview_course_reset. Case-sensitive.'),
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

      // Fetch course and validate confirmation text
      const course = await getCourse(client, courseId)

      if (args.confirmation_text !== course.name) {
        return toolError(
          `Confirmation text does not match. Expected "${course.name}" but got "${args.confirmation_text}". No changes were made.`
        )
      }

      // Sandbox hint — warning only, not a blocker
      const sandboxWarning = !course.name.toLowerCase().includes('sandbox')
        ? `Warning: course name "${course.name}" does not contain "sandbox". Proceeding anyway.`
        : null

      const deleted = { modules: 0, assignments: 0, quizzes: 0, pages: 0 }

      // 1. Delete modules (structure only — underlying content remains until steps 2–4)
      const modules = await listModules(client, courseId)
      for (const mod of modules) {
        await deleteModule(client, courseId, mod.id)
        deleted.modules++
      }

      // 2. Delete assignments
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

      // 4. Delete pages (front page must be unset first — Canvas forbids deleting it directly)
      const pages = await listPages(client, courseId)
      for (const page of pages) {
        if (page.front_page) {
          await updatePage(client, courseId, page.url, { front_page: false })
        }
        await deletePage(client, courseId, page.url)
        deleted.pages++
      }

      const result: Record<string, unknown> = {
        course: { id: course.id, name: course.name },
        deleted,
      }
      if (sandboxWarning) {
        result.sandbox_warning = sandboxWarning
      }

      return toJson(result)
    }
  )
}
