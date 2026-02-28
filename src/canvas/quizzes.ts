import { type CanvasClient } from './client.js'

export interface CanvasQuiz {
  id: number
  title: string
  quiz_type: 'practice_quiz' | 'assignment' | 'graded_survey' | 'survey'
  points_possible: number | null
  due_at: string | null
  time_limit: number | null
  allowed_attempts: number
  assignment_group_id: number | null
  published: boolean
  html_url: string
}

export interface CanvasQuizQuestion {
  id: number
  quiz_id: number
  question_name: string
  question_text: string
  question_type: string
  points_possible: number
  position: number
}

export interface CreateQuizParams {
  title: string
  quiz_type: 'practice_quiz' | 'assignment' | 'graded_survey' | 'survey'
  points_possible?: number
  due_at?: string
  time_limit?: number
  allowed_attempts?: number
  assignment_group_id?: number
  published?: boolean
}

export interface UpdateQuizParams {
  title?: string
  quiz_type?: 'practice_quiz' | 'assignment' | 'graded_survey' | 'survey'
  points_possible?: number
  due_at?: string | null
  time_limit?: number | null
  allowed_attempts?: number
  assignment_group_id?: number
  published?: boolean
}

export interface QuizQuestionParams {
  question_name: string
  question_text: string
  question_type: string
  points_possible?: number
  answers?: Array<{ text: string; weight: number }>
}

export async function createQuiz(
  client: CanvasClient,
  courseId: number,
  params: CreateQuizParams
): Promise<CanvasQuiz> {
  return client.post<CanvasQuiz>(
    `/api/v1/courses/${courseId}/quizzes`,
    { quiz: params }
  )
}

export async function updateQuiz(
  client: CanvasClient,
  courseId: number,
  quizId: number,
  params: UpdateQuizParams
): Promise<CanvasQuiz> {
  return client.put<CanvasQuiz>(
    `/api/v1/courses/${courseId}/quizzes/${quizId}`,
    { quiz: params }
  )
}

export async function createQuizQuestion(
  client: CanvasClient,
  courseId: number,
  quizId: number,
  params: QuizQuestionParams
): Promise<CanvasQuizQuestion> {
  return client.post<CanvasQuizQuestion>(
    `/api/v1/courses/${courseId}/quizzes/${quizId}/questions`,
    { question: params }
  )
}

export async function listQuizzes(
  client: CanvasClient,
  courseId: number
): Promise<CanvasQuiz[]> {
  return client.get<CanvasQuiz>(
    `/api/v1/courses/${courseId}/quizzes`,
    { per_page: '100' }
  )
}

export async function getQuiz(
  client: CanvasClient,
  courseId: number,
  quizId: number
): Promise<CanvasQuiz> {
  return client.getOne<CanvasQuiz>(
    `/api/v1/courses/${courseId}/quizzes/${quizId}`
  )
}

export async function listQuizQuestions(
  client: CanvasClient,
  courseId: number,
  quizId: number
): Promise<CanvasQuizQuestion[]> {
  return client.get<CanvasQuizQuestion>(
    `/api/v1/courses/${courseId}/quizzes/${quizId}/questions`
  )
}

export async function deleteQuiz(
  client: CanvasClient,
  courseId: number,
  quizId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/quizzes/${quizId}`)
}
