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
import { CanvasClient, ConfigManager, SecureStore, SidecarManager } from '@canvas-mcp/core'
import { registerFindTools } from '../../../src/tools/find.js'
import { registerReportingTools } from '../../../src/tools/reporting.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PAGE = {
  page_id: 801,
  url: 'week-1-overview',
  title: 'Week 1 Overview',
  body: '<p>Welcome</p>',
  published: false,
  front_page: false,
}

const MOCK_PAGE_2 = {
  page_id: 802,
  url: 'week-2-overview',
  title: 'Week 2 Overview',
  body: '<p>Week 2</p>',
  published: true,
  front_page: false,
}

const MOCK_FRONT_PAGE = {
  page_id: 803,
  url: 'course-home',
  title: 'Course Home',
  body: '<p>Home</p>',
  published: true,
  front_page: true,
}

const MOCK_ASSIGNMENT = {
  id: 501,
  name: 'Week 1 | Coding Assignment',
  points_possible: 10,
  due_at: '2026-03-01T23:59:00Z',
  html_url: `${CANVAS_URL}/courses/${COURSE_ID}/assignments/501`,
  description: '<p>Submit your code</p>',
  submission_types: ['online_url'],
  assignment_group_id: 100,
  published: false,
  rubric_settings: undefined,
}

const MOCK_QUIZ = {
  id: 601,
  title: 'Week 1 | Exit Card (5 mins)',
  quiz_type: 'graded_survey',
  points_possible: 0.5,
  due_at: null,
  time_limit: null,
  allowed_attempts: 1,
  assignment_group_id: 100,
  published: false,
  html_url: `${CANVAS_URL}/courses/${COURSE_ID}/quizzes/601`,
}

const MOCK_QUIZ_QUESTION = {
  id: 701,
  quiz_id: 601,
  question_name: 'Confidence',
  question_text: 'Rate your confidence.',
  question_type: 'essay_question',
  points_possible: 0,
  position: 1,
}

const MOCK_MODULE = {
  id: 10,
  name: 'Week 1: Introduction',
  position: 1,
  published: false,
  items_count: 2,
  unlock_at: null,
  prerequisite_module_ids: [],
  require_sequential_progress: false,
  workflow_state: 'unpublished',
}

const MOCK_MODULE_2 = {
  id: 11,
  name: 'Week 1: Lab',
  position: 2,
  published: false,
  items_count: 1,
  unlock_at: null,
  prerequisite_module_ids: [],
  require_sequential_progress: false,
  workflow_state: 'unpublished',
}

const MOCK_MODULE_ITEM = {
  id: 201,
  module_id: 10,
  position: 1,
  type: 'Assignment',
  title: 'Week 1 | Coding Assignment',
  content_id: 501,
  page_url: undefined,
  external_url: undefined,
  indent: 0,
  completion_requirement: { type: 'min_score', min_score: 1 },
  content_details: {},
}

const MOCK_DISCUSSION = {
  id: 901,
  title: 'Week 1 Discussion',
  message: '<p>Discuss Week 1</p>',
  is_announcement: false,
  published: true,
  assignment_id: null,
}

