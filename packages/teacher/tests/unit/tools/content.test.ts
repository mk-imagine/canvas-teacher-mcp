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
import { CanvasClient, ConfigManager } from '@canvas-mcp/core'
import { registerContentTools } from '../../../src/tools/content.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

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

// ─── delete_file ────────────────────────────────────────────────────────────

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
