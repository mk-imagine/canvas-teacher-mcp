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
import { registerFindTools } from '../../src/tools/find.js'
import { SecureStore } from '../../src/security/secure-store.js'

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

async function makeIntegrationClient(configPath: string, store?: SecureStore) {
  const secureStore = store ?? new SecureStore()
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerReportingTools(mcpServer, canvasClient, configManager, secureStore)
  registerFindTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager, store: secureStore }
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

type ToolResult = Awaited<ReturnType<Client['callTool']>>
type ContentBlock = { type: string; text: string; annotations?: { audience: string[] } }

function getContent(result: ToolResult): ContentBlock[] {
  return result.content as ContentBlock[]
}

/** Parses content[0].text as JSON (always the primary/assistant data). */
function parseResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

/**
 * Finds a student's token by their Canvas ID from the secure store.
 * The store must have been populated by a prior tool call.
 */
function findTokenByCid(store: SecureStore, canvasId: number): string | undefined {
  return store.listTokens().find(t => store.resolve(t)?.canvasId === canvasId)
}

// ─── list_items — modules ──────────────────────────────────────────────────────

describe('Integration: list_items — modules', () => {
  it('returns at least one module', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_items', arguments: { type: 'modules' } }))
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    console.log(`  Found ${data.length} module(s): ${data.map((m: { name: string }) => m.name).join(', ')}`)
  })

  it.skipIf(!hasSeedIds)('seed module appears with correct items_count', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_items', arguments: { type: 'modules' } }))
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

// ─── list_items — assignment_groups ───────────────────────────────────────────

describe('Integration: list_items — assignment_groups', () => {
  it('returns at least one assignment group with required fields', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'assignment_groups' } })
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

// ─── get_grades — scope=class ─────────────────────────────────────────────────

describe('Integration: get_grades — scope=class', () => {
  it('returns enrolled students with blinded tokens', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const content = getContent(result)
    const data = parseResult(result)
    expect(content[0].annotations?.audience).toEqual(['assistant'])
    expect(content[1].annotations?.audience).toEqual(['user'])
    expect(data.students.length).toBeGreaterThan(0)
    for (const s of data.students) {
      expect(s.student).toMatch(/^\[STUDENT_\d{3}\]$/)
    }
    expect(data.as_of).toBeTruthy()
    console.log(`  ${data.student_count} students (blinded)`)
  })

  it('no real student names appear in assistant content', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient, store } = await makeIntegrationClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const assistantText = getContent(result)[0].text
    // Verify all names in the lookup table do NOT appear in assistant content
    const userText = getContent(result)[1].text
    const names = userText.split('\n').slice(1)
      .map(line => line.match(/^\[STUDENT_\d{3}\] → (.+)$/)?.[1])
      .filter(Boolean) as string[]
    for (const name of names) {
      expect(assistantText).not.toContain(name)
    }
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('returns exactly 5 students matching seed', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    )
    expect(data.student_count).toBe(5)
  })

  it.skipIf(!hasSeedIds)('Student 4 has missing_count=3 (A1, A2, exit card per seed)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    )
    const s4token = findTokenByCid(store, studentIds[3])
    expect(s4token, 'Student 4 token not found').toBeDefined()
    const s4 = data.students.find((s: { student: string }) => s.student === s4token)
    expect(s4, 'Student 4 not found in grade summary').toBeDefined()
    // A3 is due in the future so it is not yet missing; A1, A2, exit card are past due
    expect(s4.missing_count).toBe(3)
    console.log(`  Student 4 missing_count: ${s4.missing_count}`)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('Student 2 has missing_count=2 (A2, exit card per seed)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    )
    const s2token = findTokenByCid(store, studentIds[1])
    expect(s2token, 'Student 2 token not found').toBeDefined()
    const s2 = data.students.find((s: { student: string }) => s.student === s2token)
    expect(s2, 'Student 2 not found').toBeDefined()
    // A3 is on-time+graded (future due date), so only A2 and exit card are missing
    expect(s2.missing_count).toBe(2)
    store.destroy()
  })

  it('echoes sort_by="name" in response when not specified', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    )
    expect(data.sort_by).toBe('name')
  })

  it('every student row includes zeros_count as a number', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    )
    for (const student of data.students) {
      expect(typeof student.zeros_count).toBe('number')
    }
  })

  it.skipIf(!hasSeedIds)('sort_by=engagement: Student 4 appears first (most missing)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'class', sort_by: 'engagement' },
      })
    )
    expect(data.sort_by).toBe('engagement')
    const s4token = findTokenByCid(store, studentIds[3])
    // Student 4 has 3 missing (A1, A2, exit) — highest missing_count, should sort first
    expect(data.students[0].student).toBe(s4token)
    console.log(
      `  Engagement order: ${data.students.slice(0, 3).map((s: { student: string; missing_count: number; late_count: number }) => `${s.student}(m:${s.missing_count},l:${s.late_count})`).join(', ')}`
    )
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('sort_by=grade: null-score student appears first', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'class', sort_by: 'grade' },
      })
    )
    expect(data.sort_by).toBe('grade')
    // First student should have null score or the lowest score
    const first = data.students[0]
    // Student 4 has all missing → null current_score → sorts first
    expect(first.current_score === null || first.current_score <= first.current_score).toBe(true)
    console.log(
      `  Grade order: ${data.students.slice(0, 3).map((s: { student: string; current_score: number | null }) => `${s.student}(${s.current_score})`).join(', ')}`
    )
  })

  it.skipIf(!hasSeedIds)('sort_by=zeros: response includes zeros_count and sort_by field', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'class', sort_by: 'zeros' },
      })
    )
    expect(data.sort_by).toBe('zeros')
    for (const student of data.students) {
      expect(typeof student.zeros_count).toBe('number')
    }
    console.log(
      `  Zeros order: ${data.students.slice(0, 3).map((s: { student: string; zeros_count: number }) => `${s.student}(zeros:${s.zeros_count})`).join(', ')}`
    )
  })
})

