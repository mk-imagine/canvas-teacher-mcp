import { type CanvasClient } from './client.js'

export interface CanvasCourse {
  id: number
  name: string
  course_code: string
  workflow_state: string
  term?: { name: string }
}

export async function getCourse(client: CanvasClient, courseId: number): Promise<CanvasCourse> {
  return client.getOne<CanvasCourse>(`/api/v1/courses/${courseId}`)
}

export async function updateCourse(
  client: CanvasClient,
  courseId: number,
  params: { syllabus_body?: string }
): Promise<CanvasCourse> {
  return client.put<CanvasCourse>(
    `/api/v1/courses/${courseId}`,
    { course: params }
  )
}

export async function fetchTeacherCourses(client: CanvasClient): Promise<CanvasCourse[]> {
  return client.get<CanvasCourse>('/api/v1/courses', {
    enrollment_type: 'teacher',
    'include[]': 'term',
    per_page: '100',
  })
}
