import { vi, describe, it, expect, beforeEach } from 'vitest'
import { syncRosterFromEnrollments } from '../../../src/roster/sync.js'
import type { RosterStudent } from '../../../src/roster/types.js'

// Mock fetchStudentEnrollments + fetchTeacherSectionIds
vi.mock('../../../src/canvas/submissions.js', () => ({
  fetchStudentEnrollments: vi.fn(),
  fetchTeacherSectionIds: vi.fn(),
}))

import { fetchStudentEnrollments, fetchTeacherSectionIds } from '../../../src/canvas/submissions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SECTION = 500

function makeEnrollment(
  userId: number,
  name: string,
  sortableName: string,
  loginId?: string,
  sectionId: number = DEFAULT_SECTION,
) {
  return {
    id: userId * 100,
    user_id: userId,
    user: {
      id: userId,
      name,
      sortable_name: sortableName,
      login_id: loginId,
    },
    type: 'StudentEnrollment' as const,
    enrollment_state: 'active' as const,
    course_section_id: sectionId,
    grades: { current_score: null, current_grade: null, final_score: null, final_grade: null },
  }
}

function makeStudent(partial: Partial<RosterStudent> & { canvasUserId: number }): RosterStudent {
  return {
    name: 'Default Name',
    sortable_name: 'Name, Default',
    emails: [],
    courseIds: [],
    sectionIds: [],
    zoomAliases: [],
    created: '2025-01-01T00:00:00.000Z',
    ...partial,
  }
}

/**
 * Creates a mock RosterStore backed by an in-memory array.
 * Reflects actual mutations so tests can inspect final state via allStudents().
 */