const MOCK_ANNOUNCEMENT = {
  id: 902,
  title: 'Week 1 Announcement',
  message: '<p>Important notice</p>',
  is_announcement: true,
  published: true,
  assignment_id: null,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-find-test-${suffix}`, 'config.json')
}

function writeConfig(path: string, overrides: Record<string, unknown> = {}) {
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const base = {
    canvas: { instanceUrl: CANVAS_URL, apiToken: 'tok' },
    program: { activeCourseId: COURSE_ID, courseCodes: [], courseCache: {} },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(base), 'utf-8')
}

async function makeFindClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  const templateService = {
    list: () => [{ template_name: 'later-standard', name: 'Later Standard Week', description: 'test', variables_schema: {} }],
    render: () => [],
    renderFile: () => '<p>rendered</p>',
  }
  registerFindTools(mcpServer, canvasClient, configManager, templateService as any)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

async function makeReportingClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const config = configManager.read()
  const sidecarManager = new SidecarManager(config.privacy.sidecarPath, config.privacy.blindingEnabled)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  const secureStore = new SecureStore()
  registerReportingTools(mcpServer, canvasClient, configManager, secureStore, sidecarManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient }
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  return JSON.parse(text)
}

function isError(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.isError === true
}

// ─── find_item ────────────────────────────────────────────────────────────────

describe('find_item — page', () => {
  it('returns page with body on single match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_PAGE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(MOCK_PAGE)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'page', search: 'overview' } })
    )
    expect(data.type).toBe('page')
    expect(data.page_url).toBe('week-1-overview')
    expect(data.page_id).toBe(801)
    expect(data.title).toBe('Week 1 Overview')
    expect(data.body).toBe('<p>Welcome</p>')
    expect(data.matched_title).toBe('Week 1 Overview')
    expect(data.warning).toBeUndefined()
  })

  it('includes warning when multiple pages match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_PAGE, MOCK_PAGE_2])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(MOCK_PAGE)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'page', search: 'overview' } })
    )
    expect(data.page_id).toBe(801)
    expect(data.warning).toBeDefined()
    expect(data.warning).toContain('2 items matched')
  })

  it('returns error when no page matches', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'find_item', arguments: { type: 'page', search: 'nonexistent' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No page found matching')
  })
})

describe('find_item — assignment', () => {
  it('returns assignment with description on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([MOCK_ASSIGNMENT])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'assignment', search: 'Week 1' } })
    )
    expect(data.type).toBe('assignment')
    expect(data.id).toBe(501)
    expect(data.name).toBe('Week 1 | Coding Assignment')
    expect(data.description).toBe('<p>Submit your code</p>')
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })

  it('returns error when no assignment matches', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'find_item', arguments: { type: 'assignment', search: 'xyz' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No assignment found matching')
  })
})

describe('find_item — quiz', () => {
  it('returns quiz with questions on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([MOCK_QUIZ])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601/questions`, () =>
        HttpResponse.json([MOCK_QUIZ_QUESTION])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'quiz', search: 'Exit Card' } })
    )
    expect(data.type).toBe('quiz')
    expect(data.id).toBe(601)
    expect(data.title).toBe('Week 1 | Exit Card (5 mins)')
    expect(data.questions).toHaveLength(1)
    expect(data.questions[0].id).toBe(701)
    expect(data.matched_title).toBe('Week 1 | Exit Card (5 mins)')
  })
})

describe('find_item — module', () => {
  it('returns module metadata on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'module', search: 'Week 1' } })
    )
    expect(data.type).toBe('module')
    expect(data.id).toBe(10)
    expect(data.name).toBe('Week 1: Introduction')
    expect(data.items_count).toBe(2)
    expect(data.matched_title).toBe('Week 1: Introduction')
  })
})

describe('find_item — module_item', () => {
  it('returns module_item with module_id on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_MODULE_ITEM])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'module_item', search: 'Coding', module_name: 'Week 1' },
      })
    )
    expect(data.type).toBe('module_item')
    expect(data.id).toBe(201)
    expect(data.module_id).toBe(10)
    expect(data.item_type).toBe('Assignment')
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })

  it('returns error when module not found', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'find_item',
      arguments: { type: 'module_item', search: 'Coding', module_name: 'Week 99' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No module found matching')
  })
})

describe('find_item — discussion', () => {
  it('returns discussion on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_DISCUSSION])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'discussion', search: 'Week 1' } })
    )
    expect(data.type).toBe('discussion')
    expect(data.id).toBe(901)
    expect(data.title).toBe('Week 1 Discussion')
    expect(data.message).toBe('<p>Discuss Week 1</p>')
  })

  it('does not return announcements when searching discussions', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_ANNOUNCEMENT])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'find_item', arguments: { type: 'discussion', search: 'Week 1' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No discussion found matching')
  })
})

