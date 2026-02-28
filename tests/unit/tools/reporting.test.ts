import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { server as mswServer } from '../../setup/msw-server.js'
import { CanvasClient } from '../../../src/canvas/client.js'
import { ConfigManager } from '../../../src/config/manager.js'
import { registerReportingTools } from '../../../src/tools/reporting.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_MODULE = {
  id: 10, name: 'Week 1: Introduction', position: 1, published: true,
  items_count: 3, unlock_at: null, prerequisite_module_ids: [],
  require_sequential_progress: false, workflow_state: 'active',
}

const MOCK_ITEMS = [
  {
    id: 101, module_id: 10, position: 1, title: 'OVERVIEW', type: 'SubHeader',
    indent: 0, completion_requirement: null, content_details: {},
  },
  {
    id: 102, module_id: 10, position: 2, title: 'Week 1 | Overview', type: 'Page',
    content_id: 201, indent: 0, completion_requirement: { type: 'must_view' }, content_details: {},
  },
  {
    id: 103, module_id: 10, position: 3, title: 'Week 1 | Assignment 1.1', type: 'Assignment',
    content_id: 301, indent: 0,
    completion_requirement: { type: 'min_score', min_score: 1 },
    content_details: { points_possible: 10, due_at: '2026-03-01T23:59:00Z' },
  },
]

const MOCK_ENROLLMENTS = [
  {
    id: 1, user_id: 1001, type: 'StudentEnrollment', enrollment_state: 'active',
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
    grades: { current_score: 87.4, final_score: 82.1, current_grade: 'B+', final_grade: 'B-' },
  },
  {
    id: 2, user_id: 1002, type: 'StudentEnrollment', enrollment_state: 'active',
    user: { id: 1002, name: 'Bob Adams', sortable_name: 'Adams, Bob' },
    grades: { current_score: 60.0, final_score: 50.0, current_grade: 'D', final_grade: 'F' },
  },
]

const MOCK_SUBMISSIONS = [
  // Jane: 1 graded, 1 late+ungraded
  {
    id: 201, assignment_id: 501, user_id: 1001, score: 9.0,
    submitted_at: '2026-02-01T10:00:00Z', graded_at: '2026-02-02T09:00:00Z',
    late: false, missing: false, workflow_state: 'graded',
    assignment: { id: 501, name: 'Assignment A', points_possible: 10, due_at: '2026-02-01T23:59:00Z' },
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
  },
  {
    id: 202, assignment_id: 502, user_id: 1001, score: null,
    submitted_at: '2026-02-15T10:00:00Z', graded_at: null,
    late: true, missing: false, workflow_state: 'submitted',
    assignment: { id: 502, name: 'Assignment B', points_possible: 10, due_at: '2026-02-10T23:59:00Z' },
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
  },
  // Bob: 1 missing
  {
    id: 203, assignment_id: 501, user_id: 1002, score: null,
    submitted_at: null, graded_at: null,
    late: false, missing: true, workflow_state: 'unsubmitted',
    assignment: { id: 501, name: 'Assignment A', points_possible: 10, due_at: '2026-02-01T23:59:00Z' },
    user: { id: 1002, name: 'Bob Adams', sortable_name: 'Adams, Bob' },
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-reporting-test-${suffix}`, 'config.json')
}

function writeConfig(path: string, overrides: Record<string, unknown> = {}) {
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const base = {
    canvas: { instanceUrl: CANVAS_URL, apiToken: 'tok' },
    program: { activeCourseId: COURSE_ID, courseCodes: [], courseCache: {} },
    defaults: { assignmentGroup: 'Assignments', submissionType: 'online_url', pointsPossible: 100 },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(base), 'utf-8')
}

async function makeTestClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerReportingTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  return JSON.parse(text)
}

// ─── list_modules ──────────────────────────────────────────────────────────────

describe('list_modules', () => {
  it('returns array with expected fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_modules', arguments: {} }))
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      id: 10, name: 'Week 1: Introduction', published: true,
      items_count: 3, unlock_at: null, prerequisite_module_ids: [],
    })
  })

  it('uses active course from config when no course_id provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(await mcpClient.callTool({ name: 'list_modules', arguments: {} }))
    expect(data[0].id).toBe(10)
  })

  it('accepts explicit course_id override', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/2/modules`, () => HttpResponse.json([]))
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_modules', arguments: { course_id: 2 } })
    )
    expect(data).toEqual([])
  })

  it('returns error message when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, {
      program: { activeCourseId: null, courseCodes: [], courseCache: {} },
    })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'list_modules', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── get_module_summary ────────────────────────────────────────────────────────

