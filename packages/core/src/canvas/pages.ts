import { type CanvasClient } from './client.js'

export interface CanvasPage {
  page_id: number
  url: string        // slug, e.g. "week-2-overview"
  title: string
  body: string | null
  published: boolean
  front_page: boolean
}

/**
 * Resolves a page identifier (ID or slug) to the current URL slug.
 * This handles cases where slugs might have changed due to renaming or collisions.
 */
async function resolvePageUrl(
  client: CanvasClient,
  courseId: number,
  identifier: string | number
): Promise<string> {
  // If it's a slug (contains non-digits), use it directly
  if (typeof identifier === 'string' && /[a-zA-Z\-_]/.test(identifier)) {
    return identifier
  }

  // If it's numeric, we MUST find the current slug because the Pages API
  // uses slugs in the resource path (/courses/:id/pages/:slug).
  const pages = await listPages(client, courseId)
  const id = typeof identifier === 'number' ? identifier : parseInt(identifier, 10)
  const page = pages.find(p => p.page_id === id)
  
  if (!page) {
    throw new Error(`Page with ID ${id} not found in course ${courseId}`)
  }
  return page.url
}

export async function updatePage(
  client: CanvasClient,
  courseId: number,
  identifier: string | number,
  params: { title?: string; body?: string; published?: boolean; front_page?: boolean }
): Promise<CanvasPage> {
  const pageUrl = await resolvePageUrl(client, courseId, identifier)
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
  identifier: string | number
): Promise<void> {
  const pageUrl = await resolvePageUrl(client, courseId, identifier)
  return client.delete(`/api/v1/courses/${courseId}/pages/${pageUrl}`)
}

export async function getPage(
  client: CanvasClient,
  courseId: number,
  identifier: string | number
): Promise<CanvasPage> {
  const pageUrl = await resolvePageUrl(client, courseId, identifier)
  return client.getOne<CanvasPage>(`/api/v1/courses/${courseId}/pages/${pageUrl}`)
}

export async function searchPages(
  client: CanvasClient,
  courseId: number,
  searchTerm: string
): Promise<CanvasPage[]> {
  return client.get<CanvasPage>(
    `/api/v1/courses/${courseId}/pages`,
    { search_term: searchTerm, per_page: '100' }
  )
}
