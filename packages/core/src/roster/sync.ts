import { type RosterStore } from './store.js'
import type { RosterStudent } from './types.js'
import { type CanvasClient } from '../canvas/client.js'
import { fetchStudentEnrollments, fetchTeacherSectionIds } from '../canvas/submissions.js'
import { type ConflictStore } from './conflicts.js'

/**
 * Syncs the shared roster from Canvas enrollments for a given course.
 *
 * Section scoping: only students enrolled in sections the current teacher
 * actually teaches are included. Cross-listed sections taught by other
 * instructors are filtered out. The teacher's sections are auto-detected
 * via `fetchTeacherSectionIds`.
 *
 * For each enrolled student (after section filter):
 *   - Existing record: name/sortable_name refreshed from Canvas, login_id
 *     merged into emails (deduped), courseId added to courseIds (deduped),
 *     section_id added to sectionIds (deduped). Existing zoomAliases and
 *     created timestamp are preserved.
 *   - New record: fresh record with the above fields populated.
 *
 * Students previously in the roster for this course who no longer appear in
 * the filtered enrollment list get the courseId removed (existing behavior).
 * Section IDs accumulate and are not pruned by sync — they are informational
 * and the authoritative filter for attendance uses fresh Canvas data.
 *
 * If a `conflictStore` is provided, alias/name collisions are detected and
 * recorded: when a newly-synced student's canonical name (or a token of it)
 * matches an existing alias that points to a different user, the conflict is
 * persisted so attendance import can route that alias to review.
 *
 * Returns the full roster (scoped to this course) after all mutations.
 */
export async function syncRosterFromEnrollments(
  rosterStore: RosterStore,
  client: CanvasClient,
  courseId: number,
  conflictStore?: ConflictStore
): Promise<RosterStudent[]> {
  const teacherSections = await fetchTeacherSectionIds(client, courseId)

  if (teacherSections.size === 0) {
    process.stderr.write(
      `[roster] Teacher has no sections in course ${courseId} — skipping sync.\n`
    )
    return rosterStore.allStudents(courseId)
  }

  const allEnrollments = await fetchStudentEnrollments(client, courseId)
  const enrollments = allEnrollments.filter((e) =>
    teacherSections.has(e.course_section_id),
  )

  const existing = await rosterStore.load()
  const existingByCanvasId = new Map<number, RosterStudent>(
    existing.map((s) => [s.canvasUserId, s]),
  )

  const enrolledIds = new Set<number>(enrollments.map((e) => e.user_id))

  // Conflict detection: new students whose canonical name (or tokens) collide
  // with an existing alias pointing to a different user.
  if (conflictStore) {
    for (const enrollment of enrollments) {
      const sNameLower = enrollment.user.name.toLowerCase()
      const sTokens = sNameLower.split(/\s+/)
      for (const other of existing) {
        if (other.canvasUserId === enrollment.user_id) continue
        for (const alias of other.zoomAliases) {
          const aLower = alias.toLowerCase()
          if (sNameLower !== aLower && !sTokens.includes(aLower)) continue
          const added = conflictStore.add({
            alias,
            aliasUserId: other.canvasUserId,
            aliasUserName: other.name,
            newUserId: enrollment.user_id,
            newUserName: enrollment.user.name,
            courseId,
            detectedAt: new Date().toISOString(),
          })
          if (added) {
            process.stderr.write(
              `[roster] Alias conflict: "${alias}" -> ${other.name} (${other.canvasUserId}), ` +
                `but new student ${enrollment.user.name} (${enrollment.user_id}) also matches. ` +
                `Attendance import will route "${alias}" to review.\n`,
            )
          }
        }
      }
    }
  }

  for (const enrollment of enrollments) {
    const { user_id, user, course_section_id } = enrollment
    const loginId = user.login_id

    const prev = existingByCanvasId.get(user_id)

    if (prev) {
      const emails = prev.emails.slice()
      if (loginId && !emails.includes(loginId)) {
        emails.push(loginId)
      }
      const courseIds = prev.courseIds.includes(courseId)
        ? prev.courseIds
        : [...prev.courseIds, courseId]
      const sectionIds = prev.sectionIds.includes(course_section_id)
        ? prev.sectionIds
        : [...prev.sectionIds, course_section_id]

      await rosterStore.upsertStudent({
        canvasUserId: user_id,
        name: user.name,
        sortable_name: user.sortable_name,
        emails,
        courseIds,
        sectionIds,
        zoomAliases: prev.zoomAliases,
        created: prev.created,
      })
    } else {
      await rosterStore.upsertStudent({
        canvasUserId: user_id,
        name: user.name,
        sortable_name: user.sortable_name,
        emails: loginId ? [loginId] : [],
        courseIds: [courseId],
        sectionIds: [course_section_id],
        zoomAliases: [],
        created: new Date().toISOString(),
      })
    }
  }

  for (const student of existing) {
    if (student.courseIds.includes(courseId) && !enrolledIds.has(student.canvasUserId)) {
      await rosterStore.removeStudentCourseId(student.canvasUserId, courseId)
    }
  }

  return rosterStore.allStudents(courseId)
}
