import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { type CanvasTeacherConfig, type DeepPartial, DEFAULT_CONFIG } from './schema.js'

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as Array<keyof T>) {
    const overrideVal = override[key]
    if (overrideVal === undefined) continue
    const baseVal = base[key]
    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === 'object' &&
      overrideVal !== null &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(baseVal as object, overrideVal as object) as T[keyof T]
    } else {
      result[key] = overrideVal as T[keyof T]
    }
  }
  return result
}

export class ConfigManager {
  private readonly configPath: string

  constructor(configPath?: string) {
    this.configPath =
      configPath ??
      join(homedir(), '.config', 'mcp', 'canvas-mcp', 'config.json')
  }

  read(): CanvasTeacherConfig {
    let raw: DeepPartial<CanvasTeacherConfig> = {}
    const fileExists = existsSync(this.configPath)
    if (fileExists) {
      const content = readFileSync(this.configPath, 'utf-8')
      raw = JSON.parse(content) as DeepPartial<CanvasTeacherConfig>
    }

    // Migration: existing configs without a `privacy` key were on always-on blinding (Phase 6).
    // Preserve that behaviour by enabling blinding for them.
    const needsMigration = fileExists && raw.privacy === undefined
    if (needsMigration) {
      raw.privacy = { blindingEnabled: true }
    }

    const config = deepMerge(DEFAULT_CONFIG, raw)

    // Expand ~ in sidecarPath
    config.privacy.sidecarPath = expandHome(config.privacy.sidecarPath)

    if (needsMigration) {
      // Write the migrated privacy block to disk so future reads don't re-run migration
      try {
        this.write(config)
      } catch {
        // Non-fatal — migration will re-run next time, but blinding is still active
      }
    }

    if (!config.canvas.instanceUrl) {
      throw new ConfigError(
        `canvas.instanceUrl is not configured. Set it in ${this.configPath}.`
      )
    }
    if (!config.canvas.apiToken) {
      throw new ConfigError(
        `canvas.apiToken is not configured. Set it in ${this.configPath}.`
      )
    }

    return config
  }

  write(config: CanvasTeacherConfig): void {
    const dir = dirname(this.configPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  getConfigDir(): string {
    return dirname(this.configPath)
  }

  update(patch: DeepPartial<CanvasTeacherConfig>): CanvasTeacherConfig {
    const current = this.read()
    const updated = deepMerge(current, patch)
    this.write(updated)
    return updated
  }
}
