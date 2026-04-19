import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const FILENAME = 'zoom-name-map.json'

// TODO: import from roster-crypto-store once available
interface RosterStore {
  findByCanvasUserId(id: number): Promise<{ canvasUserId: number } | undefined>
  appendZoomAlias(canvasUserId: number, alias: string): Promise<void>
}

export interface MigrationResult {
  migrated: number
  deleted: boolean
}

/**
 * Migrate legacy `zoom-name-map.json` into the RosterStore.
 *
 * Reads `<configDir>/zoom-name-map.json`, imports each alias into the roster
 * via `appendZoomAlias` (skipping entries whose Canvas user ID is not found),
 * deletes the file, and returns a result summary.
 *
 * If the file does not exist, returns `{ migrated: 0, deleted: false }` and
 * makes no roster calls.
 */
export async function migrateZoomNameMap(
  configDir: string,
  store: RosterStore,
): Promise<MigrationResult> {
  const filePath = path.join(configDir, FILENAME)

  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { migrated: 0, deleted: false }
    }
    throw err
  }

  const nameMap = JSON.parse(raw) as Record<string, number>
  let migrated = 0

  for (const [key, value] of Object.entries(nameMap)) {
    const found = await store.findByCanvasUserId(value)
    if (found === undefined) {
      process.stderr.write(
        `[canvas-mcp] Migration skip: zoom alias "${key}" -> userId ${value} (not in roster)\n`,
      )
      continue
    }
    await store.appendZoomAlias(value, key)
    migrated++
  }

  await fs.rename(filePath, filePath + '.legacy')

  return { migrated, deleted: true }
}
