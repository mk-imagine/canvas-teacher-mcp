import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient, CanvasApiError } from '../canvas/client.js'
import { type ConfigManager } from '../config/manager.js'
import { type CanvasTeacherConfig } from '../config/schema.js'
import {
  listModules,
  getModule,
  listModuleItems,
} from '../canvas/modules.js'
import {
  fetchStudentEnrollments,
  fetchAllSubmissions,
  fetchStudentSubmissions,
  fetchAssignmentSubmissions,
  fetchAssignment,
  fetchAssignmentGroups,
} from '../canvas/submissions.js'
import { SecureStore } from '../security/secure-store.js'

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

/**
 * Builds a two-block response for PII-blinded data.
 * content[0]: blinded JSON for the assistant (no real names or IDs)
 * content[1]: lookup table of token → name for the user only
 */
function blindedResponse(blindedData: unknown, store: SecureStore) {
  const lookupLines = store.listTokens().map(token => {
    const resolved = store.resolve(token)!
    return `${token} → ${resolved.name}`
  })
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(blindedData, null, 2),
        annotations: { audience: ['assistant' as const] },
      },
      {
        type: 'text' as const,
        text: 'Student lookup (current session):\n' + lookupLines.join('\n'),
        annotations: { audience: ['user' as const] },
      },
    ],
  }
}

