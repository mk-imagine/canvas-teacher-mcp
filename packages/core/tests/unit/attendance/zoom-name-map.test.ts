import { describe, it, expect, beforeEach } from 'vitest'
import { ZoomNameMap } from '../../../src/attendance/zoom-name-map.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

describe('ZoomNameMap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-name-map-'))
  })

  it('load() from non-existent file returns empty map', async () => {
    const map = new ZoomNameMap()
    await map.load(tmpDir)
    expect(map.get('anyone')).toBeUndefined()
  })

  it('set() + save() + load() round-trip', async () => {
    const map = new ZoomNameMap()
    map.set('alice johnson', 101)
    map.set('bob smith', 202)
    await map.save(tmpDir)

    const map2 = new ZoomNameMap()
    await map2.load(tmpDir)
    expect(map2.get('alice johnson')).toBe(101)
    expect(map2.get('bob smith')).toBe(202)
  })

  it('get() is case-insensitive (lowercased lookup)', () => {
    const map = new ZoomNameMap()
    map.set('Alice Johnson', 101)
    expect(map.get('alice johnson')).toBe(101)
    expect(map.get('ALICE JOHNSON')).toBe(101)
    expect(map.get('Alice Johnson')).toBe(101)
  })

  it('save() creates parent directory if missing', async () => {
    const nestedDir = path.join(tmpDir, 'deeply', 'nested', 'dir')
    const map = new ZoomNameMap()
    map.set('charlie', 303)
    await map.save(nestedDir)

    const filePath = path.join(nestedDir, 'zoom-name-map.json')
    expect(fs.existsSync(filePath)).toBe(true)

    // Verify round-trip through the nested dir
    const map2 = new ZoomNameMap()
    await map2.load(nestedDir)
    expect(map2.get('charlie')).toBe(303)
  })
})
