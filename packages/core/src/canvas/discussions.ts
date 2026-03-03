import { type CanvasClient } from './client.js'

export interface CanvasDiscussionTopic {
  id: number
  title: string
  message: string | null
  is_announcement: boolean
  published: boolean
  assignment_id: number | null
}

export async function listDiscussionTopics(
  client: CanvasClient,
  courseId: number
): Promise<CanvasDiscussionTopic[]> {
  return client.get<CanvasDiscussionTopic>(
    `/api/v1/courses/${courseId}/discussion_topics`,
    { per_page: '100' }
  )
}

export async function listAnnouncements(
  client: CanvasClient,
  courseId: number
): Promise<CanvasDiscussionTopic[]> {
  return client.get<CanvasDiscussionTopic>(
    `/api/v1/courses/${courseId}/discussion_topics`,
    { only_announcements: 'true', per_page: '100' }
  )
}

export interface CreateDiscussionTopicParams {
  title: string
  message?: string
  is_announcement?: boolean
  published?: boolean
}

export async function createDiscussionTopic(
  client: CanvasClient,
  courseId: number,
  params: CreateDiscussionTopicParams
): Promise<CanvasDiscussionTopic> {
  return client.post<CanvasDiscussionTopic>(
    `/api/v1/courses/${courseId}/discussion_topics`,
    params
  )
}

export async function deleteDiscussionTopic(
  client: CanvasClient,
  courseId: number,
  topicId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/discussion_topics/${topicId}`)
}
