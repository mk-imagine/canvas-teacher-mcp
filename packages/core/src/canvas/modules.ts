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
  page_url?: string
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

export interface CreateModuleParams {
  name: string
  unlock_at?: string
  prerequisite_module_ids?: number[]
  require_sequential_progress?: boolean
}

export interface UpdateModuleParams {
  name?: string
  published?: boolean
  unlock_at?: string | null
  prerequisite_module_ids?: number[]
  require_sequential_progress?: boolean
}

export interface CreateModuleItemParams {
  type: 'SubHeader' | 'Page' | 'Assignment' | 'Quiz' | 'ExternalUrl'
  title: string
  content_id?: number
  page_url?: string
  external_url?: string
  position?: number
  indent?: number
  new_tab?: boolean
  completion_requirement?: {
    type: 'min_score' | 'must_submit' | 'must_view'
    min_score?: number
  }
}

export interface UpdateModuleItemParams {
  title?: string
  position?: number
  indent?: number
  completion_requirement?: {
    type: 'min_score' | 'must_submit' | 'must_view'
    min_score?: number
  } | null
}

export async function createModule(
  client: CanvasClient,
  courseId: number,
  params: CreateModuleParams
): Promise<CanvasModule> {
  return client.post<CanvasModule>(
    `/api/v1/courses/${courseId}/modules`,
    { module: params }
  )
}

export async function updateModule(
  client: CanvasClient,
  courseId: number,
  moduleId: number,
  params: UpdateModuleParams
): Promise<CanvasModule> {
  return client.put<CanvasModule>(
    `/api/v1/courses/${courseId}/modules/${moduleId}`,
    { module: params }
  )
}

export async function deleteModule(
  client: CanvasClient,
  courseId: number,
  moduleId: number
): Promise<void> {
  return client.delete(`/api/v1/courses/${courseId}/modules/${moduleId}`)
}

export async function createModuleItem(
  client: CanvasClient,
  courseId: number,
  moduleId: number,
  params: CreateModuleItemParams
): Promise<CanvasModuleItem> {
  const body: Record<string, unknown> = { ...params }
  if (params.page_url != null) {
    body.page_url = params.page_url
  }
  return client.post<CanvasModuleItem>(
    `/api/v1/courses/${courseId}/modules/${moduleId}/items`,
    { module_item: body }
  )
}

export async function updateModuleItem(
  client: CanvasClient,
  courseId: number,
  moduleId: number,
  itemId: number,
  params: UpdateModuleItemParams
): Promise<CanvasModuleItem> {
  return client.put<CanvasModuleItem>(
    `/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`,
    { module_item: params }
  )
}

export async function deleteModuleItem(
  client: CanvasClient,
  courseId: number,
  moduleId: number,
  itemId: number
): Promise<void> {
  return client.delete(
    `/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`
  )
}
