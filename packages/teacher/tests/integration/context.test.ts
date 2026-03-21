import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasClient, ConfigManager, registerContextTools } from '@canvas-mcp/core'

const instanceUrl = process.env.CANVAS_INSTANCE_URL!
const apiToken = process.env.CANVAS_API_TOKEN!
const testCourseId = parseInt(process.env.CANVAS_TEST_COURSE_ID!)

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-int-ctx-${suffix}`, 'config.json')
}

async function makeIntegrationClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl, apiToken })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerContextTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'int-test-client', version: '0.0.1' })

  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

function makeConfig(configPath: string) {
  const dir = configPath.substring(0, configPath.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    configPath,
    JSON.stringify({
      canvas: { instanceUrl, apiToken },
      program: { activeCourseId: null, courseCodes: [], courseCache: {} },
      defaults: { assignmentGroup: 'Assignments', submissionType: 'online_url', pointsPossible: 100 },
    }),
    'utf-8'
  )
}

describe('Integration: context tools', () => {
  it('list_courses: returns at least one course', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const result = await mcpClient.callTool({ name: 'list_courses', arguments: { all: true } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const data = JSON.parse(text) as Array<{ id: number }>

    expect(data.length).toBeGreaterThan(0)
  })

  it('list_courses: TEST SANDBOX course appears in full list', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient } = await makeIntegrationClient(configPath)

    const result = await mcpClient.callTool({ name: 'list_courses', arguments: { all: true } })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const data = JSON.parse(text) as Array<{ id: number; name: string }>

    const testCourse = data.find((c) => c.id === testCourseId)
    expect(testCourse, `Expected course with id ${testCourseId} in list`).toBeDefined()
    console.log(`  Found course: "${testCourse!.name}" (id: ${testCourse!.id})`)
  })

  it('set_active_course: resolves TEST SANDBOX by fuzzy match', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient, configManager } = await makeIntegrationClient(configPath)

    const result = await mcpClient.callTool({
      name: 'set_active_course',
      arguments: { query: 'TEST SANDBOX' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    console.log(`  set_active_course result: ${text}`)

    // Could match exactly one, or multiple if TEST SANDBOX is ambiguous
    // In either case, assert activeCourseId was set if unique match
    const config = configManager.read()
    if (config.program.activeCourseId !== null) {
      expect(config.program.activeCourseId).toBe(testCourseId)
    } else {
      // Disambiguation — the text should contain a list
      expect(text).toContain('Multiple')
    }
  })

  it('set_active_course: updates courseCache on resolution', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient, configManager } = await makeIntegrationClient(configPath)

    // Use the course ID directly as a highly specific query
    // to force a unique match (search by numeric ID is not supported,
    // so use the course name if known)
    await mcpClient.callTool({
      name: 'set_active_course',
      arguments: { query: 'TEST SANDBOX' },
    })

    const config = configManager.read()
    if (config.program.activeCourseId !== null) {
      const cached = config.program.courseCache[String(config.program.activeCourseId)]
      expect(cached).toBeDefined()
      expect(cached.name).toBeTruthy()
      console.log(`  Cached: ${JSON.stringify(cached)}`)
    }
  })

  it('get_active_course: returns course info after set_active_course', async () => {
    const configPath = makeTmpConfigPath()
    makeConfig(configPath)
    const { mcpClient, configManager } = await makeIntegrationClient(configPath)

    // First set the active course
    await mcpClient.callTool({
      name: 'set_active_course',
      arguments: { query: 'TEST SANDBOX' },
    })

    const config = configManager.read()
    if (config.program.activeCourseId === null) {
      // Skip if disambiguation occurred
      console.log('  Skipping: set_active_course did not resolve uniquely')
      return
    }

    // Now get it
    const result = await mcpClient.callTool({ name: 'get_active_course', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const data = JSON.parse(text) as { activeCourseId: number; name: string }

    expect(data.activeCourseId).toBe(testCourseId)
    expect(data.name).toBeTruthy()
    console.log(`  get_active_course: ${JSON.stringify(data)}`)
  })
})
