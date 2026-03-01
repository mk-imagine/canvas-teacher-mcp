import { z } from 'zod'
import Handlebars from 'handlebars'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient } from '../canvas/client.js'
import { type ConfigManager } from '../config/manager.js'
import { type CanvasTeacherConfig } from '../config/schema.js'
import {
  createAssignment,
  updateAssignment,
  deleteAssignment,
} from '../canvas/assignments.js'
import {
  createQuiz,
  updateQuiz,
  createQuizQuestion,
  deleteQuiz,
} from '../canvas/quizzes.js'
import {
  createModule,
  updateModule,
  deleteModule,
  createModuleItem,
  updateModuleItem,
  deleteModuleItem,
} from '../canvas/modules.js'
import { createPage, updatePage, listPages, deletePage, getPage } from '../canvas/pages.js'
import { createDiscussionTopic, deleteDiscussionTopic } from '../canvas/discussions.js'
import { uploadFile, deleteFile } from '../canvas/files.js'
import { createRubric, createRubricAssociation } from '../canvas/rubrics.js'
import { updateCourse } from '../canvas/courses.js'

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

function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return Handlebars.compile(template)(vars)
}

const completionRequirementSchema = z.object({
  type: z.enum(['min_score', 'must_submit', 'must_view']),
  min_score: z.number().optional(),
}).optional()

