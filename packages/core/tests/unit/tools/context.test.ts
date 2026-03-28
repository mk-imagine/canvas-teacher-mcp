import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import type { RosterStore } from '../../../src/roster/store.js'
import type { SecureStore } from '../../../src/security/secure-store.js'

// Mock syncRosterFromEnrollments to avoid real Canvas calls in fire-and-forget tests
vi.mock('../../../src/roster/sync.js', () => ({
  syncRosterFromEnrollments: vi.fn(),
}))

import { syncRosterFromEnrollments } from '../../../src/roster/sync.js'

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

  describe('set_active_course — fire-and-forget roster sync', () => {
    const MOCK_STUDENTS = [
      { canvasUserId: 1, name: 'Alice Smith', sortable_name: 'Smith, Alice', emails: [], courseIds: [101], zoomAliases: [], created: '2026-01-01T00:00:00Z' },
      { canvasUserId: 2, name: 'Bob Jones', sortable_name: 'Jones, Bob', emails: [], courseIds: [101], zoomAliases: [], created: '2026-01-01T00:00:00Z' },
    ]

    function makeMockRosterStore(): RosterStore {
      return {} as unknown as RosterStore
    }

    function makeMockSecureStore(): SecureStore {
      return { preload: vi.fn() } as unknown as SecureStore
    }

    async function makeTestClientWithStores(
      configPath: string,
      rosterStore?: RosterStore,
      secureStore?: SecureStore
    ) {
      const configManager = new ConfigManager(configPath)
      const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
      const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
      registerContextTools(mcpServer, canvasClient, configManager, rosterStore, secureStore)

      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })

      await mcpServer.connect(serverTransport)
      await mcpClient.connect(clientTransport)

      return { mcpClient, configManager }
    }

    beforeEach(() => {
      vi.mocked(syncRosterFromEnrollments).mockResolvedValue(MOCK_STUDENTS)
    })

    afterEach(() => {
      vi.clearAllMocks()
    })

    it('returns success response immediately without waiting for sync', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const rosterStore = makeMockRosterStore()
      const secureStore = makeMockSecureStore()

      // Make sync take a long time to ensure we don't wait
      let syncResolved = false
      vi.mocked(syncRosterFromEnrollments).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => { syncResolved = true; resolve(MOCK_STUDENTS) }, 5000))
      )

      const { mcpClient } = await makeTestClientWithStores(configPath, rosterStore, secureStore)

      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      // Tool response returned before sync resolved
      expect(syncResolved).toBe(false)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('Active course set to')
    })

    it('calls syncRosterFromEnrollments with the resolved courseId', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const rosterStore = makeMockRosterStore()
      const secureStore = makeMockSecureStore()

      const { mcpClient } = await makeTestClientWithStores(configPath, rosterStore, secureStore)

      await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      // Allow microtasks/promises to flush
      await new Promise((resolve) => setImmediate(resolve))

      expect(syncRosterFromEnrollments).toHaveBeenCalledOnce()
      expect(syncRosterFromEnrollments).toHaveBeenCalledWith(
        rosterStore,
        expect.anything(),
        101
      )
    })

    it('calls secureStore.preload with students returned from sync', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const rosterStore = makeMockRosterStore()
      const secureStore = makeMockSecureStore()

      const { mcpClient } = await makeTestClientWithStores(configPath, rosterStore, secureStore)

      await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      // Allow the fire-and-forget promise chain to flush
      await new Promise((resolve) => setImmediate(resolve))

      expect(secureStore.preload).toHaveBeenCalledOnce()
      expect(secureStore.preload).toHaveBeenCalledWith([
        { canvasUserId: 1, name: 'Alice Smith' },
        { canvasUserId: 2, name: 'Bob Jones' },
      ])
    })

    it('logs sync failure to stderr but does not affect the tool response', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const rosterStore = makeMockRosterStore()
      const secureStore = makeMockSecureStore()

      vi.mocked(syncRosterFromEnrollments).mockRejectedValue(new Error('network timeout'))

      const stderrWrites: string[] = []
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderrWrites.push(String(chunk))
        return true
      })

      const { mcpClient } = await makeTestClientWithStores(configPath, rosterStore, secureStore)

      const result = await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      // Allow the promise rejection handler to flush
      await new Promise((resolve) => setImmediate(resolve))

      vi.restoreAllMocks()

      // Tool response should be success
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      expect(text).toContain('Active course set to')

      // Error should be logged to stderr with [roster] prefix
      const loggedError = stderrWrites.some((w) => w.includes('[roster]') && w.includes('network timeout'))
      expect(loggedError).toBe(true)
    })

    it('does not call syncRosterFromEnrollments when rosterStore is not provided', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)

      // No rosterStore or secureStore — old caller pattern
      const { mcpClient } = await makeTestClientWithStores(configPath)

      await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'CSC408' },
      })

      await new Promise((resolve) => setImmediate(resolve))

      expect(syncRosterFromEnrollments).not.toHaveBeenCalled()
    })

    it('does not call syncRosterFromEnrollments when query is ambiguous', async () => {
      const configPath = makeTmpConfigPath()
      writeConfig(configPath)
      const rosterStore = makeMockRosterStore()
      const secureStore = makeMockSecureStore()

      const { mcpClient } = await makeTestClientWithStores(configPath, rosterStore, secureStore)

      // "spring" matches all three courses — disambiguation, no course set
      await mcpClient.callTool({
        name: 'set_active_course',
        arguments: { query: 'spring' },
      })

      await new Promise((resolve) => setImmediate(resolve))

      expect(syncRosterFromEnrollments).not.toHaveBeenCalled()
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
