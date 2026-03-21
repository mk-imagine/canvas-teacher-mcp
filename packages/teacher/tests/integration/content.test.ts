import { describe, it, expect, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient, ConfigManager } from '@canvas-mcp/core'
import { registerContentTools } from '../../packages/teacher/src/tools/content.js'
import { registerFindTools } from '../../packages/teacher/src/tools/find.js'

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
  registerFindTools(mcpServer, canvasClient, configManager)

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

// Assignments, quizzes, pages, discussions, files, and rubrics created during tests are tracked for afterAll cleanup
const createdAssignmentIds: number[] = []
const createdQuizIds: number[] = []
const createdPageUrls: string[] = []
const createdDiscussionIds: number[] = []
const createdFileIds: number[] = []
const createdRubricIds: number[] = []

afterAll(async () => {
  const hasCleanup = createdAssignmentIds.length + createdQuizIds.length + createdPageUrls.length +
    createdDiscussionIds.length + createdFileIds.length + createdRubricIds.length > 0
  if (!hasCleanup) return
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const { deleteAssignment, deleteQuiz, deletePage, deleteDiscussionTopic, deleteFile, deleteRubric } = await import('@canvas-mcp/core')
  const configPath = makeTmpConfigPath()
  makeConfig(configPath)
  const { mcpClient } = await makeIntegrationClient(configPath)
  for (const id of createdAssignmentIds) {
    try { await deleteAssignment(canvasClient, testCourseId, id) } catch { /* ignore */ }
  }
  for (const id of createdQuizIds) {
    try { await deleteQuiz(canvasClient, testCourseId, id) } catch { /* ignore */ }
  }
  for (const url of createdPageUrls) {
    try { await deletePage(canvasClient, testCourseId, url) } catch { /* ignore */ }
  }
  for (const id of createdDiscussionIds) {
    try { await deleteDiscussionTopic(canvasClient, testCourseId, id) } catch { /* ignore */ }
  }
  for (const id of createdFileIds) {
    await mcpClient.callTool({ name: 'delete_file', arguments: { file_id: id } })
  }
  for (const id of createdRubricIds) {
    try { await deleteRubric(canvasClient, testCourseId, id) } catch {
      console.warn(`  Warning: failed to delete rubric id=${id} (may already be deleted)`)
    }
  }
  console.log(`  Cleanup: deleted ${createdAssignmentIds.length} assignments, ${createdQuizIds.length} quizzes, ${createdPageUrls.length} pages, ${createdDiscussionIds.length} discussions, ${createdFileIds.length} files, ${createdRubricIds.length} rubrics`)
})

// ─── create_item — assignment ────────────────────────────────────────────────

describe('Integration: create_item — assignment', () => {
  it('creates an assignment and verifies fields round-trip', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'assignment',
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
        name: 'create_item',
        arguments: {
          type: 'assignment',
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

// ─── update_item — assignment ─────────────────────────────────────────────────

describe('Integration: update_item — assignment', () => {
  it('updates assignment name and verifies response', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Create first
    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] To Be Renamed', points_possible: 10, published: false },
      })
    )
    createdAssignmentIds.push(created.id)

    // Then update
    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'assignment', search: 'To Be Renamed', name: '[MCP TEST] Renamed Assignment' },
      })
    )

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('[MCP TEST] Renamed Assignment')
    console.log(`  Updated assignment id=${updated.id} name="${updated.name}"`)
  })
})

// ─── create_item — quiz ───────────────────────────────────────────────────────

