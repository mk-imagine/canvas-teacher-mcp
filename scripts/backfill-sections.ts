/**
 * scripts/backfill-sections.ts
 *
 * One-shot backfill: populate sectionIds on existing RosterStudent records.
 *
 * For each course ID present in roster.json, queries Canvas for the teacher's
 * own sections and the filtered student enrollments. Each matching student's
 * record gets their course_section_id added to sectionIds (deduped).
 *
 * Runs read-mostly against Canvas (two paginated enrollment calls per course)
 * and a single write to roster.json at the end.
 *
 * Students whose canvasUserId no longer appears in the teacher's sections are
 * NOT modified — they keep their empty sectionIds field. A future sync will
 * reconcile.
 *
 * Usage:
 *   npx tsx scripts/backfill-sections.ts --config <path>
 *
 * The legacy zoom-name-map.json.legacy is untouched.
 */

import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import {
  ConfigManager,
  CanvasClient,
  RosterStore,
  fetchStudentEnrollments,
  fetchTeacherSectionIds,
} from '../packages/core/src/index.js'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
  },
  strict: true,
})

const configPath = values.config
if (!configPath) {
  process.stderr.write('Usage: npx tsx scripts/backfill-sections.ts --config <path>\n')
  process.exit(1)
}

const configDir = dirname(configPath)

async function main() {
  const configManager = new ConfigManager(configPath!)
  const config = configManager.read()
  const client = new CanvasClient(config.canvas)
  const rosterStore = new RosterStore(configDir)

  const students = await rosterStore.load()
  if (students.length === 0) {
    process.stderr.write('[backfill] roster.json is empty — nothing to backfill.\n')
    return
  }

  // Collect all distinct courseIds across all students
  const courseIds = new Set<number>()
  for (const s of students) {
    for (const id of s.courseIds) {
      courseIds.add(id)
    }
  }
  process.stderr.write(
    `[backfill] Processing ${students.length} students across ${courseIds.size} course(s): ` +
      `${[...courseIds].join(', ')}\n`,
  )

  // Per course: fetch teacher sections + filtered enrollments, build user -> section map
  const userSectionsByCourse = new Map<number, Map<number, number>>()
  for (const courseId of courseIds) {
    process.stderr.write(`[backfill] Course ${courseId}: fetching teacher sections...\n`)
    const teacherSections = await fetchTeacherSectionIds(client, courseId)
    if (teacherSections.size === 0) {
      process.stderr.write(`[backfill]   (no teacher sections — skipping course)\n`)
      continue
    }
    process.stderr.write(
      `[backfill]   Teacher owns sections: ${[...teacherSections].join(', ')}\n`,
    )

    const allEnrollments = await fetchStudentEnrollments(client, courseId)
    const filtered = allEnrollments.filter((e) => teacherSections.has(e.course_section_id))
    const userToSection = new Map<number, number>()
    for (const e of filtered) {
      userToSection.set(e.user_id, e.course_section_id)
    }
    userSectionsByCourse.set(courseId, userToSection)
    process.stderr.write(`[backfill]   ${filtered.length} students in teacher sections\n`)
  }

  // Apply to roster: for each student, for each courseId they're in,
  // look up their section and add to sectionIds (deduped).
  let updated = 0
  let skipped = 0
  for (const s of students) {
    const before = s.sectionIds.slice()
    const newSectionIds = new Set<number>(s.sectionIds)
    for (const courseId of s.courseIds) {
      const userSections = userSectionsByCourse.get(courseId)
      if (!userSections) continue
      const sectionId = userSections.get(s.canvasUserId)
      if (sectionId === undefined) continue
      newSectionIds.add(sectionId)
    }
    s.sectionIds = [...newSectionIds].sort((a, b) => a - b)
    if (s.sectionIds.length === before.length && s.sectionIds.every((id, i) => id === before[i])) {
      skipped++
    } else {
      updated++
      process.stderr.write(
        `  + ${s.name} (${s.canvasUserId}): sectionIds ${JSON.stringify(before)} -> ${JSON.stringify(s.sectionIds)}\n`,
      )
    }
  }

  // Persist
  await rosterStore.save(students)

  process.stderr.write(
    `\n[backfill] Done. updated: ${updated}, unchanged: ${skipped}, total: ${students.length}\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
