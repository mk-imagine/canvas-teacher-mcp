import { type CanvasClient } from './client.js'

export interface CanvasPage {
  page_id: number
  url: string        // slug, e.g. "week-2-overview"
  title: string
  body: string | null
  published: boolean
  front_page: boolean
}

export async function updatePage(
  client: CanvasClient,
  courseId: number,
  pageUrl: string,
  params: { title?: string; body?: string; published?: boolean; front_page?: boolean }
): Promise<CanvasPage> {
  return client.put<CanvasPage>(
    `/api/v1/courses/${courseId}/pages/${pageUrl}`,
    { wiki_page: params }
  )
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

export async function listPages(
  client: CanvasClient,
  courseId: number
): Promise<CanvasPage[]> {
  return client.get<CanvasPage>(
    `/api/v1/courses/${courseId}/pages`,
    { per_page: '100' }
  )
}

export async function deletePage(
  client: CanvasClient,
  courseId: number,
  pageUrl: string
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/pages/${pageUrl}`)
}

export async function getPage(
  client: CanvasClient,
  courseId: number,
  pageUrl: string
): Promise<CanvasPage> {
  return client.getOne<CanvasPage>(`/api/v1/courses/${courseId}/pages/${pageUrl}`)
}
