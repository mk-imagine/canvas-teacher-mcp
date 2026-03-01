import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { type CanvasClient } from './client.js'

export interface CanvasFile {
  id: number
  display_name: string
  filename: string
  size: number
  content_type: string
  folder_id: number
}

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.py': 'text/x-python',
  '.ipynb': 'application/x-ipynb+json',
}

function lookupMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

export interface UploadFileParams {
  file_path: string
  name?: string
  folder_path?: string
}

interface UploadStep1Response {
  upload_url: string
  upload_params: Record<string, string>
}

export async function uploadFile(
  client: CanvasClient,
  courseId: number,
  params: UploadFileParams
): Promise<CanvasFile> {
  const stat = statSync(params.file_path)
  const fileName = params.name ?? basename(params.file_path)
  const contentType = lookupMimeType(fileName)

  // Step 1: Tell Canvas about the file
  const step1Body: Record<string, unknown> = {
    name: fileName,
    size: stat.size,
    content_type: contentType,
  }
  if (params.folder_path) {
    step1Body.parent_folder_path = params.folder_path
  }

  const step1 = await client.post<UploadStep1Response>(
    `/api/v1/courses/${courseId}/files`,
    step1Body
  )

  // Step 2: Upload file data to the upload_url
  const fileData = readFileSync(params.file_path)
  const formData = new FormData()
  for (const [key, value] of Object.entries(step1.upload_params)) {
    formData.append(key, value)
  }
  formData.append('file', new Blob([fileData], { type: contentType }), fileName)

  const step2Response = await fetch(step1.upload_url, {
    method: 'POST',
    body: formData,
  })

  // Step 3: If redirect (301/303), follow with auth; otherwise parse directly
  if (step2Response.status === 301 || step2Response.status === 303) {
    const location = step2Response.headers.get('Location')
    if (!location) {
      throw new Error('File upload redirect missing Location header')
    }
    const step3Response = await fetch(location, {
      headers: client.authHeaders,
    })
    if (!step3Response.ok) {
      throw new Error(`File upload confirmation failed: ${step3Response.status}`)
    }
    return (await step3Response.json()) as CanvasFile
  }

  if (!step2Response.ok) {
    throw new Error(`File upload failed: ${step2Response.status}`)
  }
  return (await step2Response.json()) as CanvasFile
}

export async function listFiles(
  client: CanvasClient,
  courseId: number
): Promise<CanvasFile[]> {
  return client.get<CanvasFile>(
    `/api/v1/courses/${courseId}/files`,
    { per_page: '100' }
  )
}

export async function deleteFile(
  client: CanvasClient,
  fileId: number
): Promise<void> {
  return client.delete(`/api/v1/files/${fileId}`)
}
