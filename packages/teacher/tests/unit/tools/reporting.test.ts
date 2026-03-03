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
import { CanvasClient, ConfigManager, SecureStore } from '@canvas-mcp/core'
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
    assignment: { id: 501, name: 'Assignment A', points_possible: 10, due_at: '2026-02-01T23:59:00Z', assignment_group_id: 100 },
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
  },
  {
    id: 202, assignment_id: 502, user_id: 1001, score: null,
    submitted_at: '2026-02-15T10:00:00Z', graded_at: null,
    late: true, missing: false, workflow_state: 'submitted',
    assignment: { id: 502, name: 'Assignment B', points_possible: 10, due_at: '2026-02-10T23:59:00Z', assignment_group_id: 100 },
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
  },
  // Bob: 1 missing
  {
    id: 203, assignment_id: 501, user_id: 1002, score: null,
    submitted_at: null, graded_at: null,
    late: false, missing: true, workflow_state: 'unsubmitted',
    assignment: { id: 501, name: 'Assignment A', points_possible: 10, due_at: '2026-02-01T23:59:00Z', assignment_group_id: 100 },
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

async function makeTestClient(configPath: string, store?: SecureStore) {
  const secureStore = store ?? new SecureStore()
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerReportingTools(mcpServer, canvasClient, configManager, secureStore)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager, store: secureStore }
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>
type ContentBlock = { type: string; text: string; annotations?: { audience: string[] } }

function getContent(result: ToolResult): ContentBlock[] {
  return result.content as ContentBlock[]
}

/** Parses content[0].text as JSON (assistant-audience blinded data — tokens only). */
function parseBlindedResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

/** Parses content[1].text as JSON (user-audience unblinded data — real names). */
function parseUserResult(result: ToolResult) {
  return JSON.parse(getContent(result)[1].text)
}

/** Returns content[1].text raw string (user-audience). */
function getUserText(result: ToolResult): string {
  return getContent(result)[1].text
}

/** Helper for non-blinded tools that return a single JSON block. */
function parseResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

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
    expect(assignment.html).toBeUndefined()
  })
})

// ─── get_grades (scope=class) ─────────────────────────────────────────────────

describe('get_grades — scope=class', () => {
  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(MOCK_SUBMISSIONS)
      ),
    )
  })

  it('returns blinded student list with grade totals', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class' },
    })
    const blocks = getContent(result)
    // Audience annotations
    expect(blocks[0].annotations?.audience).toContain('assistant')
    expect(blocks[1].annotations?.audience).toContain('user')
    // Assistant block: tokens only, no real names
    const data = parseBlindedResult(result)
    expect(data.student_count).toBe(2)
    expect(data.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.students[0].current_score).toBeDefined()
    expect(data.students[0].missing_count).toBeDefined()
    expect(blocks[0].text).not.toContain('Jane Smith')
    expect(blocks[0].text).not.toContain('Bob Adams')
    // User block: real names in JSON, no tokens
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
    expect(userText).toContain('Bob Adams')
    expect(userText).not.toMatch(/\[STUDENT_\d{3}\]/)
  })

  it('sorts by engagement (missing DESC)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', sort_by: 'engagement' },
    })
    // Bob has 1 missing, Jane has 0 → Bob first
    // Verify via user-facing block (real names, same order)
    const userData = parseUserResult(result)
    expect(userData.students[0].student).toBe('Bob Adams')
  })

  it('sorts by grade (score ASC)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', sort_by: 'grade' },
    })
    // Bob has 60, Jane has 87.4 → Bob first
    const userData = parseUserResult(result)
    expect(userData.students[0].student).toBe('Bob Adams')
  })

  it('sorts by zeros (zeros DESC)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    // Add a submission with score 0 for Jane
    const janeZero = { ...MOCK_SUBMISSIONS[0], score: 0 }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json([janeZero, MOCK_SUBMISSIONS[1], MOCK_SUBMISSIONS[2]])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', sort_by: 'zeros' },
    })
    // Jane has 1 zero, Bob has 0 → Jane first
    const userData = parseUserResult(result)
    expect(userData.students[0].student).toBe('Jane Smith')
  })

  it('filters by assignment_group_id', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseBlindedResult(await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', assignment_group_id: 999 }, // No subs in this group
    }))
    expect(data.students[0].missing_count).toBe(0)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const text = getContent(result)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── get_grades (scope=class sorting) ─────────────────────────────────────────