describe('find_item — announcement', () => {
  it('returns announcement on match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_ANNOUNCEMENT])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'announcement', search: 'Week 1' } })
    )
    expect(data.type).toBe('announcement')
    expect(data.id).toBe(902)
    expect(data.title).toBe('Week 1 Announcement')
    expect(data.message).toBe('<p>Important notice</p>')
  })
})

// ─── update_item ──────────────────────────────────────────────────────────────

describe('update_item — page', () => {
  it('updates page fields and returns updated object', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const updatedPage = { ...MOCK_PAGE, title: 'New Title', body: '<p>New body</p>' }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_PAGE])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(updatedPage)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'page', search: 'overview', title: 'New Title', body: '<p>New body</p>' },
      })
    )
    expect(data.title).toBe('New Title')
    expect(data.body).toBe('<p>New body</p>')
    expect(data.matched_title).toBe('Week 1 Overview')
  })

  it('returns error when page not found', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'update_item',
      arguments: { type: 'page', search: 'nonexistent', title: 'X' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No page found matching')
  })
})

describe('update_item — assignment', () => {
  it('updates assignment fields and returns updated object', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const updatedAssignment = { ...MOCK_ASSIGNMENT, published: true }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([MOCK_ASSIGNMENT])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json(updatedAssignment)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'assignment', search: 'Week 1', published: true },
      })
    )
    expect(data.published).toBe(true)
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })
})

describe('update_item — quiz', () => {
  it('updates quiz fields and returns updated object', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const updatedQuiz = { ...MOCK_QUIZ, title: 'Renamed Quiz' }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([MOCK_QUIZ])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601`, () =>
        HttpResponse.json(updatedQuiz)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'quiz', search: 'Exit Card', title: 'Renamed Quiz' },
      })
    )
    expect(data.title).toBe('Renamed Quiz')
    expect(data.matched_title).toBe('Week 1 | Exit Card (5 mins)')
  })
})

describe('update_item — module', () => {
  it('updates module fields and returns updated object', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const updatedModule = { ...MOCK_MODULE, published: true }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(updatedModule)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'module', search: 'Week 1', published: true },
      })
    )
    expect(data.published).toBe(true)
    expect(data.matched_title).toBe('Week 1: Introduction')
  })
})

describe('update_item — module_item', () => {
  it('updates module_item position and returns updated item', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const updatedItem = { ...MOCK_MODULE_ITEM, position: 2 }
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_MODULE_ITEM])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items/201`, () =>
        HttpResponse.json(updatedItem)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'module_item', search: 'Coding', module_name: 'Week 1', position: 2 },
      })
    )
    expect(data.position).toBe(2)
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })
})

// ─── delete_item ──────────────────────────────────────────────────────────────

describe('delete_item — page', () => {
  it('deletes page and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_PAGE])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(MOCK_PAGE)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'page', search: 'overview' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1 Overview')
  })

  it('rejects deletion of front page', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_FRONT_PAGE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'page', search: 'home' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('front page')
  })
})

describe('delete_item — assignment', () => {
  it('deletes assignment and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([MOCK_ASSIGNMENT])
      ),
      // deleteAssignment calls getAssignment first to check for rubric
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json(MOCK_ASSIGNMENT)
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'assignment', search: 'Week 1' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })
})

describe('delete_item — quiz', () => {
  it('deletes quiz and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([MOCK_QUIZ])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'quiz', search: 'Exit Card' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1 | Exit Card (5 mins)')
  })
})

describe('delete_item — module', () => {
  it('deletes module and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'module', search: 'Week 1' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1: Introduction')
  })
})

describe('delete_item — module_item', () => {
  it('removes module_item and returns removed:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_MODULE_ITEM])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items/201`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'module_item', search: 'Coding', module_name: 'Week 1' },
      })
    )
    expect(data.removed).toBe(true)
    expect(data.matched_title).toBe('Week 1 | Coding Assignment')
  })
})

