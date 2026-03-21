import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigManager, CanvasClient, SecureStore, SidecarManager, registerContextTools, fetchStudentEnrollments, TemplateService, seedDefaultTemplates } from '@canvas-mcp/core'
import { registerReportingTools } from './tools/reporting.js'
import { registerContentTools } from './tools/content.js'
import { registerModuleTools } from './tools/modules.js'
import { registerResetTools } from './tools/reset.js'
import { registerFindTools } from './tools/find.js'

// Module-scope so cleanup is reachable from the top-level .catch()
let secureStore: SecureStore | undefined
let sidecarManager: SidecarManager | undefined

function cleanup(exitCode = 0): never {
  sidecarManager?.purge()
  secureStore?.destroy()
  process.exit(exitCode)
}

async function main() {
  secureStore = new SecureStore()

  const configFlagIndex = process.argv.indexOf('--config')
  const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined
  const configManager = new ConfigManager(configPath)
  const config = configManager.read()

  // 2.2 — Template Service initialization
  const defaultConfigDir = join(homedir(), '.config', 'mcp', 'canvas-mcp')
  const configDir = configPath != null ? dirname(configPath) : defaultConfigDir
  const templatesDir = join(configDir, 'templates')
  seedDefaultTemplates(templatesDir)
  const templateService = new TemplateService(templatesDir)

  sidecarManager = new SidecarManager(config.privacy.sidecarPath, config.privacy.blindingEnabled)

  process.on('SIGINT', () => cleanup(0))
  process.on('SIGTERM', () => cleanup(0))
  process.on('SIGHUP', () => cleanup(0))
  process.on('uncaughtException', () => cleanup(1))

  const client = new CanvasClient(config.canvas)

  const { activeCourseId, courseCache } = config.program

  // 3.2 — Server-start roster pre-fetch
  // Fire-and-forget: populate SecureStore before any tool call to eliminate
  // the first-message blindspot (PII_ARCHITECTURE.md §5.2).
  if (config.privacy.blindingEnabled && activeCourseId !== null) {
    void (async () => {
      try {
        const enrollments = await fetchStudentEnrollments(client, activeCourseId)
        for (const enrollment of enrollments) {
          secureStore.tokenize(enrollment.user_id, enrollment.user.name)
        }
        const synced = sidecarManager.sync(secureStore)
        if (synced) {
          process.stderr.write(
            `[canvas-mcp] Pre-fetched ${enrollments.length} students into SecureStore.\n`
          )
        }
      } catch (err) {
        process.stderr.write(
          `[canvas-mcp] Roster pre-fetch failed (non-fatal): ${(err as Error).message}\n`
        )
      }
    })()
  }

  let instructions: string
  if (activeCourseId !== null) {
    const cached = courseCache[String(activeCourseId)]
    const label = cached
      ? `${cached.name} (${cached.code})${cached.term ? `, ${cached.term}` : ''}`
      : `Canvas ID ${activeCourseId}`
    instructions = [
      `Active course: ${label}, Canvas ID: ${activeCourseId}.`,
      `Do NOT call get_active_course — the active course is already known from the information above.`,
      `Do NOT call set_active_course unless the user explicitly asks to switch to a different course.`,
      `All course-specific tools default to this course when no course_id argument is provided.`,
      `IMPORTANT — student privacy blinding: get_grades and get_submission_status return student names as [STUDENT_NNN] tokens instead of real names (FERPA compliance).`,
      `This is intentional. Do NOT call these tools again trying to obtain real names — the token-to-name mapping is handled automatically by the client after you respond.`,
      `When answering questions about students, reference them by their [STUDENT_NNN] token and include the relevant numeric data (scores, counts).`,
      `The user will see real names in your response — you do not need to resolve or explain the tokens.`,
    ].join(' ')
  } else {
    instructions = `No active course is set. Call set_active_course before using any course-specific tools.`
  }

  const server = new McpServer({ name: 'canvas-mcp', version: '0.1.0' }, { instructions })
  registerContextTools(server, client, configManager)
  registerReportingTools(server, client, configManager, secureStore, sidecarManager)
  registerContentTools(server, client, configManager)
  registerModuleTools(server, client, configManager, templateService)
  registerResetTools(server, client, configManager)
  registerFindTools(server, client, configManager, templateService)
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  cleanup(1)
})
