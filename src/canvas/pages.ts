import { type CanvasClient } from './client.js'

export interface CanvasPage {
  page_id: number
  url: string        // slug, e.g. "week-2-overview"
  title: string
  body: string | null
  published: boolean
}

export async function createPage(
  client: CanvasClient,
  courseId: number,
  params: { title: string; body?: string; published?: boolean }
): Promise<CanvasPage> {
  return client.post<CanvasPage>(
    `/api/v1/courses/${courseId}/pages`,
    { wiki_page: params }
  )
}

export async function getPage(
  client: CanvasClient,
  courseId: number,
  pageUrl: string
): Promise<CanvasPage> {
  return client.getOne<CanvasPage>(`/api/v1/courses/${courseId}/pages/${pageUrl}`)
}
