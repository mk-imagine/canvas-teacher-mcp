import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { server as mswServer } from '../../setup/msw-server.js'
import { CanvasClient } from '../../../src/canvas/client.js'
import { ConfigManager } from '../../../src/config/manager.js'
import { registerContentTools } from '../../../src/tools/content.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ASSIGNMENT = {
  id: 501,
  name: 'Week 1 | Coding Assignment',
  points_possible: 10,
  due_at: '2026-03-01T23:59:00Z',
  html_url: `${CANVAS_URL}/courses/${COURSE_ID}/assignments/501`,
  description: null,
  submission_types: ['online_url'],
  assignment_group_id: 100,
  published: false,
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

const MOCK_PAGE = {
  page_id: 801,
  url: 'week-1-overview',
  title: 'Week 1 Overview',
  body: '<p>Welcome</p>',
  published: false,
  front_page: false,
}

const MOCK_MODULE = {
  id: 10,
  name: 'Week 1: Introduction',
  position: 1,
  published: false,
  items_count: 0,
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
  indent: 0,
  completion_requirement: { type: 'min_score', min_score: 1 },
  content_details: {},
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-content-test-${suffix}`, 'config.json')
}

function writeConfig(path: string, overrides: Record<string, unknown> = {}) {
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const base = {
    canvas: { instanceUrl: CANVAS_URL, apiToken: 'tok' },
    program: { activeCourseId: COURSE_ID, courseCodes: [], courseCache: {} },
    defaults: {
      assignmentGroup: 'Assignments',
      submissionType: 'online_url',
      pointsPossible: 100,
      completionRequirement: 'min_score',
      minScore: 1,
      exitCardPoints: 0.5,
    },
    assignmentDescriptionTemplate: {
      default: '<h3><strong><a href="{{notebook_url}}">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>',
      solution: '<h3><strong><a href="{{notebook_url}}">View Solution in Colab</a></strong></h3>',
    },
    exitCardTemplate: {
      title: 'Week {{week}} | Exit Card (5 mins)',
      quizType: 'graded_survey',
      questions: [
        { question_name: 'Confidence', question_text: 'Rate your confidence.', question_type: 'essay_question' },
        { question_name: 'Muddiest Point', question_text: "What's still unclear?", question_type: 'essay_question' },
      ],
    },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(base), 'utf-8')
}

async function makeTestClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerContentTools(mcpServer, canvasClient, configManager)

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

// ─── create_assignment ────────────────────────────────────────────────────────

describe('create_assignment', () => {
  beforeEach(() => {
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json(MOCK_ASSIGNMENT, { status: 201 })
      )
    )
  })

  it('returns created assignment with expected fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: { name: 'Week 1 | Coding Assignment', points_possible: 10 },
      })
    )
    expect(data.id).toBe(501)
    expect(data.name).toBe('Week 1 | Coding Assignment')
    expect(data.points_possible).toBe(10)
    expect(data.published).toBe(false)
  })

  it('renders description from template when notebook_url is provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(MOCK_ASSIGNMENT, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'create_assignment',
      arguments: {
        name: 'Week 1 | Coding Assignment',
        notebook_url: 'https://colab.research.google.com/drive/abc',
        notebook_title: 'Week 1 Notebook',
        instructions: 'Complete all cells.',
      },
    })
    const body = capturedBody as { assignment: { description: string } }
    expect(body.assignment.description).toContain('https://colab.research.google.com/drive/abc')
    expect(body.assignment.description).toContain('Week 1 Notebook')
    expect(body.assignment.description).toContain('Complete all cells.')
  })

  it('uses description as-is when explicitly provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(MOCK_ASSIGNMENT, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'create_assignment',
      arguments: {
        name: 'Week 1 | Coding Assignment',
        description: '<p>Custom HTML</p>',
        notebook_url: 'https://colab.research.google.com/drive/abc',
      },
    })
    const body = capturedBody as { assignment: { description: string } }
    expect(body.assignment.description).toBe('<p>Custom HTML</p>')
  })

  it('defaults points_possible from config when not provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(MOCK_ASSIGNMENT, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'create_assignment',
      arguments: { name: 'Week 1 | Coding Assignment' },
    })
    const body = capturedBody as { assignment: { points_possible: number } }
    expect(body.assignment.points_possible).toBe(100)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_assignment',
      arguments: { name: 'Test' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── update_assignment ────────────────────────────────────────────────────────

describe('update_assignment', () => {
  it('sends only provided fields in PUT body', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_ASSIGNMENT, name: 'Renamed', published: true })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_assignment',
        arguments: { assignment_id: 501, name: 'Renamed', published: true },
      })
    )
    expect(data.name).toBe('Renamed')
    expect(data.published).toBe(true)
    const body = capturedBody as { assignment: Record<string, unknown> }
    expect(body.assignment.name).toBe('Renamed')
    expect(body.assignment.assignment_id).toBeUndefined()
  })
})

// ─── create_quiz ──────────────────────────────────────────────────────────────

describe('create_quiz', () => {
  it('creates quiz and questions from exit card template', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const createdQuestions: unknown[] = []
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json(MOCK_QUIZ, { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601/questions`, async ({ request }) => {
        const body = await request.json()
        createdQuestions.push(body)
        return HttpResponse.json(MOCK_QUIZ_QUESTION, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: { use_exit_card_template: true, week: 1 },
      })
    )
    expect(data.id).toBe(601)
    expect(data.quiz_type).toBe('graded_survey')
    expect(data.questions_created).toBe(2)
    // Title rendered from template
    expect(data.title).toContain('Exit Card')
  })

  it('substitutes week number into exit card title', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(MOCK_QUIZ, { status: 201 })
      }),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601/questions`, () =>
        HttpResponse.json(MOCK_QUIZ_QUESTION, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'create_quiz',
      arguments: { use_exit_card_template: true, week: 3 },
    })
    const body = capturedBody as { quiz: { title: string } }
    expect(body.quiz.title).toBe('Week 3 | Exit Card (5 mins)')
  })

  it('creates quiz without template when given explicit title and questions', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json({ ...MOCK_QUIZ, title: 'Custom Quiz', quiz_type: 'assignment' }, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: { title: 'Custom Quiz', quiz_type: 'assignment', questions: [] },
      })
    )
    expect(data.title).toBe('Custom Quiz')
    expect(data.questions_created).toBe(0)
  })

  it('returns error when no title and not using template', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_quiz',
      arguments: { quiz_type: 'assignment' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('title is required')
  })
})

// ─── update_quiz ──────────────────────────────────────────────────────────────

describe('update_quiz', () => {
  it('sends provided fields to PUT endpoint', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_QUIZ, published: true })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_quiz',
        arguments: { quiz_id: 601, published: true },
      })
    )
    expect(data.published).toBe(true)
    const body = capturedBody as { quiz: Record<string, unknown> }
    expect(body.quiz.published).toBe(true)
    expect(body.quiz.quiz_id).toBeUndefined()
  })
})

// ─── delete_assignment ────────────────────────────────────────────────────────

describe('delete_assignment', () => {
  it('returns deleted=true and assignment_id on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ ...MOCK_ASSIGNMENT, rubric_settings: undefined })
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_assignment',
        arguments: { assignment_id: 501 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.assignment_id).toBe(501)
  })

  it('pre-deletes associated rubric before deleting assignment', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let rubricDeleted = false
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        HttpResponse.json({ ...MOCK_ASSIGNMENT, rubric_settings: { id: 3001, points_possible: 10 } })
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics/3001`, () => {
        rubricDeleted = true
        return new HttpResponse(null, { status: 200 })
      }),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/501`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_assignment',
        arguments: { assignment_id: 501 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(rubricDeleted).toBe(true)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_assignment',
      arguments: { assignment_id: 501 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── delete_quiz ──────────────────────────────────────────────────────────────

describe('delete_quiz', () => {
  it('returns deleted=true and quiz_id on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_quiz',
        arguments: { quiz_id: 601 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.quiz_id).toBe(601)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_quiz',
      arguments: { quiz_id: 601 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── update_module ────────────────────────────────────────────────────────────

describe('update_module', () => {
  it('publishes a module', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json({ ...MOCK_MODULE, published: true })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_module',
        arguments: { module_id: 10, published: true },
      })
    )
    expect(data.published).toBe(true)
  })

  it('sets prerequisite_module_ids', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_MODULE, prerequisite_module_ids: [9] })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'update_module',
      arguments: { module_id: 10, prerequisite_module_ids: [9] },
    })
    const body = capturedBody as { module: { prerequisite_module_ids: number[] } }
    expect(body.module.prerequisite_module_ids).toEqual([9])
  })
})

// ─── delete_module ────────────────────────────────────────────────────────────

describe('delete_module', () => {
  it('returns deleted=true on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_module',
        arguments: { module_id: 10 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.module_id).toBe(10)
  })
})

// ─── add_module_item ──────────────────────────────────────────────────────────

describe('add_module_item', () => {
  it('creates an Assignment item with content_id', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json(MOCK_MODULE_ITEM, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'add_module_item',
        arguments: {
          module_id: 10,
          type: 'Assignment',
          title: 'Week 1 | Coding Assignment',
          content_id: 501,
        },
      })
    )
    expect(data.id).toBe(201)
    expect(data.type).toBe('Assignment')
    expect(data.content_id).toBe(501)
  })

  it('returns error when content_id missing for Assignment type', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'add_module_item',
      arguments: { module_id: 10, type: 'Assignment', title: 'Test' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('content_id is required')
  })

  it('returns error when external_url missing for ExternalUrl type', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'add_module_item',
      arguments: { module_id: 10, type: 'ExternalUrl', title: 'Download Files' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('external_url is required')
  })

  it('defaults new_tab=true for ExternalUrl type', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_MODULE_ITEM, type: 'ExternalUrl', content_id: undefined }, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'add_module_item',
      arguments: {
        module_id: 10,
        type: 'ExternalUrl',
        title: 'Download Files',
        external_url: 'https://example.com/data.zip',
      },
    })
    const body = capturedBody as { module_item: { new_tab: boolean } }
    expect(body.module_item.new_tab).toBe(true)
  })

  it('creates a SubHeader item (no content_id required)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () =>
        HttpResponse.json({ ...MOCK_MODULE_ITEM, type: 'SubHeader', content_id: undefined }, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'add_module_item',
        arguments: { module_id: 10, type: 'SubHeader', title: 'OVERVIEW' },
      })
    )
    expect(data.type).toBe('SubHeader')
  })
})

// ─── update_module_item ───────────────────────────────────────────────────────

describe('update_module_item', () => {
  it('updates position', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items/201`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_MODULE_ITEM, position: 3 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_module_item',
        arguments: { module_id: 10, item_id: 201, position: 3 },
      })
    )
    expect(data.position).toBe(3)
    const body = capturedBody as { module_item: { position: number } }
    expect(body.module_item.position).toBe(3)
  })
})