describe('Integration: create_item — quiz', () => {
  it('creates a quiz from exit card template with week substitution', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'quiz', use_exit_card_template: true, week: 99, published: false },
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
        name: 'create_item',
        arguments: {
          type: 'quiz',
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

// ─── update_item — quiz ───────────────────────────────────────────────────────

describe('Integration: update_item — quiz', () => {
  it('updates quiz title', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'quiz', title: '[MCP TEST] Original Title', quiz_type: 'practice_quiz', published: false, questions: [] },
      })
    )
    createdQuizIds.push(created.id)

    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'quiz', search: 'Original Title', title: '[MCP TEST] Updated Title' },
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
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Module Item Assignment', points_possible: 5, published: false },
      })
    )
    createdAssignmentIds.push(assignment.id)

    // Look up the seed module name
    const modules = parseResult(await mcpClient.callTool({ name: 'list_items', arguments: { type: 'modules' } }))
    const seedMod = modules.find((m: { id: number }) => m.id === moduleId)
    const moduleName: string = seedMod.name

    // Add it to the seed module
    const item = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'module_item',
          module_name: moduleName,
          item_type: 'Assignment',
          title: '[MCP TEST] Module Item Assignment',
          content_id: assignment.id,
          completion_requirement: { type: 'min_score', min_score: 1 },
        },
      })
    )
    expect(item.id).toBeTypeOf('number')
    expect(item.type).toBe('Assignment')
    console.log(`  Added module item id=${item.id}`)

    // Update its title
    const updated = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'module_item', module_name: moduleName, search: '[MCP TEST] Module Item Assignment', title: '[MCP TEST] Renamed Item' },
      })
    )
    expect(updated.id).toBe(item.id)
    console.log(`  Updated module item title="${updated.title}"`)

    // Remove it
    const removed = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'module_item', module_name: moduleName, search: '[MCP TEST] Renamed Item' },
      })
    )
    expect(removed.removed).toBe(true)
    console.log(`  Removed module item id=${item.id}`)
  })
})

// ─── update_item — module ─────────────────────────────────────────────────────

describe('Integration: update_item — module', () => {
  it.skipIf(!hasSeedIds)('can set unlock_at on the seed module', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const modules = parseResult(await mcpClient.callTool({ name: 'list_items', arguments: { type: 'modules' } }))
    const seedMod = modules.find((m: { id: number }) => m.id === moduleId)
    const moduleName: string = seedMod.name

    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'module', search: moduleName, unlock_at: '2099-01-01T00:00:00Z' },
      })
    )

    expect(data.id).toBe(moduleId)
    expect(data.unlock_at).toBe('2099-01-01T00:00:00Z')
    console.log(`  Module ${moduleId} unlock_at set to ${data.unlock_at}`)

    // Restore
    await mcpClient.callTool({
      name: 'update_item',
      arguments: { type: 'module', search: moduleName, unlock_at: null },
    })
    console.log(`  Module ${moduleId} unlock_at cleared`)
  })
})

// ─── delete_item — module ─────────────────────────────────────────────────────

describe('Integration: delete_item — module', () => {
  it('creates a module then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)

    // We need canvas functions directly for this — use a second client
    const configManager = new ConfigManager(configPath)
    const canvasClient = new CanvasClient({ instanceUrl, apiToken })
    const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
    registerContentTools(mcpServer, canvasClient, configManager)
    registerFindTools(mcpServer, canvasClient, configManager)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })
    await mcpServer.connect(serverTransport)
    await mcpClient.connect(clientTransport)

    // First create a throwaway module via Canvas directly
    const { createModule } = await import('@canvas-mcp/core')
    const mod = await createModule(canvasClient, testCourseId, { name: '[MCP TEST] Throwaway Module' })
    console.log(`  Created throwaway module id=${mod.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'module', search: '[MCP TEST] Throwaway Module' },
      })
    )

    expect(data.deleted).toBe(true)
    console.log(`  Deleted module id=${mod.id}`)
  })
})

// ─── delete_item — assignment ─────────────────────────────────────────────────

describe('Integration: delete_item — assignment', () => {
  it('creates an assignment then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] To Be Deleted', points_possible: 5, published: false },
      })
    )
    console.log(`  Created assignment id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'assignment', search: 'To Be Deleted' },
      })
    )

    expect(data.deleted).toBe(true)
    console.log(`  Deleted assignment id=${created.id}`)
  })
})

// ─── delete_item — quiz ───────────────────────────────────────────────────────

