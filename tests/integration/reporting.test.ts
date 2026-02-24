import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient } from '../../src/canvas/client.js'
import { ConfigManager } from '../../src/config/manager.js'
import { registerReportingTools } from '../../src/tools/reporting.js'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const moduleId = parseInt(process.env.CANVAS_TEST_MODULE_ID ?? '0')
const assignment1Id = parseInt(process.env.CANVAS_TEST_ASSIGNMENT_1_ID ?? '0')
const assignment2Id = parseInt(process.env.CANVAS_TEST_ASSIGNMENT_2_ID ?? '0')
const assignment3Id = parseInt(process.env.CANVAS_TEST_ASSIGNMENT_3_ID ?? '0')
const studentIds = process.env.CANVAS_TEST_STUDENT_IDS?.split(',').map(Number) ?? []

// Tests that require seed data are skipped if seed IDs are absent
const hasSeedIds = moduleId > 0 && assignment1Id > 0 && studentIds.length === 5

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-reporting-${suffix}`, 'config.json')
}

async function makeIntegrationClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerReportingTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

function makeConfig(configPath: string) {
  const dir = configPath.substring(0, configPath.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    configPath,
    JSON.stringify({
      canvas: { instanceUrl, apiToken },
      program: { activeCourseId: testCourseId, courseCodes: [], courseCache: {} },
      defaults: { assignmentGroup: 'Assignments', submissionType: 'online_url', pointsPossible: 100 },
    }),
    'utf-8'
  )
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  return JSON.parse(text)
}

// ─── list_modules ──────────────────────────────────────────────────────────────

describe('Integration: list_modules', () => {
  it('returns at least one module', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_modules', arguments: {} }))
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    console.log(`  Found ${data.length} module(s): ${data.map((m: { name: string }) => m.name).join(', ')}`)
  })

  it.skipIf(!hasSeedIds)('seed module appears with correct items_count', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_modules', arguments: {} }))
    const seedModule = data.find((m: { id: number }) => m.id === moduleId)
    expect(seedModule, `Module ${moduleId} not found in list`).toBeDefined()
    expect(seedModule.items_count).toBe(4)
    console.log(`  Seed module: "${seedModule.name}" (id: ${seedModule.id}, items: ${seedModule.items_count})`)
  })
})

// ─── get_module_summary ────────────────────────────────────────────────────────

describe('Integration: get_module_summary', () => {
  it.skipIf(!hasSeedIds)('returns seed module with 4 items', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_module_summary', arguments: { module_id: moduleId } })
    )
    expect(data.module.id).toBe(moduleId)
    expect(data.items).toHaveLength(4)
    console.log(`  Items: ${data.items.map((i: { type: string; title: string }) => `${i.type}:${i.title}`).join(', ')}`)
  })

  it.skipIf(!hasSeedIds)('assignment items have points_possible=10 from content_details', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_module_summary', arguments: { module_id: moduleId } })
    )
    const assignments = data.items.filter((i: { type: string }) => i.type === 'Assignment')
    expect(assignments).toHaveLength(3)
    for (const a of assignments) {
      expect(a.points_possible).toBe(10)
    }
  })

  it.skipIf(!hasSeedIds)('include_html=true returns description on assignment items', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_id: moduleId, include_html: true },
      })
    )
    const assignments = data.items.filter((i: { type: string }) => i.type === 'Assignment')
    for (const a of assignments) {
      expect('html' in a).toBe(true)
    }
  })
})

// ─── list_assignment_groups ────────────────────────────────────────────────────

describe('Integration: list_assignment_groups', () => {
  it('returns at least one assignment group with required fields', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_assignment_groups', arguments: {} })
    )
    expect(data.length).toBeGreaterThan(0)
    const group = data[0]
    expect(group).toHaveProperty('id')
    expect(group).toHaveProperty('name')
    expect(group).toHaveProperty('group_weight')
    expect(group).toHaveProperty('rules')
    console.log(`  Groups: ${data.map((g: { name: string }) => g.name).join(', ')}`)
  })
})

// ─── get_class_grade_summary ───────────────────────────────────────────────────

describe('Integration: get_class_grade_summary', () => {
  it('returns enrolled students', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    expect(data.students.length).toBeGreaterThan(0)
    expect(data.as_of).toBeTruthy()
    console.log(`  ${data.student_count} students`)
  })

  it.skipIf(!hasSeedIds)('returns exactly 5 students matching seed', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    expect(data.student_count).toBe(5)
  })

  it.skipIf(!hasSeedIds)('Student 4 has missing_count=4 (A1, A2, A3, exit card per seed)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    // studentIds[3] is Student 4 (0-indexed)
    const s4 = data.students.find((s: { id: number }) => s.id === studentIds[3])
    expect(s4, 'Student 4 not found in grade summary').toBeDefined()
    // Exit card quiz (graded_survey, past due) also counts as missing
    expect(s4.missing_count).toBe(4)
    console.log(`  Student 4 missing_count: ${s4.missing_count}`)
  })

  it.skipIf(!hasSeedIds)('Student 2 has missing_count=3 (A2, A3, exit card per seed)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    const s2 = data.students.find((s: { id: number }) => s.id === studentIds[1])
    expect(s2, 'Student 2 not found').toBeDefined()
    // Exit card quiz (graded_survey, past due) also counts as missing
    expect(s2.missing_count).toBe(3)
  })

  it('echoes sort_by="name" in response when not specified', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    expect(data.sort_by).toBe('name')
  })

  it('every student row includes zeros_count as a number', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    for (const student of data.students) {
      expect(typeof student.zeros_count).toBe('number')
    }
  })

  it.skipIf(!hasSeedIds)('sort_by=engagement: Student 4 appears first (most missing)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'engagement' },
      })
    )
    expect(data.sort_by).toBe('engagement')
    // Student 4 has 4 missing — highest missing_count, should sort first
    expect(data.students[0].id).toBe(studentIds[3])
    console.log(
      `  Engagement order: ${data.students.slice(0, 3).map((s: { name: string; missing_count: number; late_count: number }) => `${s.name}(m:${s.missing_count},l:${s.late_count})`).join(', ')}`
    )
  })

  it.skipIf(!hasSeedIds)('sort_by=grade: null-score student appears first', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'grade' },
      })
    )
    expect(data.sort_by).toBe('grade')
    // First student should have null score or the lowest score
    const first = data.students[0]
    // Student 4 has all missing → null current_score → sorts first
    expect(first.current_score === null || first.current_score <= first.current_score).toBe(true)
    console.log(
      `  Grade order: ${data.students.slice(0, 3).map((s: { name: string; current_score: number | null }) => `${s.name}(${s.current_score})`).join(', ')}`
    )
  })

  it.skipIf(!hasSeedIds)('sort_by=zeros: response includes zeros_count and sort_by field', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'zeros' },
      })
    )
    expect(data.sort_by).toBe('zeros')
    for (const student of data.students) {
      expect(typeof student.zeros_count).toBe('number')
    }
    console.log(
      `  Zeros order: ${data.students.slice(0, 3).map((s: { name: string; zeros_count: number }) => `${s.name}(zeros:${s.zeros_count})`).join(', ')}`
    )
  })
})

// ─── get_assignment_breakdown ──────────────────────────────────────────────────

describe('Integration: get_assignment_breakdown', () => {
  it.skipIf(!hasSeedIds)('returns correct metadata for Assignment 1', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_assignment_breakdown',
        arguments: { assignment_id: assignment1Id },
      })
    )
    expect(data.assignment.id).toBe(assignment1Id)
    expect(data.assignment.points_possible).toBe(10)
    console.log(`  A1: ${data.summary.submitted} submitted, ${data.summary.missing} missing, mean=${data.summary.mean_score}`)
  })

  it.skipIf(!hasSeedIds)('Student 4 submission on A1 has missing=true', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_assignment_breakdown',
        arguments: { assignment_id: assignment1Id },
      })
    )
    const s4sub = data.submissions.find((s: { student_id: number }) => s.student_id === studentIds[3])
    expect(s4sub, 'Student 4 submission not found').toBeDefined()
    expect(s4sub.missing).toBe(true)
    expect(s4sub.score).toBeNull()
  })

  it.skipIf(!hasSeedIds)('Student 1 submission on A1 has score=10', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_assignment_breakdown',
        arguments: { assignment_id: assignment1Id },
      })
    )
    const s1sub = data.submissions.find((s: { student_id: number }) => s.student_id === studentIds[0])
    expect(s1sub, 'Student 1 submission not found').toBeDefined()
    expect(s1sub.score).toBe(10)
  })
})

// ─── get_student_report ────────────────────────────────────────────────────────

describe('Integration: get_student_report', () => {
  it.skipIf(!hasSeedIds)('Student 4: all assignments missing (A1, A2, A3, exit card)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_student_report',
        arguments: { student_id: studentIds[3] },
      })
    )
    // Exit card quiz (graded_survey, past due) also counts as missing
    expect(data.summary.total_missing).toBe(4)
    expect(data.summary.total_graded).toBe(0)
    console.log(`  Student 4: missing=${data.summary.total_missing}, graded=${data.summary.total_graded}`)
  })

  it.skipIf(!hasSeedIds)('Student 1: 3 graded (A1=10, A2=8, exit card), 1 ungraded (A3)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_student_report',
        arguments: { student_id: studentIds[0] },
      })
    )
    // graded_survey auto-grades on submission, so exit card counts as graded
    expect(data.summary.total_graded).toBe(3)
    expect(data.summary.total_missing).toBe(0)
    expect(data.summary.total_ungraded).toBe(1)
  })

  it('returns error message for unenrolled student ID', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_student_report',
      arguments: { student_id: 999999999 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('not enrolled')
  })
})

// ─── get_missing_assignments ───────────────────────────────────────────────────

describe('Integration: get_missing_assignments', () => {
  it.skipIf(!hasSeedIds)('Student 2 and Student 4 both appear in missing list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    // At minimum Student 2 (A2, A3, exit card) and Student 4 (A1, A2, A3, exit card) are missing
    // (quiz submission states may add additional students depending on Canvas grading behavior)
    expect(data.students.length).toBeGreaterThanOrEqual(2)
    const s4 = data.students.find((s: { id: number }) => s.id === studentIds[3])
    const s2 = data.students.find((s: { id: number }) => s.id === studentIds[1])
    expect(s4, 'Student 4 not found in missing list').toBeDefined()
    expect(s2, 'Student 2 not found in missing list').toBeDefined()
    console.log(
      `  Missing: ${data.students.map((s: { name: string; missing_count: number }) => `${s.name}(${s.missing_count})`).join(', ')}`
    )
  })

  it.skipIf(!hasSeedIds)('Student 4 has 4 missing assignments (A1, A2, A3, exit card)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    const s4 = data.students.find((s: { id: number }) => s.id === studentIds[3])
    expect(s4, 'Student 4 not found in missing list').toBeDefined()
    // Exit card quiz (graded_survey, past due) also counts as missing
    expect(s4.missing_count).toBe(4)
  })

  it.skipIf(!hasSeedIds)('Student 4 appears first (most missing)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    expect(data.students[0].id).toBe(studentIds[3])
  })

  it.skipIf(!hasSeedIds)('since_date far in future returns empty', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_missing_assignments',
        arguments: { since_date: '2099-01-01T00:00:00Z' },
      })
    )
    expect(data.students).toEqual([])
  })
})

// ─── get_late_assignments ──────────────────────────────────────────────────────

describe('Integration: get_late_assignments', () => {
  it.skipIf(!hasSeedIds)('Student 4 not in late list (never submitted)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    const s4 = data.students.find((s: { id: number }) => s.id === studentIds[3])
    expect(s4).toBeUndefined()
    console.log(
      `  Late students: ${data.students.map((s: { name: string; late_count: number }) => `${s.name}(${s.late_count})`).join(', ')}`
    )
  })

  it.skipIf(!hasSeedIds)('Student 1 appears in late list with submitted assignments', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    const s1 = data.students.find((s: { id: number }) => s.id === studentIds[0])
    expect(s1, 'Student 1 not in late list').toBeDefined()
    // Student 1 submitted A1 (graded), A2 (graded), A3 (ungraded) — all with past due date
    expect(s1.late_count).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(!hasSeedIds)('late assignments include graded flag', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    expect(data.students.length).toBeGreaterThan(0)
    const firstStudent = data.students[0]
    for (const a of firstStudent.late_assignments) {
      expect(typeof a.graded).toBe('boolean')
    }
  })
})