describe('delete_item — discussion', () => {
  it('deletes discussion and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_DISCUSSION])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/901`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'discussion', search: 'Week 1' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1 Discussion')
  })
})

describe('delete_item — announcement', () => {
  it('deletes announcement and returns deleted:true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_ANNOUNCEMENT])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/902`, () =>
        HttpResponse.json({})
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'delete_item', arguments: { type: 'announcement', search: 'Week 1' } })
    )
    expect(data.deleted).toBe(true)
    expect(data.matched_title).toBe('Week 1 Announcement')
  })
})

// ─── search_course ────────────────────────────────────────────────────────────

const MOCK_SEARCH_RESULTS = [
  {
    content_id: 801,
    content_type: 'WikiPage',
    title: 'Week 1 Overview',
    body: '<p>Python basics</p>',
    html_url: `${CANVAS_URL}/courses/${COURSE_ID}/pages/week-1-overview`,
    distance: 0.15,
    published: true,
  },
  {
    content_id: 501,
    content_type: 'Assignment',
    title: 'Week 1 Assignment',
    body: '<p>Submit code</p>',
    html_url: `${CANVAS_URL}/courses/${COURSE_ID}/assignments/501`,
    distance: 0.42,
    published: false,
    due_at: '2026-03-01T23:59:00Z',
  },
  {
    content_id: 901,
    content_type: 'DiscussionTopic',
    title: 'Week 1 Discussion',
    body: '<p>Discuss</p>',
    html_url: `${CANVAS_URL}/courses/${COURSE_ID}/discussion_topics/901`,
    distance: 0.78,
    published: true,
  },
]