export function registerContentTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {
  // ── create_assignment ────────────────────────────────────────────────────────

  server.registerTool(
    'create_assignment',
    {
      description: 'Create a new graded assignment. Renders an HTML description from the config template if notebook_url is provided and description is omitted.',
      inputSchema: z.object({
        name: z.string()
          .describe('Assignment title'),
        points_possible: z.number().positive().optional()
          .describe('Points possible. Defaults to config defaults.pointsPossible.'),
        due_at: z.string().optional()
          .describe('Due date as ISO 8601 string.'),
        submission_types: z.array(z.string()).optional()
          .describe('Submission types. Defaults to config defaults.submissionType.'),
        assignment_group_id: z.number().int().positive().optional()
          .describe('Assignment group ID. Defaults to first group matching config defaults.assignmentGroup.'),
        description: z.string().optional()
          .describe('Raw HTML description. If omitted and notebook_url is provided, rendered from template.'),
        notebook_url: z.string().optional()
          .describe('Google Colab notebook URL. Used to render description from template.'),
        notebook_title: z.string().optional()
          .describe('Link text for notebook URL in the rendered description.'),
        instructions: z.string().optional()
          .describe('Instructional text inserted into the rendered description.'),
        published: z.boolean().optional()
          .describe('Whether to publish immediately. Default false.'),
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

      let description = args.description
      if (description == null && args.notebook_url != null) {
        description = renderTemplate(config.assignmentDescriptionTemplate.default, {
          notebook_url: args.notebook_url,
          notebook_title: args.notebook_title ?? args.name,
          instructions: args.instructions ?? '',
        })
      }

      const assignment = await createAssignment(client, courseId, {
        name: args.name,
        points_possible: args.points_possible ?? config.defaults.pointsPossible,
        due_at: args.due_at,
        submission_types: args.submission_types ?? [config.defaults.submissionType],
        assignment_group_id: args.assignment_group_id,
        description,
        published: args.published ?? false,
      })

      return toJson({
        id: assignment.id,
        name: assignment.name,
        points_possible: assignment.points_possible,
        due_at: assignment.due_at,
        published: assignment.published,
        html_url: assignment.html_url,
      })
    }
  )

  // ── update_assignment ────────────────────────────────────────────────────────

  server.registerTool(
    'update_assignment',
    {
      description: 'Update an existing assignment\'s settings.',
      inputSchema: z.object({
        assignment_id: z.number().int().positive()
          .describe('Canvas assignment ID'),
        name: z.string().optional(),
        points_possible: z.number().positive().optional(),
        due_at: z.string().nullable().optional()
          .describe('ISO 8601 due date, or null to clear.'),
        submission_types: z.array(z.string()).optional(),
        assignment_group_id: z.number().int().positive().optional(),
        description: z.string().optional()
          .describe('Raw HTML description.'),
        published: z.boolean().optional(),
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

      const { assignment_id, course_id: _cid, ...fields } = args
      const assignment = await updateAssignment(client, courseId, assignment_id, fields)

      return toJson({
        id: assignment.id,
        name: assignment.name,
        points_possible: assignment.points_possible,
        due_at: assignment.due_at,
        published: assignment.published,
        html_url: assignment.html_url,
      })
    }
  )

  // ── create_quiz ──────────────────────────────────────────────────────────────

  server.registerTool(
    'create_quiz',
    {
      description: 'Create a Classic Quiz. Use use_exit_card_template=true to populate from the config exit card template.',
      inputSchema: z.object({
        title: z.string().optional()
          .describe('Quiz title. Required unless use_exit_card_template=true.'),
        quiz_type: z.enum(['practice_quiz', 'assignment', 'graded_survey', 'survey']).optional()
          .describe('Quiz type. Defaults to config exitCardTemplate.quizType when using template.'),
        points_possible: z.number().positive().optional()
          .describe('Points possible. Defaults to config defaults.exitCardPoints when using template.'),
        due_at: z.string().optional()
          .describe('Due date as ISO 8601 string.'),
        time_limit: z.number().int().positive().optional()
          .describe('Time limit in minutes. Omit for unlimited.'),
        allowed_attempts: z.number().int().optional()
          .describe('Number of allowed attempts. -1 for unlimited.'),
        assignment_group_id: z.number().int().positive().optional(),
        use_exit_card_template: z.boolean().optional()
          .describe('Populate quiz title and questions from config exitCardTemplate.'),
        week: z.number().int().positive().optional()
          .describe('Week number substituted into the exit card title template (e.g. "Week {{week}} | Exit Card").'),
        questions: z.array(z.object({
          question_name: z.string(),
          question_text: z.string(),
          question_type: z.string(),
          points_possible: z.number().optional(),
        })).optional()
          .describe('Custom questions. Ignored when use_exit_card_template=true.'),
        published: z.boolean().optional()
          .describe('Whether to publish immediately. Default false.'),
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

      const useTemplate = args.use_exit_card_template ?? false

      const title = useTemplate
        ? renderTemplate(config.exitCardTemplate.title, {
            week: args.week != null ? String(args.week) : '?',
          })
        : args.title

      if (!title) {
        return toolError('title is required when use_exit_card_template is not set.')
      }

      const quizType = useTemplate
        ? config.exitCardTemplate.quizType
        : (args.quiz_type ?? 'assignment')

      const pointsPossible = useTemplate
        ? config.defaults.exitCardPoints
        : args.points_possible

      const quiz = await createQuiz(client, courseId, {
        title,
        quiz_type: quizType,
        points_possible: pointsPossible,
        due_at: args.due_at,
        time_limit: args.time_limit,
        allowed_attempts: args.allowed_attempts,
        assignment_group_id: args.assignment_group_id,
        published: args.published ?? false,
      })

      const questions = useTemplate ? config.exitCardTemplate.questions : (args.questions ?? [])
      const createdQuestions = await Promise.all(
        questions.map((q) =>
          createQuizQuestion(client, courseId, quiz.id, {
            question_name: q.question_name,
            question_text: q.question_text,
            question_type: q.question_type,
            points_possible: q.points_possible ?? 0,
          })
        )
      )

      return toJson({
        id: quiz.id,
        title: quiz.title,
        quiz_type: quiz.quiz_type,
        points_possible: quiz.points_possible,
        due_at: quiz.due_at,
        published: quiz.published,
        html_url: quiz.html_url,
        questions_created: createdQuestions.length,
      })
    }
  )

  // ── update_quiz ──────────────────────────────────────────────────────────────

  server.registerTool(
    'update_quiz',
    {
      description: 'Update an existing Classic Quiz\'s settings.',
      inputSchema: z.object({
        quiz_id: z.number().int().positive()
          .describe('Canvas quiz ID'),
        title: z.string().optional(),
        quiz_type: z.enum(['practice_quiz', 'assignment', 'graded_survey', 'survey']).optional(),
        points_possible: z.number().positive().optional(),
        due_at: z.string().nullable().optional()
          .describe('ISO 8601 due date, or null to clear.'),
        time_limit: z.number().int().positive().nullable().optional()
          .describe('Time limit in minutes, or null to clear.'),
        allowed_attempts: z.number().int().optional(),
        assignment_group_id: z.number().int().positive().optional(),
        published: z.boolean().optional(),
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

      const { quiz_id, course_id: _cid, ...fields } = args
      const quiz = await updateQuiz(client, courseId, quiz_id, fields)

      return toJson({
        id: quiz.id,
        title: quiz.title,
        quiz_type: quiz.quiz_type,
        points_possible: quiz.points_possible,
        due_at: quiz.due_at,
        published: quiz.published,
        html_url: quiz.html_url,
      })
    }
  )

  // ── delete_assignment ────────────────────────────────────────────────────────

  server.registerTool(
    'delete_assignment',
    {
      description: 'Permanently delete an assignment.',
      inputSchema: z.object({
        assignment_id: z.number().int().positive()
          .describe('Canvas assignment ID'),
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

      await deleteAssignment(client, courseId, args.assignment_id)
      return toJson({ deleted: true, assignment_id: args.assignment_id })
    }
  )

  // ── delete_quiz ──────────────────────────────────────────────────────────────

  server.registerTool(
    'delete_quiz',
    {
      description: 'Permanently delete a Classic Quiz.',
      inputSchema: z.object({
        quiz_id: z.number().int().positive()
          .describe('Canvas quiz ID'),
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

      await deleteQuiz(client, courseId, args.quiz_id)
      return toJson({ deleted: true, quiz_id: args.quiz_id })
    }
  )

  // ── update_module ────────────────────────────────────────────────────────────

  server.registerTool(
    'update_module',
    {
      description: 'Update a module\'s settings (name, published state, lock date, prerequisites).',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
        name: z.string().optional(),
        published: z.boolean().optional(),
        unlock_at: z.string().nullable().optional()
          .describe('ISO 8601 unlock date, or null to clear.'),
        prerequisite_module_ids: z.array(z.number().int().positive()).optional()
          .describe('IDs of modules that must be completed before this one unlocks.'),
        require_sequential_progress: z.boolean().optional()
          .describe('Require students to complete items in order.'),
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

      const { module_id, course_id: _cid, ...fields } = args
      const mod = await updateModule(client, courseId, module_id, fields)

      return toJson({
        id: mod.id,
        name: mod.name,
        published: mod.published,
        unlock_at: mod.unlock_at,
        prerequisite_module_ids: mod.prerequisite_module_ids,
        require_sequential_progress: mod.require_sequential_progress,
      })
    }
  )

  // ── delete_module ────────────────────────────────────────────────────────────

  server.registerTool(
    'delete_module',
    {
      description: 'Delete a module and its module items. Does NOT delete the underlying assignments, quizzes, or pages.',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
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

      await deleteModule(client, courseId, args.module_id)
      return toJson({ deleted: true, module_id: args.module_id })
    }
  )

  // ── add_module_item ──────────────────────────────────────────────────────────

  server.registerTool(
    'add_module_item',
    {
      description: 'Add a single item to an existing module.',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
        type: z.enum(['SubHeader', 'Page', 'Assignment', 'Quiz', 'ExternalUrl'])
          .describe('Module item type'),
        title: z.string()
          .describe('Item title'),
        content_id: z.number().int().positive().optional()
          .describe('Canvas object ID. Required for Assignment, Quiz, and Page types.'),
        external_url: z.string().optional()
          .describe('URL. Required for ExternalUrl type.'),
        position: z.number().int().positive().optional()
          .describe('1-based position in the module. Appends if omitted.'),
        new_tab: z.boolean().optional()
          .describe('Open in new tab. Default true for ExternalUrl.'),
        completion_requirement: completionRequirementSchema
          .describe('Completion requirement for this item.'),
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

      if (
        (args.type === 'Assignment' || args.type === 'Quiz' || args.type === 'Page') &&
        args.content_id == null
      ) {
        return toolError(`content_id is required for type "${args.type}".`)
      }
      if (args.type === 'ExternalUrl' && !args.external_url) {
        return toolError('external_url is required for type "ExternalUrl".')
      }

      const item = await createModuleItem(client, courseId, args.module_id, {
        type: args.type,
        title: args.title,
        content_id: args.content_id,
        external_url: args.external_url,
        position: args.position,
        new_tab: args.new_tab ?? (args.type === 'ExternalUrl' ? true : undefined),
        completion_requirement: args.completion_requirement,
      })

      return toJson({
        id: item.id,
        module_id: item.module_id,
        position: item.position,
        type: item.type,
        title: item.title,
        content_id: item.content_id,
      })
    }
  )

  // ── update_module_item ───────────────────────────────────────────────────────

  server.registerTool(
    'update_module_item',
    {
      description: 'Update an existing module item (position, title, or completion requirement).',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
        item_id: z.number().int().positive()
          .describe('Canvas module item ID'),
        title: z.string().optional(),
        position: z.number().int().positive().optional(),
        completion_requirement: z.union([
          completionRequirementSchema,
          z.null(),
        ]).optional()
          .describe('Updated completion requirement, or null to remove it.'),
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

      const item = await updateModuleItem(client, courseId, args.module_id, args.item_id, {
        title: args.title,
        position: args.position,
        completion_requirement: args.completion_requirement ?? undefined,
      })

      return toJson({
        id: item.id,
        module_id: item.module_id,
        position: item.position,
        type: item.type,
        title: item.title,
        completion_requirement: item.completion_requirement,
      })
    }
  )

  // ── create_page ──────────────────────────────────────────────────────────────

  server.registerTool(
    'create_page',
    {
      description: 'Create a new wiki page in a course.',
      inputSchema: z.object({
        title: z.string()
          .describe('Page title'),
        body: z.string().optional()
          .describe('HTML body content.'),
        published: z.boolean().optional()
          .describe('Whether to publish immediately. Default false.'),
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

      const page = await createPage(client, courseId, {
        title: args.title,
        body: args.body,
        published: args.published ?? false,
      })

      return toJson({
        page_id: page.page_id,
        url: page.url,
        title: page.title,
        published: page.published,
        front_page: page.front_page,
      })
    }
  )

  // ── update_page ──────────────────────────────────────────────────────────────

  server.registerTool(
    'update_page',
    {
      description: 'Update an existing wiki page\'s title, body, or published state.',
      inputSchema: z.object({
        page_url: z.string()
          .describe('Page URL slug (e.g. "week-2-overview"). Returned by create_page as the "url" field.'),
        title: z.string().optional()
          .describe('New page title.'),
        body: z.string().optional()
          .describe('HTML body content.'),
        published: z.boolean().optional()
          .describe('Published state.'),
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

      const { page_url, course_id: _cid, ...fields } = args
      try {
        await getPage(client, courseId, page_url)
      } catch {
        return toolError(`Page not found: "${page_url}". Use list_pages to find the correct URL slug.`)
      }
      const page = await updatePage(client, courseId, page_url, fields)

      return toJson({
        page_id: page.page_id,
        url: page.url,
        title: page.title,
        published: page.published,
        front_page: page.front_page,
      })
    }
  )

  // ── list_pages ────────────────────────────────────────────────────────────────

  server.registerTool(
    'list_pages',
    {
      description: 'List all wiki pages in a course with their URL slugs and published state.',
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

      const pages = await listPages(client, courseId)
      return toJson(pages.map(p => ({
        page_id: p.page_id,
        url: p.url,
        title: p.title,
        published: p.published,
        front_page: p.front_page,
      })))
    }
  )

  // ── delete_page ───────────────────────────────────────────────────────────────

  server.registerTool(
    'delete_page',
    {
      description: 'Permanently delete a wiki page.',
      inputSchema: z.object({
        page_url: z.string()
          .describe('Page URL slug (e.g. "week-2-overview"). Returned by create_page as the "url" field.'),
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

      const page = await getPage(client, courseId, args.page_url)
      if (page.front_page) {
        return toolError(
          `Cannot delete "${args.page_url}" because it is the course front page. ` +
          `Assign a different front page in Canvas first, then retry.`
        )
      }

      await deletePage(client, courseId, args.page_url)
      return toJson({ deleted: true, page_url: args.page_url })
    }
  )

  // ── remove_module_item ───────────────────────────────────────────────────────

  server.registerTool(
    'remove_module_item',
    {
      description: 'Remove an item from a module. Does not delete the underlying Canvas object.',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
        item_id: z.number().int().positive()
          .describe('Canvas module item ID'),
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

      await deleteModuleItem(client, courseId, args.module_id, args.item_id)
      return toJson({ deleted: true, module_id: args.module_id, item_id: args.item_id })
    }
  )

  // ── delete_discussion ──────────────────────────────────────────────────────

  server.registerTool(
    'delete_discussion',
    {
      description: 'Permanently delete a discussion topic.',
      inputSchema: z.object({
        topic_id: z.number().int().positive()
          .describe('Canvas discussion topic ID'),
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

      await deleteDiscussionTopic(client, courseId, args.topic_id)
      return toJson({ deleted: true, topic_id: args.topic_id })
    }
  )

  // ── delete_announcement ────────────────────────────────────────────────────

  server.registerTool(
    'delete_announcement',
    {
      description: 'Permanently delete an announcement. Announcements are discussion topics internally.',
      inputSchema: z.object({
        topic_id: z.number().int().positive()
          .describe('Canvas announcement (discussion topic) ID'),
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

      await deleteDiscussionTopic(client, courseId, args.topic_id)
      return toJson({ deleted: true, topic_id: args.topic_id })
    }
  )

  // ── delete_file ────────────────────────────────────────────────────────────

  server.registerTool(
    'delete_file',
    {
      description: 'Permanently delete a file. Warning: this is irreversible — Canvas has no trash bin for files.',
      inputSchema: z.object({
        file_id: z.number().int().positive()
          .describe('Canvas file ID'),
      }),
    },
    async (args) => {
      await deleteFile(client, args.file_id)
      return toJson({ deleted: true, file_id: args.file_id })
    }
  )

  // ── clear_syllabus ─────────────────────────────────────────────────────────

  server.registerTool(
    'clear_syllabus',
    {
      description: 'Clear the course syllabus body to an empty string.',
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

      await updateCourse(client, courseId, { syllabus_body: '' })
      return toJson({ cleared: true, course_id: courseId })
    }
  )

  // ── create_discussion ─────────────────────────────────────────────────────

  server.registerTool(
    'create_discussion',
    {
      description: 'Create a new discussion topic in a course.',
      inputSchema: z.object({
        title: z.string()
          .describe('Discussion title'),
        message: z.string().optional()
          .describe('HTML body content for the discussion.'),
        published: z.boolean().optional()
          .describe('Whether to publish immediately. Default false.'),
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

      const topic = await createDiscussionTopic(client, courseId, {
        title: args.title,
        message: args.message,
        published: args.published ?? false,
      })

      return toJson({
        id: topic.id,
        title: topic.title,
        message: topic.message,
        is_announcement: topic.is_announcement,
        published: topic.published,
      })
    }
  )

  // ── create_announcement ───────────────────────────────────────────────────

  server.registerTool(
    'create_announcement',
    {
      description: 'Create a new announcement in a course. Announcements are always published.',
      inputSchema: z.object({
        title: z.string()
          .describe('Announcement title'),
        message: z.string().optional()
          .describe('HTML body content for the announcement.'),
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

      const topic = await createDiscussionTopic(client, courseId, {
        title: args.title,
        message: args.message,
        is_announcement: true,
        published: true,
      })

      return toJson({
        id: topic.id,
        title: topic.title,
        message: topic.message,
        is_announcement: topic.is_announcement,
        published: topic.published,
      })
    }
  )

  // ── upload_file ───────────────────────────────────────────────────────────

  server.registerTool(
    'upload_file',
    {
      description: 'Upload a file to a course. Uses the 3-step Canvas file upload process.',
      inputSchema: z.object({
        file_path: z.string()
          .describe('Absolute path to the local file to upload.'),
        name: z.string().optional()
          .describe('Display name for the file in Canvas. Defaults to the local filename.'),
        folder_path: z.string().optional()
          .describe('Canvas folder path (e.g. "course files/week1"). Defaults to root.'),
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

      try {
        const { statSync } = await import('node:fs')
        statSync(args.file_path)
      } catch {
        return toolError(`File not found: ${args.file_path}`)
      }

      const file = await uploadFile(client, courseId, {
        file_path: args.file_path,
        name: args.name,
        folder_path: args.folder_path,
      })

      return toJson({
        id: file.id,
        display_name: file.display_name,
        filename: file.filename,
        size: file.size,
        content_type: file.content_type,
        folder_id: file.folder_id,
      })
    }
  )

  // ── create_rubric ─────────────────────────────────────────────────────────

  server.registerTool(
    'create_rubric',
    {
      description: 'Create a rubric and immediately associate it with an assignment for grading. Rubrics must be linked to an assignment — Canvas does not support standalone rubrics.',
      inputSchema: z.object({
        title: z.string()
          .describe('Rubric title'),
        assignment_id: z.number().int().positive()
          .describe('Canvas assignment ID to associate the rubric with.'),
        criteria: z.array(z.object({
          description: z.string()
            .describe('Criterion description'),
          points: z.number()
            .describe('Maximum points for this criterion'),
          ratings: z.array(z.object({
            description: z.string()
              .describe('Rating level description'),
            points: z.number()
              .describe('Points for this rating level'),
          }))
            .describe('Rating levels for this criterion'),
        }))
          .describe('Rubric criteria with nested ratings'),
        use_for_grading: z.boolean().optional()
          .describe('Use the rubric for grading. Defaults to true.'),
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

      const { rubric, rubric_association } = await createRubric(client, courseId, {
        title: args.title,
        assignment_id: args.assignment_id,
        criteria: args.criteria,
        use_for_grading: args.use_for_grading,
      })

      return toJson({
        id: rubric.id,
        title: rubric.title,
        points_possible: rubric.points_possible,
        association_id: rubric_association.id,
        assignment_id: rubric_association.association_id,
        use_for_grading: rubric_association.use_for_grading,
      })
    }
  )

  // ── update_syllabus ───────────────────────────────────────────────────────

  server.registerTool(
    'update_syllabus',
    {
      description: 'Set the course syllabus body to the provided HTML.',
      inputSchema: z.object({
        body: z.string()
          .describe('HTML content for the syllabus.'),
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

      await updateCourse(client, courseId, { syllabus_body: args.body })
      return toJson({ updated: true, course_id: courseId })
    }
  )

  // ── associate_rubric ──────────────────────────────────────────────────────

  server.registerTool(
    'associate_rubric',
    {
      description: 'Associate an existing rubric with an assignment for grading. If assignment_id is omitted, associates the rubric at the course level.',
      inputSchema: z.object({
        rubric_id: z.number().int().positive()
          .describe('Canvas rubric ID'),
        assignment_id: z.number().int().positive().optional()
          .describe('Canvas assignment ID. If omitted, associates at the course level.'),
        use_for_grading: z.boolean().optional()
          .describe('Use the rubric for grading. Defaults to true when assignment_id is provided.'),
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

      const association = await createRubricAssociation(client, courseId, {
        rubric_id: args.rubric_id,
        assignment_id: args.assignment_id,
        use_for_grading: args.use_for_grading,
      })

      return toJson({
        id: association.id,
        rubric_id: association.rubric_id,
        association_id: association.association_id,
        association_type: association.association_type,
        use_for_grading: association.use_for_grading,
      })
    }
  )
}
