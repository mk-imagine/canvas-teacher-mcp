import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigManager } from './config/manager.js'
import { CanvasClient } from './canvas/client.js'
import { SecureStore } from './security/secure-store.js'
import { registerContextTools } from './tools/context.js'
import { registerReportingTools } from './tools/reporting.js'
import { registerContentTools } from './tools/content.js'
import { registerModuleTools } from './tools/modules.js'
import { registerResetTools } from './tools/reset.js'

async function main() {
  const secureStore = new SecureStore()

  const cleanup = () => { secureStore.destroy(); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGHUP', cleanup)
  process.on('uncaughtException', () => { cleanup() })

  const configManager = new ConfigManager()
  const config = configManager.read()
  const client = new CanvasClient(config.canvas)
  const server = new McpServer({ name: 'canvas-teacher-mcp', version: '0.1.0' })
  registerContextTools(server, client, configManager)
  registerReportingTools(server, client, configManager, secureStore)
  registerContentTools(server, client, configManager)
  registerModuleTools(server, client, configManager)
  registerResetTools(server, client, configManager)
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
