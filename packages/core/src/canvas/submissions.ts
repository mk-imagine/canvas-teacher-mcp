import { type CanvasClient } from './client.js'

export interface CanvasSubmission {
  id: number
  assignment_id: number
  user_id: number
  score: number | null
  submitted_at: string | null
  graded_at: string | null
  late: boolean
  missing: boolean
  workflow_state: 'submitted' | 'unsubmitted' | 'graded' | 'pending_review'
  assignment?: {
    id: number
    name: string
    points_possible: number
    due_at: string | null
    assignment_group_id?: number
  }
  user?: {
    id: number
    name: string
    sortable_name: string
  }
}

export interface CanvasEnrollment {
  id: number
  user_id: number
  user: {
    id: number
    name: string
    sortable_name: string
    login_id?: string
  }
  type: 'StudentEnrollment' | 'TeacherEnrollment' | 'TaEnrollment'
  enrollment_state: 'active' | 'invited' | 'completed' | 'inactive'
  course_section_id: number
  grades: {
    current_score: number | null
    current_grade: string | null
    final_score: number | null
    final_grade: string | null
  }
}

export interface CanvasAssignment {
  id: number
  name: string
  points_possible: number
  due_at: string | null
  html_url: string
  description?: string
}

export interface CanvasAssignmentGroup {
  id: number
  name: string
  group_weight: number
  rules: Record<string, unknown>
}

export async function fetchStudentEnrollments(
  client: CanvasClient,
  courseId: number
): Promise<CanvasEnrollment[]> {
  return client.get<CanvasEnrollment>(`/api/v1/courses/${courseId}/enrollments`, {
    'type[]': 'StudentEnrollment',
    per_page: '100',
  })
}

/**
 * Returns the set of section IDs where the current user is enrolled as a
 * Teacher or TA for the given course. Used to scope roster sync and
 * attendance matching to only the teacher's own sections, excluding
 * cross-listed sections taught by other instructors.
 */
export async function fetchTeacherSectionIds(
  client: CanvasClient,
  courseId: number
): Promise<Set<number>> {
  const enrollments = await client.getWithArrayParams<CanvasEnrollment>(
    `/api/v1/courses/${courseId}/enrollments`,
    {
      'type[]': ['TeacherEnrollment', 'TaEnrollment'],
      user_id: 'self',
      per_page: '100',
    }
  )
  return new Set(enrollments.map((e) => e.course_section_id))
}

export async function fetchAllSubmissions(
  client: CanvasClient,
  courseId: number,
  options?: { workflowState?: string }
): Promise<CanvasSubmission[]> {
  const params: Record<string, string | string[]> = {
    'student_ids[]': 'all',
    'include[]': ['assignment', 'user'],
    per_page: '100',
  }
  if (options?.workflowState) {
    params['workflow_state'] = options.workflowState
  }
  return client.getWithArrayParams<CanvasSubmission>(
    `/api/v1/courses/${courseId}/students/submissions`,
    params
  )
}

export async function fetchStudentSubmissions(
  client: CanvasClient,
  courseId: number,
  studentId: number
): Promise<CanvasSubmission[]> {
  return client.getWithArrayParams<CanvasSubmission>(
    `/api/v1/courses/${courseId}/students/submissions`,
    {
      'student_ids[]': String(studentId),
      'include[]': 'assignment',
      per_page: '100',
    }
  )
}

export async function fetchAssignmentSubmissions(
  client: CanvasClient,
  courseId: number,
  assignmentId: number
): Promise<CanvasSubmission[]> {
  return client.get<CanvasSubmission>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
    { 'include[]': 'user', per_page: '100' }
  )
}

export async function fetchAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number
): Promise<CanvasAssignment> {
  return client.getOne<CanvasAssignment>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}`
  )
}

export async function fetchAssignmentGroups(
  client: CanvasClient,
  courseId: number
): Promise<CanvasAssignmentGroup[]> {
  return client.get<CanvasAssignmentGroup>(
    `/api/v1/courses/${courseId}/assignment_groups`,
    { per_page: '100' }
  )
}

export async function gradeSubmission(
  client: CanvasClient,
  courseId: number,
  assignmentId: number,
  userId: number,
  score: number
): Promise<CanvasSubmission> {
  return client.put<CanvasSubmission>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
    { submission: { posted_grade: String(score) } }
  )
}
