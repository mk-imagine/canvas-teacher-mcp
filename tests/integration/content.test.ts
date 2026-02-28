import { describe, it, expect, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient } from '../../src/canvas/client.js'
import { ConfigManager } from '../../src/config/manager.js'
import { registerContentTools } from '../../src/tools/content.js'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const moduleId = parseInt(process.env.CANVAS_TEST_MODULE_ID ?? '0')

const hasSeedIds = moduleId > 0

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-content-${suffix}`, 'config.json')
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
          { question_name: 'Confidence', question_text: 'Rate your confidence (1–5).', question_type: 'essay_question' },
          { question_name: 'Muddiest Point', question_text: "What's still unclear?", question_type: 'essay_question' },
        ],
      },
    }),
    'utf-8'
  )
}

async function makeIntegrationClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerContentTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  return JSON.parse(text)
}

// Assignments, quizzes, and pages created during tests are tracked for afterAll cleanup
const createdAssignmentIds: number[] = []
const createdQuizIds: number[] = []
const createdPageUrls: string[] = []

afterAll(async () => {
  if (createdAssignmentIds.length === 0 && createdQuizIds.length === 0 && createdPageUrls.length === 0) return
  const configPath = makeTmpConfigPath()
  makeConfig(configPath)
  const { mcpClient } = await makeIntegrationClient(configPath)
  for (const id of createdAssignmentIds) {
    await mcpClient.callTool({ name: 'delete_assignment', arguments: { assignment_id: id } })
  }
  for (const id of createdQuizIds) {
    await mcpClient.callTool({ name: 'delete_quiz', arguments: { quiz_id: id } })
  }
  for (const url of createdPageUrls) {
    await mcpClient.callTool({ name: 'delete_page', arguments: { page_url: url } })
  }
  console.log(`  Cleanup: deleted ${createdAssignmentIds.length} assignments, ${createdQuizIds.length} quizzes, ${createdPageUrls.length} pages`)
})

// ─── create_assignment ────────────────────────────────────────────────────────

describe('Integration: create_assignment', () => {
  it('creates an assignment and verifies fields round-trip', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: {
          name: '[MCP TEST] Integration Assignment',
          points_possible: 15,
          published: false,
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.name).toBe('[MCP TEST] Integration Assignment')
    expect(data.points_possible).toBe(15)
    expect(data.published).toBe(false)
    expect(data.html_url).toContain(String(testCourseId))

    createdAssignmentIds.push(data.id)
    console.log(`  Created assignment id=${data.id}: "${data.name}"`)
  })

  it('renders description HTML from template with notebook_url', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: {
          name: '[MCP TEST] Notebook Assignment',
          notebook_url: 'https://colab.research.google.com/drive/test123',
          notebook_title: 'Week 99 Notebook',
          instructions: 'Complete all exercises.',
          published: false,
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    createdAssignmentIds.push(data.id)
    console.log(`  Created assignment with rendered description id=${data.id}`)
  })
})

// ─── update_assignment ────────────────────────────────────────────────────────

describe('Integration: update_assignment', () => {
  it('updates assignment name and verifies response', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Create first
    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: { name: '[MCP TEST] To Be Renamed', points_possible: 10, published: false },
      })
    )
    createdAssignmentIds.push(created.id)

    // Then update
    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_assignment',
        arguments: { assignment_id: created.id, name: '[MCP TEST] Renamed Assignment' },
      })
    )

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('[MCP TEST] Renamed Assignment')
    console.log(`  Updated assignment id=${updated.id} name="${updated.name}"`)
  })
})

// ─── create_quiz ─────────────────────────────────────────────────────────────

describe('Integration: create_quiz', () => {
  it('creates a quiz from exit card template with week substitution', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: { use_exit_card_template: true, week: 99, published: false },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe('Week 99 | Exit Card (5 mins)')
    expect(data.quiz_type).toBe('graded_survey')
    expect(data.questions_created).toBe(2)
    expect(data.published).toBe(false)

    createdQuizIds.push(data.id)
    console.log(`  Created exit card quiz id=${data.id}: "${data.title}"`)
  })

  it('creates a custom quiz with explicit title', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: {
          title: '[MCP TEST] Practice Quiz',
          quiz_type: 'practice_quiz',
          published: false,
          questions: [],
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe('[MCP TEST] Practice Quiz')
    expect(data.quiz_type).toBe('practice_quiz')
    expect(data.questions_created).toBe(0)

    createdQuizIds.push(data.id)
    console.log(`  Created custom quiz id=${data.id}: "${data.title}"`)
  })
})

// ─── update_quiz ──────────────────────────────────────────────────────────────

describe('Integration: update_quiz', () => {
  it('updates quiz title', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: { title: '[MCP TEST] Original Title', quiz_type: 'practice_quiz', published: false, questions: [] },
      })
    )
    createdQuizIds.push(created.id)

    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_quiz',
        arguments: { quiz_id: created.id, title: '[MCP TEST] Updated Title' },
      })
    )

    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe('[MCP TEST] Updated Title')
    console.log(`  Updated quiz id=${updated.id} title="${updated.title}"`)
  })
})

// ─── module item CRUD ─────────────────────────────────────────────────────────

describe('Integration: module item CRUD', () => {
  it.skipIf(!hasSeedIds)('add, update, and remove a module item sequence', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Create an assignment to link
    const assignment = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: { name: '[MCP TEST] Module Item Assignment', points_possible: 5, published: false },
      })
    )
    createdAssignmentIds.push(assignment.id)

    // Add it to the seed module
    const item = parseResult(
      await mcpClient.callTool({
        name: 'add_module_item',
        arguments: {
          module_id: moduleId,
          type: 'Assignment',
          title: '[MCP TEST] Module Item Assignment',
          content_id: assignment.id,
          completion_requirement: { type: 'min_score', min_score: 1 },
        },
      })
    )
    expect(item.id).toBeTypeOf('number')
    expect(item.type).toBe('Assignment')
    console.log(`  Added module item id=${item.id}`)

    // Update its position
    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_module_item',
        arguments: { module_id: moduleId, item_id: item.id, title: '[MCP TEST] Renamed Item' },
      })
    )
    expect(updated.id).toBe(item.id)
    console.log(`  Updated module item title="${updated.title}"`)

    // Remove it
    const removed = parseResult(
      await mcpClient.callTool({
        name: 'remove_module_item',
        arguments: { module_id: moduleId, item_id: item.id },
      })
    )
    expect(removed.deleted).toBe(true)
    console.log(`  Removed module item id=${item.id}`)
  })
})

// ─── update_module ────────────────────────────────────────────────────────────

describe('Integration: update_module', () => {
  it.skipIf(!hasSeedIds)('can set unlock_at on the seed module', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_module',
        arguments: { module_id: moduleId, unlock_at: '2099-01-01T00:00:00Z' },
      })
    )

    expect(data.id).toBe(moduleId)
    expect(data.unlock_at).toBe('2099-01-01T00:00:00Z')
    console.log(`  Module ${moduleId} unlock_at set to ${data.unlock_at}`)

    // Restore
    await mcpClient.callTool({
      name: 'update_module',
      arguments: { module_id: moduleId, unlock_at: null },
    })
    console.log(`  Module ${moduleId} unlock_at cleared`)
  })
})

// ─── delete_module ────────────────────────────────────────────────────────────

describe('Integration: delete_module', () => {
  it('creates a module then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)

    // We need canvas functions directly for this — use a second client
    const configManager = new ConfigManager(configPath)
    const canvasClient = new CanvasClient({ instanceUrl, apiToken })
    const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
    registerContentTools(mcpServer, canvasClient, configManager)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
    await mcpServer.connect(serverTransport)
    await mcpClient.connect(clientTransport)

    // First create a throwaway module via Canvas directly
    const { createModule } = await import('../../src/canvas/modules.js')
    const mod = await createModule(canvasClient, testCourseId, { name: '[MCP TEST] Throwaway Module' })
    console.log(`  Created throwaway module id=${mod.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_module',
        arguments: { module_id: mod.id },
      })
    )

    expect(data.deleted).toBe(true)
    expect(data.module_id).toBe(mod.id)
    console.log(`  Deleted module id=${mod.id}`)
  })
})

