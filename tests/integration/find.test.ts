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
import { SecureStore } from '../../src/security/secure-store.js'
import { registerFindTools } from '../../src/tools/find.js'
import { registerReportingTools } from '../../src/tools/reporting.js'
import { registerContentTools } from '../../src/tools/content.js'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const moduleId = parseInt(process.env.CANVAS_TEST_MODULE_ID ?? '0')
const hasSeedModule = moduleId > 0

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-find-${suffix}`, 'config.json')
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

async function makeClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  const secureStore = new SecureStore()
  registerFindTools(mcpServer, canvasClient, configManager)
  registerReportingTools(mcpServer, canvasClient, configManager, secureStore)
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

// Track items for cleanup
const createdAssignmentIds: number[] = []
const createdPageUrls: string[] = []
const createdModuleItemIds: Array<{ moduleId: number; itemId: number }> = []

afterAll(async () => {
  const hasCleanup = createdAssignmentIds.length + createdPageUrls.length > 0
  if (!hasCleanup) return
  const { deleteAssignment } = await import('../../src/canvas/assignments.js')
  const { deletePage } = await import('../../src/canvas/pages.js')
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  for (const id of createdAssignmentIds) {
    try {
      await deleteAssignment(canvasClient, testCourseId, id)
    } catch {
      console.warn(`  Warning: failed to clean up assignment id=${id}`)
    }
  }
  for (const url of createdPageUrls) {
    try {
      await deletePage(canvasClient, testCourseId, url)
    } catch {
      console.warn(`  Warning: failed to clean up page url=${url}`)
    }
  }
  console.log(`  Cleanup: deleted ${createdAssignmentIds.length} assignments, ${createdPageUrls.length} pages`)
})

// ─── find_item — page ─────────────────────────────────────────────────────────

describe('Integration: find_item — page', () => {
  it('finds a real page by partial title and returns body', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // Create a page first
    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: '[MCP TEST] Find Item Page', body: '<p>Hello world</p>', published: false },
      })
    )
    createdPageUrls.push(created.url)
    console.log(`  Created page url=${created.url}`)

    // Find it by partial title
    const data = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'page', search: 'Find Item Page' },
      })
    )

    expect(data.type).toBe('page')
    expect(data.title).toBe('[MCP TEST] Find Item Page')
    expect(data.body).toBeTruthy()
    expect(data.body).toContain('Hello world')
    expect(data.page_url).toBeTruthy()
    console.log(`  Found page: "${data.title}" at ${data.page_url}`)
  })
})

// ─── update_item — assignment ─────────────────────────────────────────────────

describe('Integration: update_item — assignment', () => {
  it('finds an assignment by name and updates its due date', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // Create an assignment
    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Find Update Assignment', points_possible: 10, published: false },
      })
    )
    createdAssignmentIds.push(created.id)
    console.log(`  Created assignment id=${created.id}`)

    // Update via update_item
    const newDueDate = '2026-12-31T23:59:00Z'
    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'assignment', search: 'Find Update Assignment', due_at: newDueDate },
      })
    )

    expect(updated.due_at).toBe(newDueDate)
    expect(updated.matched_title).toBe('[MCP TEST] Find Update Assignment')
    console.log(`  Updated assignment due_at to ${updated.due_at}`)
  })
})

// ─── delete_item — page ───────────────────────────────────────────────────────

describe('Integration: delete_item — page', () => {
  it('finds a page by title and deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // Create a page
    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: '[MCP TEST] Delete Item Page', body: '<p>To be deleted</p>', published: false },
      })
    )
    console.log(`  Created page url=${created.url}`)

    // Delete via delete_item (don't track for afterAll since we're deleting it here)
    const result = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'page', search: 'Delete Item Page' },
      })
    )

    expect(result.deleted).toBe(true)
    expect(result.matched_title).toBe('[MCP TEST] Delete Item Page')

    // Verify it's gone by checking find_item returns an error
    const findResult = await mcpClient.callTool({
      name: 'find_item',
      arguments: { type: 'page', search: 'Delete Item Page' },
    })
    const text = (findResult.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('No page found matching')
    console.log(`  Verified page is gone after delete_item`)
  })
})

// ─── get_module_summary — module_name ────────────────────────────────────────

describe('Integration: get_module_summary — module_name', () => {
  it.skipIf(!hasSeedModule)('returns module summary by name without module_id', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // First get the module by ID to know its name
    const byId = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_id: moduleId },
      })
    )
    const moduleName: string = byId.module.name
    console.log(`  Seed module name: "${moduleName}"`)

    // Now look it up by partial name
    const partial = moduleName.split(' ').slice(0, 2).join(' ')
    const byName = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_name: partial },
      })
    )

    expect(byName.module.id).toBe(moduleId)
    expect(byName.module.name).toBe(moduleName)
    console.log(`  Looked up module by name "${partial}" → id=${byName.module.id}`)
  })

  it('returns error when neither module_id nor module_name provided', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    const result = await mcpClient.callTool({
      name: 'get_module_summary',
      arguments: {},
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Provide either module_id or module_name')
  })
})

// ─── search_course ────────────────────────────────────────────────────────────

describe('Integration: search_course', () => {
  it('returns semantic search results or gracefully reports unavailability', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    const result = await mcpClient.callTool({
      name: 'search_course',
      arguments: { query: 'python programming', threshold: 1.0 },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    if (text.includes('Smart Search failed')) {
      console.log('  Smart Search not available on this instance — skipped')
      return
    }

    const data = JSON.parse(text)
    expect(data.query).toBe('python programming')
    expect(Array.isArray(data.results)).toBe(true)
    expect(typeof data.total_results).toBe('number')
    console.log(`  Smart Search: ${data.total_results} results, ${data.returned_results} after threshold`)
  })
})

// ─── delete_item — module_item ────────────────────────────────────────────────

describe('Integration: delete_item — module_item', () => {
  it.skipIf(!hasSeedModule)('removes a module item without deleting the underlying page', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeClient(configPath)

    // Get module name first
    const moduleData = parseResult(
      await mcpClient.callTool({
        name: 'get_module_summary',
        arguments: { module_id: moduleId },
      })
    )
    const moduleName: string = moduleData.module.name

    // Create a page to add to the module
    const page = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: '[MCP TEST] Module Item Page', body: '<p>In module</p>', published: false },
      })
    )
    createdPageUrls.push(page.url)
    console.log(`  Created page url=${page.url}`)

    // Add the page to the module using create_item type=module_item
    const addedItem = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'module_item',
          module_name: moduleName,
          item_type: 'Page',
          title: '[MCP TEST] Module Item Page',
          content_id: page.id,
          page_url: page.url,
        },
      })
    )
    console.log(`  Added page as module item id=${addedItem.id}`)

    // Remove via delete_item module_item
    const removed = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: {
          type: 'module_item',
          search: 'Module Item Page',
          module_name: moduleName,
        },
      })
    )

    expect(removed.removed).toBe(true)
    expect(removed.matched_title).toBe('[MCP TEST] Module Item Page')
    console.log(`  Removed module item; page still exists at url=${page.url}`)

    // Verify page still exists via find_item
    const foundPage = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'page', search: 'Module Item Page' },
      })
    )
    expect(foundPage.page_url).toBe(page.url)
    console.log(`  Confirmed page still exists after module item removal`)
  })
})
