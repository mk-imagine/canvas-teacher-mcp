import { z } from 'zod'
import Handlebars from 'handlebars'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient } from '../canvas/client.js'
import { type ConfigManager } from '../config/manager.js'
import { type CanvasTeacherConfig } from '../config/schema.js'
import { createPage, getPage } from '../canvas/pages.js'
import { createAssignment, getAssignment } from '../canvas/assignments.js'
import { createQuiz, createQuizQuestion, getQuiz, listQuizQuestions } from '../canvas/quizzes.js'
import {
  createModule,
  updateModule,
  getModule,
  listModuleItems,
  createModuleItem,
} from '../canvas/modules.js'
import { renderTemplate, type RenderableItem, type QuizQuestionInput } from '../templates/index.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

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

// ─── Creation sequence executor ───────────────────────────────────────────────

interface CreatedItem {
  type: string
  title: string
  id?: number
  url?: string
  module_item_id?: number
}

interface ExecutionResult {
  items_created: CreatedItem[]
  error?: string
  completed_before_failure?: CreatedItem[]
}

async function executeRenderables(
  client: CanvasClient,
  courseId: number,
  moduleId: number,
  renderables: RenderableItem[],
  config: CanvasTeacherConfig,
  assignmentGroupId?: number
): Promise<ExecutionResult> {
  const items_created: CreatedItem[] = []

  const completionReq = config.defaults.completionRequirement === 'min_score'
    ? { type: 'min_score' as const, min_score: config.defaults.minScore }
    : { type: config.defaults.completionRequirement as 'must_submit' | 'must_view' }

  for (const item of renderables) {
    try {
      if (item.kind === 'subheader') {
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'SubHeader',
          title: item.title,
        })
        items_created.push({ type: 'SubHeader', title: item.title, module_item_id: mi.id })

      } else if (item.kind === 'page') {
        const page = await createPage(client, courseId, {
          title: item.title,
          body: item.body,
          published: false,
        })
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'Page',
          title: item.title,
          page_url: page.url,
        })
        items_created.push({ type: 'Page', title: item.title, id: page.page_id, url: page.url, module_item_id: mi.id })

      } else if (item.kind === 'assignment') {
        const assignment = await createAssignment(client, courseId, {
          name: item.title,
          points_possible: item.points,
          due_at: item.due_at,
          submission_types: item.submission_types,
          assignment_group_id: assignmentGroupId,
          description: item.description,
          published: false,
        })
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'Assignment',
          title: item.title,
          content_id: assignment.id,
          completion_requirement: completionReq,
        })
        items_created.push({ type: 'Assignment', title: item.title, id: assignment.id, module_item_id: mi.id })

      } else if (item.kind === 'exit_card_quiz') {
        const title = Handlebars.compile(config.exitCardTemplate.title)({ week: String(item.week) })
        const quiz = await createQuiz(client, courseId, {
          title,
          quiz_type: config.exitCardTemplate.quizType,
          points_possible: config.defaults.exitCardPoints,
          published: false,
        })
        await Promise.all(
          config.exitCardTemplate.questions.map(q =>
            createQuizQuestion(client, courseId, quiz.id, {
              question_name: q.question_name,
              question_text: q.question_text,
              question_type: q.question_type,
              points_possible: q.points_possible ?? 0,
            })
          )
        )
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'Quiz',
          title,
          content_id: quiz.id,
          completion_requirement: completionReq,
        })
        items_created.push({ type: 'Quiz (exit card)', title, id: quiz.id, module_item_id: mi.id })

      } else if (item.kind === 'quiz') {
        const quiz = await createQuiz(client, courseId, {
          title: item.title,
          quiz_type: item.quiz_type as 'practice_quiz' | 'assignment' | 'graded_survey' | 'survey',
          points_possible: item.points,
          due_at: item.due_at,
          time_limit: item.time_limit,
          allowed_attempts: item.allowed_attempts,
          published: false,
        })
        if (item.questions && item.questions.length > 0) {
          await Promise.all(
            item.questions.map((q: QuizQuestionInput) =>
              createQuizQuestion(client, courseId, quiz.id, {
                question_name: q.question_name,
                question_text: q.question_text,
                question_type: q.question_type,
                points_possible: q.points_possible ?? 0,
              })
            )
          )
        }
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'Quiz',
          title: item.title,
          content_id: quiz.id,
          completion_requirement: completionReq,
        })
        items_created.push({ type: 'Quiz', title: item.title, id: quiz.id, module_item_id: mi.id })

      } else if (item.kind === 'external_url') {
        const mi = await createModuleItem(client, courseId, moduleId, {
          type: 'ExternalUrl',
          title: item.title,
          external_url: item.url,
          new_tab: true,
        })
        items_created.push({ type: 'ExternalUrl', title: item.title, module_item_id: mi.id })
      }
    } catch (err) {
      return {
        error: (err as Error).message,
        completed_before_failure: items_created,
        items_created: [],
      }
    }
  }

  return { items_created }
}