describe('get_module_summary', () => {
  it('returns module metadata and items array', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_ITEMS)
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_module_summary', arguments: { module_id: 10 } })
    )
    expect(data.module.id).toBe(10)
    expect(data.items).toHaveLength(3)
  })

  it('maps content_details fields onto items', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_ITEMS)
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_module_summary', arguments: { module_id: 10 } })
    )
    const assignment = data.items.find((i: { type: string }) => i.type === 'Assignment')
    expect(assignment.points_possible).toBe(10)
    expect(assignment.due_at).toBe('2026-03-01T23:59:00Z')
  })

  it('fetches assignment description HTML when include_html=true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_ITEMS)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/301`, () =>
        HttpResponse.json({ id: 301, name: 'A', points_possible: 10, due_at: null, html_url: '', description: '<h3>Hello</h3>' })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_id: 10, include_html: true },
      })
    )
    const assignment = data.items.find((i: { type: string }) => i.type === 'Assignment')
    expect(assignment.html).toBe('<h3>Hello</h3>')
  })

  it('does not fetch assignments when include_html is false', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    // Only register module/items handlers — no assignment handler
    // msw is set to error on unhandled requests, so this confirms no extra call is made
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_ITEMS)
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    // Should not throw even though no assignment handler is registered
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_module_summary', arguments: { module_id: 10 } })
    )
    const assignment = data.items.find((i: { type: string }) => i.type === 'Assignment')
    expect(assignment.html).toBeUndefined()
  })
})

// ─── list_assignment_groups ────────────────────────────────────────────────────

describe('list_assignment_groups', () => {
  it('returns groups with expected fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
        HttpResponse.json([{ id: 1, name: 'Assignments', group_weight: 0, rules: {} }])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_assignment_groups', arguments: {} })
    )
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: 1, name: 'Assignments', group_weight: 0 })
  })
})

// ─── get_class_grade_summary ───────────────────────────────────────────────────

