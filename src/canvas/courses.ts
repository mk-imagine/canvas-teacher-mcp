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

export async function fetchTeacherCourses(client: CanvasClient): Promise<CanvasCourse[]> {
  return client.get<CanvasCourse>('/api/v1/courses', {
    enrollment_type: 'teacher',
    'include[]': 'term',
    per_page: '100',
  })
}
