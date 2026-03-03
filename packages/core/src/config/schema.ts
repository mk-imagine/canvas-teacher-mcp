export interface CourseCacheEntry {
  code: string
  name: string
  term: string
}

export interface ExitCardQuestion {
  question_name: string
  question_text: string
  question_type: string
  points_possible?: number
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
  defaults: {
    assignmentGroup: string
    submissionType: string
    pointsPossible: number
    completionRequirement: 'min_score' | 'must_submit' | 'must_view'
    minScore: number
    exitCardPoints: number
  }
  smartSearch: {
    distanceThreshold: number
  }
  assignmentDescriptionTemplate: {
    default: string
    solution: string
  }
  exitCardTemplate: {
    title: string
    quizType: 'graded_survey' | 'survey'
    questions: ExitCardQuestion[]
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
  defaults: {
    assignmentGroup: 'Assignments',
    submissionType: 'online_url',
    pointsPossible: 100,
    completionRequirement: 'min_score',
    minScore: 1,
    exitCardPoints: 0.5,
  },
  smartSearch: {
    distanceThreshold: 0.5,
  },
  assignmentDescriptionTemplate: {
    default:
      '<h3><strong><a href="{{notebook_url}}">{{notebook_title}}</a></strong></h3>\n<p>{{instructions}}</p>',
    solution:
      '<h3><strong><a href="{{notebook_url}}">View Solution in Colab</a></strong></h3>',
  },
  exitCardTemplate: {
    title: 'Week {{week}} | Exit Card (5 mins)',
    quizType: 'graded_survey',
    questions: [
      {
        question_name: 'Confidence',
        question_text:
          'Rate your confidence with this week\'s material (1 = very low, 5 = very high).',
        question_type: 'essay_question',
      },
      {
        question_name: 'Muddiest Point',
        question_text: 'What is still unclear or confusing from this week?',
        question_type: 'essay_question',
      },
      {
        question_name: 'Most Valuable',
        question_text: 'What was the most valuable thing you learned this week?',
        question_type: 'essay_question',
      },
    ],
  },
}