describe('get_grades — scope=class sorting', () => {
  it('sorts by engagement with null scores', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)

    const enrollmentsWithNulls = [
      {
        id: 1, user_id: 1001, type: 'StudentEnrollment', enrollment_state: 'active',
        user: { id: 1001, name: 'C Jane Smith', sortable_name: 'Smith, C Jane' },
        grades: { current_score: null, final_score: null, current_grade: null, final_grade: null },
      },
      {
        id: 2, user_id: 1002, type: 'StudentEnrollment', enrollment_state: 'active',
        user: { id: 1002, name: 'B Bob Adams', sortable_name: 'Adams, B Bob' },
        grades: { current_score: 60.0, final_score: 50.0, current_grade: 'D', final_grade: 'F' },
      },
      {
        id: 3, user_id: 1003, type: 'StudentEnrollment', enrollment_state: 'active',
        user: { id: 1003, name: 'A Alice Jones', sortable_name: 'Jones, A Alice' },
        grades: { current_score: null, final_score: null, current_grade: null, final_grade: null },
      },
    ]

    const submissionsForSort = [
      { id: 201, assignment_id: 501, user_id: 1001, score: 9.0, late: false, missing: false, workflow_state: 'graded', assignment: {}, user: {} },
      { id: 202, assignment_id: 501, user_id: 1002, score: 6.0, late: false, missing: false, workflow_state: 'graded', assignment: {}, user: {} },
      { id: 203, assignment_id: 501, user_id: 1003, score: null, late: false, missing: false, workflow_state: 'unsubmitted', assignment: {}, user: {} },
    ]

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(enrollmentsWithNulls)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(submissionsForSort)
      ),
    )

    const store = new SecureStore()
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', sort_by: 'engagement' },
    })

    // All have 0 missing, 0 late.
    // Alice and Jane have null scores, Bob has 60.
    // With engagement sort, null scores should come first, sorted by name.
    // So order should be Alice (null), Jane (null), Bob (60)
    const userData = parseUserResult(result)
    expect(userData.students.map((s: any) => s.student)).toEqual(['A Alice Jones', 'C Jane Smith', 'B Bob Adams'])
  });

  it('sorts by grade with null scores', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)

    const enrollmentsWithNulls = [
        {
            id: 1, user_id: 1001, type: 'StudentEnrollment', enrollment_state: 'active',
            user: { id: 1001, name: 'C Jane Smith', sortable_name: 'Smith, C Jane' },
            grades: { current_score: 80, final_score: null, current_grade: null, final_grade: null },
        },
        {
            id: 2, user_id: 1002, type: 'StudentEnrollment', enrollment_state: 'active',
            user: { id: 1002, name: 'B Bob Adams', sortable_name: 'Adams, B Bob' },
            grades: { current_score: 60.0, final_score: 50.0, current_grade: 'D', final_grade: 'F' },
        },
        {
            id: 3, user_id: 1003, type: 'StudentEnrollment', enrollment_state: 'active',
            user: { id: 1003, name: 'A Alice Jones', sortable_name: 'Jones, A Alice' },
            grades: { current_score: null, final_score: null, current_grade: null, final_grade: null },
        },
    ]

    mswServer.use(
        http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
            HttpResponse.json(enrollmentsWithNulls)
        ),
        http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
            HttpResponse.json([])
        ),
    )

    const store = new SecureStore()
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
        name: 'get_grades',
        arguments: { scope: 'class', sort_by: 'grade' },
    })

    // grade sort is score ASC. nulls first, then by score.
    // Order should be Alice (null), Bob (60), Jane (80)
    const userData = parseUserResult(result)
    expect(userData.students.map((s: any) => s.student)).toEqual(['A Alice Jones', 'B Bob Adams', 'C Jane Smith'])
  })
})

// ─── get_grades (scope=assignment) ───────────────────────────────────────────

