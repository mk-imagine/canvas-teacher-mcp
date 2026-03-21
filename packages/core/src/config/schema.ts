export interface CourseCacheEntry {
  code: string
  name: string
  term: string
}

export interface CanvasTeacherConfig {
  canvas: {
    instanceUrl: string
    apiToken: string
  }
  program: {
    activeCourseId: number | null
    courseCodes: string[]
    courseCache: Record<string, CourseCacheEntry>
  }
  privacy: {
    blindingEnabled: boolean
    sidecarPath: string
  }
  smartSearch: {
    distanceThreshold: number
  }
  attendance: {
    hostName: string
    defaultPoints: number
    defaultMinDuration: number
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export const DEFAULT_CONFIG: CanvasTeacherConfig = {
  canvas: {
    instanceUrl: '',
    apiToken: '',
  },
  program: {
    activeCourseId: null,
    courseCodes: [],
    courseCache: {},
  },
  privacy: {
    blindingEnabled: false,
    sidecarPath: '~/.cache/canvas-mcp/pii_session.json',
  },
  smartSearch: {
    distanceThreshold: 0.5,
  },
  attendance: {
    hostName: '',
    defaultPoints: 10,
    defaultMinDuration: 0,
  },
}
