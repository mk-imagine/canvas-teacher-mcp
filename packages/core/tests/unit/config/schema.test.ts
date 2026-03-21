import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG } from '../../../src/config/schema.js'
import { ConfigManager } from '../../../src/config/manager.js'

describe('Config schema – attendance section', () => {
  const tmpDirs: string[] = []

  function makeTmpConfig(content: object): string {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
    tmpDirs.push(dir)
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify(content, null, 2), 'utf-8')
    return configPath
  }

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DEFAULT_CONFIG includes attendance with correct defaults', () => {
    expect(DEFAULT_CONFIG.attendance).toEqual({
      hostName: '',
      defaultPoints: 10,
      defaultMinDuration: 0,
    })
  })

  it('deep-merge fills attendance defaults when config file has no attendance key', () => {
    const configPath = makeTmpConfig({
      canvas: {
        instanceUrl: 'https://canvas.example.com',
        apiToken: 'test-token',
      },
    })
    const manager = new ConfigManager(configPath)
    const config = manager.read()

    expect(config.attendance).toEqual({
      hostName: '',
      defaultPoints: 10,
      defaultMinDuration: 0,
    })
  })

  it('deep-merge preserves user-supplied attendance values', () => {
    const configPath = makeTmpConfig({
      canvas: {
        instanceUrl: 'https://canvas.example.com',
        apiToken: 'test-token',
      },
      attendance: {
        hostName: 'Prof Smith',
        defaultPoints: 5,
        defaultMinDuration: 3,
      },
    })
    const manager = new ConfigManager(configPath)
    const config = manager.read()

    expect(config.attendance).toEqual({
      hostName: 'Prof Smith',
      defaultPoints: 5,
      defaultMinDuration: 3,
    })
  })

  it('deep-merge fills missing attendance fields with defaults', () => {
    const configPath = makeTmpConfig({
      canvas: {
        instanceUrl: 'https://canvas.example.com',
        apiToken: 'test-token',
      },
      attendance: {
        hostName: 'Dr. Jones',
      },
    })
    const manager = new ConfigManager(configPath)
    const config = manager.read()

    expect(config.attendance.hostName).toBe('Dr. Jones')
    expect(config.attendance.defaultPoints).toBe(10)
    expect(config.attendance.defaultMinDuration).toBe(0)
  })
})
