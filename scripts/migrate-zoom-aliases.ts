/**
 * scripts/migrate-zoom-aliases.ts
 *
 * One-shot migration: reads a legacy zoom-name-map.json(.legacy) file and
 * appends each alias into the encrypted RosterStore for a given course.
 *
 * If roster.json is empty for the target course, the script syncs enrollments
 * from Canvas first.
 *
 * Usage:
 *   npx tsx scripts/migrate-zoom-aliases.ts --config <path> --course <id> [--legacy-file <path>]
 *
 * The legacy file is NOT modified or deleted.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseArgs } from 'node:util'

import {
  ConfigManager,
  CanvasClient,
  RosterStore,
  syncRosterFromEnrollments,
} from '../packages/core/src/index.js'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    course: { type: 'string' },
    'legacy-file': { type: 'string' },
  },
  strict: true,
})

const configPath = values.config
const courseId = values.course ? Number(values.course) : undefined

if (!configPath || !courseId || Number.isNaN(courseId)) {
  process.stderr.write(
    'Usage: npx tsx scripts/migrate-zoom-aliases.ts --config <path> --course <id> [--legacy-file <path>]\n',
  )
  process.exit(1)
}

const configDir = dirname(configPath)
const legacyPath = values['legacy-file'] ?? join(configDir, 'zoom-name-map.json.legacy')

async function main() {
  let legacyMap: Record<string, number>
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    legacyMap = JSON.parse(raw) as Record<string, number>
  } catch (err) {
    process.stderr.write(`Cannot read legacy file at ${legacyPath}: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const entryCount = Object.keys(legacyMap).length
  process.stderr.write(`[migrate] Read ${entryCount} entries from ${legacyPath}\n`)

  const configManager = new ConfigManager(configPath!)
  const config = configManager.read()
  const rosterStore = new RosterStore(configDir)

  let students = await rosterStore.allStudents(courseId!)
  if (students.length === 0) {
    process.stderr.write(`[migrate] Roster empty for course ${courseId} -- syncing from Canvas...\n`)
    const client = new CanvasClient(config.canvas)
    students = await syncRosterFromEnrollments(rosterStore, client, courseId!)
    process.stderr.write(`[migrate] Synced ${students.length} students into roster.\n`)
  } else {
    process.stderr.write(`[migrate] Roster has ${students.length} students for course ${courseId}.\n`)
  }

  let migrated = 0
  const skipped: Array<{ alias: string; canvasUserId: number; reason: string }> = []

  for (const [alias, canvasUserId] of Object.entries(legacyMap)) {
    const student = students.find((s) => s.canvasUserId === canvasUserId)
    if (!student) {
      skipped.push({ alias, canvasUserId, reason: 'not in roster' })
      continue
    }

    const already = student.zoomAliases.some(
      (a) => a.toLowerCase() === alias.toLowerCase(),
    )
    if (already) {
      skipped.push({ alias, canvasUserId, reason: 'already present' })
      continue
    }

    const ok = await rosterStore.appendZoomAlias(canvasUserId, alias)
    if (ok) {
      migrated++
      process.stderr.write(`  + "${alias}" -> ${student.name} (${canvasUserId})\n`)
    } else {
      skipped.push({ alias, canvasUserId, reason: 'appendZoomAlias returned false' })
    }
  }

  process.stderr.write(`\n[migrate] Done. migrated: ${migrated}, skipped: ${skipped.length}\n`)

  if (skipped.length > 0) {
    process.stderr.write('[migrate] Skipped entries:\n')
    for (const s of skipped) {
      process.stderr.write(`  x "${s.alias}" -> userId ${s.canvasUserId} (${s.reason})\n`)
    }
  }

  process.stderr.write(`\n[migrate] Legacy file left untouched at ${legacyPath}\n`)

  // Verification: re-read the encrypted roster and print students with aliases
  const verified = await rosterStore.allStudents(courseId!)
  const withAliases = verified.filter((s) => s.zoomAliases.length > 0)
  process.stderr.write(`\n[verify] Roster for course ${courseId}: ${verified.length} students, ${withAliases.length} with zoom aliases\n`)
  for (const s of withAliases) {
    process.stderr.write(`  ${s.name} (${s.canvasUserId}): [${s.zoomAliases.join(', ')}]\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
