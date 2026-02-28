import { describe, it, expect, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient } from '../../src/canvas/client.js'
import { ConfigManager } from '../../src/config/manager.js'
import { registerResetTools } from '../../src/tools/reset.js'

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

async function makeResetClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerResetTools(mcpServer, canvasClient, configManager)

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

// ─── preview_course_reset (read-only) ─────────────────────────────────────────

describe('preview_course_reset', () => {
  it('returns course info and would_delete counts', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeResetClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )

    expect(data.course.id).toBe(testCourseId)
    expect(typeof data.course.name).toBe('string')
    expect(typeof data.would_delete.modules).toBe('number')
    expect(typeof data.would_delete.assignments).toBe('number')
    expect(typeof data.would_delete.quizzes).toBe('number')
    expect(typeof data.would_delete.pages).toBe('number')
    expect(data.preserves.enrollments).toBe('not touched')
    expect(data.preserves.files).toBe('not touched')
    expect(data.warning).toContain(data.course.name)
  })
})

// ─── reset_course (destructive — reseeded in afterAll) ────────────────────────

describe('reset_course', () => {
  it('rejects wrong confirmation text without deleting anything', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeResetClient(configPath)

    const preview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    const courseName = preview.course.name as string

    const text = getText(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: 'definitely wrong name 12345' },
      })
    )

    expect(text).toContain('does not match')
    expect(text).toContain(courseName)
    expect(text).toContain('No changes were made')

    // Verify nothing was deleted
    const postPreview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    expect(postPreview.would_delete.assignments).toBe(preview.would_delete.assignments)
  })

  it('deletes all content and returns counts, including front page auto-unset', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeResetClient(configPath)

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
    const courseName = preview.course.name as string

    expect(preview.would_delete.assignments).toBeGreaterThan(0)
    expect(preview.would_delete.pages).toBeGreaterThan(0) // at least our front page

    const result = parseResult(
      await mcpClient.callTool({
        name: 'reset_course',
        arguments: { confirmation_text: courseName },
      })
    )

    expect(result.course.id).toBe(testCourseId)
    // Note: deleted.quizzes will be less than preview.would_delete.quizzes because
    // quizzes are also assignments — deleting assignments in step 2 already removes
    // quiz-backed assignments, so the quiz delete step (step 3) hits mostly 404s.
    expect(result.deleted.assignments).toBeGreaterThan(0)
    expect(result.deleted.modules).toBeGreaterThanOrEqual(0)
    expect(result.deleted.quizzes).toBeGreaterThanOrEqual(0)
    expect(result.deleted.pages).toBeGreaterThan(0) // at least our front page was deleted

    // Course should now be empty
    const postPreview = parseResult(
      await mcpClient.callTool({ name: 'preview_course_reset', arguments: {} })
    )
    expect(postPreview.would_delete.modules).toBe(0)
    expect(postPreview.would_delete.assignments).toBe(0)
    expect(postPreview.would_delete.quizzes).toBe(0)
    expect(postPreview.would_delete.pages).toBe(0)
  })
})
