import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { ConfigManager } from '@canvas-mcp/core'

describe('ConfigManager.getConfigDir', () => {
  let tempDir: string
  let configPath: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `config-test-${randomBytes(4).toString('hex')}`)
    mkdirSync(tempDir, { recursive: true })
    configPath = join(tempDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        canvas: {
          instanceUrl: 'https://canvas.example.com',
          apiToken: 'test-token',
        },
      }),
      'utf-8'
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns the directory containing the config file', () => {
    const manager = new ConfigManager(configPath)
    expect(manager.getConfigDir()).toBe(tempDir)
  })

  it('returns the directory for a nested config path', () => {
    const nestedDir = join(tempDir, 'sub', 'dir')
    mkdirSync(nestedDir, { recursive: true })
    const nestedConfig = join(nestedDir, 'config.json')
    writeFileSync(
      nestedConfig,
      JSON.stringify({
        canvas: {
          instanceUrl: 'https://canvas.example.com',
          apiToken: 'test-token',
        },
      }),
      'utf-8'
    )
    const manager = new ConfigManager(nestedConfig)
    expect(manager.getConfigDir()).toBe(nestedDir)
  })
})
