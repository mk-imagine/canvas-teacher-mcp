import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CanvasClient,
  ConfigManager,
  SecureStore,
  SidecarManager,
  fetchStudentEnrollments,
} from '@canvas-mcp/core'
import { registerAttendanceTools } from '../../src/tools/attendance.js'
import { registerReportingTools } from '../../src/tools/reporting.js'

// ─── Environment ──────────────────────────────────────────────────────────────

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const assignment1Id = parseInt(process.env.CANVAS_TEST_ASSIGNMENT_1_ID ?? '0')
const attendanceAssignmentId = parseInt(process.env.CANVAS_TEST_ATTENDANCE_ASSIGNMENT_ID ?? '0')
const studentIds = process.env.CANVAS_TEST_STUDENT_IDS?.split(',').map(Number) ?? []

const hasSeedIds = assignment1Id > 0 && attendanceAssignmentId > 0 && studentIds.length === 5

// ─── Roster discovery ─────────────────────────────────────────────────────────
// Fetch real student names at runtime so we can build CSV fixtures.
// This avoids hardcoding PII in the test file.

interface RosterStudent {
  userId: number
  name: string
  sortableName: string
}

let roster: RosterStudent[] = []

beforeAll(async () => {
  if (!hasSeedIds) return
  const client = new CanvasClient({ instanceUrl, apiToken })
  const enrollments = await fetchStudentEnrollments(client, testCourseId)
  roster = enrollments.map((e) => ({
    userId: e.user_id,
    name: e.user.name,
    sortableName: e.user.sortable_name,
  }))
  console.log(`  Discovered ${roster.length} students on roster`)
})

// ─── Grade restoration ────────────────────────────────────────────────────────
// Track original grades for assignment 1 so we can restore after the test.

const originalGrades: Map<number, string | null> = new Map()

