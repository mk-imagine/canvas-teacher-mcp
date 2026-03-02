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
import { registerModuleTools } from '../../../src/tools/modules.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeModule(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    name: 'Week 2 | Intro',
    position: 1,
    published: false,
    items_count: 0,
    unlock_at: null,
    prerequisite_module_ids: [],
    require_sequential_progress: false,
    workflow_state: 'unpublished',
    ...overrides,
  }
}

function makeAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    name: 'Week 2 | Coding Assignment | ML (3 Hours)',
    points_possible: 100,
    due_at: '2026-03-01T23:59:00Z',
    html_url: `${CANVAS_URL}/courses/${COURSE_ID}/assignments/501`,
    description: null,
    submission_types: ['online_url'],
    assignment_group_id: null,
    published: false,
    ...overrides,
  }
}

function makeQuiz(overrides: Record<string, unknown> = {}) {
  return {
    id: 601,
    title: 'Week 2 | Exit Card (5 mins)',
    quiz_type: 'graded_survey',
    points_possible: 0.5,
    due_at: null,
    time_limit: null,
    allowed_attempts: 1,
    assignment_group_id: null,
    published: false,
    html_url: `${CANVAS_URL}/courses/${COURSE_ID}/quizzes/601`,
    ...overrides,
  }
}

function makeQuizQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 701,
    quiz_id: 601,
    question_name: 'Confidence',
    question_text: 'Rate your confidence.',
    question_type: 'essay_question',
    points_possible: 0,
    position: 1,
    ...overrides,
  }
}

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    page_id: 801,
    url: 'week-2-overview',
    title: 'Week 2 | Overview',
    body: null,
    published: false,
    ...overrides,
  }
}

function makeModuleItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 201,
    module_id: 10,
    position: 1,
    type: 'SubHeader',
    title: 'OVERVIEW',
    indent: 0,
    completion_requirement: null,
    content_details: {},
    ...overrides,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-modules-test-${suffix}`, 'config.json')
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
  registerModuleTools(mcpServer, canvasClient, configManager)

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

function getText(result: Awaited<ReturnType<Client['callTool']>>) {
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

// ─── build_module template='lesson' ──────────────────────────────────────────

describe('build_module — template="lesson"', () => {
  it('dry_run returns items_preview without Canvas API calls', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'lesson',
          week: 2,
          title: 'Introduction',
          lesson_template: 'later-standard',
          due_date: '2026-03-01T23:59:00Z',
          items: [
            { type: 'coding_assignment', title: 'ML Basics', hours: 3 },
          ],
          dry_run: true,
        },
      })
    )

    expect(data.dry_run).toBe(true)
    expect(Array.isArray(data.items_preview)).toBe(true)
    expect(data.items_preview.length).toBeGreaterThan(0)

    const kinds = data.items_preview.map((i: { kind: string }) => i.kind)
    expect(kinds).toContain('subheader')
    expect(kinds).toContain('page')
    expect(kinds).toContain('assignment')
    expect(kinds).toContain('exit_card_quiz')
  })

  it('later-standard creates module, subheaders, overview page, assignment, exit card quiz', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)

    let createdItemCount = 0
    mswServer.use(
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json(makeModule(), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(makePage(), { status: 200 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json(makeAssignment(), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json(makeQuiz(), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/601/questions`, () =>
        HttpResponse.json(makeQuizQuestion(), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10/items`, () => {
        createdItemCount++
        return HttpResponse.json(makeModuleItem({ id: 200 + createdItemCount }), { status: 201 })
      })
    )

    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'lesson',
          week: 2,
          title: 'Introduction',
          lesson_template: 'later-standard',
          due_date: '2026-03-01T23:59:00Z',
          items: [
            { type: 'coding_assignment', title: 'ML Basics', hours: 3 },
          ],
        },
      })
    )

    expect(data.dry_run).toBe(false)
    expect(data.module.id).toBe(10)
    expect(data.module.name).toBe('Week 2 | Intro')
    expect(Array.isArray(data.items_created)).toBe(true)
    expect(data.items_created.length).toBe(6)
  })

  it('returns toolError when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)

    const result = await mcpClient.callTool({
      name: 'build_module',
      arguments: {
        template: 'lesson',
        week: 2,
        title: 'Test',
        lesson_template: 'later-standard',
        due_date: '2026-03-01T23:59:00Z',
        items: [],
      },
    })
    expect(getText(result)).toContain('No active course')
  })

  it('returns toolError when items do not match template', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const result = await mcpClient.callTool({
      name: 'build_module',
      arguments: {
        template: 'lesson',
        week: 2,
        title: 'Test',
        lesson_template: 'later-standard',
        due_date: '2026-03-01T23:59:00Z',
        items: [{ type: 'review_quiz', title: 'Quiz', hours: 1, attempts: 3 }],
      },
    })
    expect(getText(result)).toContain('not accepted by')
  })
})

// ─── build_module template='solution' ────────────────────────────────────────

describe('build_module — template="solution"', () => {
  it('creates module with prerequisite and ExternalUrl items', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)

    let createdItemCount = 0
    let capturedModuleBody: Record<string, unknown> = {}
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/10`, () =>
        HttpResponse.json(makeModule())
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, async ({ request }) => {
        capturedModuleBody = await request.json() as Record<string, unknown>
        return HttpResponse.json(makeModule({ id: 20, name: 'Week 2 | Solutions', prerequisite_module_ids: [10] }), { status: 201 })
      }),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/20/items`, () => {
        createdItemCount++
        return HttpResponse.json(makeModuleItem({ id: 300 + createdItemCount, module_id: 20 }), { status: 201 })
      })
    )

    const { mcpClient } = await makeTestClient(configPath)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'solution',
          lesson_module_id: 10,
          unlock_at: '2026-03-08T00:00:00Z',
          title: 'Week 2 | Solutions',
          solutions: [
            { title: 'Solution 1', url: 'https://example.com/sol1' },
            { title: 'Solution 2', url: 'https://example.com/sol2' },
          ],
        },
      })
    )

    expect(data.module.id).toBe(20)
    expect(data.items_created.length).toBe(2)
    expect(data.items_created[0].type).toBe('ExternalUrl')
    expect(data.items_created[1].type).toBe('ExternalUrl')

    const modBody = capturedModuleBody as { module: { prerequisite_module_ids: number[]; unlock_at: string } }
    expect(modBody.module.prerequisite_module_ids).toEqual([10])
    expect(modBody.module.unlock_at).toBe('2026-03-08T00:00:00Z')
  })

  it('dry_run returns preview without Canvas calls', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'solution',
          lesson_module_id: 10,
          unlock_at: '2026-03-08T00:00:00Z',
          title: 'Week 2 | Solutions',
          solutions: [{ title: 'Solution 1', url: 'https://example.com/sol1' }],
          dry_run: true,
        },
      })
    )

    expect(data.dry_run).toBe(true)
    expect(data.module_preview).toBeDefined()
    expect(data.items_preview.length).toBe(1)
  })

  it('returns toolError when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)

    const result = await mcpClient.callTool({
      name: 'build_module',
      arguments: {
        template: 'solution',
        lesson_module_id: 10,
        unlock_at: '2026-03-08T00:00:00Z',
        title: 'Test',
        solutions: [],
      },
    })
    expect(getText(result)).toContain('No active course')
  })
})

// ─── build_module template='clone' ───────────────────────────────────────────

describe('build_module — template="clone"', () => {
  const SOURCE_COURSE_ID = 2
  const SOURCE_MODULE_ID = 99

  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${SOURCE_COURSE_ID}/modules/${SOURCE_MODULE_ID}`, () =>
        HttpResponse.json(makeModule({ id: SOURCE_MODULE_ID, name: 'Week 2 | Intro' }))
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${SOURCE_COURSE_ID}/modules/${SOURCE_MODULE_ID}/items`, () =>
        HttpResponse.json([
          makeModuleItem({ id: 1001, type: 'SubHeader', title: 'OVERVIEW' }),
          makeModuleItem({ id: 1002, type: 'Page', title: 'Week 2 | Overview', page_url: 'week-2-overview' }),
          makeModuleItem({ id: 1003, type: 'Assignment', title: 'Week 2 | Coding Assignment | ML (3 Hours)', content_id: 501 }),
        ])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${SOURCE_COURSE_ID}/pages/week-2-overview`, () =>
        HttpResponse.json(makePage({ title: 'Week 2 | Overview', url: 'week-2-overview' }))
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${SOURCE_COURSE_ID}/assignments/501`, () =>
        HttpResponse.json(makeAssignment({ name: 'Week 2 | Coding Assignment | ML (3 Hours)', due_at: '2026-02-01T23:59:00Z' }))
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json(makeModule({ id: 50, name: 'Week 5 | Intro' }), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(makePage({ page_id: 900, url: 'week-5-overview', title: 'Week 5 | Overview' }), { status: 200 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json(makeAssignment({ id: 551, name: 'Week 5 | Coding Assignment | ML (3 Hours)' }), { status: 201 })
      ),
      http.post(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/50/items`, () =>
        HttpResponse.json(makeModuleItem({ id: 2001, module_id: 50 }), { status: 201 })
      )
    )
  })

  it('clones module and substitutes week number in titles', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'clone',
          source_module_id: SOURCE_MODULE_ID,
          source_course_id: SOURCE_COURSE_ID,
          week: 5,
          due_date: '2026-04-01T23:59:00Z',
        },
      })
    )

    expect(data.module.id).toBe(50)
    expect(data.module.name).toBe('Week 5 | Intro')
    expect(Array.isArray(data.items_created)).toBe(true)

    const titles = data.items_created.map((i: { title: string }) => i.title)
    for (const title of titles) {
      expect(title).not.toMatch(/Week (?!5)\d+/)
    }
    const pageItem = data.items_created.find((i: { type: string }) => i.type === 'Page')
    expect(pageItem?.title).toContain('Week 5')
  })

  it('returns toolError when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)

    const result = await mcpClient.callTool({
      name: 'build_module',
      arguments: {
        template: 'clone',
        source_module_id: SOURCE_MODULE_ID,
        source_course_id: SOURCE_COURSE_ID,
      },
    })
    expect(getText(result)).toContain('No active course')
  })
})
