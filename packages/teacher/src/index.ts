import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigManager, CanvasClient, SecureStore, registerContextTools } from '@canvas-mcp/core'
import { registerReportingTools } from './tools/reporting.js'
import { registerContentTools } from './tools/content.js'
import { registerModuleTools } from './tools/modules.js'
import { registerResetTools } from './tools/reset.js'
import { registerFindTools } from './tools/find.js'

async function main() {
  const secureStore = new SecureStore()

  const cleanup = () => { secureStore.destroy(); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGHUP', cleanup)
  process.on('uncaughtException', () => { cleanup() })

  const configFlagIndex = process.argv.indexOf('--config')
  const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined
  const configManager = new ConfigManager(configPath)
  const config = configManager.read()
  const client = new CanvasClient(config.canvas)
  const server = new McpServer({ name: 'canvas-teacher-mcp', version: '0.1.0' })
  registerContextTools(server, client, configManager)
  registerReportingTools(server, client, configManager, secureStore)
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
