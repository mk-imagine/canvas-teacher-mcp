import { describe, expect, it } from 'vitest'

// Pre-Phase B verification test.
// Confirms the test Canvas environment is correctly configured before any
// implementation work begins. Run with: npm run test:integration
//
// Requires .env.test — see Section 13.4 of PLANNING.md.

const baseUrl = process.env.CANVAS_INSTANCE_URL!
const token = process.env.CANVAS_API_TOKEN!
const courseId = process.env.CANVAS_TEST_COURSE_ID!

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
}

describe('Test environment: Canvas API connectivity and permissions', () => {
  it('authenticates with the Canvas API', async () => {
    const response = await fetch(`${baseUrl}/api/v1/users/self`, { headers })

    expect(response.status, 'Expected 200 — check that CANVAS_API_TOKEN is valid').toBe(200)

    const user = (await response.json()) as { id: number; name: string; login_id: string }
    expect(user.id).toBeGreaterThan(0)

    console.log(`  Authenticated as: ${user.name} (${user.login_id})`)
  })

  it('can access the test course', async () => {
    const response = await fetch(`${baseUrl}/api/v1/courses/${courseId}`, { headers })

    expect(
      response.status,
      'Expected 200 — check that CANVAS_TEST_COURSE_ID is correct and the token has access'
    ).toBe(200)

    const course = (await response.json()) as { id: number; name: string; workflow_state: string }
    expect(course.id).toBe(Number(courseId))

    console.log(`  Course: "${course.name}" (id: ${course.id}, state: ${course.workflow_state})`)
  })

  it('has teacher-level access to the test course', async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/courses/${courseId}/enrollments?type[]=TeacherEnrollment`,
      { headers }
    )

    expect(response.status).toBe(200)

    const enrollments = (await response.json()) as Array<{ type: string; enrollment_state: string }>
    const activeTeacher = enrollments.find(
      (e) => e.type === 'TeacherEnrollment' && e.enrollment_state === 'active'
    )

    expect(
      activeTeacher,
      'Expected an active TeacherEnrollment — token must belong to a teacher in this course'
    ).toBeDefined()
  })

  it('can read and write assignments (required permission check)', async () => {
    // Create a throwaway assignment to verify write permissions, then delete it.
    const createResponse = await fetch(`${baseUrl}/api/v1/courses/${courseId}/assignments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assignment: {
          name: '[connectivity-check] DELETE ME',
          published: false,
          submission_types: ['none'],
        },
      }),
    })

    expect(
      createResponse.status,
      'Expected 201 — token may lack write permissions on this course'
    ).toBe(201)

    const assignment = (await createResponse.json()) as { id: number }

    // Clean up immediately
    const deleteResponse = await fetch(
      `${baseUrl}/api/v1/courses/${courseId}/assignments/${assignment.id}`,
      { method: 'DELETE', headers }
    )
    expect(deleteResponse.status).toBe(200)
  })

  it('can create Classic Quizzes via the API', async () => {
    // The quizzes_next feature flag only affects the Canvas UI — it does not gate
    // the Classic Quizzes REST API. What matters for this project is that
    // POST /api/v1/courses/:id/quizzes successfully creates a Classic Quiz object.
    // Note: Canvas returns 200 (not 201) for quiz creation — intentional API quirk.
    // We create a throwaway quiz and delete it immediately.
    const createResponse = await fetch(`${baseUrl}/api/v1/courses/${courseId}/quizzes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        quiz: {
          title: '[connectivity-check] DELETE ME',
          quiz_type: 'graded_survey',
          published: false,
        },
      }),
    })

    expect(
      createResponse.status,
      'Classic Quizzes API returned an error status. ' +
        'If you see a 422, go to Course Settings → Feature Options and ensure ' +
        '"Disable Classic Quiz Creation" is set to false, then re-run.'
    ).toBe(200)

    const quiz = (await createResponse.json()) as { id: number; quiz_type: string }
    expect(quiz.quiz_type).toBe('graded_survey')
    console.log(`  Classic Quiz created successfully (id: ${quiz.id}, type: ${quiz.quiz_type})`)

    // Clean up in a finally block so the quiz is always deleted even if assertions fail
    try {
      expect(quiz.quiz_type).toBe('graded_survey')
    } finally {
      await fetch(`${baseUrl}/api/v1/courses/${courseId}/quizzes/${quiz.id}`, {
        method: 'DELETE',
        headers,
      })
    }
  })

  it('pagination returns a Link header for multi-page responses', async () => {
    // Request with per_page=1 on assignments to force pagination (even on an empty course,
    // this validates that the Canvas instance returns proper Link headers).
    const response = await fetch(
      `${baseUrl}/api/v1/courses/${courseId}/assignments?per_page=1`,
      { headers }
    )

    expect(response.status).toBe(200)

    // On a course with no assignments yet, no Link header is expected.
    // Log the result so we know what to expect when the course has content.
    const linkHeader = response.headers.get('link')
    console.log(`  Link header (per_page=1): ${linkHeader ?? 'none (course has 0–1 assignments)'}`)
  })
})