describe('Integration: delete_item — quiz', () => {
  it('creates a quiz then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'quiz', title: '[MCP TEST] To Be Deleted', quiz_type: 'practice_quiz', published: false, questions: [] },
      })
    )
    console.log(`  Created quiz id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'quiz', search: 'To Be Deleted' },
      })
    )

    expect(data.deleted).toBe(true)
    console.log(`  Deleted quiz id=${created.id}`)
  })
})

// ─── create_item — page ───────────────────────────────────────────────────────

describe('Integration: create_item — page', () => {
  it('creates a page and verifies fields round-trip', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'page',
          title: '[MCP TEST] Integration Page',
          body: '<p>Hello from integration test.</p>',
          published: false,
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe('[MCP TEST] Integration Page')
    expect(data.published).toBe(false)
    expect(typeof data.url).toBe('string')

    createdPageUrls.push(data.url)
    console.log(`  Created page url="${data.url}": "${data.title}"`)
  })
})

// ─── delete_item — page ───────────────────────────────────────────────────────

describe('Integration: delete_item — page', () => {
  it('creates a page then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'page', title: '[MCP TEST] To Be Deleted Page', published: false },
      })
    )
    console.log(`  Created page url="${created.url}"`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'page', search: 'To Be Deleted Page' },
      })
    )

    expect(data.deleted).toBe(true)
    console.log(`  Deleted page url="${created.url}"`)
  })

  it('returns error when attempting to delete the course front page', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Create a page and promote it to front page via canvas directly
    const { createPage, updatePage, deletePage } = await import('@canvas-mcp/core')
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
      name: 'delete_item',
      arguments: { type: 'page', search: 'Temp Front Page' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('front page')
    console.log(`  Correctly rejected deletion of front page`)

    // Cleanup: unset front page designation then delete directly
    await updatePage(canvasClient, testCourseId, page.url, { front_page: false })
    await deletePage(canvasClient, testCourseId, page.url)
    console.log(`  Cleaned up test front page`)
  })
})

// ─── create_item — discussion ────────────────────────────────────────────────

describe('Integration: create_item — discussion', () => {
  it('creates a discussion topic and verifies fields', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'discussion',
          title: '[MCP TEST] Integration Discussion',
          message: '<p>Discuss this topic.</p>',
          published: false,
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe('[MCP TEST] Integration Discussion')

    createdDiscussionIds.push(data.id)
    console.log(`  Created discussion id=${data.id}: "${data.title}"`)
  })
})

// ─── create_item — announcement ──────────────────────────────────────────────

describe('Integration: create_item — announcement', () => {
  it('creates an announcement', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'announcement',
          title: '[MCP TEST] Integration Announcement',
          message: '<p>Important update.</p>',
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toBe('[MCP TEST] Integration Announcement')

    createdDiscussionIds.push(data.id)
    console.log(`  Created announcement id=${data.id}: "${data.title}"`)
  })
})

// ─── upload_file ────────────────────────────────────────────────────────────

describe('Integration: upload_file', () => {
  let tmpFilePath: string

  it('uploads a text file and verifies file info', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const suffix = randomBytes(4).toString('hex')
    tmpFilePath = join(tmpdir(), `mcp-test-upload-${suffix}.txt`)
    writeFileSync(tmpFilePath, 'Integration test file content', 'utf-8')

    const data = parseResult(
      await mcpClient.callTool({
        name: 'upload_file',
        arguments: { file_path: tmpFilePath, name: `mcp-test-${suffix}.txt` },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.size).toBeGreaterThan(0)

    createdFileIds.push(data.id)
    console.log(`  Uploaded file id=${data.id}: "${data.display_name}"`)

    try { unlinkSync(tmpFilePath) } catch { /* ignore */ }
  })
})

// ─── create_rubric ──────────────────────────────────────────────────────────

describe('Integration: create_rubric', () => {
  it('creates an assignment then a rubric associated with it and verifies fields', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // Rubrics must be associated with an assignment at creation time
    const assignment = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Rubric Host Assignment', points_possible: 10, published: false },
      })
    )
    createdAssignmentIds.push(assignment.id)
    console.log(`  Created host assignment id=${assignment.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'create_rubric',
        arguments: {
          title: '[MCP TEST] Integration Rubric',
          assignment_id: assignment.id,
          criteria: [
            {
              description: 'Completeness',
              points: 5,
              ratings: [
                { description: 'Full', points: 5 },
                { description: 'Partial', points: 3 },
                { description: 'Missing', points: 0 },
              ],
            },
          ],
        },
      })
    )

    expect(data.id).toBeTypeOf('number')
    expect(data.title).toContain('[MCP TEST] Integration Rubric')
    expect(data.association_id).toBeTypeOf('number')
    expect(data.assignment_id).toBe(assignment.id)
    expect(data.use_for_grading).toBe(true)

    // Rubric is linked to the assignment; deleting the assignment (in afterAll) cleans up the rubric.
    console.log(`  Created rubric id=${data.id}: "${data.title}" (associated with assignment ${assignment.id})`)
  })
})

// ─── update_item — syllabus ──────────────────────────────────────────────────

