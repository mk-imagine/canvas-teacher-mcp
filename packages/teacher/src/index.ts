import { config as loadEnv } from 'dotenv'
loadEnv()

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigManager, CanvasClient, SecureStore, SidecarManager, registerContextTools } from '@canvas-mcp/core'
import { registerReportingTools } from './tools/reporting.js'
import { registerContentTools } from './tools/content.js'
import { registerModuleTools } from './tools/modules.js'
import { registerResetTools } from './tools/reset.js'
import { registerFindTools } from './tools/find.js'

async function main() {
  const secureStore = new SecureStore()

  const configFlagIndex = process.argv.indexOf('--config')
  const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined
  const configManager = new ConfigManager(configPath)
  const config = configManager.read()

  const sidecarManager = new SidecarManager(config.privacy.sidecarPath, config.privacy.blindingEnabled)

  const cleanup = () => { sidecarManager.purge(); secureStore.destroy(); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGHUP', cleanup)
  process.on('uncaughtException', () => { cleanup() })

  const client = new CanvasClient(config.canvas)

  const { activeCourseId, courseCache } = config.program
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
  registerModuleTools(server, client, configManager)
  registerResetTools(server, client, configManager)
  registerFindTools(server, client, configManager)
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
