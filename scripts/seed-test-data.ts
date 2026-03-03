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
 * Refactored to use @canvas-mcp/core components for the current monorepo structure.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'

// We import from the source to avoid needing a build step for scripts,
// and to match how vitest handles the workspace.
import { 
  CanvasClient, 
  createAssignment, 
  createQuiz, 
  createQuizQuestion, 
  createModule, 
  createModuleItem,
  updateModule,
  listModules,
  listAssignments,
  listQuizzes,
  listPages,
  updatePage,
  deleteModule,
  deleteAssignment,
  deleteQuiz,
  deletePage
} from '../packages/core/src/index.js'

config({ path: resolve(process.cwd(), '.env.test') })

// ─── Environment ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.CANVAS_INSTANCE_URL!
const TEACHER_TOKEN = process.env.CANVAS_API_TOKEN!
const COURSE_ID = parseInt(process.env.CANVAS_TEST_COURSE_ID!)
const STUDENT_TOKENS = [0, 1, 2, 3, 4].map((n) => process.env[`STUDENT${n}_API_TOKEN`]!)

const missing = [
  ['CANVAS_INSTANCE_URL', BASE_URL],
  ['CANVAS_API_TOKEN', TEACHER_TOKEN],
  ['CANVAS_TEST_COURSE_ID', process.env.CANVAS_TEST_COURSE_ID],
  ...STUDENT_TOKENS.map((t, i) => [`STUDENT${i}_API_TOKEN`, t]),
].filter(([, v]) => !v).map(([k]) => k)

if (missing.length > 0) {
  console.error(`❌  Missing .env.test variables: ${missing.join(', ')}`)
  process.exit(1)
}

const teacherClient = new CanvasClient({ instanceUrl: BASE_URL, apiToken: TEACHER_TOKEN })
const studentClients = STUDENT_TOKENS.map(token => new CanvasClient({ instanceUrl: BASE_URL, apiToken: token }))

// ─── Date constants ───────────────────────────────────────────────────────────

const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const oneWeekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()

// ─── Seed table ───────────────────────────────────────────────────────────────

type Grade = number | null | undefined

const SEED: Array<[Grade, Grade, Grade, boolean]> = [
  [10, 8,         null,      true],   // Student 1
  [7,  undefined, 9,         false],  // Student 2
  [9,  10,        undefined, true],   // Student 3
  [undefined, undefined, undefined, false], // Student 4
  [5,  null,      0,         true],   // Student 5
]

// ─── Step 1: Get student Canvas user IDs ─────────────────────────────────────

async function getStudentIds(): Promise<number[]> {
  const users = await Promise.all(
    studentClients.map((client) =>
      client.getOne<{ id: number; name: string }>('/api/v1/users/self')
    )
  )
  users.forEach((u, i) => console.log(`    Student ${i + 1}: ${u.name} (id: ${u.id})`))
  return users.map((u) => u.id)
}

// ─── Step 1.5: Set locale to US English for all accounts ─────────────────────

async function setLocales(studentIds: number[]): Promise<void> {
  const TARGET = 'en'

  const teacherSelf = await teacherClient.getOne<{ id: number; locale: string | null }>('/api/v1/users/self')

  if (teacherSelf.locale === TARGET) {
    console.log(`    Teacher (id: ${teacherSelf.id}): locale already '${TARGET}' ✓`)
  } else {
    await teacherClient.put(`/api/v1/users/${teacherSelf.id}`, { user: { locale: TARGET } })
    console.log(`    Teacher (id: ${teacherSelf.id}): locale '${teacherSelf.locale ?? 'unset'}' → '${TARGET}'`)
  }

  for (let i = 0; i < studentClients.length; i++) {
    const student = await studentClients[i].getOne<{ locale: string | null }>('/api/v1/users/self')

    if (student.locale === TARGET) {
      console.log(`    Student ${i + 1} (id: ${studentIds[i]}): locale already '${TARGET}' ✓`)
    } else {
      await studentClients[i].put(`/api/v1/users/${studentIds[i]}`, { user: { locale: TARGET } })
      console.log(`    Student ${i + 1} (id: ${studentIds[i]}): locale '${student.locale ?? 'unset'}' → '${TARGET}'`)
    }
  }
}

// ─── Step 2: Verify course is published ──────────────────────────────────────