describe('get_class_grade_summary', () => {
  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(MOCK_SUBMISSIONS)
      )
    )
  })

  it('aggregates missing, late, and ungraded counts per student', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    // Adams (Bob) sorted first alphabetically
    const bob = data.students.find((s: { name: string }) => s.name === 'Bob Adams')
    const jane = data.students.find((s: { name: string }) => s.name === 'Jane Smith')
    expect(bob.missing_count).toBe(1)
    expect(jane.late_count).toBe(1)
    expect(jane.ungraded_count).toBe(1)
  })

  it('sorts students by sortable_name ascending', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    expect(data.students[0].name).toBe('Bob Adams')
    expect(data.students[1].name).toBe('Jane Smith')
  })

  it('passes through current_score and final_score from enrollment', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    const jane = data.students.find((s: { name: string }) => s.name === 'Jane Smith')
    expect(jane.current_score).toBe(87.4)
    expect(jane.final_score).toBe(82.1)
  })

  it('returns zero counts for student with no relevant submissions', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    const bob = data.students.find((s: { name: string }) => s.name === 'Bob Adams')
    expect(bob.late_count).toBe(0)
    expect(bob.ungraded_count).toBe(0)
  })

  it('includes zeros_count field on every student row', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    for (const student of data.students) {
      expect(typeof student.zeros_count).toBe('number')
    }
  })

  it('counts zeros_count only for submissions with score === 0', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          // Jane: one zero score, one null score
          { ...MOCK_SUBMISSIONS[0], score: 0 },
          MOCK_SUBMISSIONS[1],
          // Bob: missing (null score), not a zero
          MOCK_SUBMISSIONS[2],
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    const jane = data.students.find((s: { name: string }) => s.name === 'Jane Smith')
    const bob = data.students.find((s: { name: string }) => s.name === 'Bob Adams')
    expect(jane.zeros_count).toBe(1)
    expect(bob.zeros_count).toBe(0)
  })

  it('echoes sort_by in response, defaults to "name"', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_class_grade_summary', arguments: {} })
    )
    expect(data.sort_by).toBe('name')
  })

  it('sort_by=engagement: most-missing student appears first', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'engagement' },
      })
    )
    // Bob has 1 missing, Jane has 0 missing → Bob first
    expect(data.students[0].name).toBe('Bob Adams')
    expect(data.sort_by).toBe('engagement')
  })

  it('sort_by=engagement: ties on missing broken by late_count DESC', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          // Both students have 0 missing; Jane has 1 late, Bob has 0 late
          { ...MOCK_SUBMISSIONS[0], missing: false },
          MOCK_SUBMISSIONS[1], // Jane: late=true
          { ...MOCK_SUBMISSIONS[2], missing: false }, // Bob: no late
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'engagement' },
      })
    )
    // Jane has 1 late, Bob has 0 → Jane first when missing tied at 0
    expect(data.students[0].name).toBe('Jane Smith')
  })

  it('sort_by=engagement: ties on missing+late broken by current_score ASC', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    // Both students have 0 missing, 0 late; Bob has lower score (60 < 87.4) → Bob first
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { ...MOCK_SUBMISSIONS[0], missing: false, late: false },
          { ...MOCK_SUBMISSIONS[1], missing: false, late: false },
          { ...MOCK_SUBMISSIONS[2], missing: false, late: false },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'engagement' },
      })
    )
    // Bob current_score=60 < Jane current_score=87.4 → Bob first
    expect(data.students[0].name).toBe('Bob Adams')
    expect(data.students[1].name).toBe('Jane Smith')
  })

  it('sort_by=grade: lowest current_score appears first', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'grade' },
      })
    )
    // Bob current_score=60, Jane current_score=87.4 → Bob first
    expect(data.students[0].name).toBe('Bob Adams')
    expect(data.sort_by).toBe('grade')
  })

  it('sort_by=grade: null-score students appear before scored students', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json([
          {
            ...MOCK_ENROLLMENTS[0],
            grades: { current_score: null, final_score: null, current_grade: null, final_grade: null },
          },
          MOCK_ENROLLMENTS[1],
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'grade' },
      })
    )
    // Jane has null score → Jane first (nulls sort before any score)
    expect(data.students[0].name).toBe('Jane Smith')
    expect(data.students[0].current_score).toBeNull()
  })

  it('sort_by=zeros: student with most zero scores appears first', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          // Jane: two zero scores
          { ...MOCK_SUBMISSIONS[0], score: 0 },
          { ...MOCK_SUBMISSIONS[1], score: 0, workflow_state: 'graded', graded_at: 't', late: false },
          // Bob: one missing (null score), no zeros
          MOCK_SUBMISSIONS[2],
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'zeros' },
      })
    )
    // Jane has 2 zeros → Jane first
    expect(data.students[0].name).toBe('Jane Smith')
    expect(data.students[0].zeros_count).toBe(2)
    expect(data.sort_by).toBe('zeros')
  })

  it('sort_by=zeros: ties broken by sortable_name ASC', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          // Both students have exactly 1 zero — tie broken by name
          { ...MOCK_SUBMISSIONS[0], score: 0 },
          MOCK_SUBMISSIONS[1],
          { ...MOCK_SUBMISSIONS[2], score: 0, workflow_state: 'graded', graded_at: 't', missing: false },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_class_grade_summary',
        arguments: { sort_by: 'zeros' },
      })
    )
    // Both have zeros_count=1; Adams, Bob sorts before Smith, Jane
    expect(data.students[0].name).toBe('Bob Adams')
    expect(data.students[1].name).toBe('Jane Smith')
  })
})

