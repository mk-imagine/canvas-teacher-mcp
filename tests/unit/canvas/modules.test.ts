import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../setup/msw-server.js'
import { CanvasClient, CanvasApiError } from '../../../src/canvas/client.js'
import { listModules, getModule, listModuleItems } from '../../../src/canvas/modules.js'

const BASE_URL = 'https://canvas.example.com'
const COURSE_ID = 1
const MODULE_ID = 10

function makeClient() {
  return new CanvasClient({ instanceUrl: BASE_URL, apiToken: 'test-token' })
}

const MOCK_MODULE = {
  id: MODULE_ID,
  name: 'Week 1: Introduction',
  position: 1,
  published: true,
  items_count: 4,
  unlock_at: null,
  prerequisite_module_ids: [],
  require_sequential_progress: false,
  workflow_state: 'active',
}

const MOCK_ITEMS = [
  {
    id: 101, module_id: MODULE_ID, position: 1,
    title: 'OVERVIEW', type: 'SubHeader',
    indent: 0, completion_requirement: null, content_details: {},
  },
  {
    id: 102, module_id: MODULE_ID, position: 2,
    title: 'Week 1 | Overview', type: 'Page',
    content_id: 201, indent: 0,
    completion_requirement: { type: 'must_view' },
    content_details: {},
  },
  {
    id: 103, module_id: MODULE_ID, position: 3,
    title: 'Week 1 | Assignment 1.1', type: 'Assignment',
    content_id: 301, indent: 0,
    completion_requirement: { type: 'min_score', min_score: 1 },
    content_details: { points_possible: 10, due_at: '2026-03-01T23:59:00Z' },
  },
]

describe('listModules()', () => {
  it('returns all modules for a course', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([MOCK_MODULE])
      )
    )
    const result = await listModules(makeClient(), COURSE_ID)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(MODULE_ID)
    expect(result[0].name).toBe('Week 1: Introduction')
    expect(result[0].items_count).toBe(4)
  })

  it('follows pagination to return all modules', async () => {
    let page = 0
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules`, ({ request }) => {
        const p = new URL(request.url).searchParams.get('page') ?? '1'
        page = parseInt(p)
        if (page === 1) {
          return new HttpResponse(JSON.stringify([{ ...MOCK_MODULE, id: 10 }]), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              link: `<${BASE_URL}/api/v1/courses/${COURSE_ID}/modules?page=2>; rel="next"`,
            },
          })
        }
        return HttpResponse.json([{ ...MOCK_MODULE, id: 20 }])
      })
    )
    const result = await listModules(makeClient(), COURSE_ID)
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.id)).toEqual([10, 20])
  })

  it('returns empty array for a course with no modules', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules`, () =>
        HttpResponse.json([])
      )
    )
    const result = await listModules(makeClient(), COURSE_ID)
    expect(result).toEqual([])
  })
})

describe('getModule()', () => {
  it('returns a single module by ID', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}`, () =>
        HttpResponse.json(MOCK_MODULE)
      )
    )
    const result = await getModule(makeClient(), COURSE_ID, MODULE_ID)
    expect(result.id).toBe(MODULE_ID)
    expect(result.unlock_at).toBeNull()
    expect(result.prerequisite_module_ids).toEqual([])
  })

  it('throws CanvasApiError on 404', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/999`, () =>
        HttpResponse.json({ errors: [{ message: 'The specified resource does not exist.' }] }, { status: 404 })
      )
    )
    await expect(getModule(makeClient(), COURSE_ID, 999)).rejects.toThrow(CanvasApiError)
  })
})

describe('listModuleItems()', () => {
  it('returns items with content_details fields mapped', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/items`, () =>
        HttpResponse.json(MOCK_ITEMS)
      )
    )
    const result = await listModuleItems(makeClient(), COURSE_ID, MODULE_ID)
    expect(result).toHaveLength(3)
    const assignment = result.find((i) => i.type === 'Assignment')!
    expect(assignment.content_details?.points_possible).toBe(10)
    expect(assignment.content_details?.due_at).toBe('2026-03-01T23:59:00Z')
  })

  it('handles SubHeader items with no content_id', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/items`, () =>
        HttpResponse.json([MOCK_ITEMS[0]])
      )
    )
    const result = await listModuleItems(makeClient(), COURSE_ID, MODULE_ID)
    expect(result[0].type).toBe('SubHeader')
    expect(result[0].content_id).toBeUndefined()
  })

  it('handles null completion_requirement', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/items`, () =>
        HttpResponse.json([MOCK_ITEMS[0]])
      )
    )
    const result = await listModuleItems(makeClient(), COURSE_ID, MODULE_ID)
    expect(result[0].completion_requirement).toBeNull()
  })

  it('preserves min_score completion requirement', async () => {
    server.use(
      http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/items`, () =>
        HttpResponse.json([MOCK_ITEMS[2]])
      )
    )
    const result = await listModuleItems(makeClient(), COURSE_ID, MODULE_ID)
    expect(result[0].completion_requirement?.type).toBe('min_score')
    expect(result[0].completion_requirement?.min_score).toBe(1)
  })
})