async function verifyPublished(): Promise<void> {
  const course = await teacherClient.getOne<{ workflow_state: string; name: string }>(`/api/v1/courses/${COURSE_ID}`)
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
    const enrollments = await teacherClient.get<{ id: number; enrollment_state: string }>(
      `/api/v1/courses/${COURSE_ID}/enrollments`, 
      { user_id: String(studentIds[i]) }
    )

    if (enrollments.length === 0) {
      console.warn(`    Student ${i + 1}: not found in course enrollments`)
      continue
    }

    const { id, enrollment_state } = enrollments[0]

    if (enrollment_state === 'invited') {
      await studentClients[i].post(`/api/v1/courses/${COURSE_ID}/enrollments/${id}/accept`, {})
      console.log(`    Student ${i + 1}: accepted enrollment ${id}`)
    } else if (enrollment_state === 'active') {
      console.log(`    Student ${i + 1}: enrollment active ✓`)
    } else {
      console.warn(
        `    Student ${i + 1}: enrollment state is "${enrollment_state}" (expected "active")\n` +
          `           Submissions will likely fail. Log into this student account at canvas.instructure.com\n` +
          `           and manually accept the course invitation, then re-run: npm run seed`
      )
    }
  }
}

// ─── Step 4: Reset course content ────────────────────────────────────────────

