import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const FILENAME = 'zoom-name-map.json'

/**
 * Persistent map from Zoom display names (lowercased) to Canvas user IDs.
 *
 * Backed by a JSON file at `<dir>/zoom-name-map.json`. Keys are always stored
 * and looked up in lowercase for case-insensitive matching.
 */
export class ZoomNameMap {
  private map = new Map<string, number>()

  /** Look up the Canvas user ID for a Zoom display name (case-insensitive). */
  get(zoomName: string): number | undefined {
    return this.map.get(zoomName.toLowerCase())
  }

  /** Associate a Zoom display name with a Canvas user ID (stored lowercase). */
  set(zoomName: string, canvasUserId: number): void {
    this.map.set(zoomName.toLowerCase(), canvasUserId)
  }

  /**
   * Load the map from `<dir>/zoom-name-map.json`.
   * If the file does not exist, the map is left empty (no error).
   */
  async load(dir: string): Promise<void> {
    const filePath = path.join(dir, FILENAME)
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const obj = JSON.parse(raw) as Record<string, number>
      this.map = new Map(Object.entries(obj))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.map = new Map()
        return
      }
      throw err
    }
  }

  /** Save the map as pretty-printed JSON to `<dir>/zoom-name-map.json`. Creates the directory if needed. */
  async save(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, FILENAME)
    const obj = Object.fromEntries(this.map)
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  }
}