describe('get_grades — scope=assignment', () => {
  it('returns blinded submission rows for one assignment', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({
          id: 501, name: 'Assignment A', points_possible: 10,
          due_at: '2026-02-01T23:59:00Z',
          html_url: `${CANVAS_URL}/courses/${COURSE_ID}/assignments/501`,
        })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501/submissions`, () =>
        HttpResponse.json([MOCK_SUBMISSIONS[0], MOCK_SUBMISSIONS[2]])
      ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'assignment', assignment_id: 501 },
    })
    const blocks = getContent(result)
    // Audience annotations
    expect(blocks[0].annotations?.audience).toContain('assistant')
    expect(blocks[1].annotations?.audience).toContain('user')
    // Assistant block: tokens only, no real names
    const data = parseBlindedResult(result)
    expect(data.assignment.id).toBe(501)
    expect(data.submissions).toHaveLength(2)
    expect(data.submissions[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.summary.total_students).toBe(2)
    expect(data.summary.missing).toBe(1)
    expect(blocks[0].text).not.toContain('Jane Smith')
    expect(blocks[0].text).not.toContain('Bob Adams')
    // User block: real names in JSON, no tokens
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
    expect(userText).not.toMatch(/\[STUDENT_\d{3}\]/)
  })
})

// ─── get_grades (scope=student) ───────────────────────────────────────────────

describe('get_grades — scope=student', () => {
  it('returns full submission history for the resolved student', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const janeToken = store.tokenize(1001, 'Jane Smith')

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, ({ request }) => {
        const url = new URL(request.url)
        const userId = url.searchParams.get('student_ids[]')
        if (userId === '1001') return HttpResponse.json(MOCK_SUBMISSIONS.filter(s => s.user_id === 1001))
        return HttpResponse.json(MOCK_SUBMISSIONS)
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
    )

    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: janeToken },
    })
    const blocks = getContent(result)
    // Audience annotations
    expect(blocks[0].annotations?.audience).toContain('assistant')
    expect(blocks[1].annotations?.audience).toContain('user')
    // Assistant block: no real names
    const data = parseBlindedResult(result)
    expect(data.student_token).toBe(janeToken)
    expect(data.current_score).toBe(87.4)
    expect(data.assignments.length).toBeGreaterThan(0)
    expect(blocks[0].text).not.toContain('Jane Smith')
    // User block: real names in JSON, no tokens
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
    expect(userText).not.toMatch(/\[STUDENT_\d{3}\]/)
  })

  it('returns error for unknown token', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: '[STUDENT_999]' },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('Unknown student token')
  })

  it('returns error when student is not in course', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const janeToken = store.tokenize(1001, 'Jane Smith')
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () => {
        return HttpResponse.json(MOCK_SUBMISSIONS.filter(s => s.user_id === 1001))
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS.filter(e => e.user_id !== 1001))
      ),
    )
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: janeToken },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('is not enrolled in course')
  })

  it('returns error on Canvas API error', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const janeToken = store.tokenize(1001, 'Jane Smith')
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () => {
        return new HttpResponse(null, { status: 404 })
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
    )
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'student', student_token: janeToken },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('is not enrolled in course')
  })
})

// ─── get_submission_status (type=missing) ─────────────────────────────────────

describe('get_submission_status — type=missing', () => {
  it('returns blinded students with missing assignments', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('workflow_state') === 'unsubmitted') {
          return HttpResponse.json(MOCK_SUBMISSIONS.filter(s => s.workflow_state === 'unsubmitted'))
        }
        return HttpResponse.json(MOCK_SUBMISSIONS)
      }),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_submission_status',
      arguments: { type: 'missing' },
    })
    const blocks = getContent(result)
    // Audience annotations
    expect(blocks[0].annotations?.audience).toContain('assistant')
    expect(blocks[1].annotations?.audience).toContain('user')
    // Assistant block: tokens only, no real names
    const data = parseBlindedResult(result)
    expect(data.total_missing_submissions).toBe(1)
    expect(data.students).toHaveLength(1)
    expect(data.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.students[0].missing_count).toBe(1)
    expect(blocks[0].text).not.toContain('Bob Adams')
    expect(blocks[0].text).not.toContain('Jane Smith')
    // User block: real names in JSON, no tokens
    const userText = getUserText(result)
    expect(userText).toContain('Bob Adams')
    expect(userText).not.toMatch(/\[STUDENT_\d{3}\]/)
  })

  it('filters missing assignments with since_date', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const missingWithDates = [
      { ...MOCK_SUBMISSIONS[2], assignment: { ...MOCK_SUBMISSIONS[2].assignment, due_at: '2026-01-15T23:59:00Z' } }, // Bob, will be filtered out
      { id: 204, assignment_id: 503, user_id: 1001, score: null, submitted_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 503, name: 'Assignment C', due_at: '2026-02-15T23:59:00Z' }, user: MOCK_ENROLLMENTS[0].user }, // Jane, will be included
    ]
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(missingWithDates)
      ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_submission_status',
      arguments: { type: 'missing', since_date: '2026-02-01' },
    })
    const data = parseBlindedResult(result)
    expect(data.total_missing_submissions).toBe(1)
    expect(data.students).toHaveLength(1)
    const userData = parseUserResult(result)
    expect(userData.students[0].student).toBe('Jane Smith')
  })

  it('sorts missing assignments with null due dates', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const missingWithNulls = [
      { ...MOCK_SUBMISSIONS[2], assignment: { ...MOCK_SUBMISSIONS[2].assignment, due_at: null } },
      { id: 204, assignment_id: 503, user_id: 1002, score: null, submitted_at: null, late: false, missing: true, workflow_state: 'unsubmitted', assignment: { id: 503, name: 'Assignment C', due_at: '2026-02-15T23:59:00Z' }, user: MOCK_ENROLLMENTS[1].user },
    ]
    mswServer.use(
        http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
            HttpResponse.json(missingWithNulls)
        ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
        name: 'get_submission_status',
        arguments: { type: 'missing' },
    })
    const data = parseBlindedResult(result)
    const student = data.students[0]
    // The assignment with the null due date should be last in the list
    expect(student.missing_assignments[1].due_at).toBeNull()
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_submission_status',
      arguments: { type: 'missing' },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── get_submission_status (type=late) ────────────────────────────────────────

describe('get_submission_status — type=late', () => {
  it('returns blinded students with late assignments', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(MOCK_SUBMISSIONS)
      ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_submission_status',
      arguments: { type: 'late' },
    })
    const blocks = getContent(result)
    // Audience annotations
    expect(blocks[0].annotations?.audience).toContain('assistant')
    expect(blocks[1].annotations?.audience).toContain('user')
    // Assistant block: tokens only, no real names
    const data = parseBlindedResult(result)
    expect(data.total_late_submissions).toBe(1)
    expect(data.students).toHaveLength(1)
    expect(data.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.students[0].late_count).toBe(1)
    expect(blocks[0].text).not.toContain('Jane Smith')
    expect(blocks[0].text).not.toContain('Bob Adams')
    // User block: real names in JSON, no tokens
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
    expect(userText).not.toMatch(/\[STUDENT_\d{3}\]/)
  })

  it('sorts late assignments with null submitted_at dates', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const lateWithNulls = [
        { ...MOCK_SUBMISSIONS[1], submitted_at: null }, // This is an impossible state, but good for testing the sort
        { ...MOCK_SUBMISSIONS[1], id: 205, user_id: 1001, submitted_at: '2026-03-01T10:00:00Z' },
    ]
    mswServer.use(
        http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
            HttpResponse.json(lateWithNulls)
        ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
        name: 'get_submission_status',
        arguments: { type: 'late' },
    })
    const data = parseBlindedResult(result)
    const student = data.students[0]
    // The submission with the null submitted_at date should be last in the list
    expect(student.late_assignments[1].submitted_at).toBeNull()
  })
})

// ─── student_pii ──────────────────────────────────────────────────────────────

describe('student_pii — action=resolve', () => {
  it('returns name and canvas_id for a valid token (user-audience only)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const token = store.tokenize(1001, 'Jane Smith')

    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'student_pii',
      arguments: { action: 'resolve', student_token: token },
    })
    const blocks = getContent(result)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].annotations?.audience).toContain('user')
    const data = JSON.parse(blocks[0].text)
    expect(data.name).toBe('Jane Smith')
    expect(data.canvas_id).toBe(1001)
    expect(data.student_token).toBe(token)
  })

  it('returns error for unknown token', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'student_pii',
      arguments: { action: 'resolve', student_token: '[STUDENT_999]' },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('Unknown student token')
  })
})

describe('student_pii — action=list', () => {
  it('returns token list (assistant-audience only)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const t1 = store.tokenize(1001, 'Jane Smith')
    const t2 = store.tokenize(1002, 'Bob Adams')

    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'student_pii',
      arguments: { action: 'list' },
    })
    const blocks = getContent(result)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].annotations?.audience).toContain('assistant')
    const data = JSON.parse(blocks[0].text) as Array<{ token: string }>
    const tokens = data.map(d => d.token)
    expect(tokens).toContain(t1)
    expect(tokens).toContain(t2)
  })

  it('returns empty list when no tokens have been issued', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'student_pii',
      arguments: { action: 'list' },
    })
    const data = JSON.parse(getContent(result)[0].text) as Array<unknown>
    expect(data).toHaveLength(0)
  })
})

// ─── get_module_summary with module_name ─────────────────────────────────────

const MOCK_MODULE_ITEM = {
  id: 103, module_id: 10, position: 1, type: 'Assignment',
  title: 'Week 1 | Assignment 1.1', content_id: 301,
  indent: 0, completion_requirement: { type: 'min_score', min_score: 1 },
  content_details: { points_possible: 10, due_at: '2026-03-01T23:59:00Z' },
}

describe('get_module_summary — module_name', () => {
  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_MODULE_ITEM])
      ),
    )
  })

  it('returns module summary when module_name is provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_name: 'Week 1' },
      })
    )
    expect(data.module.id).toBe(10)
    expect(data.module.name).toBe('Week 1: Introduction')
    expect(data.items).toHaveLength(1)
  })

  it('returns warning when multiple modules match name', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([
          MOCK_MODULE,
          { ...MOCK_MODULE, id: 11, name: 'Week 1: Advanced' }
        ])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_name: 'Week 1' },
      })
    )
    expect(data.warning).toContain('2 modules matched')
    expect(data.module.id).toBe(10)
  })

  it('returns toolError when neither module_id nor module_name is provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_module_summary',
      arguments: {},
    })
    const text = getContent(result)[0].text
    expect(text).toContain('Provide either module_id or module_name')
  })

  it('returns toolError when module_name does not match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_module_summary',
      arguments: { module_name: 'nonexistent' },
    })
    const text = getContent(result)[0].text
    expect(text).toContain('No module found matching')
  })
})

// ─── FERPA blinding — MCP protocol compliance ─────────────────────────────────
//
// These tests verify MCP audience annotation compliance:
//   content[0] audience=['assistant'] — only tokens, no real names → safe for AI context
//   content[1] audience=['user']      — real names, no tokens → shown in client UI
//
// If these tests pass, the MCP client can be verified correct: a client that properly
// filters audience annotations will expose only blinded data to the model, while the
// user sees the full unblinded view. Failure indicates a regression in the blinding
// contract that could result in PII being sent to the AI model.

describe('FERPA blinding — MCP protocol compliance', () => {
  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () =>
        HttpResponse.json(MOCK_SUBMISSIONS)
      ),
    )
  })

  it('content[0] has audience=[assistant] and contains only tokens, no real names', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const block = getContent(result)[0]

    expect(block.annotations?.audience).toEqual(['assistant'])
    expect(block.text).toMatch(/\[STUDENT_\d{3}\]/)
    expect(block.text).not.toContain('Jane Smith')
    expect(block.text).not.toContain('Bob Adams')
    expect(() => JSON.parse(block.text)).not.toThrow()
  })

  it('content[1] has audience=[user] and contains real names, no tokens', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const block = getContent(result)[1]

    expect(block.annotations?.audience).toEqual(['user'])
    expect(block.text).toContain('Jane Smith')
    expect(block.text).toContain('Bob Adams')
    expect(block.text).not.toMatch(/\[STUDENT_\d{3}\]/)
    expect(() => JSON.parse(block.text)).not.toThrow()
  })

  it('content[1] has identical structure to content[0] — only student field differs', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })
    const blinded = parseBlindedResult(result)
    const unblinded = parseUserResult(result)

    expect(Object.keys(unblinded)).toEqual(Object.keys(blinded))
    expect(unblinded.students).toHaveLength(blinded.students.length)
    expect(Object.keys(unblinded.students[0])).toEqual(Object.keys(blinded.students[0]))
    // Numeric fields are identical — only the `student` field differs
    expect(unblinded.students[0].current_score).toBe(blinded.students[0].current_score)
    expect(unblinded.students[0].missing_count).toBe(blinded.students[0].missing_count)
    expect(unblinded.students[0].student).not.toMatch(/\[STUDENT_\d{3}\]/)
    expect(blinded.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
  })

  it('no content block targets both assistant and user simultaneously', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class' } })

    for (const block of getContent(result)) {
      const audience = block.annotations?.audience ?? []
      const hasAssistant = audience.includes('assistant')
      const hasUser = audience.includes('user')
      expect(hasAssistant && hasUser).toBe(false)
    }
  })

  it('get_submission_status: content[0] blinded, content[1] unblinded', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('workflow_state') === 'unsubmitted') {
          return HttpResponse.json(MOCK_SUBMISSIONS.filter(s => s.workflow_state === 'unsubmitted'))
        }
        return HttpResponse.json(MOCK_SUBMISSIONS)
      }),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_submission_status', arguments: { type: 'missing' } })
    const blocks = getContent(result)

    expect(blocks[0].annotations?.audience).toEqual(['assistant'])
    expect(blocks[1].annotations?.audience).toEqual(['user'])
    expect(blocks[0].text).not.toContain('Bob Adams')
    expect(blocks[1].text).toContain('Bob Adams')
    expect(blocks[1].text).not.toMatch(/\[STUDENT_\d{3}\]/)
    expect(() => JSON.parse(blocks[0].text)).not.toThrow()
    expect(() => JSON.parse(blocks[1].text)).not.toThrow()
  })

  it('get_grades scope=assignment: content[0] blinded, content[1] unblinded', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ id: 501, name: 'Assignment A', points_possible: 10, due_at: null, html_url: '' })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501/submissions`, () =>
        HttpResponse.json([MOCK_SUBMISSIONS[0], MOCK_SUBMISSIONS[2]])
      ),
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'assignment', assignment_id: 501 } })
    const blocks = getContent(result)

    expect(blocks[0].annotations?.audience).toEqual(['assistant'])
    expect(blocks[1].annotations?.audience).toEqual(['user'])
    expect(blocks[0].text).not.toContain('Jane Smith')
    expect(blocks[1].text).toContain('Jane Smith')
    expect(blocks[1].text).not.toMatch(/\[STUDENT_\d{3}\]/)
    expect(() => JSON.parse(blocks[1].text)).not.toThrow()
  })

  it('get_grades scope=student: content[0] blinded, content[1] unblinded', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const janeToken = store.tokenize(1001, 'Jane Smith')
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('student_ids[]') === '1001') {
          return HttpResponse.json(MOCK_SUBMISSIONS.filter(s => s.user_id === 1001))
        }
        return HttpResponse.json(MOCK_SUBMISSIONS)
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
        HttpResponse.json(MOCK_ENROLLMENTS)
      ),
    )
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'student', student_token: janeToken } })
    const blocks = getContent(result)

    expect(blocks[0].annotations?.audience).toEqual(['assistant'])
    expect(blocks[1].annotations?.audience).toEqual(['user'])
    expect(blocks[0].text).not.toContain('Jane Smith')
    expect(blocks[1].text).not.toMatch(/\[STUDENT_\d{3}\]/)
    expect(() => JSON.parse(blocks[1].text)).not.toThrow()
  })
})

