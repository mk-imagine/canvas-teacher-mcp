import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { server as mswServer } from '../../setup/msw-server.js'
import { CanvasClient, ConfigManager, SecureStore, SidecarManager } from '@canvas-mcp/core'
import { registerAttendanceTools } from '../../../src/tools/attendance.js'

const CANVAS_URL = 'https://canvas.example.com'
const COURSE_ID = 1

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ROSTER_ENROLLMENTS = [
  {
    id: 1, user_id: 1001, type: 'StudentEnrollment', enrollment_state: 'active',
    user: { id: 1001, name: 'Jane Smith', sortable_name: 'Smith, Jane' },
    grades: { current_score: 90, final_score: 85, current_grade: 'A-', final_grade: 'B+' },
  },
  {
    id: 2, user_id: 1002, type: 'StudentEnrollment', enrollment_state: 'active',
    user: { id: 1002, name: 'Bob Adams', sortable_name: 'Adams, Bob' },
    grades: { current_score: 80, final_score: 75, current_grade: 'B-', final_grade: 'C+' },
  },
  {
    id: 3, user_id: 1003, type: 'StudentEnrollment', enrollment_state: 'active',
    user: { id: 1003, name: 'Carlos Rivera', sortable_name: 'Rivera, Carlos' },
    grades: { current_score: 70, final_score: 65, current_grade: 'C-', final_grade: 'D+' },
  },
]

/** Real names from fixtures — used for PII assertion scans. */
const REAL_NAMES = ['Jane Smith', 'Bob Adams', 'Carlos Rivera']

const CSV_ALL_MATCH = [
  'Name (original name),Duration (minutes)',
  'Jane Smith,45',
  'Bob Adams,30',
  'Carlos Rivera,60',
].join('\n')

const CSV_AMBIGUOUS = [
  'Name (original name),Duration (minutes)',
  'Jane Smith,45',
  'Bobb Addams,30',
  'Xander Unknown,60',
].join('\n')

const CSV_WITH_HOST = [
  'Name (original name),Duration (minutes)',
  'Prof Mark (Host),120',
  'Jane Smith,45',
  'Bob Adams,30',
].join('\n')

const CSV_DURATION = [
  'Name (original name),Duration (minutes)',
  'Jane Smith,45',
  'Bob Adams,10',
  'Carlos Rivera,60',
].join('\n')

