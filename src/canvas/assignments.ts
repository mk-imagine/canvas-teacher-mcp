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
  rubric_settings?: { id: number; points_possible: number }
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

export async function listAssignments(
  client: CanvasClient,
  courseId: number
): Promise<CanvasAssignmentFull[]> {
  return client.get<CanvasAssignmentFull>(
    `/api/v1/courses/${courseId}/assignments`,
    { per_page: '100' }
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

export interface CanvasAssignmentGroup {
  id: number
  name: string
  position: number
  group_weight: number
}

export async function listAssignmentGroups(
  client: CanvasClient,
  courseId: number
): Promise<CanvasAssignmentGroup[]> {
  return client.get<CanvasAssignmentGroup>(
    `/api/v1/courses/${courseId}/assignment_groups`,
    { per_page: '100' }
  )
}

export async function deleteAssignmentGroup(
  client: CanvasClient,
  courseId: number,
  groupId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/assignment_groups/${groupId}`)
}

export async function deleteAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number
): Promise<void> {
  // Pre-delete any associated rubric — Canvas returns 500 when deleting
  // orphaned rubrics whose assignment was already deleted.
  const assignment = await getAssignment(client, courseId, assignmentId)
  if (assignment.rubric_settings?.id) {
    await client.delete(`/api/v1/courses/${courseId}/rubrics/${assignment.rubric_settings.id}`)
  }
  return client.delete(`/api/v1/courses/${courseId}/assignments/${assignmentId}`)
}