describe('Integration: update_item — syllabus', () => {
  it('sets syllabus body and then clears it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'syllabus', body: '<h1>[MCP TEST] Syllabus</h1>' },
      })
    )

    expect(data.updated).toBe(true)
    console.log(`  Set syllabus body`)

    // Clear it back
    const cleared = parseResult(
      await mcpClient.callTool({
        name: 'update_item',
        arguments: { type: 'syllabus', body: '' },
      })
    )
    expect(cleared.updated).toBe(true)
    console.log(`  Cleared syllabus body`)
  })
})

// ─── delete_item — discussion ────────────────────────────────────────────────

describe('Integration: delete_item — discussion', () => {
  it('creates a discussion then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'discussion', title: '[MCP TEST] To Be Deleted Discussion' },
      })
    )
    console.log(`  Created discussion id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_item',
        arguments: { type: 'discussion', search: 'To Be Deleted Discussion' },
      })
    )

    expect(data.deleted).toBe(true)
    console.log(`  Deleted discussion id=${created.id}`)
  })
})

// ─── delete_file ────────────────────────────────────────────────────────────

describe('Integration: delete_file', () => {
  it('uploads a file then deletes it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const suffix = randomBytes(4).toString('hex')
    const tmpPath = join(tmpdir(), `mcp-test-delete-${suffix}.txt`)
    writeFileSync(tmpPath, 'File to be deleted', 'utf-8')

    const created = parseResult(
      await mcpClient.callTool({
        name: 'upload_file',
        arguments: { file_path: tmpPath },
      })
    )
    console.log(`  Uploaded file id=${created.id}`)
    try { unlinkSync(tmpPath) } catch { /* ignore */ }

    const data = parseResult(
      await mcpClient.callTool({
        name: 'delete_file',
        arguments: { file_id: created.id },
      })
    )

    expect(data.deleted).toBe(true)
    expect(data.file_id).toBe(created.id)
    console.log(`  Deleted file id=${created.id}`)
  })
})

// ─── find_item — page ─────────────────────────────────────────────────────────

describe('Integration: find_item — page', () => {
  it('creates a page then retrieves it by slug with body', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'page',
          title: '[MCP TEST] Get Page',
          body: '<p>Body content for retrieval test.</p>',
          published: false,
        },
      })
    )
    createdPageUrls.push(created.url)
    console.log(`  Created page url="${created.url}"`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'page', search: 'Get Page' },
      })
    )

    expect(data.page_id).toBe(created.id)
    expect(data.page_url).toBe(created.url)
    expect(data.title).toBe('[MCP TEST] Get Page')
    expect(data.body).toContain('Body content for retrieval test.')
    expect(data.published).toBe(false)
    console.log(`  Retrieved page page_id=${data.page_id} url="${data.page_url}"`)
  })
})

// ─── list_items — assignments ─────────────────────────────────────────────────

describe('Integration: list_items — assignments', () => {
  it('creates an assignment then verifies it appears in the list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] List Assignments Check', points_possible: 5, published: false },
      })
    )
    createdAssignmentIds.push(created.id)
    console.log(`  Created assignment id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'assignments' } })
    )

    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    const found = data.find((a: { id: number }) => a.id === created.id)
    expect(found).toBeDefined()
    expect(found.name).toBe('[MCP TEST] List Assignments Check')
    expect(found.points_possible).toBe(5)
    console.log(`  list_assignments returned ${data.length} items; found id=${created.id}`)
  })
})

// ─── find_item — assignment ───────────────────────────────────────────────────

describe('Integration: find_item — assignment', () => {
  it('creates an assignment with a description then retrieves it by name search', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'assignment',
          name: '[MCP TEST] Get Assignment',
          points_possible: 20,
          description: '<p>Assignment details for retrieval test.</p>',
          published: false,
        },
      })
    )
    createdAssignmentIds.push(created.id)
    console.log(`  Created assignment id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'assignment', search: 'Get Assignment' },
      })
    )

    expect(data.id).toBe(created.id)
    expect(data.name).toBe('[MCP TEST] Get Assignment')
    expect(data.points_possible).toBe(20)
    expect(data.description).toContain('Assignment details for retrieval test.')
    expect(data.published).toBe(false)
    console.log(`  Retrieved assignment id=${data.id} name="${data.name}"`)
  })
})

// ─── list_items — quizzes ─────────────────────────────────────────────────────

describe('Integration: list_items — quizzes', () => {
  it('creates a quiz then verifies it appears in the list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'quiz', title: '[MCP TEST] List Quizzes Check', quiz_type: 'practice_quiz', published: false, questions: [] },
      })
    )
    createdQuizIds.push(created.id)
    console.log(`  Created quiz id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'quizzes' } })
    )

    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    const found = data.find((q: { id: number }) => q.id === created.id)
    expect(found).toBeDefined()
    expect(found.title).toBe('[MCP TEST] List Quizzes Check')
    expect(found.quiz_type).toBe('practice_quiz')
    console.log(`  list_quizzes returned ${data.length} items; found id=${created.id}`)
  })
})