describe('search_course', () => {
  it('filters results by default config threshold (0.5)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'python week 1' } })
    )
    expect(data.query).toBe('python week 1')
    expect(data.threshold).toBe(0.5)
    expect(data.total_results).toBe(2)
    expect(data.returned_results).toBe(2)
    expect(data.results).toHaveLength(2)
    expect(data.results[0].content_id).toBe(801)
    expect(data.results[1].content_id).toBe(501)
    // distance 0.78 excluded
    expect(data.results.find((r: { content_id: number }) => r.content_id === 901)).toBeUndefined()
  })

  it('threshold override of 1.0 returns all 3 results', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'week 1', threshold: 1.0 } })
    )
    expect(data.threshold).toBe(1.0)
    expect(data.results).toHaveLength(3)
  })

  it('limit:1 returns only first result after threshold filtering', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'search_course',
        arguments: { query: 'week 1', threshold: 1.0, limit: 1 },
      })
    )
    expect(data.results).toHaveLength(1)
    expect(data.returned_results).toBe(1)
    expect(data.results[0].content_id).toBe(801)
  })

  it('body excluded by default; include_body:true includes it', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)

    const withoutBody = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'week 1' } })
    )
    expect(withoutBody.results[0].body).toBeUndefined()

    const withBody = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'week 1', include_body: true } })
    )
    expect(withBody.results[0].body).toBe('<p>Python basics</p>')
  })

  it('returns empty results array (not an error) when no results pass threshold', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'unrelated', threshold: 0.1 } })
    )
    expect(data.results).toHaveLength(0)
    expect(data.total_results).toBe(0)
  })

  it('returns toolError when Canvas API throws (Smart Search not available)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json({ errors: [{ message: 'Feature not enabled' }] }, { status: 404 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'search_course', arguments: { query: 'anything' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Smart Search failed')
  })

  it('returns toolError when no active course set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'search_course', arguments: { query: 'anything' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

describe('search_course — save_threshold', () => {
  it('persists the threshold to config and subsequent searches use it as default', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/smartsearch`, () =>
        HttpResponse.json(MOCK_SEARCH_RESULTS)
      ),
    )
    const { mcpClient, configManager } = await makeFindClient(configPath)

    // Set threshold=0.3 and save it
    await mcpClient.callTool({
      name: 'search_course',
      arguments: { query: 'python', threshold: 0.3, save_threshold: true },
    })

    // Config should now have the new threshold
    const config = configManager.read()
    expect(config.smartSearch?.distanceThreshold).toBe(0.3)

    // Next search without explicit threshold uses saved 0.3
    const searchData = parseResult(
      await mcpClient.callTool({ name: 'search_course', arguments: { query: 'python' } })
    )
    expect(searchData.threshold).toBe(0.3)
    // Only distance 0.15 passes 0.3 threshold
    expect(searchData.results).toHaveLength(1)
    expect(searchData.results[0].content_id).toBe(801)
  })
})

// ─── get_module_summary with module_name ─────────────────────────────────────

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
    const { mcpClient } = await makeReportingClient(configPath)
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
    const { mcpClient } = await makeReportingClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_module_summary',
      arguments: {},
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Provide either module_id or module_name')
  })

  it('includes warning when multiple modules match module_name', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE, MOCK_MODULE_2])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(MOCK_MODULE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_MODULE_ITEM])
      ),
    )
    const { mcpClient } = await makeReportingClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_name: 'Week 1' },
      })
    )
    expect(data.module.id).toBe(10)
    expect(data.warning).toBeDefined()
    expect(data.warning).toContain('2 modules matched')
  })

  it('returns toolError when no module matches module_name', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      ),
    )
    const { mcpClient } = await makeReportingClient(configPath)
    const result = await mcpClient.callTool({
      name: 'get_module_summary',
      arguments: { module_name: 'Week 99' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No module found matching')
  })
})

// ─── find_item — syllabus ──────────────────────────────────────────────────────

describe('find_item — syllabus', () => {
  it('returns syllabus_body from course include', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json({
          id: COURSE_ID, name: 'Test Course', course_code: 'T', workflow_state: 'available',
          syllabus_body: '<h1>Syllabus</h1>',
        })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'syllabus' } })
    )
    expect(data.type).toBe('syllabus')
    expect(data.syllabus_body).toBe('<h1>Syllabus</h1>')
  })

  it('returns null syllabus_body when empty', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json({
          id: COURSE_ID, name: 'Test Course', course_code: 'T', workflow_state: 'available',
          syllabus_body: null,
        })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'syllabus' } })
    )
    expect(data.syllabus_body).toBeNull()
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({ name: 'find_item', arguments: { type: 'syllabus' } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── update_item — syllabus ────────────────────────────────────────────────────

describe('update_item — syllabus', () => {
  it('sends syllabus_body in course update and returns updated=true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ id: COURSE_ID, name: 'Test', course_code: 'T', workflow_state: 'available' })
      }),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'syllabus', body: '<h1>New Syllabus</h1>' },
      })
    )
    expect(data.updated).toBe(true)
    const body = capturedBody as { course: { syllabus_body: string } }
    expect(body.course.syllabus_body).toBe('<h1>New Syllabus</h1>')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'update_item',
      arguments: { type: 'syllabus', body: '<p>test</p>' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── create_item ──────────────────────────────────────────────────────────────

const MOCK_CREATED_PAGE = { page_id: 801, url: 'week-1-overview', title: 'Week 1 Overview', body: '', published: false, front_page: false }
const MOCK_CREATED_ASSIGNMENT = { id: 501, name: 'HW1', points_possible: 10, due_at: null, html_url: 'https://canvas.example.com/courses/1/assignments/501', published: false, submission_types: ['online_url'], assignment_group_id: null, description: null }
const MOCK_CREATED_QUIZ = { id: 601, title: 'Exit Card', quiz_type: 'graded_survey', points_possible: 0.5, due_at: null, time_limit: null, allowed_attempts: 1, assignment_group_id: null, published: false, html_url: 'https://canvas.example.com/courses/1/quizzes/601' }
const MOCK_CREATED_DISCUSSION = { id: 901, title: 'Week 1 Discussion', message: null, is_announcement: false, published: false, assignment_id: null }
const MOCK_CREATED_ANNOUNCEMENT = { id: 902, title: 'Important Update', message: null, is_announcement: true, published: true, assignment_id: null }
const MOCK_CREATED_MODULE = { id: 10, name: 'Week 1', position: 1, published: false, items_count: 0, unlock_at: null, prerequisite_module_ids: [], require_sequential_progress: false, workflow_state: 'unpublished' }
const MOCK_CREATED_MODULE_ITEM = { id: 201, module_id: 10, position: 1, type: 'Assignment', title: 'HW1', content_id: 501, page_url: undefined, external_url: undefined, indent: 0, completion_requirement: null, content_details: {} }

describe('create_item — dry_run=true', () => {
  it('returns preview without calling Canvas for type=page', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: 'Week 1 Overview', dry_run: true },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.type).toBe('page')
    expect(data.preview.title).toBe('Week 1 Overview')
  })

  it('returns preview for type=assignment with resolved description', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'assignment',
          name: 'HW1',
          notebook_url: 'https://colab.example.com/nb',
          notebook_title: 'Notebook 1',
          dry_run: true,
        },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.description).toContain('colab.example.com/nb')
  })

  it('returns preview for type=quiz with exit card template', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'quiz',
          use_exit_card_template: true,
          week: 1,
          dry_run: true,
        },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.title).toContain('Week 1')
  })

  it('returns preview for type=discussion', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'discussion', title: 'D1', dry_run: true },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.title).toBe('D1')
  })

  it('returns preview for type=announcement', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'announcement', title: 'A1', dry_run: true },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.title).toBe('A1')
  })

  it('returns preview for type=module', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'module', name: 'M1', dry_run: true },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.name).toBe('M1')
  })

  it('returns preview for type=module_item', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'module_item',
          module_name: 'Week 1',
          item_type: 'SubHeader',
          title: 'H1',
          dry_run: true,
        },
      })
    )
    expect(data.dry_run).toBe(true)
    expect(data.preview.module_id).toBe(10)
  })
})

describe('create_item — errors', () => {
  it('returns error when title missing for quiz without template', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_item',
      arguments: { type: 'quiz' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('title is required')
  })
})

describe('create_item — type=page', () => {
  it('creates a page and returns id, url, title', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(MOCK_CREATED_PAGE, { status: 200 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: 'Week 1 Overview' },
      })
    )
    expect(data.id).toBe(801)
    expect(data.url).toBe('week-1-overview')
    expect(data.title).toBe('Week 1 Overview')
  })
})

describe('create_item — type=assignment', () => {
  it('creates an assignment and returns id, name, points_possible', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json(MOCK_CREATED_ASSIGNMENT, { status: 201 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: 'HW1', points_possible: 10 },
      })
    )
    expect(data.id).toBe(501)
    expect(data.name).toBe('HW1')
    expect(data.points_possible).toBe(10)
  })
})

describe('create_item — type=quiz', () => {
  it('creates a quiz and returns id, title, questions_created', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json(MOCK_CREATED_QUIZ, { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601/questions`, () =>
        HttpResponse.json({ id: 701, quiz_id: 601, question_name: 'Q1', question_text: 'text', question_type: 'essay_question', points_possible: 0, position: 1 }, { status: 201 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'quiz',
          title: 'Exit Card',
          quiz_type: 'graded_survey',
          questions: [{ question_name: 'Q1', question_text: 'text', question_type: 'essay_question' }],
        },
      })
    )
    expect(data.id).toBe(601)
    expect(data.title).toBe('Exit Card')
    expect(data.questions_created).toBe(1)
  })
})

