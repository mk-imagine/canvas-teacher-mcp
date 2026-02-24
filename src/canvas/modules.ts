import { type CanvasClient } from './client.js'

export interface CanvasModule {
  id: number
  name: string
  position: number
  published: boolean
  items_count: number
  unlock_at: string | null
  prerequisite_module_ids: number[]
  require_sequential_progress: boolean
  workflow_state: 'active' | 'unpublished' | 'deleted'
}

export interface CanvasModuleItem {
  id: number
  module_id: number
  position: number
  title: string
  indent: number
  type: 'SubHeader' | 'Page' | 'Assignment' | 'Quiz' | 'ExternalUrl' | 'File' | 'Discussion'
  content_id?: number
  html_url?: string
  url?: string
  external_url?: string
  new_tab?: boolean
  published?: boolean
  completion_requirement: {
    type: 'min_score' | 'must_submit' | 'must_view' | 'must_mark_done'
    min_score?: number
    completed?: boolean
  } | null
  content_details?: {
    points_possible?: number
    due_at?: string | null
    unlock_at?: string | null
    lock_at?: string | null
    locked_for_user?: boolean
  }
}

export async function listModules(
  client: CanvasClient,
  courseId: number
): Promise<CanvasModule[]> {
  return client.get<CanvasModule>(`/api/v1/courses/${courseId}/modules`, { per_page: '100' })
}

export async function getModule(
  client: CanvasClient,
  courseId: number,
  moduleId: number
): Promise<CanvasModule> {
  return client.getOne<CanvasModule>(`/api/v1/courses/${courseId}/modules/${moduleId}`)
}

export async function listModuleItems(
  client: CanvasClient,
  courseId: number,
  moduleId: number
): Promise<CanvasModuleItem[]> {
  return client.get<CanvasModuleItem>(
    `/api/v1/courses/${courseId}/modules/${moduleId}/items`,
    { 'include[]': 'content_details', per_page: '100' }
  )
}
