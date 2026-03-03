import { type CanvasClient } from './client.js'

export interface CanvasRubric {
  id: number
  title: string
  points_possible: number
  context_type: string
}

export interface CreateRubricRating {
  description: string
  points: number
}

export interface CreateRubricCriterion {
  description: string
  points: number
  ratings: CreateRubricRating[]
}

export interface CreateRubricParams {
  title: string
  criteria: CreateRubricCriterion[]
  assignment_id: number
  use_for_grading?: boolean
}

function convertCriteriaToCanvasFormat(
  criteria: CreateRubricCriterion[]
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i]
    const ratings: Record<string, Record<string, unknown>> = {}
    for (let j = 0; j < c.ratings.length; j++) {
      ratings[String(j)] = {
        description: c.ratings[j].description,
        points: c.ratings[j].points,
      }
    }
    result[String(i)] = {
      description: c.description,
      points: c.points,
      ratings,
    }
  }
  return result
}

export async function createRubric(
  client: CanvasClient,
  courseId: number,
  params: CreateRubricParams
): Promise<{ rubric: CanvasRubric; rubric_association: CanvasRubricAssociation }> {
  const body = {
    rubric: {
      title: params.title,
      criteria: convertCriteriaToCanvasFormat(params.criteria),
    },
    rubric_association: {
      association_id: params.assignment_id,
      association_type: 'Assignment',
      purpose: 'grading',
      use_for_grading: params.use_for_grading ?? true,
    },
  }
  return client.post<{ rubric: CanvasRubric; rubric_association: CanvasRubricAssociation }>(
    `/api/v1/courses/${courseId}/rubrics`,
    body
  )
}

export interface CanvasRubricAssociation {
  id: number
  rubric_id: number
  association_id: number
  association_type: string
  use_for_grading: boolean
  purpose: string
}

export interface CreateRubricAssociationParams {
  rubric_id: number
  assignment_id?: number
  use_for_grading?: boolean
}

export async function createRubricAssociation(
  client: CanvasClient,
  courseId: number,
  params: CreateRubricAssociationParams
): Promise<CanvasRubricAssociation> {
  const body = {
    rubric_association: {
      rubric_id: params.rubric_id,
      association_id: params.assignment_id ?? courseId,
      association_type: params.assignment_id != null ? 'Assignment' : 'Course',
      purpose: 'grading',
      use_for_grading: params.use_for_grading ?? (params.assignment_id != null),
    },
  }
  const response = await client.post<{ rubric_association: CanvasRubricAssociation }>(
    `/api/v1/courses/${courseId}/rubric_associations`,
    body
  )
  return response.rubric_association
}

export async function listRubrics(
  client: CanvasClient,
  courseId: number
): Promise<CanvasRubric[]> {
  return client.get<CanvasRubric>(
    `/api/v1/courses/${courseId}/rubrics`,
    { per_page: '100' }
  )
}

export async function deleteRubric(
  client: CanvasClient,
  courseId: number,
  rubricId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/rubrics/${rubricId}`)
}