describe('create_item — type=discussion', () => {
  it('creates a discussion and returns id, title', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json(MOCK_CREATED_DISCUSSION, { status: 201 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'discussion', title: 'Week 1 Discussion' },
      })
    )
    expect(data.id).toBe(901)
    expect(data.title).toBe('Week 1 Discussion')
    expect(data.published).toBe(false)
  })
})

describe('create_item — type=announcement', () => {
  it('creates an announcement (is_announcement=true, published=true)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(MOCK_CREATED_ANNOUNCEMENT, { status: 201 })
      }),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'announcement', title: 'Important Update' },
      })
    )
    expect(data.id).toBe(902)
    expect(capturedBody.is_announcement).toBe(true)
    expect(capturedBody.published).toBe(true)
  })
})

describe('create_item — type=module', () => {
  it('creates a module and returns id, name', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json(MOCK_CREATED_MODULE, { status: 201 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'module', name: 'Week 1' },
      })
    )
    expect(data.id).toBe(10)
    expect(data.name).toBe('Week 1')
  })
})

describe('create_item — type=module_item', () => {
  it('resolves module by name and creates item', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_CREATED_MODULE_ITEM, { status: 201 })
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'module_item',
          module_name: 'Week 1',
          item_type: 'Assignment',
          title: 'HW1',
          content_id: 501,
        },
      })
    )
    expect(data.id).toBe(201)
    expect(data.module_id).toBe(10)
    expect(data.title).toBe('HW1')
  })

  it('returns error when module_name does not match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_item',
      arguments: {
        type: 'module_item',
        module_name: 'Nonexistent Module',
        item_type: 'SubHeader',
        title: 'Header',
      },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No module found matching')
  })
})

