import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient } from '../../src/canvas/client.js'
import { ConfigManager } from '../../src/config/manager.js'
import { registerResetTools } from '../../src/tools/reset.js'
import { registerContentTools } from '../../src/tools/content.js'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)

// Reseed after destructive tests so future runs have consistent state.
// Runs after ALL tests in this file complete (pass or fail).
afterAll(() => {
  try {
    console.log('\n  Reseeding test course after reset...')
    execSync('npm run seed', { stdio: 'inherit', timeout: 300_000 })
  } catch (err) {
    console.warn('\n  Warning: reseed failed after reset —', (err as Error).message)
    console.warn('  Run "npm run seed" manually to restore the test course.')
  }
})

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-reset-${suffix}`, 'config.json')
}

function makeConfig(configPath: string) {
  const dir = configPath.substring(0, configPath.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    configPath,
    JSON.stringify({
      canvas: { instanceUrl, apiToken },
      program: { activeCourseId: testCourseId, courseCodes: [], courseCache: {} },
      defaults: {
        assignmentGroup: 'Assignments',
        submissionType: 'online_url',
        pointsPossible: 10,
        completionRequirement: 'min_score',
        minScore: 1,
        exitCardPoints: 0.5,
      },
      assignmentDescriptionTemplate: { default: '<p>{{instructions}}</p>', solution: '' },
      exitCardTemplate: { title: 'Week {{week}} | Exit Card (5 mins)', quizType: 'graded_survey', questions: [] },
    }),
    'utf-8'
  )
}

async function makeClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerResetTools(mcpServer, canvasClient, configManager)
  registerContentTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
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

// ─── Setup: create test content before reset tests ────────────────────────────

let sharedConfigPath: string
let tmpFilePath: string

beforeAll(async () => {
  sharedConfigPath = makeTmpConfigPath()
  makeConfig(sharedConfigPath)
  const { mcpClient } = await makeClient(sharedConfigPath)

  // Create a discussion
  await mcpClient.callTool({
    name: 'create_discussion',
    arguments: { title: '[RESET TEST] Discussion', published: false },
  })
  console.log('  Setup: created discussion')

  // Create an announcement
  await mcpClient.callTool({
    name: 'create_announcement',
    arguments: { title: '[RESET TEST] Announcement', message: '<p>Test</p>' },
  })
  console.log('  Setup: created announcement')

  // Upload a file
  const suffix = randomBytes(4).toString('hex')
  tmpFilePath = join(tmpdir(), `reset-test-${suffix}.txt`)
  writeFileSync(tmpFilePath, 'Reset test file content', 'utf-8')
  await mcpClient.callTool({
    name: 'upload_file',
    arguments: { file_path: tmpFilePath },
  })
  console.log('  Setup: uploaded file')
  try { unlinkSync(tmpFilePath) } catch { /* ignore */ }

  // Create an assignment to host the rubric (rubrics must be assignment-associated at creation)
  const rubricAssignment = parseResult(
    await mcpClient.callTool({
      name: 'create_assignment',
      arguments: { name: '[RESET TEST] Rubric Host Assignment', points_possible: 5, published: false },
    })
  )
  console.log(`  Setup: created rubric host assignment id=${rubricAssignment.id}`)

  // Create a rubric linked to the assignment
  await mcpClient.callTool({
    name: 'create_rubric',
    arguments: {
      title: '[RESET TEST] Rubric',
      assignment_id: rubricAssignment.id,
      criteria: [
        {
          description: 'Quality',
          points: 5,
          ratings: [
            { description: 'Good', points: 5 },
            { description: 'Poor', points: 0 },
          ],
        },
      ],
    },
  })
  console.log('  Setup: created rubric')

  // Set syllabus
  await mcpClient.callTool({
    name: 'update_syllabus',
    arguments: { body: '<h1>[RESET TEST] Syllabus</h1>' },
  })
  console.log('  Setup: set syllabus body')
})

// ─── preview_course_reset (read-only) ─────────────────────────────────────────

describe('preview_course_reset', () => {
  it('returns course info, would_delete counts, and a confirmation token', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(data.course.id).toBe(testCourseId)
    expect(typeof data.course.name).toBe('string')
    expect(typeof data.would_delete.modules).toBe('number')
    expect(typeof data.would_delete.assignments).toBe('number')
    expect(typeof data.would_delete.quizzes).toBe('number')
    expect(typeof data.would_delete.pages).toBe('number')
    expect(data.would_delete.discussions).toBeGreaterThanOrEqual(1)
    expect(data.would_delete.announcements).toBeGreaterThanOrEqual(1)
    expect(data.would_delete.files).toBeGreaterThanOrEqual(1)
    expect(data.would_delete.rubrics).toBeGreaterThanOrEqual(1)
    expect(data.would_delete.assignment_groups).toBeGreaterThanOrEqual(1)
    expect(data.would_clear.syllabus).toBe(true)
    expect(data.preserves.enrollments).toBe('not touched')
    expect(typeof data.confirmation_token).toBe('string')
    expect(data.confirmation_token).toHaveLength(6)
    expect(data.instructions).toContain('Do NOT call reset_course automatically')
  })
})

// ─── reset_course (destructive — reseeded in afterAll) ────────────────────────

describe('reset_course', () => {
  it('rejects an invalid token without deleting anything', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    const preview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_token: 'BADTOK' },
      })
    )

    expect(text).toContain('Invalid confirmation token')

    // Verify nothing was deleted — the valid token from preview is still usable
    const postPreview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    expect(postPreview.would_delete.assignments).toBe(preview.would_delete.assignments)
  })

  it('deletes all content including new types and returns counts', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // Explicitly create a front page so the reset exercises the auto-unset code path
    const { createPage, updatePage } = await import('../../src/canvas/pages.js')
    const canvasClient = new CanvasClient({ instanceUrl, apiToken })
    const frontPage = await createPage(canvasClient, testCourseId, {
      title: '[MCP TEST] Front Page for Reset',
      body: '<p>This should be auto-unset and deleted by reset_course.</p>',
      published: true,
    })
    await updatePage(canvasClient, testCourseId, frontPage.url, { front_page: true })
    console.log(`  Created front page url="${frontPage.url}" — reset must unset it before deleting`)

    const preview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    const token = preview.confirmation_token as string

    expect(preview.would_delete.assignments).toBeGreaterThan(0)
    expect(preview.would_delete.pages).toBeGreaterThan(0) // at least our front page

    const resetResult = await mcpClient.callTool({
      name: 'reset_course',
      arguments: { confirmation_token: token },
    })
    const resetText = (resetResult.content as Array<{ type: string; text: string }>)[0].text
    let result: Record<string, unknown>
    try {
      result = JSON.parse(resetText)
    } catch {
      throw new Error(`reset_course returned non-JSON: ${resetText}`)
    }

    expect(result.course).toBeDefined()
    const course = result.course as { id: number }
    expect(course.id).toBe(testCourseId)
    const deleted = result.deleted as Record<string, unknown>
    expect(deleted.assignments).toBeGreaterThan(0)
    expect(deleted.modules).toBeGreaterThanOrEqual(0)
    expect(deleted.quizzes).toBeGreaterThanOrEqual(0)
    expect(deleted.pages).toBeGreaterThan(0)
    expect(deleted.discussions).toBeGreaterThanOrEqual(0)
    expect(deleted.files).toBeGreaterThanOrEqual(0)
    expect(deleted.rubrics).toBeGreaterThanOrEqual(0)
    expect(deleted.syllabus_cleared).toBe(true)
    const zombieRubrics = (deleted.rubrics_failed as number[]) ?? []
    if (zombieRubrics.length > 0) {
      console.warn(`  Warning: ${zombieRubrics.length} zombie rubric(s) not deleted by Canvas: [${zombieRubrics.join(', ')}]`)
    }

    // Course should now be empty (zombie rubrics that Canvas cannot delete are excluded)
    const postPreview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    expect(postPreview.would_delete.modules).toBe(0)
    expect(postPreview.would_delete.assignments).toBe(0)
    expect(postPreview.would_delete.quizzes).toBe(0)
    expect(postPreview.would_delete.pages).toBe(0)
    expect(postPreview.would_delete.discussions).toBe(0)
    expect(postPreview.would_delete.announcements).toBe(0)
    expect(postPreview.would_delete.files).toBe(0)
    expect(postPreview.would_delete.rubrics).toBe(zombieRubrics.length)
    // assignment_groups may be 1 — Canvas keeps at least one group
  })
})