describe('Coverage gaps', () => {
  it('get_grades(scope=class, sort_by=zeros) handles ties', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const enrollments = [
      { id: 1, user_id: 1001, user: { id: 1001, name: 'B Smith', sortable_name: 'Smith, B' }, grades: { current_score: 80 } },
      { id: 2, user_id: 1002, user: { id: 1002, name: 'A Adams', sortable_name: 'Adams, A' }, grades: { current_score: 90 } },
    ]
    const submissions = [
      { id: 1, user_id: 1001, score: 0, missing: false, late: false, workflow_state: 'graded' },
      { id: 2, user_id: 1002, score: 0, missing: false, late: false, workflow_state: 'graded' },
    ]
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () => HttpResponse.json(enrollments)),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () => HttpResponse.json(submissions))
    )
    const { mcpClient, store } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'class', sort_by: 'zeros' } })
    // Both have 1 zero, so it should sort by name ASC. Adams first.
    const userData = parseUserResult(result)
    expect(userData.students[0].student).toBe('A Adams')
  })

  it('get_grades(scope=student) handles non-CanvasApiError', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const token = store.tokenize(1001, 'Jane Smith')
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/students/submissions`, () => {
        return Promise.reject(new Error('Network error'))
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () => HttpResponse.json(MOCK_ENROLLMENTS))
    )
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({ name: 'get_grades', arguments: { scope: 'student', student_token: token } })
    expect(getContent(result)[0].text).toContain('Network error')
  })
})
