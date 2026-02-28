import { describe, it, expect } from 'vitest'
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
import { registerResetTools } from '../../../src/tools/reset.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1
const COURSE_NAME = 'Test Sandbox Course'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_COURSE = {
  id: COURSE_ID,
  name: COURSE_NAME,
  course_code: 'TEST-001',
  workflow_state: 'available',
}

const MOCK_MODULES = [
  { id: 10, name: 'Week 1 Module' },
  { id: 11, name: 'Week 2 Module' },
]

const MOCK_ASSIGNMENTS = [
  { id: 501, name: 'Assignment 1' },
  { id: 502, name: 'Assignment 2' },
]

const MOCK_QUIZZES = [
  { id: 601, title: 'Quiz 1' },
]

const MOCK_PAGES = [
  { page_id: 701, url: 'week-1-overview', title: 'Week 1 Overview', front_page: false },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-reset-test-${suffix}`, 'config.json')
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
    assignmentDescriptionTemplate: { default: '', solution: '' },
    exitCardTemplate: { title: 'Exit Card', quizType: 'graded_survey', questions: [] },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(base), 'utf-8')
}

async function makeTestClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerResetTools(mcpServer, canvasClient, configManager)

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

function getText(result: Awaited<ReturnType<Client['callTool']>>) {
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

// ─── Shared MSW handler helpers ───────────────────────────────────────────────

function registerPreviewHandlers() {
  mswServer.use(
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
      HttpResponse.json(MOCK_COURSE)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
      HttpResponse.json(MOCK_MODULES)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
      HttpResponse.json(MOCK_ASSIGNMENTS)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
      HttpResponse.json(MOCK_QUIZZES)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
      HttpResponse.json(MOCK_PAGES)
    ),
  )
}

// ─── preview_course_reset ─────────────────────────────────────────────────────

describe('preview_course_reset', () => {
  it('returns counts of all content without modifying anything', async () => {
    registerPreviewHandlers()
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(data.course.id).toBe(COURSE_ID)
    expect(data.course.name).toBe(COURSE_NAME)
    expect(data.would_delete.modules).toBe(2)
    expect(data.would_delete.assignments).toBe(2)
    expect(data.would_delete.quizzes).toBe(1)
    expect(data.would_delete.pages).toBe(1)
    expect(data.preserves.enrollments).toBe('not touched')
    expect(data.preserves.files).toBe('not touched')
  })

  it('includes warning with exact course name for confirmation', async () => {
    registerPreviewHandlers()
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(data.warning).toContain(COURSE_NAME)
    expect(data.warning).toContain('confirmation_text')
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)

    const text = getText(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(text).toContain('No active course')
  })
})

// ─── reset_course ─────────────────────────────────────────────────────

describe('reset_course', () => {
  it('rejects wrong confirmation text without making any deletions', async () => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      )
    )
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: 'wrong name' },
      })
    )

    expect(text).toContain('does not match')
    expect(text).toContain(COURSE_NAME)
    expect(text).toContain('No changes were made')
  })

  it('deletes all content when confirmation text matches course name', async () => {
    const deletedModules: number[] = []
    const deletedAssignments: number[] = []
    const deletedQuizzes: number[] = []
    const deletedPages: string[] = []

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json(MOCK_MODULES)
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/:id`, ({ params }) => {
        deletedModules.push(Number(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json(MOCK_ASSIGNMENTS)
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/:id`, ({ params }) => {
        deletedAssignments.push(Number(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json(MOCK_QUIZZES)
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/:id`, ({ params }) => {
        deletedQuizzes.push(Number(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json(MOCK_PAGES)
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/:slug`, ({ params }) => {
        deletedPages.push(params.slug as string)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: COURSE_NAME },
      })
    )

    expect(data.course.id).toBe(COURSE_ID)
    expect(data.deleted.modules).toBe(2)
    expect(data.deleted.assignments).toBe(2)
    expect(data.deleted.quizzes).toBe(1)
    expect(data.deleted.pages).toBe(1)
    expect(deletedModules).toEqual([10, 11])
    expect(deletedAssignments).toEqual([501, 502])
    expect(deletedQuizzes).toEqual([601])
    expect(deletedPages).toEqual(['week-1-overview'])
  })

  it('includes sandbox_warning when course name does not contain "sandbox"', async () => {
    const nonSandboxCourse = { ...MOCK_COURSE, name: 'Production Course' }

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(nonSandboxCourse)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
    )

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: 'Production Course' },
      })
    )

    expect(data.sandbox_warning).toBeDefined()
    expect(data.sandbox_warning).toContain('Production Course')
  })

  it('does not include sandbox_warning when course name contains "sandbox"', async () => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)  // COURSE_NAME = 'Test Sandbox Course'
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
    )

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: COURSE_NAME },
      })
    )

    expect(data.sandbox_warning).toBeUndefined()
  })

  it('unsets front page designation before deleting', async () => {
    const frontPage = { page_id: 702, url: 'home', title: 'Home', front_page: true }
    const unsetRequests: string[] = []

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([frontPage])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/home`, async ({ request }) => {
        const body = await request.json() as { wiki_page: Record<string, unknown> }
        if (body.wiki_page.front_page === false) unsetRequests.push('home')
        return HttpResponse.json({ ...frontPage, front_page: false })
      }),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/home`, () =>
        new HttpResponse(null, { status: 204 })
      ),
    )

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: COURSE_NAME },
      })
    )

    expect(unsetRequests).toContain('home')
    expect(data.deleted.pages).toBe(1)
  })

  it('returns error when no active course is set', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const { mcpClient } = await makeTestClient(configPath)

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: COURSE_NAME },
      })
    )

    expect(text).toContain('No active course')
  })
})
