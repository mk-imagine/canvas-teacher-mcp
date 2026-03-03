import { type CanvasClient } from './client.js'

export interface CanvasSmartSearchResult {
  content_id: number
  content_type: string
  title: string
  body: string
  html_url: string
  distance: number
  readable_id?: string
  published?: boolean
  due_at?: string | null
}

export async function smartSearch(
  client: CanvasClient,
  courseId: number,
  query: string,
  options?: { filter?: string[]; include?: string[] }
): Promise<CanvasSmartSearchResult[]> {
  const params: Record<string, string | string[]> = { q: query, per_page: '50' }
  if (options?.filter?.length) params['filter[]'] = options.filter
  if (options?.include?.length) params['include[]'] = options.include
  return client.getWithArrayParams<CanvasSmartSearchResult>(
    `/api/v1/courses/${courseId}/smartsearch`,
    params
  )
}