// ─── get_assignment_breakdown ──────────────────────────────────────────────────

describe('get_assignment_breakdown', () => {
  it('computes mean_score from graded submissions only', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ id: 501, name: 'Assignment A', points_possible: 10, due_at: null, html_url: '/a' })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 501, user_id: 1002, score: 7, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', user: { id: 1002, name: 'Bob', sortable_name: 'Bob' } },
          { id: 3, assignment_id: 501, user_id: 1003, score: null, submitted_at: 't', graded_at: null, late: false, missing: false, workflow_state: 'submitted', user: { id: 1003, name: 'Alice', sortable_name: 'Alice' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_assignment_breakdown', arguments: { assignment_id: 501 } })
    )
    expect(data.summary.mean_score).toBe(8.0)
    expect(data.summary.ungraded).toBe(1)
  })

  it('counts missing, late, and submitted correctly', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ id: 501, name: 'A', points_possible: 10, due_at: null, html_url: '' })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', user: { id: 1001, name: 'A', sortable_name: 'A' } },
          { id: 2, assignment_id: 501, user_id: 1002, score: 8, submitted_at: 't', graded_at: 't', late: true, missing: false, workflow_state: 'graded', user: { id: 1002, name: 'B', sortable_name: 'B' } },
          { id: 3, assignment_id: 501, user_id: 1003, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', user: { id: 1003, name: 'C', sortable_name: 'C' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_assignment_breakdown', arguments: { assignment_id: 501 } })
    )
    expect(data.summary.missing).toBe(1)
    expect(data.summary.late).toBe(1)
    expect(data.summary.submitted).toBe(2)
  })

  it('returns mean_score null when no graded submissions', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ id: 501, name: 'A', points_possible: 10, due_at: null, html_url: '' })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', user: { id: 1001, name: 'A', sortable_name: 'A' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_assignment_breakdown', arguments: { assignment_id: 501 } })
    )
    expect(data.summary.mean_score).toBeNull()
  })
})

// ─── get_student_report ────────────────────────────────────────────────────────

describe('get_student_report', () => {
  it('returns summary counts correctly', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-01-01T00:00:00Z' } },
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 502, name: 'B', points_possible: 10, due_at: '2026-01-08T00:00:00Z' } },
          { id: 3, assignment_id: 503, user_id: 1001, score: null, submitted_at: 't', graded_at: null, late: true, missing: false, workflow_state: 'submitted', assignment: { id: 503, name: 'C', points_possible: 10, due_at: '2026-01-15T00:00:00Z' } },
        ])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json([MOCK_ENROLLMENTS[0]])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_student_report', arguments: { student_id: 1001 } })
    )
    expect(data.summary.total_missing).toBe(1)
    expect(data.summary.total_late).toBe(1)
    expect(data.summary.total_graded).toBe(1)
    expect(data.summary.total_ungraded).toBe(1)
  })

  it('sorts assignments by due_at ascending', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: false, workflow_state: 'unsubmitted', assignment: { id: 502, name: 'Later', points_possible: 10, due_at: '2026-03-01T00:00:00Z' } },
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'Earlier', points_possible: 10, due_at: '2026-01-01T00:00:00Z' } },
        ])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json([MOCK_ENROLLMENTS[0]])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_student_report', arguments: { student_id: 1001 } })
    )
    expect(data.assignments[0].name).toBe('Earlier')
    expect(data.assignments[1].name).toBe('Later')
  })

  it('returns error message when student is not enrolled', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json([])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_student_report', arguments: { student_id: 9999 } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('not enrolled')
  })
})

