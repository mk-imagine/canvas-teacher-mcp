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
}