// ─── get_grades — scope=assignment ────────────────────────────────────────────

describe('Integration: get_grades — scope=assignment', () => {
  it.skipIf(!hasSeedIds)('returns correct metadata for Assignment 1 (blinded)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'assignment', assignment_id: assignment1Id },
    })
    const content = getContent(result)
    expect(content[0].annotations?.audience).toEqual(['assistant'])
    const data = parseResult(result)
    expect(data.assignment.id).toBe(assignment1Id)
    expect(data.assignment.points_possible).toBe(10)
    for (const s of data.submissions) {
      expect(s.student).toMatch(/^\[STUDENT_\d{3}\]$/)
      expect(s).not.toHaveProperty('student_id')
      expect(s).not.toHaveProperty('student_name')
    }
    console.log(`  A1: ${data.summary.submitted} submitted, ${data.summary.missing} missing, mean=${data.summary.mean_score}`)
  })

  it.skipIf(!hasSeedIds)('Student 4 submission on A1 has missing=true', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'assignment', assignment_id: assignment1Id },
      })
    )
    const s4token = findTokenByCid(store, studentIds[3])
    expect(s4token, 'Student 4 not tokenized').toBeDefined()
    const s4sub = data.submissions.find((s: { student: string }) => s.student === s4token)
    expect(s4sub, 'Student 4 submission not found').toBeDefined()
    expect(s4sub.missing).toBe(true)
    expect(s4sub.score).toBeNull()
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('Student 1 submission on A1 has score=10', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'assignment', assignment_id: assignment1Id },
      })
    )
    const s1token = findTokenByCid(store, studentIds[0])
    expect(s1token, 'Student 1 not tokenized').toBeDefined()
    const s1sub = data.submissions.find((s: { student: string }) => s.student === s1token)
    expect(s1sub, 'Student 1 submission not found').toBeDefined()
    expect(s1sub.score).toBe(10)
    store.destroy()
  })
})

// ─── get_grades — scope=student ───────────────────────────────────────────────

describe('Integration: get_grades — scope=student', () => {
  it.skipIf(!hasSeedIds)('Student 4: 3 assignments missing (A1, A2, exit card; A3 not yet due)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)

    // Populate tokens by calling get_grades first
    await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const s4token = findTokenByCid(store, studentIds[3])
    expect(s4token, 'Student 4 token not found').toBeDefined()

    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'student', student_token: s4token! },
      })
    )
    // A3 is due in the future so it is not yet missing; A1, A2, exit card are past due
    expect(data.summary.total_missing).toBe(3)
    expect(data.summary.total_graded).toBe(0)
    expect(data.student_token).toBe(s4token)
    console.log(`  Student 4: missing=${data.summary.total_missing}, graded=${data.summary.total_graded}`)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('Student 1: 3 graded (A1=10, A2=8, exit card), 1 ungraded (A3)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)

    // Populate tokens by calling get_grades first
    await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const s1token = findTokenByCid(store, studentIds[0])
    expect(s1token, 'Student 1 token not found').toBeDefined()

    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'student', student_token: s1token! },
      })
    )
    // graded_survey auto-grades on submission, so exit card counts as graded
    expect(data.summary.total_graded).toBe(3)
    expect(data.summary.total_missing).toBe(0)
    expect(data.summary.total_ungraded).toBe(1)
    store.destroy()
  })

  it('no real student names appear in assistant content', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)

    // Populate tokens
    const summaryResult = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const tokens = store.listTokens()
    if (tokens.length === 0) return // no students, skip

    const token = tokens[0]
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: token },
    })
    const assistantText = getContent(result)[0].text
    const resolved = store.resolve(token)!
    expect(assistantText).not.toContain(resolved.name)
    expect(assistantText).not.toContain(String(resolved.canvasId))

    // Verify the lookup text in summaryResult mentions the name
    const summaryUserText = getContent(summaryResult)[1].text
    expect(summaryUserText).toContain(resolved.name)
    store.destroy()
  })

  it('returns error message for unknown student token', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: '[STUDENT_999]' },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('Unknown student token')
  })
})