// ─── remove_module_item ───────────────────────────────────────────────────────

describe('remove_module_item', () => {
  it('returns deleted=true on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items/201`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'remove_module_item',
        arguments: { module_id: 10, item_id: 201 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.item_id).toBe(201)
  })
})

// ─── create_page ─────────────────────────────────────────────────────────────

describe('create_page', () => {
  it('returns created page with url slug and fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(MOCK_PAGE, { status: 200 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_page',
        arguments: { title: 'Week 1 Overview' },
      })
    )
    expect(data.page_id).toBe(801)
    expect(data.url).toBe('week-1-overview')
    expect(data.title).toBe('Week 1 Overview')
    expect(data.published).toBe(false)
  })

  it('sends body and published fields when provided', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ...MOCK_PAGE, published: true }, { status: 200 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    await mcpClient.callTool({
      name: 'create_page',
      arguments: { title: 'Week 1 Overview', body: '<p>Hello</p>', published: true },
    })
    const body = capturedBody as { wiki_page: Record<string, unknown> }
    expect(body.wiki_page.body).toBe('<p>Hello</p>')
    expect(body.wiki_page.published).toBe(true)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_page',
      arguments: { title: 'Test Page' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── update_page ─────────────────────────────────────────────────────────────

describe('update_page', () => {
  it('returns updated page fields on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(MOCK_PAGE)
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json({ ...MOCK_PAGE, title: 'Updated Title' })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_page',
        arguments: { page_url: 'week-1-overview', title: 'Updated Title' },
      })
    )
    expect(data.page_id).toBe(801)
    expect(data.url).toBe('week-1-overview')
    expect(data.title).toBe('Updated Title')
  })

  it('returns error when page_url does not exist', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/nonexistent`, () =>
        new HttpResponse(null, { status: 404 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'update_page',
      arguments: { page_url: 'nonexistent', body: '<p>hi</p>' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Page not found')
    expect(text).toContain('nonexistent')
    expect(text).toContain('list_pages')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'update_page',
      arguments: { page_url: 'week-1-overview' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── list_pages ───────────────────────────────────────────────────────────────

describe('list_pages', () => {
  it('returns all pages with url slugs and fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const pages = [
      MOCK_PAGE,
      { page_id: 802, url: 'week-2-overview', title: 'Week 2 Overview', published: false, front_page: false },
    ]
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(pages)
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_pages', arguments: {} })
    )
    expect(data).toHaveLength(2)
    expect(data[0].page_id).toBe(801)
    expect(data[0].url).toBe('week-1-overview')
    expect(data[1].url).toBe('week-2-overview')
  })

  it('returns empty array when no pages exist', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({ name: 'list_pages', arguments: {} })
    )
    expect(data).toHaveLength(0)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({ name: 'list_pages', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── delete_page ─────────────────────────────────────────────────────────────

describe('delete_page', () => {
  it('returns deleted=true and page_url on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json(MOCK_PAGE)  // front_page: false
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_page',
        arguments: { page_url: 'week-1-overview' },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.page_url).toBe('week-1-overview')
  })

  it('returns error when page is the course front page', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/week-1-overview`, () =>
        HttpResponse.json({ ...MOCK_PAGE, front_page: true })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_page',
      arguments: { page_url: 'week-1-overview' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('front page')
    expect(text).toContain('week-1-overview')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_page',
      arguments: { page_url: 'week-1-overview' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── delete_discussion ───────────────────────────────────────────────────────

describe('delete_discussion', () => {
  it('returns deleted=true and topic_id on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/901`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_discussion',
        arguments: { topic_id: 901 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.topic_id).toBe(901)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_discussion',
      arguments: { topic_id: 901 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── delete_announcement ─────────────────────────────────────────────────────

describe('delete_announcement', () => {
  it('returns deleted=true and topic_id on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/902`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_announcement',
        arguments: { topic_id: 902 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.topic_id).toBe(902)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'delete_announcement',
      arguments: { topic_id: 902 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── delete_file ─────────────────────────────────────────────────────────────

describe('delete_file', () => {
  it('returns deleted=true and file_id on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.delete(`${CANVAS_URL}/api/v1/files/1001`, () =>
        new HttpResponse(null, { status: 204 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_file',
        arguments: { file_id: 1001 },
      })
    )
    expect(data.deleted).toBe(true)
    expect(data.file_id).toBe(1001)
  })
})

// ─── clear_syllabus ──────────────────────────────────────────────────────────

describe('clear_syllabus', () => {
  it('returns cleared=true on success', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json({ id: COURSE_ID, name: 'Test', course_code: 'T', workflow_state: 'available' })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'clear_syllabus',
        arguments: {},
      })
    )
    expect(data.cleared).toBe(true)
    expect(data.course_id).toBe(COURSE_ID)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'clear_syllabus',
      arguments: {},
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── create_discussion ──────────────────────────────────────────────────────

describe('create_discussion', () => {
  it('returns created discussion with expected fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json({
          id: 1001,
          title: 'Week 1 Discussion',
          message: '<p>Discuss this week.</p>',
          is_announcement: false,
          published: false,
          assignment_id: null,
        }, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_discussion',
        arguments: { title: 'Week 1 Discussion', message: '<p>Discuss this week.</p>' },
      })
    )
    expect(data.id).toBe(1001)
    expect(data.title).toBe('Week 1 Discussion')
    expect(data.is_announcement).toBe(false)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_discussion',
      arguments: { title: 'Test' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── create_announcement ────────────────────────────────────────────────────

describe('create_announcement', () => {
  it('sends is_announcement=true and published=true in request body', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({
          id: 1002,
          title: 'Important Update',
          message: null,
          is_announcement: true,
          published: true,
          assignment_id: null,
        }, { status: 201 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_announcement',
        arguments: { title: 'Important Update' },
      })
    )
    expect(data.id).toBe(1002)
    expect(data.is_announcement).toBe(true)
    expect(data.published).toBe(true)
    expect(capturedBody.is_announcement).toBe(true)
    expect(capturedBody.published).toBe(true)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_announcement',
      arguments: { title: 'Test' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── upload_file ────────────────────────────────────────────────────────────

describe('upload_file', () => {
  let tmpFilePath: string

  beforeEach(() => {
    const suffix = randomBytes(8).toString('hex')
    tmpFilePath = join(tmpdir(), `upload-test-${suffix}.txt`)
    writeFileSync(tmpFilePath, 'hello world', 'utf-8')
  })

  afterEach(() => {
    try { unlinkSync(tmpFilePath) } catch { /* ignore */ }
  })

  it('completes 3-step upload and returns file info', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const S3_URL = 'https://s3.example.com/upload'
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
        HttpResponse.json({
          upload_url: S3_URL,
          upload_params: { key: 'abc123', token: 'xyz' },
        }, { status: 200 })
      ),
      http.post(S3_URL, () =>
        HttpResponse.json({
          id: 2001,
          display_name: 'test-file.txt',
          filename: 'test-file.txt',
          size: 11,
          content_type: 'text/plain',
          folder_id: 50,
        }, { status: 201 })
      )
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'upload_file',
        arguments: { file_path: tmpFilePath },
      })
    )
    expect(data.id).toBe(2001)
    expect(data.content_type).toBe('text/plain')
    expect(data.size).toBe(11)
  })

  it('returns error when file does not exist', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'upload_file',
      arguments: { file_path: '/nonexistent/path/file.txt' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('File not found')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'upload_file',
      arguments: { file_path: tmpFilePath },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── create_rubric ──────────────────────────────────────────────────────────

describe('create_rubric', () => {
  it('converts criteria to numeric-keyed format and returns rubric', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({
          rubric: { id: 3001, title: 'Grading Rubric', points_possible: 10, context_type: 'Course' },
          rubric_association: { id: 4001, rubric_id: 3001, association_id: 501, association_type: 'Assignment', use_for_grading: true, purpose: 'grading' },
        }, { status: 200 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_rubric',
        arguments: {
          title: 'Grading Rubric',
          assignment_id: 501,
          criteria: [
            {
              description: 'Quality',
              points: 10,
              ratings: [
                { description: 'Excellent', points: 10 },
                { description: 'Poor', points: 0 },
              ],
            },
          ],
        },
      })
    )
    expect(data.id).toBe(3001)
    expect(data.title).toBe('Grading Rubric')
    expect(data.association_id).toBe(4001)
    expect(data.assignment_id).toBe(501)
    expect(data.use_for_grading).toBe(true)
    // Verify numeric-keyed format was sent
    const body = capturedBody as { rubric: { criteria: Record<string, unknown> }; rubric_association: { association_id: number } }
    expect(body.rubric.criteria['0']).toBeDefined()
    const crit = body.rubric.criteria['0'] as { ratings: Record<string, unknown> }
    expect(crit.ratings['0']).toBeDefined()
    expect(crit.ratings['1']).toBeDefined()
    expect(body.rubric_association.association_id).toBe(501)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'create_rubric',
      arguments: {
        title: 'Test',
        assignment_id: 501,
        criteria: [{ description: 'X', points: 5, ratings: [{ description: 'OK', points: 5 }] }],
      },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── associate_rubric ────────────────────────────────────────────────────────

describe('associate_rubric', () => {
  it('associates rubric with assignment and returns association fields', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubric_associations`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({
          rubric_association: {
            id: 4001,
            rubric_id: 3001,
            association_id: 501,
            association_type: 'Assignment',
            use_for_grading: true,
            purpose: 'grading',
          },
        }, { status: 200 })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'associate_rubric',
        arguments: { rubric_id: 3001, assignment_id: 501 },
      })
    )
    expect(data.id).toBe(4001)
    expect(data.rubric_id).toBe(3001)
    expect(data.association_id).toBe(501)
    expect(data.association_type).toBe('Assignment')
    expect(data.use_for_grading).toBe(true)
    const body = capturedBody as { rubric_association: Record<string, unknown> }
    expect(body.rubric_association.rubric_id).toBe(3001)
    expect(body.rubric_association.association_id).toBe(501)
    expect(body.rubric_association.association_type).toBe('Assignment')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'associate_rubric',
      arguments: { rubric_id: 3001 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})

// ─── update_syllabus ────────────────────────────────────────────────────────

describe('update_syllabus', () => {
  it('sends syllabus_body in course update and returns updated=true', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    let capturedBody: Record<string, unknown> = {}
    mswServer.use(
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ id: COURSE_ID, name: 'Test', course_code: 'T', workflow_state: 'available' })
      })
    )
    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_syllabus',
        arguments: { body: '<h1>Course Syllabus</h1>' },
      })
    )
    expect(data.updated).toBe(true)
    expect(data.course_id).toBe(COURSE_ID)
    const body = capturedBody as { course: { syllabus_body: string } }
    expect(body.course.syllabus_body).toBe('<h1>Course Syllabus</h1>')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'update_syllabus',
      arguments: { body: '<p>test</p>' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No active course')
  })
})
