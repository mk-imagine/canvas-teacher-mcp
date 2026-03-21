import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { server as mswServer } from '../../setup/msw-server.js'
import { CanvasClient, ConfigManager, registerContextTools } from '@canvas-mcp/core'

const CANVAS_URL = 'https://canvas.example.com'

const COURSES = [
  {
    id: 101,
    name: 'Introduction to Machine Learning',
    course_code: 'CSC408-001',
    workflow_state: 'available',
    term: { name: 'Spring 2026' },
  },
  {
    id: 102,
    name: 'Advanced Machine Learning',
    course_code: 'CSC411-001',
    workflow_state: 'available',
    term: { name: 'Spring 2026' },
  },
  {
    id: 103,
    name: 'TEST SANDBOX',
    course_code: 'SANDBOX-001',
    workflow_state: 'available',
    term: { name: 'Spring 2026' },
  },
]

function makeTmpConfigPath(): string {
  const suffix = randomBytes(8).toString('hex')
  return join(tmpdir(), `canvas-ctx-test-${suffix}`, 'config.json')
}

function writeConfig(path: string, extra: object = {}) {
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const base = {
    canvas: { instanceUrl: CANVAS_URL, apiToken: 'tok' },
    program: { activeCourseId: null, courseCodes: ['CSC408', 'CSC411'], courseCache: {} },
    defaults: { assignmentGroup: 'Assignments', submissionType: 'online_url', pointsPossible: 100 },
  }
  writeFileSync(path, JSON.stringify({ ...base, ...extra }), 'utf-8')
}

async function makeTestClient(configPath: string) {
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  registerContextTools(mcpServer, canvasClient, configManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })

  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager }
}

describe('context tools', () => {
  beforeEach(() => {
    mswServer.use(
      http.get(`${CANVAS_URL}/api/v1/courses`, () => {
        return HttpResponse.json(COURSES)
      })
    )
  })

  describe('list_courses', () => {
    it('filters by courseCodes by default', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({ name: 'list_courses', arguments: {} })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      const data = JSON.parse(text) as Array<{ courseCode: string }>

      // Should only include CSC408 and CSC411, not SANDBOX
      expect(data).toHaveLength(2)
      expect(data.map((c) => c.courseCode)).toContain('CSC408-001')
      expect(data.map((c) => c.courseCode)).toContain('CSC411-001')
      expect(data.map((c) => c.courseCode)).not.toContain('SANDBOX-001')
    })

    it('all=true returns all courses', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({ name: 'list_courses', arguments: { all: true } })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      const data = JSON.parse(text) as Array<{ courseCode: string }>

      expect(data).toHaveLength(3)
    })

    it('marks the active course with isActive=true', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath, {
        program: {
          activeCourseId: 101,
          courseCodes: ['CSC408', 'CSC411'],
          courseCache: {},
        },
      })
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({ name: 'list_courses', arguments: {} })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      const data = JSON.parse(text) as Array<{ id: number; isActive: boolean }>

      const active = data.find((c) => c.id === 101)
      expect(active?.isActive).toBe(true)
      const inactive = data.find((c) => c.id === 102)
      expect(inactive?.isActive).toBe(false)
    })
  })

  describe('set_active_course', () => {
    it('resolves an exact course code match', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient, configManager } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('101')

      const config = configManager.read()
      expect(config.program.activeCourseId).toBe(101)
    })

    it('resolves a fuzzy match on code + term', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient, configManager } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: '408 spring' },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('101')

      const config = configManager.read()
      expect(config.program.activeCourseId).toBe(101)
    })

    it('returns disambiguation list when multiple courses match', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient, configManager } = await makeTestClient(configPath)

      // "spring" matches all three courses (all have Spring 2026 term)
      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'spring' },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('Multiple courses match')

      // Should NOT have set activeCourseId
      const config = configManager.read()
      expect(config.program.activeCourseId).toBeNull()
    })

    it('returns program courses when no match found', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'XYZNONEXISTENT999' },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('Available program courses')
    })

    it('populates courseCache after resolution', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient, configManager } = await makeTestClient(configPath)

      await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      const config = configManager.read()
      const cached = config.program.courseCache['101']
      expect(cached).toBeDefined()
      expect(cached.code).toBe('CSC408-001')
      expect(cached.name).toBe('Introduction to Machine Learning')
      expect(cached.term).toBe('Spring 2026')
    })
  })

  describe('get_active_course', () => {
    it('returns cached course info when active course is set', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath, {
        program: {
          activeCourseId: 101,
          courseCodes: ['CSC408', 'CSC411'],
          courseCache: {
            '101': { code: 'CSC408-001', name: 'Introduction to Machine Learning', term: 'Spring 2026' },
          },
        },
      })
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({ name: 'get_active_course', arguments: {} })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      const data = JSON.parse(text) as {
        activeCourseId: number
        courseCode: string
        name: string
        term: string
      }

      expect(data.activeCourseId).toBe(101)
      expect(data.courseCode).toBe('CSC408-001')
      expect(data.name).toBe('Introduction to Machine Learning')
      expect(data.term).toBe('Spring 2026')
    })

    it('returns guidance message when no active course', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const { mcpClient } = await makeTestClient(configPath)

      const result = await mcpClient.callTool({ name: 'get_active_course', arguments: {} })
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      const data = JSON.parse(text) as { activeCourseId: null; message: string }

      expect(data.activeCourseId).toBeNull()
      expect(data.message).toBeTruthy()
    })
  })
})
