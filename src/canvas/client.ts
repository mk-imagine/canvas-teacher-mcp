export class CanvasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly canvasMessage: string
  ) {
    super(`Canvas API error ${status}: ${canvasMessage}`)
    this.name = 'CanvasApiError'
  }
}

interface CanvasClientOptions {
  instanceUrl: string
  apiToken: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CanvasClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor({ instanceUrl, apiToken }: CanvasClientOptions) {
    this.baseUrl = instanceUrl.replace(/\/$/, '')
    this.headers = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    }
  }

  private url(path: string, params?: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        u.searchParams.set(k, v)
      }
    }
    return u.toString()
  }

  private async fetchWithRetry(
    urlOrRequest: string,
    options: RequestInit,
    retries = 3
  ): Promise<Response> {
    let attempt = 0
    let delay = 1000
    while (true) {
      const response = await fetch(urlOrRequest, options)
      if (response.status === 429) {
        attempt++
        if (attempt >= retries) {
          await this.throwCanvasError(response)
        }
        await sleep(delay)
        delay *= 2
        continue
      }
      return response
    }
  }

  private async throwCanvasError(response: Response): Promise<never> {
    let canvasMessage = response.statusText
    try {
      const body = (await response.json()) as {
        errors?: Array<{ message: string }>
        message?: string
      }
      if (body.errors?.[0]?.message) {
        canvasMessage = body.errors[0].message
      } else if (body.message) {
        canvasMessage = body.message
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new CanvasApiError(response.status, canvasMessage)
  }

  private async checkResponse(response: Response, acceptStatuses: number[]): Promise<Response> {
    if (!acceptStatuses.includes(response.status) && response.ok === false) {
      await this.throwCanvasError(response)
    }
    if (!acceptStatuses.includes(response.status) && !response.ok) {
      await this.throwCanvasError(response)
    }
    return response
  }

  private buildArrayParamUrl(path: string, params: Record<string, string | string[]>): string {
    const u = new URL(`${this.baseUrl}${path}`)
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          u.searchParams.append(k, item)
        }
      } else {
        u.searchParams.append(k, v)
      }
    }
    return u.toString()
  }

  private async paginatedFetch<T>(firstUrl: string): Promise<T[]> {
    let nextUrl: string | null = firstUrl
    const results: T[] = []

    while (nextUrl) {
      const response = await this.fetchWithRetry(nextUrl, { headers: this.headers })

      const remaining = response.headers.get('X-Rate-Limit-Remaining')
      if (remaining !== null && parseFloat(remaining) < 10) {
        await sleep(500)
      }

      if (!response.ok) {
        await this.throwCanvasError(response)
      }

      const data = (await response.json()) as T[]
      results.push(...data)

      const link = response.headers.get('link')
      nextUrl = null
      if (link) {
        for (const part of link.split(',')) {
          const match = part.match(/<([^>]+)>;\s*rel="next"/)
          if (match) {
            nextUrl = match[1]
            break
          }
        }
      }
    }

    return results
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    return this.paginatedFetch<T>(this.url(path, params))
  }

  async getWithArrayParams<T>(
    path: string,
    params: Record<string, string | string[]>
  ): Promise<T[]> {
    return this.paginatedFetch<T>(this.buildArrayParamUrl(path, params))
  }

  async getOne<T>(path: string, params?: Record<string, string>): Promise<T> {
    const response = await this.fetchWithRetry(this.url(path, params), { headers: this.headers })
    if (!response.ok) {
      await this.throwCanvasError(response)
    }
    return (await response.json()) as T
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchWithRetry(this.url(path), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (response.status !== 200 && response.status !== 201) {
      await this.throwCanvasError(response)
    }
    return (await response.json()) as T
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchWithRetry(this.url(path), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await this.throwCanvasError(response)
    }
    return (await response.json()) as T
  }

  async delete(path: string): Promise<void> {
    const response = await this.fetchWithRetry(this.url(path), {
      method: 'DELETE',
      headers: this.headers,
    })
    if (response.status === 404) return
    if (response.status !== 200 && response.status !== 204) {
      await this.throwCanvasError(response)
    }
  }
}
