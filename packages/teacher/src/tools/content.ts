import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CanvasClient,
  type ConfigManager,
  type CanvasTeacherConfig,
  uploadFile,
  deleteFile,
  createRubric,
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

export const completionRequirementSchema = z.object({
  type: z.enum(['min_score', 'must_submit', 'must_view']),
  min_score: z.number().optional(),
}).optional()

export function registerContentTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager
): void {
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
}