const CSV_MAP_LOOKUP = [
  'Name (original name),Duration (minutes)',
  'jsmith_zoom,45',
  'Bob Adams,30',
].join('\n')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const suffix = randomBytes(8).toString('hex')
  const dir = join(tmpdir(), `canvas-attendance-test-${suffix}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeTmpConfigPath(dir: string): string {
  return join(dir, 'config.json')
}

function writeConfig(path: string, overrides: Record<string, unknown> = {}) {
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const base = {
    canvas: { instanceUrl: CANVAS_URL, apiToken: 'tok' },
    program: { activeCourseId: COURSE_ID, courseCodes: [], courseCache: {} },
    defaults: { assignmentGroup: 'Assignments', submissionType: 'online_url', pointsPossible: 100 },
    attendance: { hostName: 'Prof Mark', defaultPoints: 10, defaultMinDuration: 0 },
    ...overrides,
  }
  writeFileSync(path, JSON.stringify(base), 'utf-8')
}

function writeCsv(dir: string, content: string): string {
  const csvPath = join(dir, 'zoom-participants.csv')
  writeFileSync(csvPath, content, 'utf-8')
  return csvPath
}

function writeNameMap(dir: string, map: Record<string, number>): void {
  writeFileSync(join(dir, 'zoom-name-map.json'), JSON.stringify(map, null, 2), 'utf-8')
}

function setupEnrollmentHandler() {
  mswServer.use(
    http.get(`${CANVAS_URL}/api/v1/courses/${COURSE_ID}/enrollments`, () =>
      HttpResponse.json(ROSTER_ENROLLMENTS)
    ),
  )
}

async function makeTestClient(configPath: string, store?: SecureStore) {
  const secureStore = store ?? new SecureStore()
  const configManager = new ConfigManager(configPath)
  const canvasClient = new CanvasClient({ instanceUrl: CANVAS_URL, apiToken: 'tok' })
  const mcpServer = new McpServer({ name: 'test', version: '0.0.1' })
  const sidecarManager = new SidecarManager('', false)
  registerAttendanceTools(mcpServer, canvasClient, configManager, secureStore, sidecarManager)

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const mcpClient = new Client({ name: 'test-client', version: '0.0.1' })
  await mcpServer.connect(serverTransport)
  await mcpClient.connect(clientTransport)

  return { mcpClient, configManager, store: secureStore }
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>
type ContentBlock = { type: string; text: string }

function getContent(result: ToolResult): ContentBlock[] {
  return result.content as ContentBlock[]
}

function parseResult(result: ToolResult) {
  return JSON.parse(getContent(result)[0].text)
}

/** Assert that no real student names appear in the raw response text. */
function assertNoPII(result: ToolResult) {
  const raw = getContent(result)[0].text
  for (const name of REAL_NAMES) {
    expect(raw).not.toContain(name)
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('import_attendance', () => {
  // (1) Parse happy path
  it('parse: returns tokenized present list when all students match', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_ALL_MATCH)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const data = parseResult(result)
    expect(data.matched_count).toBe(3)
    expect(data.ambiguous_count).toBe(0)
    expect(data.unmatched_count).toBe(0)
    // All entries should use [STUDENT_NNN] tokens
    for (const entry of data.matched) {
      expect(entry.student).toMatch(/^\[STUDENT_\d{3}\]$/)
    }
    assertNoPII(result)
  })

  // (2) Parse with ambiguous names
  it('parse: correctly categorizes ambiguous and unmatched names', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_AMBIGUOUS)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const data = parseResult(result)
    // Jane Smith exact + Bobb Addams fuzzy-matched (normalized distance < 0.25)
    expect(data.matched_count).toBe(2)
    // Xander Unknown should be unmatched
    expect(data.unmatched_count).toBeGreaterThanOrEqual(1)
    expect(data.review_file).toBeTruthy()
    assertNoPII(result)
  })

  // (3) Host filtering
  it('parse: excludes host from results', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_WITH_HOST)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const data = parseResult(result)
    // Host "Prof Mark" should be excluded; only Jane and Bob matched
    expect(data.matched_count).toBe(2)
    assertNoPII(result)
  })

  // (4) Duration threshold
  it('parse: excludes participants below min_duration', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_DURATION)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100, min_duration: 30 },
    })

    const data = parseResult(result)
    // Bob has 10 min, below 30 min threshold — excluded
    expect(data.matched_count).toBe(2)
    assertNoPII(result)
  })

  // (5) Persistent map lookup
  it('parse: resolves names from persistent map', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_MAP_LOOKUP)
    // Pre-write a name map: "jsmith_zoom" -> Canvas user 1001 (Jane Smith)
    writeNameMap(dir, { jsmith_zoom: 1001 })
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const data = parseResult(result)
    expect(data.matched_count).toBe(2) // jsmith_zoom via map + Bob Adams via exact
    // Verify one was matched via map
    const mapMatch = data.matched.find((m: { source: string }) => m.source === 'map')
    expect(mapMatch).toBeTruthy()
    assertNoPII(result)
  })

  // (6) Config defaults used when args not provided
  it('parse: uses config defaults for min_duration when not provided', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    // Set defaultMinDuration to 30 in config
    writeConfig(configPath, {
      attendance: { hostName: '', defaultPoints: 10, defaultMinDuration: 30 },
    })
    const csvPath = writeCsv(dir, CSV_DURATION)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const data = parseResult(result)
    // Bob has 10 min, below 30 min default threshold — excluded
    expect(data.matched_count).toBe(2)
    assertNoPII(result)
  })

  // (7) PII assertion — covered in each test above via assertNoPII, but here's an explicit one
  it('parse: response contains only STUDENT tokens, never real names', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    const csvPath = writeCsv(dir, CSV_ALL_MATCH)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const raw = getContent(result)[0].text
    // Must contain STUDENT tokens
    expect(raw).toMatch(/\[STUDENT_\d{3}\]/)
    // Must NOT contain any real name
    assertNoPII(result)
  })

  // (8) Missing CSV file
  it('parse: returns error for nonexistent CSV file', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)
    setupEnrollmentHandler()

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: '/nonexistent/file.csv', assignment_id: 100 },
    })

    const text = getContent(result)[0].text
    expect(text).toContain('file')
  })

  // (9) No active course
  it('parse: returns error when no active course is set', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath, { program: { activeCourseId: null, courseCodes: [], courseCache: {} } })
    const csvPath = writeCsv(dir, CSV_ALL_MATCH)

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'parse', csv_path: csvPath, assignment_id: 100 },
    })

    const text = getContent(result)[0].text
    expect(text).toContain('No active course')
  })

  // Submit action returns error (not yet implemented)
  it('submit: returns error telling user to parse first', async () => {
    const dir = makeTmpDir()
    const configPath = makeTmpConfigPath(dir)
    writeConfig(configPath)

    const { mcpClient } = await makeTestClient(configPath)
    const result = await mcpClient.callTool({
      name: 'import_attendance',
      arguments: { action: 'submit', assignment_id: 100, points: 10 },
    })

    const text = getContent(result)[0].text
    expect(text).toContain('parse')
  })
})
