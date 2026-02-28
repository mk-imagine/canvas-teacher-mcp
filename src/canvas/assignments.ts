import { type CanvasClient } from './client.js'

export interface CanvasAssignmentFull {
  id: number
  name: string
  points_possible: number
  due_at: string | null
  html_url: string
  description: string | null
  submission_types: string[]
  assignment_group_id: number | null
  published: boolean
}

export interface CreateAssignmentParams {
  name: string
  points_possible: number
  due_at?: string
  submission_types?: string[]
  assignment_group_id?: number
  description?: string
  published?: boolean
}

export interface UpdateAssignmentParams {
  name?: string
  points_possible?: number
  due_at?: string | null
  submission_types?: string[]
  assignment_group_id?: number
  description?: string
  published?: boolean
}

export async function createAssignment(
  client: CanvasClient,
  courseId: number,
  params: CreateAssignmentParams
): Promise<CanvasAssignmentFull> {
  return client.post<CanvasAssignmentFull>(
    `/api/v1/courses/${courseId}/assignments`,
    { assignment: params }
  )
}

export async function updateAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number,
  params: UpdateAssignmentParams
): Promise<CanvasAssignmentFull> {
  return client.put<CanvasAssignmentFull>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}`,
    { assignment: params }
  )
}

export async function getAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number
): Promise<CanvasAssignmentFull> {
  return client.getOne<CanvasAssignmentFull>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}`
  )
}

export async function deleteAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/assignments/${assignmentId}`)
}