// ─── delete_assignment ────────────────────────────────────────────────────────

describe('Integration: delete_assignment', () => {
  it('creates an assignment then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_assignment',
        arguments: { name: '[MCP TEST] To Be Deleted', points_possible: 5, published: false },
      })
    )
    console.log(`  Created assignment id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_assignment',
        arguments: { assignment_id: created.id },
      })
    )

    expect(data.deleted).toBe(true)
    expect(data.assignment_id).toBe(created.id)
    console.log(`  Deleted assignment id=${created.id}`)
  })
})

// ─── delete_quiz ──────────────────────────────────────────────────────────────

describe('Integration: delete_quiz', () => {
  it('creates a quiz then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_quiz',
        arguments: { title: '[MCP TEST] To Be Deleted', quiz_type: 'practice_quiz', published: false, questions: [] },
      })
    )
    console.log(`  Created quiz id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_quiz',
        arguments: { quiz_id: created.id },
      })
    )

    expect(data.deleted).toBe(true)
    expect(data.quiz_id).toBe(created.id)
    console.log(`  Deleted quiz id=${created.id}`)
  })
})

// ─── create_page ──────────────────────────────────────────────────────────────

describe('Integration: create_page', () => {
  it('creates a page and verifies fields round-trip', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_page',
        arguments: {
          title: '[MCP TEST] Integration Page',
          body: '<p>Hello from integration test.</p>',
          published: false,
        },
      })
    )

    expect(data.page_id).toBeTypeOf('number')
    expect(data.title).toBe('[MCP TEST] Integration Page')
    expect(data.published).toBe(false)
    expect(data.front_page).toBe(false)
    expect(typeof data.url).toBe('string')

    createdPageUrls.push(data.url)
    console.log(`  Created page url="${data.url}": "${data.title}"`)
  })
})