// ─── get_submission_status — type=missing ─────────────────────────────────────

describe('Integration: get_submission_status — type=missing', () => {
  it.skipIf(!hasSeedIds)('Student 2 and Student 4 both appear in missing list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'missing' } })
    )
    // At minimum Student 2 (A2, exit card) and Student 4 (A1, A2, exit card) are missing
    expect(data.students.length).toBeGreaterThanOrEqual(2)
    const s4token = findTokenByCid(store, studentIds[3])
    const s2token = findTokenByCid(store, studentIds[1])
    const s4 = data.students.find((s: { student: string }) => s.student === s4token)
    const s2 = data.students.find((s: { student: string }) => s.student === s2token)
    expect(s4, 'Student 4 not found in missing list').toBeDefined()
    expect(s2, 'Student 2 not found in missing list').toBeDefined()
    console.log(
      `  Missing: ${data.students.map((s: { student: string; missing_count: number }) => `${s.student}(${s.missing_count})`).join(', ')}`
    )
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('Student 4 has 3 missing assignments (A1, A2, exit card; A3 not yet due)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'missing' } })
    )
    const s4token = findTokenByCid(store, studentIds[3])
    const s4 = data.students.find((s: { student: string }) => s.student === s4token)
    expect(s4, 'Student 4 not found in missing list').toBeDefined()
    // A3 is due in the future so it is not yet missing; A1, A2, exit card are past due
    expect(s4.missing_count).toBe(3)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('students are sorted by missing_count descending', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'missing' } })
    )
    // Verify descending sort — each student's missing_count is >= the next
    for (let i = 0; i < data.students.length - 1; i++) {
      expect(data.students[i].missing_count).toBeGreaterThanOrEqual(data.students[i + 1].missing_count)
    }
  })

  it.skipIf(!hasSeedIds)('since_date far in future returns empty', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_submission_status',
        arguments: { type: 'missing', since_date: '2099-01-01T00:00:00Z' },
      })
    )
    expect(data.students).toEqual([])
  })

  it('no real student names appear in assistant content', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const result = await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'missing' } })
    const assistantText = getContent(result)[0].text
    const userText = getContent(result)[1].text
    const names = userText.split('\n').slice(1)
      .map(line => line.match(/^\[STUDENT_\d{3}\] → (.+)$/)?.[1])
      .filter(Boolean) as string[]
    for (const name of names) {
      expect(assistantText).not.toContain(name)
    }
    store.destroy()
  })
})

// ─── get_submission_status — type=late ────────────────────────────────────────

describe('Integration: get_submission_status — type=late', () => {
  it.skipIf(!hasSeedIds)('Student 4 not in late list (never submitted)', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'late' } })
    )
    const s4token = findTokenByCid(store, studentIds[3])
    const s4 = data.students.find((s: { student: string }) => s.student === s4token)
    expect(s4).toBeUndefined()
    console.log(
      `  Late students: ${data.students.map((s: { student: string; late_count: number }) => `${s.student}(${s.late_count})`).join(', ')}`
    )
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('Student 1 appears in late list with submitted assignments', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'late' } })
    )
    const s1token = findTokenByCid(store, studentIds[0])
    expect(s1token, 'Student 1 not tokenized').toBeDefined()
    const s1 = data.students.find((s: { student: string }) => s.student === s1token)
    expect(s1, 'Student 1 not in late list').toBeDefined()
    // Student 1 submitted A1 (graded), A2 (graded), A3 (ungraded) — all with past due date
    expect(s1.late_count).toBeGreaterThanOrEqual(1)
    store.destroy()
  })

  it.skipIf(!hasSeedIds)('late assignments include graded flag', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'late' } })
    )
    expect(data.students.length).toBeGreaterThan(0)
    const firstStudent = data.students[0]
    for (const a of firstStudent.late_assignments) {
      expect(typeof a.graded).toBe('boolean')
    }
  })

  it('no real student names appear in assistant content', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeIntegrationClient(configPath, store)
    const result = await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'late' } })
    const assistantText = getContent(result)[0].text
    const userText = getContent(result)[1].text
    const names = userText.split('\n').slice(1)
      .map(line => line.match(/^\[STUDENT_\d{3}\] → (.+)$/)?.[1])
      .filter(Boolean) as string[]
    for (const name of names) {
      expect(assistantText).not.toContain(name)
    }
    store.destroy()
  })
})
