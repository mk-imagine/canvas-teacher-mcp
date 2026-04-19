import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CanvasClient,
  type ConfigManager,
  type CanvasTeacherConfig,
  fetchStudentEnrollments,
  fetchTeacherSectionIds,
  gradeSubmission,
  parseZoomCsv,
  matchAttendance,
  writeReviewFile,
  SecureStore,
  SidecarManager,
  RosterStore,
  ConflictStore,
  type MatchResult,
  type RosterEntry,
  type ReviewEntry,
  type ZoomParticipant,
} from '@canvas-mcp/core'

// ─── Per-server parse state (WeakMap prevents cross-instance leakage) ───────

interface ParseState {
  matchResult: MatchResult
  courseId: number
  assignmentId: number
  points: number
  roster: RosterEntry[]
}

const parseStateByServer = new WeakMap<McpServer, ParseState>()

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/**
 * Builds a single-block blinded response — plain text JSON with tokens only.
 * See reporting.ts for full rationale on why audience annotations are omitted.
 */
function blindedResponse(blindedData: unknown, store: SecureStore, sidecarManager?: SidecarManager) {
  const blindedJson = JSON.stringify(blindedData, null, 2)
  if (sidecarManager?.sync(store)) {
    const n = store.listTokens().length
    process.stderr.write(
      `[canvas-mcp] PII sidecar updated — ${n} student${n === 1 ? '' : 's'} mapped to tokens.\n`
    )
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: blindedJson,
      },
    ],
  }
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerAttendanceTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  secureStore: SecureStore,
  sidecarManager: SidecarManager,
  rosterStore: RosterStore,
): void {
  server.registerTool(
    'import_attendance',
    {
      description: [
        'Import attendance from a Zoom participant CSV.',
        'action="parse" — read CSV, match names to Canvas roster, return tokenized results for review.',
        'action="submit" — post grades for matched students from a prior parse. Requires a successful parse first.',
        'Results are FERPA-blinded: real names replaced with [STUDENT_NNN] tokens.',
      ].join(' '),
      inputSchema: z.object({
        action: z.enum(['parse', 'submit'])
          .describe('Action: "parse" reads CSV and matches names. "submit" posts grades from prior parse.'),
        csv_path: z.string().optional()
          .describe('For action="parse": absolute path to the Zoom participant CSV file (required).'),
        assignment_id: z.number().optional()
          .describe('Canvas assignment ID to grade. Required for submit; stored during parse for reference.'),
        points: z.number().optional()
          .describe('Points to award for attendance. Defaults to config attendance.defaultPoints.'),
        min_duration: z.number().optional()
          .describe('For action="parse": minimum duration in minutes to count as present. Defaults to config attendance.defaultMinDuration.'),
        dry_run: z.boolean().optional()
          .describe('For action="submit": if true, preview grades without posting. Default: false.'),
        course_id: z.number().optional()
          .describe('Canvas course ID. Defaults to active course.'),
      }),
    },
    async (args) => {
      if (args.action === 'parse') {
        const config = configManager.read()
        let courseId: number
        try {
          courseId = resolveCourseId(config, args.course_id)
        } catch (err) {
          return toolError((err as Error).message)
        }

        // Read CSV file
        let csvContent: string
        try {
          csvContent = readFileSync(args.csv_path!, 'utf-8')
        } catch (err) {
          return toolError(`Cannot read CSV file: ${(err as Error).message}`)
        }

        // Parse CSV with host filtering from config
        const hostName = config.attendance.hostName || undefined
        const participants = parseZoomCsv(csvContent, { hostName })

        // Apply min_duration filter
        const minDuration = args.min_duration ?? config.attendance.defaultMinDuration
        const filtered = minDuration > 0
          ? participants.filter((p) => p.duration >= minDuration)
          : participants

        // Fetch Canvas roster — filtered to the teacher's own sections, so
        // cross-listed sections taught by other instructors don't pollute
        // the matching haystack.
        const teacherSections = await fetchTeacherSectionIds(client, courseId)
        const enrollments = (await fetchStudentEnrollments(client, courseId)).filter(
          (e) => teacherSections.has(e.course_section_id),
        )
        const roster: RosterEntry[] = enrollments.map((e) => ({
          userId: e.user_id,
          name: e.user.name,
          sortableName: e.user.sortable_name,
        }))

        // Build alias map from RosterStore
        let students: Awaited<ReturnType<RosterStore['allStudents']>>
        try {
          students = await rosterStore.allStudents(courseId)
        } catch (err) {
          return toolError(`Failed to load roster: ${(err as Error).message}`)
        }
        const aliasMap = new Map<string, number>()
        for (const student of students) {
          for (const alias of student.zoomAliases) {
            aliasMap.set(alias.toLowerCase(), student.canvasUserId)
          }
        }

        // Conflict-driven review routing: zoom names whose aliases collided
        // with a different student's canonical name at sync time are force-
        // routed to the review file (rather than auto-matched via alias).
        const conflictStore = new ConflictStore(configManager.getConfigDir())
        const conflicted: ZoomParticipant[] = []
        const matchable: ZoomParticipant[] = []
        for (const p of filtered) {
          if (conflictStore.hasConflict(p.name)) {
            conflicted.push(p)
          } else {
            matchable.push(p)
          }
        }

        // Run matching pipeline on non-conflicted participants
        const autoMatchPromises: Promise<boolean>[] = []
        const matchResult = matchAttendance(matchable, roster, aliasMap, (zoomName, canvasUserId) => {
          autoMatchPromises.push(rosterStore.appendZoomAlias(canvasUserId, zoomName))
        })

        // Persist auto-matched aliases
        await Promise.all(autoMatchPromises)

        // Append conflicted participants to ambiguous with both candidate users
        for (const p of conflicted) {
          const conflicts = conflictStore.forAlias(p.name)
          const uniqueCandidates = new Map<number, { canvasName: string; canvasUserId: number; distance: number }>()
          for (const c of conflicts) {
            uniqueCandidates.set(c.aliasUserId, { canvasName: c.aliasUserName, canvasUserId: c.aliasUserId, distance: 0 })
            uniqueCandidates.set(c.newUserId, { canvasName: c.newUserName, canvasUserId: c.newUserId, distance: 0 })
          }
          matchResult.ambiguous.push({
            zoomName: p.name,
            duration: p.duration,
            candidates: [...uniqueCandidates.values()],
          })
        }

        // Write review file if there are ambiguous or unmatched entries
        const configDir = configManager.getConfigDir()
        let reviewFilePath: string | null = null
        if (matchResult.ambiguous.length > 0 || matchResult.unmatched.length > 0) {
          const reviewEntries: ReviewEntry[] = [
            ...matchResult.ambiguous.map((a) => ({
              zoomName: a.zoomName,
              status: 'ambiguous' as const,
              candidates: a.candidates,
            })),
            ...matchResult.unmatched.map((u) => ({
              zoomName: u.zoomName,
              status: 'unmatched' as const,
              candidates: u.candidates,
            })),
          ]
          reviewFilePath = writeReviewFile(configDir, reviewEntries)
        }

        // Determine points
        const points = args.points ?? config.attendance.defaultPoints

        // Store parse result for later submit
        parseStateByServer.set(server, {
          matchResult,
          courseId,
          assignmentId: args.assignment_id ?? 0,
          points,
          roster,
        })

        // Build tokenized response — blind all student names
        const blindedMatched = matchResult.matched.map((m) => {
          const token = secureStore.tokenize(m.canvasUserId, m.canvasName)
          return {
            student: token,
            duration: m.duration,
            source: m.source,
          }
        })

        // Compute absent students (on roster but not matched)
        const matchedIds = new Set(matchResult.matched.map((m) => m.canvasUserId))
        const absent = roster.filter((r) => !matchedIds.has(r.userId))
        const blindedAbsent = absent.map((a) => {
          const token = secureStore.tokenize(a.userId, a.name)
          return { student: token }
        })

        const responseData: Record<string, unknown> = {
          course_id: courseId,
          matched_count: matchResult.matched.length,
          ambiguous_count: matchResult.ambiguous.length,
          unmatched_count: matchResult.unmatched.length,
          absent_count: absent.length,
          matched: blindedMatched,
          absent: blindedAbsent,
        }
        if (reviewFilePath) {
          responseData.review_file = reviewFilePath
        }

        return blindedResponse(responseData, secureStore, sidecarManager)
      }

      if (args.action === 'submit') {
        const lastParseResult = parseStateByServer.get(server) ?? null
        if (lastParseResult === null) {
          return toolError('No attendance data parsed. Run import_attendance with action="parse" first.')
        }

        const config = configManager.read()
        const { matchResult, courseId, roster } = lastParseResult
        const assignmentId = args.assignment_id ?? lastParseResult.assignmentId
        const points = args.points ?? lastParseResult.points ?? config.attendance.defaultPoints
        const dryRun = args.dry_run ?? false

        if (dryRun) {
          // Preview mode — no API calls
          const gradesPreview = matchResult.matched.map((m) => {
            const token = secureStore.tokenize(m.canvasUserId, m.canvasName)
            return { student: token, points, status: 'would_post' as const }
          })

          return blindedResponse(
            {
              dry_run: true,
              course_id: courseId,
              assignment_id: assignmentId,
              points,
              grades_preview: gradesPreview,
            },
            secureStore,
            sidecarManager,
          )
        }

        // Live submission — post grades for each matched student
        const results: Array<{ student: string; points: number; status: 'posted' | 'error'; error?: string }> = []
        let posted = 0
        const errors: Array<{ student: string; error: string }> = []

        for (const m of matchResult.matched) {
          const token = secureStore.tokenize(m.canvasUserId, m.canvasName)
          try {
            await gradeSubmission(client, courseId, assignmentId, m.canvasUserId, points)
            results.push({ student: token, points, status: 'posted' })
            posted++
          } catch (err) {
            const errorMsg = (err as Error).message
            results.push({ student: token, points, status: 'error', error: errorMsg })
            errors.push({ student: token, error: errorMsg })
          }
        }

        // Clear parse state after (non-dry-run) submission
        parseStateByServer.delete(server)

        return blindedResponse(
          {
            course_id: courseId,
            assignment_id: assignmentId,
            points,
            grades_posted: posted,
            grades_attempted: matchResult.matched.length,
            results,
            errors,
          },
          secureStore,
          sidecarManager,
        )
      }

      throw new Error(`Unsupported action: ${(args as any).action}`)
    }
  )
}