// ─── list_items ──────────────────────────────────────────────────────────────

describe('list_items — type=modules', () => {
  it('returns array of modules', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'modules' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(10)
    expect(data[0].name).toBe('Week 1')
  })
})

describe('list_items — type=assignments', () => {
  it('returns array of assignments', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([MOCK_ASSIGNMENT])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'assignments' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(501)
    expect(data[0].name).toBe('Week 1 | Coding Assignment')
  })
})

describe('list_items — type=quizzes', () => {
  it('returns array of quizzes', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([MOCK_QUIZ])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'quizzes' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(601)
    expect(data[0].title).toBe('Week 1 | Exit Card (5 mins)')
  })
})

describe('list_items — type=pages', () => {
  it('returns array of pages', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([MOCK_PAGE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'pages' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].page_id).toBe(801)
    expect(data[0].title).toBe('Week 1 Overview')
  })
})

describe('list_items — type=discussions', () => {
  it('returns only non-announcement discussion topics', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('only_announcements') === 'true') return HttpResponse.json([])
        return HttpResponse.json([MOCK_DISCUSSION, { ...MOCK_ANNOUNCEMENT, is_announcement: true }])
      }),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'discussions' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(901)
  })
})

describe('list_items — type=announcements', () => {
  it('returns announcements', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([MOCK_ANNOUNCEMENT])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'announcements' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(902)
    expect(data[0].title).toBe('Week 1 Announcement')
  })
})

describe('list_items — type=rubrics', () => {
  it('returns array of rubrics', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
        HttpResponse.json([{ id: 3001, title: 'Coding Rubric', points_possible: 10, context_type: 'Course' }])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'rubrics' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(3001)
    expect(data[0].title).toBe('Coding Rubric')
  })
})

describe('list_items — type=assignment_groups', () => {
  it('returns array of assignment groups', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
        HttpResponse.json([{ id: 100, name: 'Assignments', group_weight: 100, rules: {} }])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'assignment_groups' } })
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(100)
    expect(data[0].name).toBe('Assignments')
  })
})

describe('list_items — type=module_items', () => {
  it('resolves module by name and returns its items', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE_ITEM])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'list_items',
        arguments: { type: 'module_items', module_name: 'Week 1' },
      })
    )
    expect(data.module_id).toBe(10)
    expect(data.module_name).toBe('Week 1')
    expect(data.items).toHaveLength(1)
    expect(data.items[0].id).toBe(201)
  })

  it('returns error when module_name does not match', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_CREATED_MODULE])
      ),
    )
    const { mcpClient } = await makeFindClient(configPath)
    const result = await mcpClient.callTool({
      name: 'list_items',
      arguments: { type: 'module_items', module_name: 'Nonexistent' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No module found matching')
  })
})