// ─── Shared item input schema ─────────────────────────────────────────────────

const itemSchema = z.object({
  type: z.enum([
    'coding_assignment', 'download_url', 'reading_page', 'regular_assignment',
    'manual_assignment', 'video_page', 'review_assignment', 'supplemental_page',
    'review_quiz', 'assignment',
  ]),
  title: z.string().optional(),
  verb: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  hours: z.number().optional(),
  mins: z.number().optional(),
  points: z.number().optional(),
  attempts: z.number().optional(),
  time_limit: z.number().optional(),
  notebook_url: z.string().optional(),
  notebook_title: z.string().optional(),
  instructions: z.string().optional(),
})

// ─── registerModuleTools ──────────────────────────────────────────────────────

export function registerModuleTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {
  // ── create_lesson_module ──────────────────────────────────────────────────

  server.registerTool(
    'create_lesson_module',
    {
      description: 'Create a full lesson module from a template. Orchestrates creation of the module, all sub-items (assignments, quizzes, pages, headers), and optionally publishes it.',
      inputSchema: z.object({
        week: z.number().int().positive()
          .describe('Week number for title and naming'),
        title: z.string()
          .describe('Module title suffix, e.g. "Introduction to Python"'),
        template: z.enum(['later-standard', 'later-review', 'earlier-standard', 'earlier-review'])
          .describe('Template to use for structuring the module'),
        due_date: z.string()
          .describe('Due date for graded items, ISO 8601'),
        items: z.array(itemSchema)
          .describe('Content items to include in the module'),
        assignment_group_id: z.number().int().positive().optional()
          .describe('Assignment group ID for all assignments created'),
        publish: z.boolean().optional()
          .describe('Publish the module after creation. Default false.'),
        dry_run: z.boolean().optional()
          .describe('Preview items without creating anything in Canvas'),
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

      let renderables: RenderableItem[]
      try {
        renderables = renderTemplate(
          args.template,
          args.week,
          args.items,
          args.due_date,
          config
        )
      } catch (err) {
        return toolError(String(err))
      }

      if (args.dry_run) {
        return toJson({ items_preview: renderables, dry_run: true })
      }

      const moduleName = `Week ${args.week} | ${args.title}`
      const mod = await createModule(client, courseId, { name: moduleName })

      const result = await executeRenderables(
        client, courseId, mod.id, renderables, config, args.assignment_group_id
      )

      if (result.error) {
        return toJson({
          module: { id: mod.id, name: mod.name },
          completed_before_failure: result.completed_before_failure,
          error: result.error,
        })
      }

      if (args.publish) {
        await updateModule(client, courseId, mod.id, { published: true })
      }

      return toJson({
        module: { id: mod.id, name: mod.name },
        items_created: result.items_created,
        dry_run: false,
      })
    }
  )

  // ── create_solution_module ────────────────────────────────────────────────

  server.registerTool(
    'create_solution_module',
    {
      description: 'Create a solution module that unlocks after the given lesson module and contains ExternalUrl items linking to solution resources.',
      inputSchema: z.object({
        lesson_module_id: z.number().int().positive()
          .describe('ID of the prerequisite lesson module'),
        unlock_at: z.string()
          .describe('ISO 8601 date when this module unlocks'),
        title: z.string()
          .describe('Module title'),
        solutions: z.array(z.object({
          title: z.string(),
          url: z.string(),
        })).describe('Solution links to add as module items'),
        publish: z.boolean().optional()
          .describe('Publish the module after creation. Default false.'),
        dry_run: z.boolean().optional()
          .describe('Preview without creating anything in Canvas'),
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

      if (args.dry_run) {
        return toJson({
          dry_run: true,
          module_preview: {
            name: args.title,
            prerequisite_module_ids: [args.lesson_module_id],
            unlock_at: args.unlock_at,
          },
          items_preview: args.solutions.map(s => ({ kind: 'external_url', title: s.title, url: s.url })),
        })
      }

      // Verify the lesson module exists
      try {
        await getModule(client, courseId, args.lesson_module_id)
      } catch {
        return toolError(`Lesson module ${args.lesson_module_id} not found in course ${courseId}`)
      }

      const mod = await createModule(client, courseId, {
        name: args.title,
        prerequisite_module_ids: [args.lesson_module_id],
        unlock_at: args.unlock_at,
      })

      const items_created: CreatedItem[] = []
      for (const solution of args.solutions) {
        const mi = await createModuleItem(client, courseId, mod.id, {
          type: 'ExternalUrl',
          title: solution.title,
          external_url: solution.url,
          new_tab: true,
        })
        items_created.push({ type: 'ExternalUrl', title: solution.title, module_item_id: mi.id })
      }

      if (args.publish) {
        await updateModule(client, courseId, mod.id, { published: true })
      }

      return toJson({
        module: { id: mod.id, name: mod.name, prerequisite_module_ids: mod.prerequisite_module_ids },
        items_created,
      })
    }
  )

  // ── clone_module ──────────────────────────────────────────────────────────

  server.registerTool(
    'clone_module',
    {
      description: 'Clone a module from one course into the active (or specified) destination course. Optionally renumber the week and update due dates.',
      inputSchema: z.object({
        source_module_id: z.number().int().positive()
          .describe('Canvas module ID to clone'),
        source_course_id: z.number().int().positive()
          .describe('Course ID containing the source module'),
        week: z.number().int().positive().optional()
          .describe('If provided, replace "Week N" in all titles with this week number'),
        due_date: z.string().optional()
          .describe('If provided, apply this due date to all graded items'),
        dest_course_id: z.number().int().positive().optional()
          .describe('Destination course ID. Defaults to active course.'),
      }),
    },
    async (args) => {
      const config = configManager.read()
      let destCourseId: number
      try {
        destCourseId = resolveCourseId(config, args.dest_course_id)
      } catch (err) {
        return toolError((err as Error).message)
      }

      // Fetch source module
      let sourceModule: Awaited<ReturnType<typeof getModule>>
      try {
        sourceModule = await getModule(client, args.source_course_id, args.source_module_id)
      } catch {
        return toolError(`Source module ${args.source_module_id} not found in course ${args.source_course_id}`)
      }

      // Fetch source module items
      const sourceItems = await listModuleItems(client, args.source_course_id, args.source_module_id)

      // Fetch underlying object details in parallel
      const detailFetches = sourceItems.map(async (item) => {
        if (item.type === 'Assignment' && item.content_id) {
          try {
            return { item, detail: await getAssignment(client, args.source_course_id, item.content_id) }
          } catch {
            return { item, detail: null }
          }
        }
        if (item.type === 'Quiz' && item.content_id) {
          try {
            const [quiz, questions] = await Promise.all([
              getQuiz(client, args.source_course_id, item.content_id),
              listQuizQuestions(client, args.source_course_id, item.content_id),
            ])
            return { item, detail: { ...quiz, questions } }
          } catch {
            return { item, detail: null }
          }
        }
        if (item.type === 'Page' && item.page_url) {
          try {
            return { item, detail: await getPage(client, args.source_course_id, item.page_url) }
          } catch {
            return { item, detail: null }
          }
        }
        return { item, detail: null }
      })

      const fetched = await Promise.all(detailFetches)

      // Week substitution helper
      function subWeek(text: string): string {
        if (args.week == null) return text
        return text.replace(/Week\s+\d+/g, `Week ${args.week}`)
      }

      // Build renderables from fetched data
      const renderables: RenderableItem[] = []
      for (const { item, detail } of fetched) {
        if (item.type === 'SubHeader') {
          renderables.push({ kind: 'subheader', title: subWeek(item.title) })

        } else if (item.type === 'ExternalUrl') {
          renderables.push({
            kind: 'external_url',
            title: subWeek(item.title),
            url: item.external_url ?? '',
          })

        } else if (item.type === 'Page') {
          const pageDetail = detail as { title: string; body: string | null } | null
          const title = subWeek(pageDetail?.title ?? item.title)
          const body = pageDetail?.body
            ? subWeek(pageDetail.body)
            : undefined
          renderables.push({ kind: 'page', title, body })

        } else if (item.type === 'Assignment') {
          const asgn = detail as { name: string; points_possible: number; due_at: string | null; submission_types: string[]; description: string | null } | null
          const title = subWeek(asgn?.name ?? item.title)
          renderables.push({
            kind: 'assignment',
            title,
            points: asgn?.points_possible ?? 0,
            due_at: args.due_date ?? asgn?.due_at ?? '',
            submission_types: asgn?.submission_types ?? ['online_url'],
            description: asgn?.description ?? undefined,
          })

        } else if (item.type === 'Quiz') {
          const quizDetail = detail as { title: string; quiz_type: string; points_possible: number | null; due_at: string | null; time_limit: number | null; allowed_attempts: number; questions?: QuizQuestionInput[] } | null
          const title = subWeek(quizDetail?.title ?? item.title)
          renderables.push({
            kind: 'quiz',
            title,
            quiz_type: quizDetail?.quiz_type ?? 'assignment',
            points: quizDetail?.points_possible ?? 0,
            due_at: args.due_date ?? quizDetail?.due_at ?? '',
            time_limit: quizDetail?.time_limit ?? undefined,
            allowed_attempts: quizDetail?.allowed_attempts,
            questions: quizDetail?.questions,
          })
        }
      }

      // Determine cloned module name
      const moduleName = args.week != null
        ? subWeek(sourceModule.name)
        : sourceModule.name

      const mod = await createModule(client, destCourseId, { name: moduleName })

      const result = await executeRenderables(
        client, destCourseId, mod.id, renderables, config
      )

      if (result.error) {
        return toJson({
          module: { id: mod.id, name: mod.name },
          completed_before_failure: result.completed_before_failure,
          error: result.error,
        })
      }

      return toJson({
        module: { id: mod.id, name: mod.name },
        items_created: result.items_created,
        dry_run: false,
      })
    }
  )
}
