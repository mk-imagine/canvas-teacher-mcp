import { describe, it, expect, vi } from 'vitest'
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
  { id: 501, name: 'Assignment 1', rubric_settings: { id: 1001, points_possible: 10 } },
  { id: 502, name: 'Assignment 2' },
]

const MOCK_QUIZZES = [
  { id: 601, title: 'Quiz 1' },
]

const MOCK_PAGES = [
  { page_id: 701, url: 'week-1-overview', title: 'Week 1 Overview', front_page: false },
]

const MOCK_DISCUSSIONS = [
  { id: 801, title: 'Discussion 1', message: 'Hello', is_announcement: false, published: true, assignment_id: null },
  { id: 802, title: 'Announcement 1', message: 'News', is_announcement: true, published: true, assignment_id: null },
]

const MOCK_FILES = [
  { id: 901, display_name: 'file1.pdf', filename: 'file1.pdf', size: 1024, content_type: 'application/pdf', folder_id: 1 },
]

const MOCK_RUBRICS = [
  { id: 1002, title: 'Unassociated Rubric', points_possible: 5, context_type: 'Course' },
]

const MOCK_ASSIGNMENT_GROUPS = [
  { id: 100, name: 'Assignments', position: 1, group_weight: 0 },
  { id: 101, name: 'Quizzes', position: 2, group_weight: 0 },
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

/** Register minimal GET handlers and call preview_course_reset to obtain a valid token. */
async function getTokenFromPreview(
  mcpClient: Client,
  courseOverride?: object
): Promise<string> {
  mswServer.use(
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
      HttpResponse.json(courseOverride ?? MOCK_COURSE)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () => HttpResponse.json([])),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () => HttpResponse.json([])),
  )
  const data = parseResult(
    await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
  )
  return data.confirmation_token as string
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
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, ({ request }) => {
      const url = new URL(request.url)
      if (url.searchParams.get('only_announcements') === 'true') {
        return HttpResponse.json(MOCK_DISCUSSIONS.filter((d) => d.is_announcement))
      }
      return HttpResponse.json(MOCK_DISCUSSIONS.filter((d) => !d.is_announcement))
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
      HttpResponse.json(MOCK_FILES)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
      HttpResponse.json(MOCK_RUBRICS)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
      HttpResponse.json(MOCK_ASSIGNMENT_GROUPS)
    ),
  )
}