// ─── get_missing_assignments ───────────────────────────────────────────────────

describe('get_missing_assignments', () => {
  it('groups missing submissions by student, excludes non-missing', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-01-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 501, user_id: 1002, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-01-01T00:00:00Z' }, user: { id: 1002, name: 'Bob', sortable_name: 'Bob' } },
          { id: 3, assignment_id: 502, user_id: 1001, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', assignment: { id: 502, name: 'B', points_possible: 10, due_at: '2026-01-08T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    expect(data.students).toHaveLength(2)
    expect(data.total_missing_submissions).toBe(2)
  })

  it('filters by since_date', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 501, name: 'Old', points_possible: 10, due_at: '2025-01-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 502, name: 'New', points_possible: 10, due_at: '2026-06-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_missing_assignments',
        arguments: { since_date: '2026-01-01T00:00:00Z' },
      })
    )
    expect(data.students[0].missing_assignments).toHaveLength(1)
    expect(data.students[0].missing_assignments[0].name).toBe('New')
  })

  it('sorts students by missing_count descending', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-01-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 502, name: 'B', points_possible: 10, due_at: '2026-01-08T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 3, assignment_id: 501, user_id: 1002, score: null, submitted_at: null, graded_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-01-01T00:00:00Z' }, user: { id: 1002, name: 'Bob', sortable_name: 'Bob' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    expect(data.students[0].name).toBe('Jane')
    expect(data.students[0].missing_count).toBe(2)
    expect(data.students[1].name).toBe('Bob')
  })

  it('returns empty students array when nothing is missing', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_missing_assignments', arguments: {} })
    )
    expect(data.students).toEqual([])
    expect(data.total_missing_submissions).toBe(0)
  })
})

// ─── get_late_assignments ──────────────────────────────────────────────────────

describe('get_late_assignments', () => {
  it('returns only late submissions grouped by student', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: '2026-02-15T10:00:00Z', graded_at: 't', late: true, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-02-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: '2026-02-16T10:00:00Z', graded_at: null, late: true, missing: false, workflow_state: 'submitted', assignment: { id: 502, name: 'B', points_possible: 10, due_at: '2026-02-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 3, assignment_id: 501, user_id: 1002, score: 8, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-02-01T00:00:00Z' }, user: { id: 1002, name: 'Bob', sortable_name: 'Bob' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    expect(data.students).toHaveLength(1)
    expect(data.students[0].name).toBe('Jane')
    expect(data.students[0].late_count).toBe(2)
    expect(data.total_late_submissions).toBe(2)
  })

  it('sets graded=true for scored submissions, graded=false for unscored', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: '2026-02-15T10:00:00Z', graded_at: 't', late: true, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'A', points_possible: 10, due_at: '2026-02-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
          { id: 2, assignment_id: 502, user_id: 1001, score: null, submitted_at: '2026-02-16T10:00:00Z', graded_at: null, late: true, missing: false, workflow_state: 'submitted', assignment: { id: 502, name: 'B', points_possible: 10, due_at: '2026-02-01T00:00:00Z' }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    const [first, second] = data.students[0].late_assignments
    // Sorted by submitted_at descending — most recent first
    const graded = [first, second].find((a: { graded: boolean }) => a.graded === true)
    const ungraded = [first, second].find((a: { graded: boolean }) => a.graded === false)
    expect(graded).toBeDefined()
    expect(ungraded).toBeDefined()
  })

  it('returns empty students array when nothing is late', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([
          { id: 1, assignment_id: 501, user_id: 1001, score: 9, submitted_at: 't', graded_at: 't', late: false, missing: false, workflow_state: 'graded', assignment: { id: 501, name: 'A', points_possible: 10, due_at: null }, user: { id: 1001, name: 'Jane', sortable_name: 'Jane' } },
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'get_late_assignments', arguments: {} })
    )
    expect(data.students).toEqual([])
    expect(data.total_late_submissions).toBe(0)
  })
})