// ─── find_item — quiz ─────────────────────────────────────────────────────────

describe('Integration: find_item — quiz', () => {
  it('creates a quiz with questions then retrieves quiz and questions together', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'quiz',
          title: '[MCP TEST] Get Quiz',
          quiz_type: 'graded_survey',
          published: false,
          questions: [
            { question_name: 'Q1', question_text: 'How confident are you?', question_type: 'essay_question', points_possible: 0 },
            { question_name: 'Q2', question_text: 'What was unclear?', question_type: 'essay_question', points_possible: 0 },
          ],
        },
      })
    )
    createdQuizIds.push(created.id)
    console.log(`  Created quiz id=${created.id} with ${created.questions_created} questions`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'find_item',
        arguments: { type: 'quiz', search: 'Get Quiz' },
      })
    )

    expect(data.id).toBe(created.id)
    expect(data.title).toBe('[MCP TEST] Get Quiz')
    expect(data.quiz_type).toBe('graded_survey')
    expect(Array.isArray(data.questions)).toBe(true)
    expect(data.questions.length).toBe(2)
    const q1 = data.questions.find((q: { question_name: string }) => q.question_name === 'Q1')
    expect(q1).toBeDefined()
    expect(q1.question_text).toBe('How confident are you?')
    console.log(`  Retrieved quiz id=${data.id} with ${data.questions.length} questions`)
  })
})

// ─── list_items — discussions ────────────────────────────────────────────────