function registerResetHandlers(trackers: {
  deletedModules: number[]
  deletedAssignments: number[]
  deletedQuizzes: number[]
  deletedDiscussions: number[]
  deletedPages: string[]
  deletedFiles: number[]
  deletedRubrics: number[]
  deletedAssignmentGroups: number[]
  syllabusCleared: boolean[]
}) {
  mswServer.use(
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
      HttpResponse.json(MOCK_COURSE)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
      HttpResponse.json(MOCK_MODULES)
    ),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules/:id`, ({ params }) => {
      trackers.deletedModules.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () =>
      HttpResponse.json(MOCK_ASSIGNMENTS)
    ),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/:id`, ({ params }) => {
      const asgn = MOCK_ASSIGNMENTS.find((a) => a.id === Number(params.id))
      return HttpResponse.json(asgn ?? { id: Number(params.id), name: 'Unknown' })
    }),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments/:id`, ({ params }) => {
      trackers.deletedAssignments.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () =>
      HttpResponse.json(MOCK_QUIZZES)
    ),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes/:id`, ({ params }) => {
      trackers.deletedQuizzes.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, ({ request }) => {
      const url = new URL(request.url)
      if (url.searchParams.get('only_announcements') === 'true') {
        return HttpResponse.json(MOCK_DISCUSSIONS.filter((d) => d.is_announcement))
      }
      return HttpResponse.json(MOCK_DISCUSSIONS.filter((d) => !d.is_announcement))
    }),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/:id`, ({ params }) => {
      trackers.deletedDiscussions.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
      HttpResponse.json(MOCK_PAGES)
    ),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages/:slug`, ({ params }) => {
      trackers.deletedPages.push(params.slug as string)
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
      HttpResponse.json(MOCK_FILES)
    ),
    http.delete(`${CANVAS_URL}/api/v1/files/:id`, ({ params }) => {
      trackers.deletedFiles.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
      HttpResponse.json(MOCK_RUBRICS)
    ),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics/:id`, ({ params }) => {
      trackers.deletedRubrics.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
      HttpResponse.json(MOCK_ASSIGNMENT_GROUPS)
    ),
    http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups/:id`, ({ params }) => {
      trackers.deletedAssignmentGroups.push(Number(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
    http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () => {
      trackers.syllabusCleared.push(true)
      return HttpResponse.json(MOCK_COURSE)
    }),
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
    expect(data.would_delete.discussions).toBe(1)
    expect(data.would_delete.announcements).toBe(1)
    expect(data.would_delete.pages).toBe(1)
    expect(data.would_delete.files).toBe(1)
    expect(data.would_delete.rubrics).toBe(1)
    expect(data.would_delete.assignment_groups).toBe(2)
    expect(data.would_clear.syllabus).toBe(true)
    expect(data.preserves.enrollments).toBe('not touched')
  })

  it('returns a confirmation_token and instructions requiring user approval', async () => {
    registerPreviewHandlers()
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(typeof data.confirmation_token).toBe('string')
    expect(data.confirmation_token).toHaveLength(6)
    expect(data.instructions).toContain(data.confirmation_token)
    expect(data.instructions).toContain('Do NOT call reset_course automatically')
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
  it('rejects invalid token without making any deletions', async () => {
    // Token validation happens before any Canvas API calls — no mocks needed
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: 'BADTOK' },
      })
    )

    expect(text).toContain('Invalid confirmation token')
    expect(text).toContain('BADTOK')
  })

  it('rejects an expired token', async () => {
    registerPreviewHandlers()
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

    // Advance time past the 5-minute expiry
    vi.useFakeTimers()
    vi.advanceTimersByTime(6 * 60 * 1000)

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    vi.useRealTimers()

    expect(text).toContain('expired')
  })

  it('deletes all content when a valid token from preview is supplied', async () => {
    const trackers = {
      deletedModules: [] as number[],
      deletedAssignments: [] as number[],
      deletedQuizzes: [] as number[],
      deletedDiscussions: [] as number[],
      deletedPages: [] as string[],
      deletedFiles: [] as number[],
      deletedRubrics: [] as number[],
      deletedAssignmentGroups: [] as number[],
      syllabusCleared: [] as boolean[],
    }

    registerPreviewHandlers()
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

    registerResetHandlers(trackers)
    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    expect(data.course.id).toBe(COURSE_ID)
    expect(data.deleted.modules).toBe(2)
    expect(data.deleted.assignments).toBe(2)
    expect(data.deleted.quizzes).toBe(1)
    expect(data.deleted.discussions).toBe(2)
    expect(data.deleted.pages).toBe(1)
    expect(data.deleted.files).toBe(1)
    expect(data.deleted.rubrics).toBe(1)
    expect(data.deleted.assignment_groups).toBe(2)
    expect(data.deleted.syllabus_cleared).toBe(true)
    expect(trackers.deletedModules).toEqual([10, 11])
    expect(trackers.deletedAssignments).toEqual([501, 502])
    expect(trackers.deletedQuizzes).toEqual([601])
    expect(trackers.deletedDiscussions).toEqual([801, 802])
    expect(trackers.deletedPages).toEqual(['week-1-overview'])
    expect(trackers.deletedFiles).toEqual([901])
    // Rubric 1001 deleted by deleteAssignment(501), rubric 1002 deleted by sweep
    expect(trackers.deletedRubrics).toEqual(expect.arrayContaining([1001, 1002]))
    expect(trackers.deletedAssignmentGroups).toEqual([100, 101])
    expect(trackers.syllabusCleared).toEqual([true])
  })

  it('token is single-use — second call with same token is rejected', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

    // First use: consume the token (all lists empty → no-op reset)
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () => HttpResponse.json(MOCK_COURSE)),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () => HttpResponse.json([])),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () => HttpResponse.json(MOCK_COURSE)),
    )
    await mcpClient.callTool({ name: 'reset_course', arguments: { confirmation_token: token } })

    // Second use: same token should be rejected
    const text = getText(
      await mcpClient.callTool({ name: 'reset_course', arguments: { confirmation_token: token } })
    )
    expect(text).toContain('Invalid confirmation token')
  })

  it('handles 404 on discussions gracefully (graded discussions already deleted)', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

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
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('only_announcements') === 'true') {
          return HttpResponse.json([])
        }
        return HttpResponse.json([{ id: 803, title: 'Graded Discussion', is_announcement: false, assignment_id: 503 }])
      }),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics/803`, () =>
        new HttpResponse(null, { status: 404 })
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
        HttpResponse.json([])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
    )

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    // Should complete successfully despite the 404
    expect(data.deleted.discussions).toBe(1)
  })

  it('handles assignment group deletion error on last group gracefully', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

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
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
        HttpResponse.json([{ id: 100, name: 'Assignments', position: 1, group_weight: 0 }])
      ),
      http.delete(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups/100`, () =>
        HttpResponse.json({ message: 'cannot delete last assignment group' }, { status: 400 })
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
    )

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    // Should complete successfully — the last group error is swallowed
    expect(data.deleted.assignment_groups).toBe(0)
    expect(data.deleted.syllabus_cleared).toBe(true)
  })

  it('includes sandbox_warning when course name does not contain "sandbox"', async () => {
    const nonSandboxCourse = { ...MOCK_COURSE, name: 'Production Course' }

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    // Token is keyed by courseId — course name doesn't affect token validity
    const token = await getTokenFromPreview(mcpClient)

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(nonSandboxCourse)
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () => HttpResponse.json([])),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(nonSandboxCourse)
      ),
    )

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    expect(data.sandbox_warning).toBeDefined()
    expect(data.sandbox_warning).toContain('Production Course')
  })

  it('does not include sandbox_warning when course name contains "sandbox"', async () => {
    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)  // COURSE_NAME = 'Test Sandbox Course'
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/modules`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignments`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/quizzes`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/pages`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () => HttpResponse.json([])),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () => HttpResponse.json([])),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
    )

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
      })
    )

    expect(data.sandbox_warning).toBeUndefined()
  })

  it('unsets front page designation before deleting', async () => {
    const frontPage = { page_id: 702, url: 'home', title: 'Home', front_page: true }
    const unsetRequests: string[] = []

    const configPath = makeTmpConfigPath()
    writeConfig(configPath)
    const { mcpClient } = await makeTestClient(configPath)

    const token = await getTokenFromPreview(mcpClient)

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
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/discussion_topics`, () =>
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
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/files`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/rubrics`, () =>
        HttpResponse.json([])
      ),
      http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/assignment_groups`, () =>
        HttpResponse.json([])
      ),
      http.put(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}`, () =>
        HttpResponse.json(MOCK_COURSE)
      ),
    )

    const data = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: token },
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
        arguments: { confirmation_token: 'ANYVAL' },
      })
    )

    expect(text).toContain('No active course')
  })
})
