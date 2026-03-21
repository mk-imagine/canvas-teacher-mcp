import { describe, it, expect, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient, ConfigManager } from '@canvas-mcp/core'
import { registerModuleTools } from '../../packages/teacher/src/tools/modules.js'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const seedModuleId = parseInt(process.env.CANVAS_TEST_MODULE_ID ?? '0')

const hasSeedModule = seedModuleId > 0

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-modules-${suffix}`, 'config.json')
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
  registerModuleTools(mcpServer, canvasClient, configManager)

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

// Track created modules for cleanup
const createdModuleIds: number[] = []

afterAll(async () => {
  if (createdModuleIds.length === 0) return
  const configPath = makeTmpConfigPath()
  makeConfig(configPath)
  const { deleteModule } = await import('@canvas-mcp/core')
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  for (const id of createdModuleIds) {
    try {
      await deleteModule(canvasClient, testCourseId, id)
      console.log(`  Cleanup: deleted module id=${id}`)
    } catch {
      console.log(`  Cleanup: failed to delete module id=${id}`)
    }
  }
})

// ─── build_module — lesson ────────────────────────────────────────────────────

describe('Integration: build_module — lesson', () => {
  it('dry_run=true returns preview without creating Canvas objects', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'lesson',
          week: 99,
          title: '[MCP TEST] Dry Run Module',
          lesson_template: 'later-standard',
          due_date: '2099-01-01T23:59:00Z',
          items: [
            { type: 'coding_assignment', title: 'Test Assignment', hours: 2 },
          ],
          dry_run: true,
        },
      })
    )

    expect(data.dry_run).toBe(true)
    expect(Array.isArray(data.items_preview)).toBe(true)
    expect(data.items_preview.length).toBeGreaterThan(0)
    console.log(`  dry_run preview: ${data.items_preview.length} items`)
  })

  it('full round-trip: creates later-standard module and verifies item count', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'lesson',
          week: 99,
          title: '[MCP TEST] Later Standard Module',
          lesson_template: 'later-standard',
          due_date: '2099-01-01T23:59:00Z',
          items: [
            { type: 'coding_assignment', title: 'Test Coding Assignment', hours: 2 },
            { type: 'reading_page', title: 'Test Reading', hours: 1 },
          ],
        },
      })
    )

    expect(data.module).toBeDefined()
    expect(data.module.id).toBeTypeOf('number')
    expect(data.module.name).toBe('Week 99 | [MCP TEST] Later Standard Module')
    expect(Array.isArray(data.items_created)).toBe(true)
    // OVERVIEW subheader + overview page + ASSIGNMENTS subheader + 2 user items + WRAP-UP subheader + exit card = 7
    expect(data.items_created.length).toBe(7)

    createdModuleIds.push(data.module.id)
    console.log(`  Created module id=${data.module.id}: "${data.module.name}" (${data.items_created.length} items)`)
  })
})

// ─── build_module — solution ──────────────────────────────────────────────────

describe('Integration: build_module — solution', () => {
  it('creates solution module linked to lesson module', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    // First create a lesson module to link to
    const lesson = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'lesson',
          week: 99,
          title: '[MCP TEST] Lesson For Solution',
          lesson_template: 'later-standard',
          due_date: '2099-01-01T23:59:00Z',
          items: [],
        },
      })
    )
    createdModuleIds.push(lesson.module.id)
    console.log(`  Created lesson module id=${lesson.module.id}`)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'solution',
          lesson_module_id: lesson.module.id,
          unlock_at: '2099-01-08T00:00:00Z',
          title: '[MCP TEST] Solution Module',
          solutions: [
            { title: 'Solution Notebook', url: 'https://colab.research.google.com/drive/test' },
          ],
        },
      })
    )

    expect(data.module.id).toBeTypeOf('number')
    expect(data.module.prerequisite_module_ids).toContain(lesson.module.id)
    expect(data.items_created.length).toBe(1)
    expect(data.items_created[0].type).toBe('ExternalUrl')

    createdModuleIds.push(data.module.id)
    console.log(`  Created solution module id=${data.module.id} with prerequisite ${lesson.module.id}`)
  })
})

// ─── build_module — clone ─────────────────────────────────────────────────────

describe('Integration: build_module — clone', () => {
  it.skipIf(!hasSeedModule)('clones seed module with week substitution', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const data = parseResult(
      await mcpClient.callTool({
        name: 'build_module',
        arguments: {
          template: 'clone',
          source_module_id: seedModuleId,
          source_course_id: testCourseId,
          week: 99,
          due_date: '2099-01-01T23:59:00Z',
        },
      })
    )

    expect(data.module.id).toBeTypeOf('number')
    expect(Array.isArray(data.items_created)).toBe(true)

    // Verify week substitution: no title should contain "Week N" where N != 99
    const titles = data.items_created.map((i: { title: string }) => i.title)
    for (const title of titles) {
      expect(title).not.toMatch(/Week (?!99)\d+/)
    }

    createdModuleIds.push(data.module.id)
    console.log(`  Cloned module id=${data.module.id} with ${data.items_created.length} items`)
  })
})
