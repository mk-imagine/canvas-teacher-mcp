import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CanvasClient,
  type ConfigManager,
  type CanvasTeacherConfig,
  fetchStudentEnrollments,
  parseZoomCsv,
  matchAttendance,
  ZoomNameMap,
  writeReviewFile,
  SecureStore,
  SidecarManager,
  type MatchResult,
  type RosterEntry,
  type ReviewEntry,
} from '@canvas-mcp/core'

// ─── Module-scoped parse state ──────────────────────────────────────────────

interface ParseState {
  matchResult: MatchResult
  courseId: number
  assignmentId: number
  points: number
  roster: RosterEntry[]
}

let lastParseResult: ParseState | null = null

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

        // Fetch Canvas roster
        const enrollments = await fetchStudentEnrollments(client, courseId)
        const roster: RosterEntry[] = enrollments.map((e) => ({
          userId: e.user_id,
          name: e.user.name,
          sortableName: e.user.sortable_name,
        }))

        // Load persistent name map
        const configDir = configManager.getConfigDir()
        const nameMap = new ZoomNameMap()
        await nameMap.load(configDir)

        // Run matching pipeline
        const matchResult = matchAttendance(filtered, roster, nameMap)

        // Save high-confidence fuzzy matches to persistent map
        await nameMap.save(configDir)

        // Write review file if there are ambiguous or unmatched entries
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
            })),
          ]
          reviewFilePath = writeReviewFile(configDir, reviewEntries)
        }

        // Determine points
        const points = args.points ?? config.attendance.defaultPoints

        // Store parse result for later submit
        lastParseResult = {
          matchResult,
          courseId,
          assignmentId: args.assignment_id ?? 0,
          points,
          roster,
        }

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
        if (lastParseResult === null) {
          return toolError('No attendance data parsed. Run import_attendance with action="parse" first.')
        }

        // Placeholder for packet 3.2
        return toolError('Submit action not yet implemented. Run parse first.')
      }

      throw new Error(`Unsupported action: ${(args as any).action}`)
    }
  )
}