export function registerReportingTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  secureStore: SecureStore,
): void {
  // ── list_modules ────────────────────────────────────────────────────────────

  server.registerTool(
    'list_modules',
    {
      description: 'List all modules in a course with published state, lock status, and item count.',
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

      const modules = await listModules(client, courseId)
      const result = modules.map((m) => ({
        id: m.id,
        name: m.name,
        position: m.position,
        published: m.published,
        items_count: m.items_count,
        unlock_at: m.unlock_at,
        prerequisite_module_ids: m.prerequisite_module_ids,
      }))
      return toJson(result)
    }
  )

  // ── get_module_summary ──────────────────────────────────────────────────────

  server.registerTool(
    'get_module_summary',
    {
      description: 'Get a module\'s full item list including types, titles, points, due dates, and optionally assignment description HTML.',
      inputSchema: z.object({
        module_id: z.number().int().positive()
          .describe('Canvas module ID'),
        include_html: z.boolean().optional()
          .describe('Fetch raw description HTML for assignment items. Default: false.'),
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

      const [module, items] = await Promise.all([
        getModule(client, courseId, args.module_id),
        listModuleItems(client, courseId, args.module_id),
      ])

      // Optionally fetch assignment descriptions in parallel
      let htmlMap: Map<number, string> = new Map()
      if (args.include_html) {
        const assignmentItems = items.filter(
          (item) => item.type === 'Assignment' && item.content_id != null
        )
        const assignments = await Promise.all(
          assignmentItems.map((item) =>
            fetchAssignment(client, courseId, item.content_id!)
          )
        )
        for (const a of assignments) {
          htmlMap.set(a.id, a.description ?? '')
        }
      }

      const result = {
        module: {
          id: module.id,
          name: module.name,
          published: module.published,
          unlock_at: module.unlock_at,
          prerequisite_module_ids: module.prerequisite_module_ids,
        },
        items: items.map((item) => {
          const base = {
            id: item.id,
            position: item.position,
            type: item.type,
            title: item.title,
            content_id: item.content_id,
            external_url: item.external_url,
            points_possible: item.content_details?.points_possible,
            due_at: item.content_details?.due_at,
            completion_requirement: item.completion_requirement,
          }
          if (args.include_html && item.type === 'Assignment' && item.content_id != null) {
            return { ...base, html: htmlMap.get(item.content_id) ?? null }
          }
          return base
        }),
      }
      return toJson(result)
    }
  )

  // ── list_assignment_groups ──────────────────────────────────────────────────

  server.registerTool(
    'list_assignment_groups',
    {
      description: 'List all assignment groups in a course with weights and rules.',
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

      const groups = await fetchAssignmentGroups(client, courseId)
      return toJson(groups.map((g) => ({
        id: g.id,
        name: g.name,
        group_weight: g.group_weight,
        rules: g.rules,
      })))
    }
  )

  // ── get_class_grade_summary ─────────────────────────────────────────────────

  server.registerTool(
    'get_class_grade_summary',
    {
      description: 'Show every enrolled student\'s grade totals, missing assignment count, late count, and ungraded count.',
      inputSchema: z.object({
        course_id: z.number().int().positive().optional()
          .describe('Canvas course ID. Defaults to active course.'),
        assignment_group_id: z.number().int().positive().optional()
          .describe('Filter submission counts to a specific assignment group.'),
        sort_by: z.enum(['name', 'engagement', 'grade', 'zeros']).optional()
          .describe('Sort order. "name": alphabetical (default). "engagement": missing_count DESC, late_count DESC, name ASC. "grade": current_score ASC, nulls first, then name ASC. "zeros": zero-score submissions DESC, name ASC.'),
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

      const [enrollments, allSubmissions] = await Promise.all([
        fetchStudentEnrollments(client, courseId),
        fetchAllSubmissions(client, courseId),
      ])

      // Group submissions by user_id
      const subsByUser = new Map<number, typeof allSubmissions>()
      for (const sub of allSubmissions) {
        if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, [])
        // Filter to assignment group if requested
        if (
          args.assignment_group_id != null &&
          sub.assignment?.assignment_group_id !== args.assignment_group_id
        ) {
          continue
        }
        subsByUser.get(sub.user_id)!.push(sub)
      }

      const sortBy = args.sort_by ?? 'name'

      // Build and sort on real data before tokenizing (preserves sort order)
      const students = enrollments
        .map((enrollment) => {
          const subs = subsByUser.get(enrollment.user_id) ?? []
          return {
            id: enrollment.user_id,
            name: enrollment.user.name,
            sortable_name: enrollment.user.sortable_name,
            current_score: enrollment.grades.current_score,
            final_score: enrollment.grades.final_score,
            missing_count: subs.filter((s) => s.missing).length,
            late_count: subs.filter((s) => s.late).length,
            ungraded_count: subs.filter(
              (s) => s.workflow_state === 'submitted' && s.graded_at === null && s.score === null
            ).length,
            zeros_count: subs.filter((s) => s.score === 0).length,
          }
        })
        .sort((a, b) => {
          if (sortBy === 'engagement') {
            if (b.missing_count !== a.missing_count) return b.missing_count - a.missing_count
            if (b.late_count !== a.late_count) return b.late_count - a.late_count
            const aScore = a.current_score
            const bScore = b.current_score
            if (aScore === null && bScore === null) return a.sortable_name.localeCompare(b.sortable_name)
            if (aScore === null) return -1
            if (bScore === null) return 1
            if (aScore !== bScore) return aScore - bScore
            return a.sortable_name.localeCompare(b.sortable_name)
          }
          if (sortBy === 'grade') {
            const aScore = a.current_score
            const bScore = b.current_score
            if (aScore === null && bScore === null) return a.sortable_name.localeCompare(b.sortable_name)
            if (aScore === null) return -1
            if (bScore === null) return 1
            if (aScore !== bScore) return aScore - bScore
            return a.sortable_name.localeCompare(b.sortable_name)
          }
          if (sortBy === 'zeros') {
            if (b.zeros_count !== a.zeros_count) return b.zeros_count - a.zeros_count
            return a.sortable_name.localeCompare(b.sortable_name)
          }
          // default: 'name'
          return a.sortable_name.localeCompare(b.sortable_name)
        })

      // Tokenize after sorting so order is preserved
      const blindedStudents = students.map((s) => {
        const token = secureStore.tokenize(s.id, s.name)
        return {
          student: token,
          current_score: s.current_score,
          final_score: s.final_score,
          missing_count: s.missing_count,
          late_count: s.late_count,
          ungraded_count: s.ungraded_count,
          zeros_count: s.zeros_count,
        }
      })

      return blindedResponse({
        course_id: courseId,
        as_of: new Date().toISOString(),
        sort_by: sortBy,
        student_count: blindedStudents.length,
        students: blindedStudents,
      }, secureStore)
    }
  )

  // ── get_assignment_breakdown ────────────────────────────────────────────────

  server.registerTool(
    'get_assignment_breakdown',
    {
      description: 'For a specific assignment, show every student\'s submission status, score, and late/missing flags, plus a class summary.',
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

      const [assignment, submissions] = await Promise.all([
        fetchAssignment(client, courseId, args.assignment_id),
        fetchAssignmentSubmissions(client, courseId, args.assignment_id),
      ])

      // Sort on real names before tokenizing
      const submissionRows = submissions
        .map((s) => ({
          student_name: s.user?.name ?? `User ${s.user_id}`,
          student_id: s.user_id,
          score: s.score,
          submitted_at: s.submitted_at,
          graded_at: s.graded_at,
          late: s.late,
          missing: s.missing,
          workflow_state: s.workflow_state,
        }))
        .sort((a, b) => a.student_name.localeCompare(b.student_name))

      const blindedRows = submissionRows.map((row) => {
        const token = secureStore.tokenize(row.student_id, row.student_name)
        return {
          student: token,
          score: row.score,
          submitted_at: row.submitted_at,
          graded_at: row.graded_at,
          late: row.late,
          missing: row.missing,
          workflow_state: row.workflow_state,
        }
      })

      const gradedScores = submissions
        .map((s) => s.score)
        .filter((score): score is number => score !== null)

      const mean_score =
        gradedScores.length > 0
          ? Math.round((gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length) * 10) / 10
          : null

      return blindedResponse({
        assignment: {
          id: assignment.id,
          name: assignment.name,
          points_possible: assignment.points_possible,
          due_at: assignment.due_at,
          html_url: assignment.html_url,
        },
        submissions: blindedRows,
        summary: {
          total_students: submissions.length,
          submitted: submissions.filter((s) => s.workflow_state !== 'unsubmitted').length,
          missing: submissions.filter((s) => s.missing).length,
          late: submissions.filter((s) => s.late).length,
          ungraded: submissions.filter(
            (s) => s.workflow_state === 'submitted' && s.graded_at === null
          ).length,
          mean_score,
        },
      }, secureStore)
    }
  )

  // ── get_student_report ──────────────────────────────────────────────────────

  server.registerTool(
    'get_student_report',
    {
      description: 'Deep report on a single student — all assignments with scores, missing/late flags, and current grade.',
      inputSchema: z.object({
        student_token: z.string()
          .describe('Session token from get_class_grade_summary or similar (e.g. "[STUDENT_001]")'),
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

      const resolved = secureStore.resolve(args.student_token)
      if (!resolved) {
        return toolError(`Unknown student token: ${args.student_token}`)
      }
      const { canvasId } = resolved

      const [submissionsResult, enrollments] = await Promise.all([
        fetchStudentSubmissions(client, courseId, canvasId)
          .then((subs) => ({ ok: true as const, subs }))
          .catch((err: unknown) => {
            if (err instanceof CanvasApiError && (err.status === 403 || err.status === 404)) {
              return { ok: false as const }
            }
            throw err
          }),
        fetchStudentEnrollments(client, courseId),
      ])

      const enrollment = enrollments.find((e) => e.user_id === canvasId)
      if (!submissionsResult.ok || !enrollment) {
        return toolError(
          `Student ${args.student_token} is not enrolled in course ${courseId}.`
        )
      }

      const submissions = submissionsResult.subs

      const assignments = submissions
        .filter((s) => s.assignment != null)
        .map((s) => ({
          id: s.assignment!.id,
          name: s.assignment!.name,
          due_at: s.assignment!.due_at,
          points_possible: s.assignment!.points_possible,
          score: s.score,
          submitted_at: s.submitted_at,
          late: s.late,
          missing: s.missing,
          workflow_state: s.workflow_state,
        }))
        .sort((a, b) => {
          if (a.due_at == null && b.due_at == null) return 0
          if (a.due_at == null) return 1
          if (b.due_at == null) return -1
          return new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
        })

      const total_missing = assignments.filter((a) => a.missing).length
      const total_late = assignments.filter((a) => a.late).length
      const total_ungraded = submissions.filter(
        (s) => s.workflow_state === 'submitted' && s.graded_at === null && s.score === null
      ).length
      const total_graded = submissions.filter((s) => s.score !== null).length

      return blindedResponse({
        student_token: args.student_token,
        current_score: enrollment.grades.current_score,
        final_score: enrollment.grades.final_score,
        assignments,
        summary: {
          total_assignments: assignments.length,
          total_missing,
          total_late,
          total_ungraded,
          total_graded,
        },
      }, secureStore)
    }
  )

  // ── get_missing_assignments ─────────────────────────────────────────────────

  server.registerTool(
    'get_missing_assignments',
    {
      description: 'List all missing assignments grouped by student. Only includes past-due unsubmitted work.',
      inputSchema: z.object({
        course_id: z.number().int().positive().optional()
          .describe('Canvas course ID. Defaults to active course.'),
        since_date: z.string().optional()
          .describe('Only include assignments with due_at after this ISO 8601 date.'),
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

      const submissions = await fetchAllSubmissions(client, courseId, {
        workflowState: 'unsubmitted',
      })

      // Canvas's missing flag is only set after the due date passes
      let missing = submissions.filter((s) => s.missing)

      if (args.since_date) {
        const since = new Date(args.since_date).getTime()
        missing = missing.filter((s) => {
          if (s.assignment?.due_at == null) return true
          return new Date(s.assignment.due_at).getTime() > since
        })
      }

      // Group by student (using real data for sort, tokenize after)
      const byStudent = new Map<
        number,
        { id: number; name: string; sortable_name: string; assignments: typeof missing }
      >()

      for (const sub of missing) {
        const userId = sub.user_id
        if (!byStudent.has(userId)) {
          byStudent.set(userId, {
            id: userId,
            name: sub.user?.name ?? `User ${userId}`,
            sortable_name: sub.user?.sortable_name ?? `User ${userId}`,
            assignments: [],
          })
        }
        byStudent.get(userId)!.assignments.push(sub)
      }

      const students = [...byStudent.values()]
        .map((s) => ({
          id: s.id,
          name: s.name,
          sortable_name: s.sortable_name,
          missing_assignments: s.assignments
            .sort((a, b) => {
              if (a.assignment?.due_at == null && b.assignment?.due_at == null) return 0
              if (a.assignment?.due_at == null) return 1
              if (b.assignment?.due_at == null) return -1
              return (
                new Date(a.assignment.due_at).getTime() -
                new Date(b.assignment.due_at).getTime()
              )
            })
            .map((s) => ({
              assignment_id: s.assignment_id,
              name: s.assignment?.name ?? `Assignment ${s.assignment_id}`,
              due_at: s.assignment?.due_at ?? null,
              points_possible: s.assignment?.points_possible ?? 0,
            })),
          missing_count: s.assignments.length,
        }))
        .sort((a, b) => {
          if (b.missing_count !== a.missing_count) return b.missing_count - a.missing_count
          return a.sortable_name.localeCompare(b.sortable_name)
        })

      // Tokenize after sorting
      const blindedStudents = students.map((s) => {
        const token = secureStore.tokenize(s.id, s.name)
        return {
          student: token,
          missing_assignments: s.missing_assignments,
          missing_count: s.missing_count,
        }
      })

      return blindedResponse({
        as_of: new Date().toISOString(),
        total_missing_submissions: missing.length,
        students: blindedStudents,
      }, secureStore)
    }
  )

  // ── get_late_assignments ────────────────────────────────────────────────────

  server.registerTool(
    'get_late_assignments',
    {
      description: 'List all late (submitted after due date) assignments grouped by student.',
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

      const allSubmissions = await fetchAllSubmissions(client, courseId)
      const lateSubmissions = allSubmissions.filter((s) => s.late)

      const byStudent = new Map<
        number,
        { id: number; name: string; sortable_name: string; submissions: typeof lateSubmissions }
      >()

      for (const sub of lateSubmissions) {
        const userId = sub.user_id
        if (!byStudent.has(userId)) {
          byStudent.set(userId, {
            id: userId,
            name: sub.user?.name ?? `User ${userId}`,
            sortable_name: sub.user?.sortable_name ?? `User ${userId}`,
            submissions: [],
          })
        }
        byStudent.get(userId)!.submissions.push(sub)
      }

      const students = [...byStudent.values()]
        .map((s) => ({
          id: s.id,
          name: s.name,
          sortable_name: s.sortable_name,
          late_assignments: s.submissions
            .sort((a, b) => {
              if (a.submitted_at == null && b.submitted_at == null) return 0
              if (a.submitted_at == null) return 1
              if (b.submitted_at == null) return -1
              return (
                new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
              )
            })
            .map((sub) => ({
              assignment_id: sub.assignment_id,
              name: sub.assignment?.name ?? `Assignment ${sub.assignment_id}`,
              due_at: sub.assignment?.due_at ?? null,
              submitted_at: sub.submitted_at,
              points_possible: sub.assignment?.points_possible ?? 0,
              score: sub.score,
              graded: sub.score !== null,
            })),
          late_count: s.submissions.length,
        }))
        .sort((a, b) => {
          if (b.late_count !== a.late_count) return b.late_count - a.late_count
          return a.sortable_name.localeCompare(b.sortable_name)
        })

      // Tokenize after sorting
      const blindedStudents = students.map((s) => {
        const token = secureStore.tokenize(s.id, s.name)
        return {
          student: token,
          late_assignments: s.late_assignments,
          late_count: s.late_count,
        }
      })

      return blindedResponse({
        as_of: new Date().toISOString(),
        total_late_submissions: lateSubmissions.length,
        students: blindedStudents,
      }, secureStore)
    }
  )

  // ── resolve_student ─────────────────────────────────────────────────────────

  server.registerTool(
    'resolve_student',
    {
      description: 'Reveal the real name and Canvas ID for a student token. Result is visible to the user only — not sent to the assistant.',
      inputSchema: z.object({
        student_token: z.string()
          .describe('Session token such as "[STUDENT_001]"'),
      }),
    },
    async (args) => {
      const resolved = secureStore.resolve(args.student_token)
      if (!resolved) {
        return toolError(`Unknown student token: ${args.student_token}`)
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              student_token: args.student_token,
              name: resolved.name,
              canvas_id: resolved.canvasId,
            }, null, 2),
            annotations: { audience: ['user' as const] },
          },
        ],
      }
    }
  )

  // ── list_blinded_students ───────────────────────────────────────────────────

  server.registerTool(
    'list_blinded_students',
    {
      description: 'List all student session tokens encountered this session. Use to remind the assistant which tokens are available.',
      inputSchema: z.object({}),
    },
    async () => {
      const tokens = secureStore.listTokens().map((t) => ({ token: t }))
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(tokens, null, 2),
            annotations: { audience: ['assistant' as const] },
          },
        ],
      }
    }
  )
}