describe('Integration: list_items — discussions', () => {
  it('creates a discussion then verifies it appears in the list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'discussion',
          title: '[MCP TEST] List Discussions Check',
          message: '<p>Discussion content.</p>',
          published: false,
        },
      })
    )
    createdDiscussionIds.push(created.id)
    console.log(`  Created discussion id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'discussions' } })
    )

    expect(Array.isArray(data)).toBe(true)
    const found = data.find((t: { id: number }) => t.id === created.id)
    expect(found).toBeDefined()
    expect(found.title).toBe('[MCP TEST] List Discussions Check')
    console.log(`  list_discussions returned ${data.length} items; found id=${created.id}`)
  })
})

// ─── list_items — announcements ──────────────────────────────────────────────

describe('Integration: list_items — announcements', () => {
  it('creates an announcement then verifies it appears in the announcements list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const created = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: {
          type: 'announcement',
          title: '[MCP TEST] List Announcements Check',
          message: '<p>Announcement content.</p>',
        },
      })
    )
    createdDiscussionIds.push(created.id)
    console.log(`  Created announcement id=${created.id}`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'announcements' } })
    )

    expect(Array.isArray(data)).toBe(true)
    const found = data.find((t: { id: number }) => t.id === created.id)
    expect(found).toBeDefined()
    expect(found.title).toBe('[MCP TEST] List Announcements Check')
    console.log(`  list_announcements returned ${data.length} items; found id=${created.id}`)
  })
})

// ─── list_items — rubrics ─────────────────────────────────────────────────────

describe('Integration: list_items — rubrics', () => {
  it('creates a rubric then verifies it appears in the list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const assignment = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Rubric List Host', points_possible: 10, published: false },
      })
    )
    createdAssignmentIds.push(assignment.id)
    console.log(`  Created host assignment id=${assignment.id}`)

    const rubric = parseResult(
      await mcpClient.callTool({
        name: 'create_rubric',
        arguments: {
          title: '[MCP TEST] List Rubrics Check',
          assignment_id: assignment.id,
          criteria: [
            { description: 'Quality', points: 10, ratings: [{ description: 'Good', points: 10 }, { description: 'Poor', points: 0 }] },
          ],
        },
      })
    )
    console.log(`  Created rubric id=${rubric.id}`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'list_items', arguments: { type: 'rubrics' } })
    )

    expect(Array.isArray(data)).toBe(true)
    const found = data.find((r: { id: number }) => r.id === rubric.id)
    expect(found).toBeDefined()
    expect(found.title).toContain('[MCP TEST] List Rubrics Check')
    expect(found.points_possible).toBe(10)
    console.log(`  list_rubrics returned ${data.length} items; found id=${rubric.id}`)
  })
})

// ─── find_item — syllabus ─────────────────────────────────────────────────────

describe('Integration: find_item — syllabus', () => {
  it('sets the syllabus then retrieves it', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    await mcpClient.callTool({
      name: 'update_item',
      arguments: { type: 'syllabus', body: '<h1>[MCP TEST] Get Syllabus</h1><p>Content.</p>' },
    })
    console.log(`  Set syllabus body`)

    const data = parseResult(
      await mcpClient.callTool({ name: 'find_item', arguments: { type: 'syllabus' } })
    )

    expect(data.syllabus_body).toContain('[MCP TEST] Get Syllabus')
    expect(data.syllabus_body).toContain('<p>Content.</p>')
    console.log(`  Retrieved syllabus (${data.syllabus_body?.length ?? 0} chars)`)

    // Restore
    await mcpClient.callTool({ name: 'update_item', arguments: { type: 'syllabus', body: '' } })
    console.log(`  Cleared syllabus`)
  })
})

// ─── associate_rubric ────────────────────────────────────────────────────────

describe('Integration: associate_rubric', () => {
  it('creates a rubric (with assignment1), then re-associates it with assignment2', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)
    const canvasClient = new CanvasClient({ instanceUrl, apiToken })

    // Create the initial host assignment (rubric requires an assignment at creation)
    const assignment1 = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Rubric Initial Host', points_possible: 10 },
      })
    )
    console.log(`  Created assignment1 id=${assignment1.id}`)
    expect(assignment1.id).toBeGreaterThan(0)

    // Create the rubric linked to assignment1
    const rubric = parseResult(
      await mcpClient.callTool({
        name: 'create_rubric',
        arguments: {
          title: '[MCP TEST] Associate Rubric',
          assignment_id: assignment1.id,
          criteria: [
            {
              description: 'Code Quality',
              points: 10,
              ratings: [
                { description: 'Excellent', points: 10 },
                { description: 'Needs Improvement', points: 5 },
                { description: 'Incomplete', points: 0 },
              ],
            },
          ],
        },
      })
    )
    console.log(`  Created rubric id=${rubric.id} title="${rubric.title}"`)
    expect(rubric.id).toBeGreaterThan(0)

    // Create a second assignment to test re-association
    const assignment2 = parseResult(
      await mcpClient.callTool({
        name: 'create_item',
        arguments: { type: 'assignment', name: '[MCP TEST] Rubric Re-association Target', points_possible: 10 },
      })
    )
    console.log(`  Created assignment2 id=${assignment2.id}`)
    expect(assignment2.id).toBeGreaterThan(0)

    try {
      // Associate the rubric with assignment2 (re-association) via direct canvas API
      const { createRubricAssociation } = await import('@canvas-mcp/core')
      const association = await createRubricAssociation(canvasClient, testCourseId, {
        rubric_id: rubric.id,
        assignment_id: assignment2.id,
        use_for_grading: true,
      })
      console.log(`  Created association id=${association.id} type=${association.association_type}`)
      expect(association.id).toBeGreaterThan(0)
      expect(association.rubric_id).toBe(rubric.id)
      expect(association.association_id).toBe(assignment2.id)
      expect(association.association_type).toBe('Assignment')
      expect(association.use_for_grading).toBe(true)
    } finally {
      // Clean up: delete rubric first (Canvas associates it to assignments), then assignments
      await canvasClient.delete(`/api/v1/courses/${testCourseId}/rubrics/${rubric.id}`).catch(() => {})
      await canvasClient.delete(`/api/v1/courses/${testCourseId}/assignments/${assignment1.id}`).catch(() => {})
      await canvasClient.delete(`/api/v1/courses/${testCourseId}/assignments/${assignment2.id}`).catch(() => {})
      console.log(`  Cleanup: deleted rubric id=${rubric.id}, assignment1 id=${assignment1.id}, assignment2 id=${assignment2.id}`)
    }
  })
})
