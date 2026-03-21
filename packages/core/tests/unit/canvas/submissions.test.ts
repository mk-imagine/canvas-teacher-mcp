import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server as mswServer } from '../../setup/msw-server.js'
import { CanvasClient, gradeSubmission, type CanvasSubmission } from '@canvas-mcp/core'

const CANVAS_URL = 'https://canvas.example.com'

const client = new CanvasClient({
  instanceUrl: CANVAS_URL,
  apiToken: 'test-token',
})

const MOCK_GRADED_SUBMISSION: CanvasSubmission = {
  id: 999,
  assignment_id: 42,
  user_id: 1001,
  score: 10,
  submitted_at: null,
  graded_at: '2026-03-21T12:00:00Z',
  late: false,
  missing: false,
  workflow_state: 'graded',
}

describe('gradeSubmission', () => {
  it('sends PUT with correct path and posted_grade body', async () => {
    let capturedBody: unknown = null

    mswServer.use(
      http.put(
        `${CANVAS_URL}/api/v1/courses/100/assignments/42/submissions/1001`,
        async ({ request }) => {
          capturedBody = await request.json()
          return HttpResponse.json(MOCK_GRADED_SUBMISSION)
        }
      )
    )

    const result = await gradeSubmission(client, 100, 42, 1001, 10)

    expect(capturedBody).toEqual({
      submission: { posted_grade: '10' },
    })
    expect(result).toEqual(MOCK_GRADED_SUBMISSION)
  })

  it('sends score as string in posted_grade', async () => {
    let capturedBody: unknown = null

    mswServer.use(
      http.put(
        `${CANVAS_URL}/api/v1/courses/100/assignments/42/submissions/1001`,
        async ({ request }) => {
          capturedBody = await request.json()
          return HttpResponse.json({ ...MOCK_GRADED_SUBMISSION, score: 7.5 })
        }
      )
    )

    await gradeSubmission(client, 100, 42, 1001, 7.5)

    expect(capturedBody).toEqual({
      submission: { posted_grade: '7.5' },
    })
  })

  it('throws on non-OK response', async () => {
    mswServer.use(
      http.put(
        `${CANVAS_URL}/api/v1/courses/100/assignments/42/submissions/9999`,
        () => HttpResponse.json({ message: 'user not found' }, { status: 404 })
      )
    )

    await expect(gradeSubmission(client, 100, 42, 9999, 10)).rejects.toThrow(
      'Canvas API error 404'
    )
  })
})