function makeMockStore(initial: RosterStudent[] = []) {
  let students: RosterStudent[] = initial.map((s) => ({ ...s }))

  const load = vi.fn(async () => students.map((s) => ({ ...s })))

  const upsertStudent = vi.fn(async (student: RosterStudent) => {
    const idx = students.findIndex((s) => s.canvasUserId === student.canvasUserId)
    if (idx >= 0) {
      students.splice(idx, 1, { ...student })
    } else {
      students.push({ ...student })
    }
  })

  const removeStudentCourseId = vi.fn(async (canvasUserId: number, courseId: number) => {
    const idx = students.findIndex((s) => s.canvasUserId === canvasUserId)
    if (idx < 0) return false
    const s = students[idx]
    s.courseIds = s.courseIds.filter((id) => id !== courseId)
    if (s.courseIds.length === 0) {
      students.splice(idx, 1)
    }
    return true
  })

  const allStudents = vi.fn(async (courseId: number) => students.filter((s) => s.courseIds.includes(courseId)).map((s) => ({ ...s })))

  return { load, upsertStudent, removeStudentCourseId, allStudents, _students: () => students }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const mockClient = {} as never

describe('syncRosterFromEnrollments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: teacher owns DEFAULT_SECTION so all default-section enrollments pass the filter.
    vi.mocked(fetchTeacherSectionIds).mockResolvedValue(new Set([DEFAULT_SECTION]))
  })

  // -------------------------------------------------------------------------
  // Positive: basic 3-enrollment sync
  // -------------------------------------------------------------------------
  it('creates 3 new students from enrollments, setting emails from login_id', async () => {
    const enrollments = [
      makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu'),
      makeEnrollment(20, 'Bob', 'Bob, B', 'bob@uni.edu'),
      makeEnrollment(30, 'Charlie', 'Charlie, C', undefined),
    ]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const store = makeMockStore([])
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    expect(result).toHaveLength(3)

    const alice = result.find((s) => s.canvasUserId === 10)!
    expect(alice.name).toBe('Alice')
    expect(alice.emails).toEqual(['alice@uni.edu'])
    expect(alice.courseIds).toContain(101)

    const charlie = result.find((s) => s.canvasUserId === 30)!
    expect(charlie.emails).toEqual([])
    expect(charlie.courseIds).toContain(101)
  })

  // -------------------------------------------------------------------------
  // Positive: idempotency — second sync with same enrollments
  // -------------------------------------------------------------------------
  it('is idempotent: re-syncing same enrollments does not duplicate courseIds or emails', async () => {
    const enrollments = [
      makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu'),
      makeEnrollment(20, 'Bob', 'Bob, B', 'bob@uni.edu'),
    ]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    // Start with roster already populated from a prior sync
    const initial = [
      makeStudent({ canvasUserId: 10, name: 'Alice', sortable_name: 'Alice, A', emails: ['alice@uni.edu'], courseIds: [101] }),
      makeStudent({ canvasUserId: 20, name: 'Bob', sortable_name: 'Bob, B', emails: ['bob@uni.edu'], courseIds: [101] }),
    ]
    const store = makeMockStore(initial)
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    const alice = result.find((s) => s.canvasUserId === 10)!
    expect(alice.courseIds.filter((id) => id === 101)).toHaveLength(1)
    expect(alice.emails.filter((e) => e === 'alice@uni.edu')).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Positive: removal reconciliation — Bob no longer enrolled
  // -------------------------------------------------------------------------
  it('removes courseId from a student who is no longer enrolled', async () => {
    // Only Alice is enrolled now; Bob was previously enrolled
    const enrollments = [makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu')]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const initial = [
      makeStudent({ canvasUserId: 10, name: 'Alice', sortable_name: 'Alice, A', emails: ['alice@uni.edu'], courseIds: [101] }),
      makeStudent({ canvasUserId: 20, name: 'Bob', sortable_name: 'Bob, B', emails: ['bob@uni.edu'], courseIds: [101, 200] }),
    ]
    const store = makeMockStore(initial)
    await syncRosterFromEnrollments(store as never, mockClient, 101)

    expect(store.removeStudentCourseId).toHaveBeenCalledWith(20, 101)
  })

  // -------------------------------------------------------------------------
  // Positive: Bob's record is retained even after courseId removal
  // -------------------------------------------------------------------------
  it('retains student record in roster after removing one of multiple courseIds', async () => {
    const enrollments = [makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu')]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const initial = [
      makeStudent({ canvasUserId: 10, name: 'Alice', sortable_name: 'Alice, A', emails: ['alice@uni.edu'], courseIds: [101] }),
      makeStudent({ canvasUserId: 20, name: 'Bob', sortable_name: 'Bob, B', emails: ['bob@uni.edu'], courseIds: [101, 200] }),
    ]
    const store = makeMockStore(initial)
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    // Result is scoped to course 101 — Bob was removed from 101, so he's
    // not in the course-scoped result even though he still has course 200.
    const bob = result.find((s) => s.canvasUserId === 20)
    expect(bob).toBeUndefined()

    // Verify Bob is still in the underlying store with course 200
    const allInStore = store._students()
    const bobInStore = allInStore.find((s) => s.canvasUserId === 20)
    expect(bobInStore).toBeDefined()
    expect(bobInStore!.courseIds).not.toContain(101)
    expect(bobInStore!.courseIds).toContain(200)
  })

  // -------------------------------------------------------------------------
  // Positive: student with existing courseId 200 gains courseId 101
  // -------------------------------------------------------------------------
  it('adds new courseId to a student already in the roster', async () => {
    const enrollments = [makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu')]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const initial = [
      makeStudent({ canvasUserId: 10, name: 'Alice', sortable_name: 'Alice, A', emails: ['alice@uni.edu'], courseIds: [200] }),
    ]
    const store = makeMockStore(initial)
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    const alice = result.find((s) => s.canvasUserId === 10)!
    expect(alice.courseIds).toContain(101)
    expect(alice.courseIds).toContain(200)
  })

  // -------------------------------------------------------------------------
  // Positive: returns full allStudents result
  // -------------------------------------------------------------------------
  it('returns the result of allStudents() after sync', async () => {
    const enrollments = [makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu')]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const store = makeMockStore([])
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    expect(store.allStudents).toHaveBeenCalled()
    expect(result).toEqual(await store.allStudents(101))
  })

  // -------------------------------------------------------------------------
  // Edge: empty enrollment list clears courseId from existing students
  // -------------------------------------------------------------------------
  it('removes courseId from all students when enrollment list is empty', async () => {
    vi.mocked(fetchStudentEnrollments).mockResolvedValue([])

    const initial = [
      makeStudent({ canvasUserId: 10, name: 'Alice', sortable_name: 'Alice, A', courseIds: [101] }),
      makeStudent({ canvasUserId: 20, name: 'Bob', sortable_name: 'Bob, B', courseIds: [101, 200] }),
    ]
    const store = makeMockStore(initial)
    await syncRosterFromEnrollments(store as never, mockClient, 101)

    expect(store.removeStudentCourseId).toHaveBeenCalledWith(10, 101)
    expect(store.removeStudentCourseId).toHaveBeenCalledWith(20, 101)
  })

  // -------------------------------------------------------------------------
  // Edge: fetchStudentEnrollments throws — error propagates
  // -------------------------------------------------------------------------
  it('propagates errors thrown by fetchStudentEnrollments', async () => {
    vi.mocked(fetchStudentEnrollments).mockRejectedValue(new Error('Canvas API error'))

    const store = makeMockStore([])
    await expect(syncRosterFromEnrollments(store as never, mockClient, 101)).rejects.toThrow(
      'Canvas API error'
    )
  })

  // -------------------------------------------------------------------------
  // Edge: login_id undefined → emails is []
  // -------------------------------------------------------------------------
  it('creates student with empty emails array when login_id is undefined', async () => {
    const enrollments = [makeEnrollment(30, 'Charlie', 'Charlie, C', undefined)]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const store = makeMockStore([])
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    const charlie = result.find((s) => s.canvasUserId === 30)!
    expect(charlie.emails).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Edge: name changed on Canvas — upsertStudent updates name, preserves aliases
  // -------------------------------------------------------------------------
  it('updates name from Canvas while preserving existing zoomAliases and created timestamp', async () => {
    const enrollments = [makeEnrollment(10, 'Alice Updated', 'Updated, Alice', 'alice@uni.edu')]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const initial = [
      makeStudent({
        canvasUserId: 10,
        name: 'Alice Old',
        sortable_name: 'Old, Alice',
        emails: ['alice@uni.edu'],
        courseIds: [101],
        zoomAliases: ['alice zoom'],
        created: '2024-01-15T00:00:00.000Z',
      }),
    ]
    const store = makeMockStore(initial)
    const result = await syncRosterFromEnrollments(store as never, mockClient, 101)

    const alice = result.find((s) => s.canvasUserId === 10)!
    expect(alice.name).toBe('Alice Updated')
    expect(alice.sortable_name).toBe('Updated, Alice')
    expect(alice.zoomAliases).toEqual(['alice zoom'])
    expect(alice.created).toBe('2024-01-15T00:00:00.000Z')
  })

  // -------------------------------------------------------------------------
  // Edge: upsertStudent call count matches enrollment count
  // -------------------------------------------------------------------------
  it('calls upsertStudent once per enrolled student', async () => {
    const enrollments = [
      makeEnrollment(10, 'Alice', 'Alice, A', 'alice@uni.edu'),
      makeEnrollment(20, 'Bob', 'Bob, B', 'bob@uni.edu'),
      makeEnrollment(30, 'Charlie', 'Charlie, C', undefined),
    ]
    vi.mocked(fetchStudentEnrollments).mockResolvedValue(enrollments)

    const store = makeMockStore([])
    await syncRosterFromEnrollments(store as never, mockClient, 101)

    expect(store.upsertStudent).toHaveBeenCalledTimes(3)
  })
})
