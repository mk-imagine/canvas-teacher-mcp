/**
 * scripts/seed-test-data.ts
 *
 * Establishes a known, reproducible state in the Canvas test environment
 * for integration testing. Run with: npm run seed
 *
 * Uses the teacher token for all content creation and grading.
 * Uses student tokens ONLY for submitting assignments and the exit card quiz.
 * After the seed runs, all subsequent integration tests use the teacher token only.
 *
 * See Section 13.2 of PLANNING.md for the full seed state table.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.test') })

// ─── Environment ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.CANVAS_INSTANCE_URL!
const TEACHER = process.env.CANVAS_API_TOKEN!
const COURSE_ID = process.env.CANVAS_TEST_COURSE_ID!
const STUDENT_TOKENS = [0, 1, 2, 3, 4].map((n) => process.env[`STUDENT${n}_API_TOKEN`]!)

const missing = [
  ['CANVAS_INSTANCE_URL', BASE_URL],
  ['CANVAS_API_TOKEN', TEACHER],
  ['CANVAS_TEST_COURSE_ID', COURSE_ID],
  ...STUDENT_TOKENS.map((t, i) => [`STUDENT${i}_API_TOKEN`, t]),
].filter(([, v]) => !v).map(([k]) => k)

if (missing.length > 0) {
  console.error(`❌  Missing .env.test variables: ${missing.join(', ')}`)
  process.exit(1)
}

// ─── Seed table ───────────────────────────────────────────────────────────────
//
// Per-student: [a1, a2, a3, submitExitCard]
// Assignment grades: number = submit + grade, null = submit (ungraded), undefined = missing
//
// All assignments have a past due date, so every submission is marked "late" by Canvas.
//
// Student 1: A1 graded 10, A2 graded 8,  A3 ungraded,  Exit submitted
// Student 2: A1 graded 7,  A2 missing,   A3 missing,   Exit not submitted
// Student 3: A1 graded 9,  A2 graded 10, A3 ungraded,  Exit submitted
// Student 4: A1 missing,   A2 missing,   A3 missing,   Exit not submitted
// Student 5: A1 graded 5,  A2 ungraded,  A3 graded 10, Exit submitted

type Grade = number | null | undefined

const SEED: Array<[Grade, Grade, Grade, boolean]> = [
  [10, 8,         null,      true],   // Student 1
  [7,  undefined, undefined, false],  // Student 2
  [9,  10,        null,      true],   // Student 3
  [undefined, undefined, undefined, false], // Student 4
  [5,  null,      10,        true],   // Student 5
]

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function makeHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function canvasGet<T>(token: string, path: string): Promise<T[]> {
  let url: string | null = `${BASE_URL}/api/v1${path}`
  const results: T[] = []
  while (url) {
    const res = await fetch(url, { headers: makeHeaders(token) })
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
    results.push(...(await res.json() as T[]))
    const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)
    url = next?.[1] ?? null
  }
  return results
}

async function canvasPost<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function canvasPut<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: 'PUT',
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function canvasDelete(token: string, path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: 'DELETE',
    headers: makeHeaders(token),
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`)
  }
}

// ─── Step 1: Get student Canvas user IDs ─────────────────────────────────────

async function getStudentIds(): Promise<number[]> {
  const users = await Promise.all(
    STUDENT_TOKENS.map((token) =>
      fetch(`${BASE_URL}/api/v1/users/self`, { headers: makeHeaders(token) })
        .then((r) => r.json() as Promise<{ id: number; name: string }>)
    )
  )
  users.forEach((u, i) => console.log(`    Student ${i + 1}: ${u.name} (id: ${u.id})`))
  return users.map((u) => u.id)
}

// ─── Step 1.5: Set locale to US English for all accounts ─────────────────────
//
// canvas.instructure.com may default to a non-English locale for accounts that
// were created without an explicit locale (e.g., via API or sign-up without
// selecting a language). Each account can only update its own locale, so we use
// each token individually. Idempotent — safe to run on every seed.

async function setLocales(studentIds: number[]): Promise<void> {
  const TARGET = 'en'

  // Teacher: already fetching self for their ID, check locale at the same time
  const teacherSelf = await fetch(`${BASE_URL}/api/v1/users/self`, {
    headers: makeHeaders(TEACHER),
  }).then((r) => r.json() as Promise<{ id: number; locale: string | null }>)

  if (teacherSelf.locale === TARGET) {
    console.log(`    Teacher (id: ${teacherSelf.id}): locale already '${TARGET}' ✓`)
  } else {
    await canvasPut(TEACHER, `/users/${teacherSelf.id}`, { user: { locale: TARGET } })
    console.log(`    Teacher (id: ${teacherSelf.id}): locale '${teacherSelf.locale ?? 'unset'}' → '${TARGET}'`)
  }

  // Students: fetch each profile with their own token to check current locale
  for (let i = 0; i < STUDENT_TOKENS.length; i++) {
    const student = await fetch(`${BASE_URL}/api/v1/users/self`, {
      headers: makeHeaders(STUDENT_TOKENS[i]),
    }).then((r) => r.json() as Promise<{ locale: string | null }>)

    if (student.locale === TARGET) {
      console.log(`    Student ${i + 1} (id: ${studentIds[i]}): locale already '${TARGET}' ✓`)
    } else {
      await canvasPut(STUDENT_TOKENS[i], `/users/${studentIds[i]}`, { user: { locale: TARGET } })
      console.log(`    Student ${i + 1} (id: ${studentIds[i]}): locale '${student.locale ?? 'unset'}' → '${TARGET}'`)
    }
  }
}

// ─── Step 2: Verify course is published ──────────────────────────────────────
//
// canvas.instructure.com free accounts cannot publish courses via the API (403).
// The course must be published manually in the Canvas UI before running this script.
// Course Settings → (right sidebar) → Publish button

async function verifyPublished(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/courses/${COURSE_ID}`, {
    headers: makeHeaders(TEACHER),
  })
  const course = (await res.json()) as { workflow_state: string; name: string }
  if (course.workflow_state === 'available') {
    console.log('    Course is published ✓')
    return
  }
  console.error(
    `\n❌  Course "${course.name}" is not published (state: ${course.workflow_state}).` +
      '\n    Students cannot submit to an unpublished course.' +
      '\n\n    To fix: go to your TEST SANDBOX course in Canvas → Settings → click "Publish" in the right sidebar.' +
      '\n    Then re-run: npm run seed\n'
  )
  process.exit(1)
}

// ─── Step 3: Accept student enrollments ──────────────────────────────────────

async function acceptEnrollments(studentIds: number[]): Promise<void> {
  for (let i = 0; i < studentIds.length; i++) {
    const enrollments = await canvasGet<{ id: number; enrollment_state: string }>(
      TEACHER,
      `/courses/${COURSE_ID}/enrollments?user_id=${studentIds[i]}`
    )

    if (enrollments.length === 0) {
      console.warn(`    Student ${i + 1}: ⚠️  not found in course enrollments`)
      continue
    }

    const { id, enrollment_state } = enrollments[0]

    if (enrollment_state === 'invited') {
      await canvasPost(STUDENT_TOKENS[i], `/courses/${COURSE_ID}/enrollments/${id}/accept`)
      console.log(`    Student ${i + 1}: accepted enrollment ${id}`)
    } else if (enrollment_state === 'active') {
      console.log(`    Student ${i + 1}: enrollment active ✓`)
    } else {
      console.warn(
        `    Student ${i + 1}: ⚠️  enrollment state is "${enrollment_state}" (expected "active")\n` +
          `           Submissions will likely fail. Log into this student account at canvas.instructure.com\n` +
          `           and manually accept the course invitation, then re-run: npm run seed`
      )
    }
  }
}

// ─── Step 4: Reset course content ────────────────────────────────────────────

async function resetCourse(): Promise<void> {
  const [modules, assignments, quizzes, pages] = await Promise.all([
    canvasGet<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/modules`),
    canvasGet<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/assignments`),
    canvasGet<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/quizzes`),
    canvasGet<{ url: string; front_page: boolean }>(TEACHER, `/courses/${COURSE_ID}/pages`),
  ])

  // Canvas forbids deleting the front page directly.
  // Unset any front page designation first, then delete.
  const frontPages = pages.filter((p) => p.front_page)
  for (const page of frontPages) {
    await canvasPut(TEACHER, `/courses/${COURSE_ID}/pages/${page.url}`, {
      wiki_page: { front_page: false },
    })
    console.log(`    Removed front page designation from: ${page.url}`)
  }

  await Promise.all([
    ...modules.map((m) => canvasDelete(TEACHER, `/courses/${COURSE_ID}/modules/${m.id}`)),
    ...assignments.map((a) => canvasDelete(TEACHER, `/courses/${COURSE_ID}/assignments/${a.id}`)),
    ...quizzes.map((q) => canvasDelete(TEACHER, `/courses/${COURSE_ID}/quizzes/${q.id}`)),
    ...pages.map((p) => canvasDelete(TEACHER, `/courses/${COURSE_ID}/pages/${p.url}`)),
  ])

  console.log(
    `    Deleted: ${modules.length} modules, ${assignments.length} assignments, ` +
      `${quizzes.length} quizzes, ${pages.length} pages`
  )
}

// ─── Step 5: Create seed content ─────────────────────────────────────────────

interface SeedContent {
  assignmentIds: [number, number, number]
  exitCardId: number
  moduleId: number
}

async function createContent(): Promise<SeedContent> {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  // Explicitly set lock_at far in the future so Canvas doesn't auto-lock the assignment
  // when due_at is in the past (which would produce a 403 on submission).
  const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

  // Use the first available assignment group (Canvas always creates a default one)
  const groups = await canvasGet<{ id: number; name: string }>(
    TEACHER,
    `/courses/${COURSE_ID}/assignment_groups`
  )
  const groupId =
    groups[0]?.id ??
    (
      await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/assignment_groups`, {
        assignment_group: { name: 'Assignments' },
      })
    ).id

  // Create 3 assignments (sequential — Canvas can have issues with parallel assignment creation)
  const assignmentBase = {
    points_possible: 10,
    due_at: twoWeeksAgo,
    lock_at: oneYearFromNow,
    submission_types: ['online_url'],
    assignment_group_id: groupId,
    published: true,
  }

  const a1 = await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/assignments`, {
    assignment: { ...assignmentBase, name: 'Week 1 | Assignment 1.1 | Seed Assignment A' },
  })
  const a2 = await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/assignments`, {
    assignment: { ...assignmentBase, name: 'Week 1 | Assignment 1.2 | Seed Assignment B' },
  })
  const a3 = await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/assignments`, {
    assignment: { ...assignmentBase, name: 'Week 1 | Assignment 1.3 | Seed Assignment C' },
  })
  console.log(`    Created assignments: ${a1.id}, ${a2.id}, ${a3.id}`)

  // Create exit card quiz (Canvas returns 200, not 201, for quiz creation)
  const exitCard = await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/quizzes`, {
    quiz: {
      title: 'Week 1 | Exit Card',
      quiz_type: 'graded_survey',
      points_possible: 1,
      due_at: twoWeeksAgo,
      published: true,
    },
  })

  // Add a question so the quiz can be submitted
  await canvasPost(TEACHER, `/courses/${COURSE_ID}/quizzes/${exitCard.id}/questions`, {
    question: {
      question_name: 'Reflection',
      question_text: 'What was the most valuable thing you learned this week?',
      question_type: 'essay_question',
      points_possible: 0,
    },
  })
  console.log(`    Created exit card quiz: ${exitCard.id}`)

  // Create module and add all items.
  // Canvas ignores published:true on POST — always creates modules as unpublished.
  // A separate PUT is required to publish after items are added.
  const module = await canvasPost<{ id: number }>(TEACHER, `/courses/${COURSE_ID}/modules`, {
    module: { name: 'Week 1: Test Module' },
  })

  const addItem = (type: string, contentId: number, title: string) =>
    canvasPost(TEACHER, `/courses/${COURSE_ID}/modules/${module.id}/items`, {
      module_item: { type, content_id: contentId, title },
    })

  await addItem('Assignment', a1.id, 'Week 1 | Assignment 1.1 | Seed Assignment A')
  await addItem('Assignment', a2.id, 'Week 1 | Assignment 1.2 | Seed Assignment B')
  await addItem('Assignment', a3.id, 'Week 1 | Assignment 1.3 | Seed Assignment C')
  await addItem('Quiz', exitCard.id, 'Week 1 | Exit Card')

  await canvasPut(TEACHER, `/courses/${COURSE_ID}/modules/${module.id}`, {
    module: { published: true },
  })
  console.log(`    Created and published module: ${module.id}`)

  return { assignmentIds: [a1.id, a2.id, a3.id], exitCardId: exitCard.id, moduleId: module.id }
}

// ─── Step 5.5: Verify student access before submitting ───────────────────────

async function verifyStudentAccess(content: SeedContent): Promise<void> {
  const firstId = content.assignmentIds[0]

  for (let i = 0; i < STUDENT_TOKENS.length; i++) {
    const token = STUDENT_TOKENS[i]

    const courseRes = await fetch(`${BASE_URL}/api/v1/courses/${COURSE_ID}`, {
      headers: makeHeaders(token),
    })

    if (!courseRes.ok) {
      console.warn(
        `    Student ${i + 1}: ✗ course → ${courseRes.status} ${await courseRes.text()}`
      )
      continue
    }

    const assignRes = await fetch(
      `${BASE_URL}/api/v1/courses/${COURSE_ID}/assignments/${firstId}`,
      { headers: makeHeaders(token) }
    )

    if (!assignRes.ok) {
      console.warn(
        `    Student ${i + 1}: ✓ course | ✗ assignment → ${assignRes.status} ${await assignRes.text()}`
      )
      continue
    }

    const assign = (await assignRes.json()) as {
      locked_for_user: boolean
      lock_explanation?: string
      submission_types: string[]
      workflow_state: string
    }

    const lockStr = assign.locked_for_user
      ? `⚠️  LOCKED — ${assign.lock_explanation ?? 'no explanation'}`
      : 'not locked'

    console.log(
      `    Student ${i + 1}: ✓ course | ✓ assignment (${assign.workflow_state}) | ` +
        `locked_for_user=${assign.locked_for_user} | types=[${assign.submission_types.join(', ')}]`
    )

    if (assign.locked_for_user) {
      console.warn(`             ${lockStr}`)
    }
  }
}

// ─── Step 6: Submit assignments and grade ─────────────────────────────────────

async function submitAndGrade(content: SeedContent, studentIds: number[]): Promise<void> {
  const { assignmentIds, exitCardId } = content

  for (let si = 0; si < SEED.length; si++) {
    const [g1, g2, g3, submitExit] = SEED[si]
    const grades: Grade[] = [g1, g2, g3]
    const studentId = studentIds[si]
    const studentToken = STUDENT_TOKENS[si]

    for (let ai = 0; ai < assignmentIds.length; ai++) {
      const grade = grades[ai]
      if (grade === undefined) {
        console.log(`    Student ${si + 1} → A${ai + 1}: missing`)
        continue
      }

      await canvasPost(studentToken, `/courses/${COURSE_ID}/assignments/${assignmentIds[ai]}/submissions`, {
        submission: {
          submission_type: 'online_url',
          url: `https://colab.research.google.com/seed-s${si + 1}-a${ai + 1}`,
        },
      })

      if (grade !== null) {
        await canvasPut(
          TEACHER,
          `/courses/${COURSE_ID}/assignments/${assignmentIds[ai]}/submissions/${studentId}`,
          { submission: { posted_grade: String(grade) } }
        )
        console.log(`    Student ${si + 1} → A${ai + 1}: submitted + graded ${grade}/10 (late)`)
      } else {
        console.log(`    Student ${si + 1} → A${ai + 1}: submitted, ungraded (late)`)
      }
    }

    // Exit card quiz submission
    if (!submitExit) {
      console.log(`    Student ${si + 1} → Exit Card: not submitted`)
      continue
    }

    try {
      const quizSub = await canvasPost<{
        quiz_submissions: Array<{ id: number; attempt: number; validation_token: string }>
      }>(studentToken, `/courses/${COURSE_ID}/quizzes/${exitCardId}/submissions`)

      const { id: subId, attempt, validation_token } = quizSub.quiz_submissions[0]

      await canvasPost(
        studentToken,
        `/courses/${COURSE_ID}/quizzes/${exitCardId}/submissions/${subId}/complete`,
        { attempt, validation_token }
      )
      console.log(`    Student ${si + 1} → Exit Card: submitted`)
    } catch (err) {
      // Non-fatal: exit card submission failure doesn't block reporting tests
      console.warn(
        `    Student ${si + 1} → Exit Card: submission failed — ${(err as Error).message}`
      )
    }
  }
}

// ─── Write seed IDs back to .env.test ────────────────────────────────────────
//
// Integration tests reference these IDs to avoid hardcoding them.
// The seed script writes them automatically after each run.

function writeSeedIds(content: SeedContent, studentIds: number[]): void {
  const envPath = resolve(process.cwd(), '.env.test')
  let envContent = readFileSync(envPath, 'utf-8')

  const updates: Record<string, string> = {
    CANVAS_TEST_MODULE_ID: String(content.moduleId),
    CANVAS_TEST_ASSIGNMENT_1_ID: String(content.assignmentIds[0]),
    CANVAS_TEST_ASSIGNMENT_2_ID: String(content.assignmentIds[1]),
    CANVAS_TEST_ASSIGNMENT_3_ID: String(content.assignmentIds[2]),
    CANVAS_TEST_EXIT_CARD_ID: String(content.exitCardId),
    CANVAS_TEST_STUDENT_IDS: studentIds.join(','),
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm')
    envContent = regex.test(envContent)
      ? envContent.replace(regex, `${key}=${value}`)
      : envContent + `\n${key}=${value}`
  }

  writeFileSync(envPath, envContent)
  console.log('\n    .env.test updated with seed content IDs:')
  for (const [key, value] of Object.entries(updates)) {
    console.log(`      ${key}=${value}`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 Seeding Canvas test environment...\n')

  console.log('Step 1: Get student Canvas user IDs')
  const studentIds = await getStudentIds()

  console.log('\nStep 1.5: Set locale to US English for all accounts')
  await setLocales(studentIds)

  console.log('\nStep 2: Verify course is published')
  await verifyPublished()

  console.log('\nStep 3: Accept student enrollments')
  await acceptEnrollments(studentIds)

  console.log('\nStep 4: Reset course content')
  await resetCourse()

  console.log('\nStep 5: Create seed content')
  const content = await createContent()

  console.log('\nStep 5.5: Verify student access to assignments')
  await verifyStudentAccess(content)

  console.log('\nStep 6: Submit and grade assignments')
  await submitAndGrade(content, studentIds)

  console.log('\nStep 7: Write seed IDs to .env.test')
  writeSeedIds(content, studentIds)

  console.log('\n✅ Seed complete.\n')
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', (err as Error).message)
  process.exit(1)
})
