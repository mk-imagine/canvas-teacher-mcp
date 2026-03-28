import { describe, it, expect, vi, afterEach } from 'vitest'
import { migrateZoomNameMap } from '../../../src/attendance/migration.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

describe('migrateZoomNameMap', () => {
  let tempDir: string

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true })
    vi.restoreAllMocks()
  })

  it('successful migration: migrates all entries and deletes file', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'))

    const nameMap = { alice_zoom: 1, bob_zoom: 2 }
    await fs.writeFile(path.join(tempDir, 'zoom-name-map.json'), JSON.stringify(nameMap))

    const mockStore = {
      findByCanvasUserId: vi.fn(async (id: number) => {
        if (id === 1 || id === 2) return { canvasUserId: id }
        return undefined
      }),
      appendZoomAlias: vi.fn(async () => {}),
    }

    const result = await migrateZoomNameMap(tempDir, mockStore)

    expect(result).toEqual({ migrated: 2, deleted: true })
    expect(mockStore.appendZoomAlias).toHaveBeenCalledWith(1, 'alice_zoom')
    expect(mockStore.appendZoomAlias).toHaveBeenCalledWith(2, 'bob_zoom')

    await expect(fs.access(path.join(tempDir, 'zoom-name-map.json'))).rejects.toThrow()
  })

  it('missing file: returns zero migrated and deleted false without calling store', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'))

    const mockStore = {
      findByCanvasUserId: vi.fn(async (_id: number) => undefined),
      appendZoomAlias: vi.fn(async () => {}),
    }

    const result = await migrateZoomNameMap(tempDir, mockStore)

    expect(result).toEqual({ migrated: 0, deleted: false })
    expect(mockStore.findByCanvasUserId).not.toHaveBeenCalled()
  })

  it('unknown userId: skips unknown, migrates known, writes to stderr, deletes file', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'))

    const nameMap = { alice_zoom: 1, unknown_zoom: 999 }
    await fs.writeFile(path.join(tempDir, 'zoom-name-map.json'), JSON.stringify(nameMap))

    const mockStore = {
      findByCanvasUserId: vi.fn(async (id: number) => {
        if (id === 1) return { canvasUserId: 1 }
        return undefined
      }),
      appendZoomAlias: vi.fn(async () => {}),
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = await migrateZoomNameMap(tempDir, mockStore)

    expect(result).toEqual({ migrated: 1, deleted: true })
    expect(mockStore.appendZoomAlias).toHaveBeenCalledTimes(1)
    expect(mockStore.appendZoomAlias).toHaveBeenCalledWith(1, 'alice_zoom')

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('999')
    expect(stderrOutput).toContain('unknown_zoom')

    await expect(fs.access(path.join(tempDir, 'zoom-name-map.json'))).rejects.toThrow()
  })
})
