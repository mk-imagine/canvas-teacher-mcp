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
import { SecureStore } from '../../../src/security/secure-store.js'

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

/** Parses content[0].text as JSON (assistant-audience blinded data). */
function parseBlindedResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

/** Returns content[1].text (user-audience lookup table). */
function getUserText(result: ToolResult): string {
  return getContent(result)[1].text
}

/** Legacy helper for non-blinded tools. */
function parseResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

/**
 * Finds the session token for a student by display name from the lookup table.
 * Lookup table format: "Student lookup (current session):\n[STUDENT_001] → Jane Smith\n..."
 */
function getStudentToken(userText: string, name: string): string | undefined {
  for (const line of userText.split('\n').slice(1)) {
    const match = line.match(/^(\[STUDENT_\d{3}\]) → (.+)$/)
    if (match && match[2] === name) return match[1]
  }
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
    const data = parseBlindedResult(result)
    expect(data.student_count).toBe(2)
    expect(data.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.students[0].current_score).toBeDefined()
    expect(data.students[0].missing_count).toBeDefined()
    // Lookup table has real names
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
    expect(userText).toContain('Bob Adams')
  })

  it('sorts by engagement (missing DESC)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const store = new SecureStore()
    const { mcpClient } = await makeTestClient(configPath, store)
    const result = await mcpClient.callTool({
      name: 'get_grades',
      arguments: { scope: 'class', sort_by: 'engagement' },
    })
    const data = parseBlindedResult(result)
    // Bob has 1 missing, Jane has 0 → Bob first
    const userText = getUserText(result)
    const bobToken = getStudentToken(userText, 'Bob Adams')
    expect(data.students[0].student).toBe(bobToken)
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
    const data = parseBlindedResult(result)
    expect(data.assignment.id).toBe(501)
    expect(data.submissions).toHaveLength(2)
    expect(data.submissions[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.summary.total_students).toBe(2)
    expect(data.summary.missing).toBe(1)
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
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
    const data = parseBlindedResult(result)
    expect(data.student_token).toBe(janeToken)
    expect(data.current_score).toBe(87.4)
    expect(data.assignments.length).toBeGreaterThan(0)
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
    const data = parseBlindedResult(result)
    expect(data.total_missing_submissions).toBe(1)
    expect(data.students).toHaveLength(1)
    expect(data.students[0].student).toMatch(/\[STUDENT_\d{3}\]/)
    expect(data.students[0].missing_count).toBe(1)
    const userText = getUserText(result)
    expect(userText).toContain('Bob Adams')
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
    const data = parseBlindedResult(result)
    expect(data.total_late_submissions).toBe(1)
    expect(data.students).toHaveLength(1)
    expect(data.students[0].late_count).toBe(1)
    const userText = getUserText(result)
    expect(userText).toContain('Jane Smith')
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