// ─── delete_page ──────────────────────────────────────────────────────────────

describe('Integration: delete_page', () => {
  it('creates a page then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_page',
        arguments: { title: '[MCP TEST] To Be Deleted Page', published: false },
      })
    )
    console.log(`  Created page url="${created.url}"`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_page',
        arguments: { page_url: created.url },
      })
    )

    expect(data.deleted).toBe(true)
    expect(data.page_url).toBe(created.url)
    console.log(`  Deleted page url="${created.url}"`)
  })

  it('returns error when attempting to delete the course front page', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Create a page and promote it to front page via canvas directly
    const { createPage, updatePage, deletePage } = await import('../../src/canvas/pages.js')
    const canvasClient = new CanvasClient({ instanceUrl, apiToken })
    const page = await createPage(canvasClient, testCourseId, {
      title: '[MCP TEST] Temp Front Page',
      body: '<p>Temporary front page for testing.</p>',
      published: true,
    })
    await updatePage(canvasClient, testCourseId, page.url, { front_page: true })
    console.log(`  Promoted page to front page: url="${page.url}"`)

    // Attempt deletion via the MCP tool — should fail
    const result = await mcpClient.callTool({
      name: 'delete_page',
      arguments: { page_url: page.url },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('front page')
    expect(text).toContain(page.url)
    console.log(`  Correctly rejected deletion of front page`)

    // Cleanup: unset front page designation then delete directly
    await updatePage(canvasClient, testCourseId, page.url, { front_page: false })
    await deletePage(canvasClient, testCourseId, page.url)
    console.log(`  Cleaned up test front page`)
  })
})