afterAll(async () => {
  if (originalGrades.size === 0) return
  const client = new CanvasClient({ instanceUrl, apiToken })
  for (const [userId, grade] of originalGrades) {
    try {
      await client.put(
        `/api/v1/courses/${testCourseId}/assignments/${attendanceAssignmentId}/submissions/${userId}`,
        { submission: { posted_grade: grade ?? '' } }
      )
    } catch {
      console.warn(`  Warning: failed to restore grade for user ${userId}`)
    }
  }
  console.log(`  Restored ${originalGrades.size} grades on assignment ${attendanceAssignmentId}`)
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigDir(): string {
  const suffix = randomBytes(8).toString('hex')
  const dir = join(tmpdir(), `canvas-int-attendance-${suffix}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeConfigAndCsv(
  configDir: string,
  studentNames: string[],
  options?: { hostName?: string; durations?: number[] },
) {
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      canvas: { instanceUrl, apiToken },
      program: { activeCourseId: testCourseId, courseCodes: [], courseCache: {} },
      attendance: {
        hostName: options?.hostName ?? '',
        defaultPoints: 10,
        defaultMinDuration: 0,
      },
    }),
    'utf-8',
  )

  // Build Zoom-style CSV
  const durations = options?.durations ?? studentNames.map(() => 45)
  const header = 'Name (Original Name),User Email,Duration (Minutes),Guest,Recording Consent'
  const rows = studentNames.map(
    (name, i) => `${name},${name.toLowerCase().replace(/\s+/g, '.')}@example.com,${durations[i]},No,Yes`,
  )
  const csvContent = [header, ...rows].join('\n')
  const csvPath = join(configDir, 'attendance.csv')
  writeFileSync(csvPath, csvContent, 'utf-8')

  return { configPath, csvPath }
}

async function makeAttendanceClient(configPath: string, store?: SecureStore) {
  const secureStore = store ?? new SecureStore()
  const configManager = new ConfigManager(configPath)
  const config = configManager.read()
  const sidecarManager = new SidecarManager(config.privacy.sidecarPath, config.privacy.blindingEnabled)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerAttendanceTools(mcpServer, canvasClient, configManager, secureStore, sidecarManager)
  registerReportingTools(mcpServer, canvasClient, configManager, secureStore, sidecarManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, store: secureStore }
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>
type ContentBlock = { type: string; text: string }

function parseResult(result: ToolResult) {
  return JSON.parse((result.content as ContentBlock[])[0].text)
}

function getResultText(result: ToolResult): string {
  return (result.content as ContentBlock[])[0].text
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Integration: import_attendance — parse', () => {
  it.skipIf(!hasSeedIds)('parses a CSV and matches all students on roster', async () => {
    const configDir = makeTmpConfigDir()
    // Use first 3 students from roster
    const testStudents = roster.slice(0, 3)
    const names = testStudents.map((s) => s.name)
    const { configPath, csvPath } = makeConfigAndCsv(configDir, names)
    const store = new SecureStore()
    const { mcpClient } = await makeAttendanceClient(configPath, store)

    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: {
        action: 'parse',
        csv_path: csvPath,
        assignment_id: attendanceAssignmentId,
        points: 10,
      },
    })

    const data = parseResult(result)
    expect(data.matched_count).toBe(3)
    expect(data.ambiguous_count).toBe(0)
    expect(data.unmatched_count).toBe(0)
    expect(data.course_id).toBe(testCourseId)
    // Absent = total roster minus 3 matched
    expect(data.absent_count).toBe(roster.length - 3)

    // PII assertion: no real names in response
    const text = getResultText(result)
    for (const name of names) {
      expect(text).not.toContain(name)
    }

    // All matched entries use [STUDENT_NNN] tokens
    for (const m of data.matched) {
      expect(m.student).toMatch(/^\[STUDENT_\d{3}\]$/)
      expect(typeof m.duration).toBe('number')
    }
    for (const a of data.absent) {
      expect(a.student).toMatch(/^\[STUDENT_\d{3}\]$/)
    }

    console.log(`  Parsed: ${data.matched_count} matched, ${data.absent_count} absent`)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('no real student names appear in blinded response', async () => {
    const configDir = makeTmpConfigDir()
    const names = roster.map((s) => s.name)
    const { configPath, csvPath } = makeConfigAndCsv(configDir, names)
    const store = new SecureStore()
    const { mcpClient } = await makeAttendanceClient(configPath, store)

    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: attendanceAssignmentId },
    })

    const text = getResultText(result)
    // Neither real names nor sortable names should appear
    for (const s of roster) {
      expect(text).not.toContain(s.name)
      expect(text).not.toContain(s.sortableName)
    }
    store.destroy()
  })
})

describe('Integration: import_attendance — submit dry-run', () => {
  it.skipIf(!hasSeedIds)('dry-run returns preview without posting grades', async () => {
    const configDir = makeTmpConfigDir()
    const testStudents = roster.slice(0, 3)
    const names = testStudents.map((s) => s.name)
    const { configPath, csvPath } = makeConfigAndCsv(configDir, names)
    const store = new SecureStore()
    const { mcpClient } = await makeAttendanceClient(configPath, store)

    // Record original grades before test so we can verify nothing changed
    const client = new CanvasClient({ instanceUrl, apiToken })
    const gradesBefore: Record<number, string | null> = {}
    for (const s of testStudents) {
      const sub = await client.getOne<{ grade: string | null }>(
        `/api/v1/courses/${testCourseId}/assignments/${attendanceAssignmentId}/submissions/${s.userId}`,
      )
      gradesBefore[s.userId] = sub.grade
    }

    // Step 1: parse
    await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: attendanceAssignmentId, points: 10 },
    })

    // Step 2: submit with dry_run=true
    const dryResult = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'submit', assignment_id: attendanceAssignmentId, dry_run: true },
    })

    const data = parseResult(dryResult)
    expect(data.dry_run).toBe(true)
    expect(data.assignment_id).toBe(attendanceAssignmentId)
    expect(data.points).toBe(10)
    expect(data.grades_preview).toHaveLength(3)

    for (const p of data.grades_preview) {
      expect(p.student).toMatch(/^\[STUDENT_\d{3}\]$/)
      expect(p.status).toBe('would_post')
    }

    // Verify no grades changed on Canvas
    for (const s of testStudents) {
      const sub = await client.getOne<{ grade: string | null }>(
        `/api/v1/courses/${testCourseId}/assignments/${attendanceAssignmentId}/submissions/${s.userId}`,
      )
      expect(sub.grade).toBe(gradesBefore[s.userId])
    }

    // PII assertion
    const text = getResultText(dryResult)
    for (const s of roster) {
      expect(text).not.toContain(s.name)
    }

    console.log(`  Dry-run: ${data.grades_preview.length} grades previewed, none posted`)
    store.destroy()
  })
})

describe('Integration: import_attendance — submit', () => {
  it.skipIf(!hasSeedIds)('submits grades and verifies they are posted on Canvas', async () => {
    const configDir = makeTmpConfigDir()
    // Use all 5 students so we can verify attendance grades for each
    const names = roster.map((s) => s.name)
    const { configPath, csvPath } = makeConfigAndCsv(configDir, names)
    const store = new SecureStore()
    const { mcpClient } = await makeAttendanceClient(configPath, store)
    const client = new CanvasClient({ instanceUrl, apiToken })

    // Record original grades so afterAll can restore them
    for (const s of roster) {
      if (!originalGrades.has(s.userId)) {
        const sub = await client.getOne<{ grade: string | null }>(
          `/api/v1/courses/${testCourseId}/assignments/${attendanceAssignmentId}/submissions/${s.userId}`,
        )
        originalGrades.set(s.userId, sub.grade)
      }
    }

    // Step 1: parse all students as present
    const parseResult_ = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: attendanceAssignmentId, points: 10 },
    })
    const parseData = parseResult(parseResult_)
    expect(parseData.matched_count).toBe(roster.length)

    // Step 2: submit for real
    const submitResult = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'submit', assignment_id: attendanceAssignmentId },
    })

    const submitData = parseResult(submitResult)
    expect(submitData.grades_posted).toBe(roster.length)
    expect(submitData.grades_attempted).toBe(roster.length)
    expect(submitData.assignment_id).toBe(attendanceAssignmentId)
    expect(submitData.points).toBe(10)
    expect(submitData.errors).toHaveLength(0)

    // Every result should show 'posted'
    for (const r of submitData.results) {
      expect(r.student).toMatch(/^\[STUDENT_\d{3}\]$/)
      expect(r.status).toBe('posted')
      expect(r.points).toBe(10)
    }

    // PII assertion
    const text = getResultText(submitResult)
    for (const s of roster) {
      expect(text).not.toContain(s.name)
    }

    // Verify grades on Canvas — all students should now have score 10
    for (let i = 0; i < roster.length; i++) {
      const sub = await client.getOne<{ score: number | null }>(
        `/api/v1/courses/${testCourseId}/assignments/${attendanceAssignmentId}/submissions/${roster[i].userId}`,
      )
      expect(sub.score, `Expected score 10 for roster[${i}]`).toBe(10)
    }

    console.log(`  Submitted: ${submitData.grades_posted}/${submitData.grades_attempted} grades posted`)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('submit without prior parse returns error', async () => {
    const configDir = makeTmpConfigDir()
    const { configPath } = makeConfigAndCsv(configDir, [])
    const { mcpClient } = await makeAttendanceClient(configPath)

    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'submit', assignment_id: attendanceAssignmentId },
    })

    const text = getResultText(result)
    expect(text).toContain('No attendance data parsed')
  })
})

describe('Integration: import_attendance — name-map re-parse', () => {
  it.skipIf(!hasSeedIds)('unmatched name resolves via zoom-name-map.json on re-parse', async () => {
    const configDir = makeTmpConfigDir()
    const fakeName = 'ZZQQ Nonexistent Person'
    const targetStudent = roster[0]

    // Build CSV with a single entry using a fake name that won't match anyone
    const { configPath, csvPath } = makeConfigAndCsv(configDir, [fakeName])

    // ── First parse: expect no matches ──
    const store1 = new SecureStore()
    const { mcpClient: client1 } = await makeAttendanceClient(configPath, store1)

    const result1 = await client1.callTool({
      name: 'import_attendance',
      arguments: {
        action: 'parse',
        csv_path: csvPath,
        assignment_id: attendanceAssignmentId,
        points: 10,
      },
    })

    const data1 = parseResult(result1)
    expect(data1.matched_count).toBe(0)
    expect(data1.unmatched_count + data1.ambiguous_count).toBeGreaterThanOrEqual(1)

    // PII assertion on first response
    const text1 = getResultText(result1)
    for (const s of roster) {
      expect(text1).not.toContain(s.name)
      expect(text1).not.toContain(s.sortableName)
    }

    // ── Write name map: fake name → target student ──
    const nameMapPath = join(configDir, 'zoom-name-map.json')
    writeFileSync(
      nameMapPath,
      JSON.stringify({ 'zzqq nonexistent person': targetStudent.userId }),
      'utf-8',
    )

    // ── Second parse: new server/client pair picks up the name map ──
    const store2 = new SecureStore()
    const { mcpClient: client2 } = await makeAttendanceClient(configPath, store2)

    const result2 = await client2.callTool({
      name: 'import_attendance',
      arguments: {
        action: 'parse',
        csv_path: csvPath,
        assignment_id: attendanceAssignmentId,
        points: 10,
      },
    })

    const data2 = parseResult(result2)
    expect(data2.matched_count).toBe(1)
    expect(data2.matched[0].source).toBe('map')

    // PII assertion on second response
    const text2 = getResultText(result2)
    for (const s of roster) {
      expect(text2).not.toContain(s.name)
      expect(text2).not.toContain(s.sortableName)
    }
    // Matched entry uses STUDENT token
    expect(data2.matched[0].student).toMatch(/^\[STUDENT_\d{3}\]$/)

    console.log(`  Name-map re-parse: ${data2.matched_count} matched via map`)

    store1.destroy()
    store2.destroy()
  })
})