async function resetCourse(): Promise<void> {
  const [modules, assignments, quizzes, pages] = await Promise.all([
    listModules(teacherClient, COURSE_ID),
    listAssignments(teacherClient, COURSE_ID),
    listQuizzes(teacherClient, COURSE_ID),
    listPages(teacherClient, COURSE_ID),
  ])

  const frontPages = pages.filter((p) => p.front_page)
  for (const page of frontPages) {
    await updatePage(teacherClient, COURSE_ID, page.url, { front_page: false })
    console.log(`    Removed front page designation from: ${page.url}`)
  }

  await Promise.all([
    ...modules.map((m) => deleteModule(teacherClient, COURSE_ID, m.id)),
    ...assignments.map((a) => deleteAssignment(teacherClient, COURSE_ID, a.id)),
    ...quizzes.map((q) => deleteQuiz(teacherClient, COURSE_ID, q.id)),
    ...pages.map((p) => deletePage(teacherClient, COURSE_ID, p.url)),
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
  const groups = await teacherClient.get<{ id: number; name: string }>(
    `/api/v1/courses/${COURSE_ID}/assignment_groups`
  )
  const groupId =
    groups[0]?.id ??
    (
      await teacherClient.post<{ id: number }>(`/api/v1/courses/${COURSE_ID}/assignment_groups`, {
        assignment_group: { name: 'Assignments' },
      })
    ).id

  const assignmentBase = {
    points_possible: 10,
    lock_at: oneYearFromNow,
    submission_types: ['online_url'],
    assignment_group_id: groupId,
    published: true,
  }

  const a1 = await createAssignment(teacherClient, COURSE_ID, { 
    ...assignmentBase, name: 'Week 1 | Assignment 1.1 | Seed Assignment A', due_at: twoWeeksAgo 
  })
  const a2 = await createAssignment(teacherClient, COURSE_ID, { 
    ...assignmentBase, name: 'Week 1 | Assignment 1.2 | Seed Assignment B', due_at: oneWeekAgo 
  })
  const a3 = await createAssignment(teacherClient, COURSE_ID, { 
    ...assignmentBase, name: 'Week 1 | Assignment 1.3 | Seed Assignment C', due_at: oneWeekFromNow 
  })
  console.log(`    Created assignments: ${a1.id} (due 2wk ago), ${a2.id} (due 1wk ago), ${a3.id} (due 1wk from now)`)

  const exitCard = await createQuiz(teacherClient, COURSE_ID, {
    title: 'Week 1 | Exit Card',
    quiz_type: 'graded_survey',
    points_possible: 1,
    due_at: twoWeeksAgo,
    published: true,
  })

  await createQuizQuestion(teacherClient, COURSE_ID, exitCard.id, {
    question_name: 'Reflection',
    question_text: 'What was the most valuable thing you learned this week?',
    question_type: 'essay_question',
    points_possible: 0,
  })
  console.log(`    Created exit card quiz: ${exitCard.id}`)

  const module = await createModule(teacherClient, COURSE_ID, { name: 'Week 1: Test Module' })

  await createModuleItem(teacherClient, COURSE_ID, module.id, { 
    type: 'Assignment', content_id: a1.id, title: 'Week 1 | Assignment 1.1 | Seed Assignment A' 
  })
  await createModuleItem(teacherClient, COURSE_ID, module.id, { 
    type: 'Assignment', content_id: a2.id, title: 'Week 1 | Assignment 1.2 | Seed Assignment B' 
  })
  await createModuleItem(teacherClient, COURSE_ID, module.id, { 
    type: 'Assignment', content_id: a3.id, title: 'Week 1 | Assignment 1.3 | Seed Assignment C' 
  })
  await createModuleItem(teacherClient, COURSE_ID, module.id, { 
    type: 'Quiz', content_id: exitCard.id, title: 'Week 1 | Exit Card' 
  })

  await updateModule(teacherClient, COURSE_ID, module.id, { published: true })
  console.log(`    Created and published module: ${module.id}`)

  return { assignmentIds: [a1.id, a2.id, a3.id], exitCardId: exitCard.id, moduleId: module.id }
}

// ─── Step 5.5: Verify student access before submitting ───────────────────────

async function verifyStudentAccess(content: SeedContent): Promise<void> {
  const firstId = content.assignmentIds[0]

  for (let i = 0; i < studentClients.length; i++) {
    const client = studentClients[i]

    try {
      await client.getOne(`/api/v1/courses/${COURSE_ID}`)
      const assign = await client.getOne<{
        locked_for_user: boolean
        lock_explanation?: string
        submission_types: string[]
        workflow_state: string
      }>(`/api/v1/courses/${COURSE_ID}/assignments/${firstId}`)

      const lockStr = assign.locked_for_user
        ? `LOCKED — ${assign.lock_explanation ?? 'no explanation'}`
        : 'not locked'

      console.log(
        `    Student ${i + 1}: ✓ course | ✓ assignment (${assign.workflow_state}) | ` +
          `locked_for_user=${assign.locked_for_user} | types=[${assign.submission_types.join(', ')}]`
      )

      if (assign.locked_for_user) {
        console.warn(`             ${lockStr}`)
      }
    } catch (err) {
      console.warn(
        `    Student ${i + 1}: ✗ access failed → ${(err as Error).message}`
      )
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
    const studentClient = studentClients[si]

    for (let ai = 0; ai < assignmentIds.length; ai++) {
      const grade = grades[ai]
      if (grade === undefined) {
        console.log(`    Student ${si + 1} → A${ai + 1}: missing`)
        continue
      }

      await studentClient.post(`/api/v1/courses/${COURSE_ID}/assignments/${assignmentIds[ai]}/submissions`, {
        submission: {
          submission_type: 'online_url',
          url: `https://colab.research.google.com/seed-s${si + 1}-a${ai + 1}`,
        },
      })

      const timing = ai < 2 ? 'late' : 'on-time'

      if (grade !== null) {
        await teacherClient.put(
          `/api/v1/courses/${COURSE_ID}/assignments/${assignmentIds[ai]}/submissions/${studentId}`,
          { submission: { posted_grade: String(grade) } }
        )
        console.log(`    Student ${si + 1} → A${ai + 1}: submitted + graded ${grade}/10 (${timing})`)
      } else {
        console.log(`    Student ${si + 1} → A${ai + 1}: submitted, ungraded (${timing})`)
      }
    }

    if (!submitExit) {
      console.log(`    Student ${si + 1} → Exit Card: not submitted`)
      continue
    }

    try {
      const quizSub = await studentClient.post<{
        quiz_submissions: Array<{ id: number; attempt: number; validation_token: string }>
      }>(`/api/v1/courses/${COURSE_ID}/quizzes/${exitCardId}/submissions`, {})

      const { id: subId, attempt, validation_token } = quizSub.quiz_submissions[0]

      await studentClient.post(
        `/api/v1/courses/${COURSE_ID}/quizzes/${exitCardId}/submissions/${subId}/complete`,
        { attempt, validation_token }
      )
      console.log(`    Student ${si + 1} → Exit Card: submitted`)
    } catch (err) {
      console.warn(
        `    Student ${si + 1} → Exit Card: submission failed — ${(err as Error).message}`
      )
    }
  }
}

// ─── Write seed IDs back to .env.test ────────────────────────────────────────

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
  console.log('Seeding Canvas test environment...\n')

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

  console.log('\nSeed complete.\n')
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', (err as Error).message)
  process.exit(1)
})
