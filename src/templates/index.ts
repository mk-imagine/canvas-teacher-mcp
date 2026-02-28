import Handlebars from 'handlebars'
import { type CanvasTeacherConfig } from '../config/schema.js'

// ─── Input item types ─────────────────────────────────────────────────────────

export interface TemplateItemInput {
  type: string
  title?: string
  verb?: string
  description?: string
  url?: string
  hours?: number
  mins?: number
  points?: number
  attempts?: number
  time_limit?: number
  notebook_url?: string
  notebook_title?: string
  instructions?: string
}

// ─── Renderable item types ────────────────────────────────────────────────────

export interface QuizQuestionInput {
  question_name: string
  question_text: string
  question_type: string
  points_possible?: number
}

export type RenderableItem =
  | { kind: 'subheader'; title: string }
  | { kind: 'page'; title: string; body?: string }
  | { kind: 'assignment'; title: string; points: number; due_at: string; submission_types: string[]; description?: string }
  | { kind: 'exit_card_quiz'; week: number }
  | { kind: 'quiz'; title: string; points: number; due_at: string; quiz_type: string; time_limit?: number; allowed_attempts?: number; questions?: QuizQuestionInput[] }
  | { kind: 'external_url'; title: string; url: string }

// ─── Accepted types per template ──────────────────────────────────────────────

const ACCEPTED_TYPES: Record<string, Set<string>> = {
  'later-standard': new Set(['coding_assignment', 'download_url', 'reading_page', 'regular_assignment', 'manual_assignment']),
  'later-review': new Set(['video_page', 'review_assignment', 'supplemental_page', 'review_quiz']),
  'earlier-standard': new Set(['assignment', 'video_page']),
  'earlier-review': new Set(['assignment']),
}

// ─── Field validation ─────────────────────────────────────────────────────────

function validateItemFields(item: TemplateItemInput, idx: number): string | null {
  const prefix = `items[${idx}] (${item.type})`
  switch (item.type) {
    case 'coding_assignment':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.hours == null) return `${prefix}: "hours" is required`
      break
    case 'download_url':
      if (!item.url) return `${prefix}: "url" is required`
      break
    case 'reading_page':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.hours == null) return `${prefix}: "hours" is required`
      break
    case 'regular_assignment':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.mins == null) return `${prefix}: "mins" is required`
      break
    case 'manual_assignment':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.mins == null) return `${prefix}: "mins" is required`
      break
    case 'video_page':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.mins == null) return `${prefix}: "mins" is required`
      break
    case 'review_assignment':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.hours == null) return `${prefix}: "hours" is required`
      break
    case 'supplemental_page':
      if (!item.title) return `${prefix}: "title" is required`
      break
    case 'review_quiz':
      if (!item.title) return `${prefix}: "title" is required`
      if (item.hours == null) return `${prefix}: "hours" is required`
      if (item.attempts == null) return `${prefix}: "attempts" is required`
      break
    case 'assignment':
      if (!item.verb) return `${prefix}: "verb" is required`
      if (!item.description) return `${prefix}: "description" is required`
      break
  }
  return null
}

export function validateItems(template: string, items: TemplateItemInput[]): string | null {
  const accepted = ACCEPTED_TYPES[template]
  if (!accepted) return `Unknown template: "${template}"`
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!accepted.has(item.type)) {
      return `items[${i}]: type "${item.type}" not accepted by "${template}". Accepted: ${[...accepted].join(', ')}`
    }
    const err = validateItemFields(item, i)
    if (err) return err
  }
  return null
}

// ─── Item renderers ───────────────────────────────────────────────────────────

function renderLaterItem(
  item: TemplateItemInput,
  N: number,
  due_date: string,
  config: CanvasTeacherConfig
): RenderableItem[] {
  switch (item.type) {
    case 'coding_assignment': {
      const description = item.notebook_url
        ? Handlebars.compile(config.assignmentDescriptionTemplate.default)({
            notebook_url: item.notebook_url,
            notebook_title: item.notebook_title ?? item.title,
            instructions: item.instructions ?? '',
          })
        : undefined
      return [{
        kind: 'assignment',
        title: `Week ${N} | Coding Assignment | ${item.title} (${item.hours} Hours)`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['online_url'],
        description,
      }]
    }
    case 'download_url':
      return [{
        kind: 'external_url',
        title: item.title ?? `DOWNLOAD: Week ${N} Data Files`,
        url: item.url!,
      }]
    case 'reading_page':
      return [{
        kind: 'page',
        title: `Week ${N} | Reading & Exercise | ${item.title} (${item.hours} Hour)`,
      }]
    case 'regular_assignment':
      return [{
        kind: 'assignment',
        title: `Week ${N} | Assignment | ${item.title} (${item.mins} min)`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['online_url'],
      }]
    case 'manual_assignment':
      return [{
        kind: 'assignment',
        title: `Week ${N} | Manual Assignment | ${item.title} (${item.mins} mins)`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['no_submission'],
      }]
    case 'video_page':
      return [{
        kind: 'page',
        title: `Week ${N} | ${item.title} Video (~${item.mins} mins)`,
      }]
    case 'review_assignment':
      return [{
        kind: 'assignment',
        title: `Week ${N} | Assignment | ${item.title} (${item.hours} hours)`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['online_url'],
      }]
    case 'supplemental_page':
      return [{
        kind: 'page',
        title: `Week ${N} | ${item.title}`,
      }]
    case 'review_quiz':
      return [{
        kind: 'quiz',
        title: `Week ${N} | ${item.title} (${item.hours} hour) - Can take ${item.attempts}x`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        quiz_type: 'assignment',
        time_limit: item.time_limit,
        allowed_attempts: item.attempts,
      }]
    default:
      return []
  }
}

// ─── renderTemplate ───────────────────────────────────────────────────────────

export function renderTemplate(
  template: 'later-standard' | 'later-review' | 'earlier-standard' | 'earlier-review',
  week: number,
  items: TemplateItemInput[],
  due_date: string,
  config: CanvasTeacherConfig
): RenderableItem[] {
  const error = validateItems(template, items)
  if (error) throw error

  const N = week
  const out: RenderableItem[] = []

  // All templates: OVERVIEW section
  out.push({ kind: 'subheader', title: 'OVERVIEW' })
  out.push({ kind: 'page', title: `Week ${N} | Overview` })

  if (template === 'later-standard' || template === 'later-review') {
    out.push({ kind: 'subheader', title: 'ASSIGNMENTS' })
    for (const item of items) {
      out.push(...renderLaterItem(item, N, due_date, config))
    }
    out.push({ kind: 'subheader', title: 'WRAP-UP' })
    out.push({ kind: 'exit_card_quiz', week: N })
  } else if (template === 'earlier-standard') {
    out.push({ kind: 'subheader', title: 'TO-DO' })

    const assignItems = items.filter(i => i.type === 'assignment')
    const videoItems = items.filter(i => i.type === 'video_page')

    let idx = 0
    for (const item of assignItems) {
      idx++
      out.push({
        kind: 'assignment',
        title: `Week ${N} | Assignment ${N}.${idx} | ${item.verb}: ${item.description}`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['online_url'],
      })
    }

    // Auto-generated reminders
    out.push({
      kind: 'assignment',
      title: `Week ${N} | Reminder | Attend Weekly Discussion`,
      points: 0,
      due_at: due_date,
      submission_types: ['no_submission'],
    })
    out.push({
      kind: 'assignment',
      title: `Week ${N} | Reminder | Check In With Your Instructor`,
      points: 0,
      due_at: due_date,
      submission_types: ['no_submission'],
    })

    // Video section (only if video items exist)
    if (videoItems.length > 0) {
      out.push({ kind: 'subheader', title: 'QUICK ACCESS TO VIDEOS' })
      videoItems.forEach((video, i) => {
        const letter = String.fromCharCode(97 + i) // a, b, c...
        out.push({
          kind: 'page',
          title: `Video ${N}${letter} | ${video.title} (~${video.mins} mins)`,
        })
      })
    }

    out.push({ kind: 'exit_card_quiz', week: N })
  } else if (template === 'earlier-review') {
    out.push({ kind: 'subheader', title: 'TO-DO' })

    let idx = 0
    for (const item of items) {
      idx++
      out.push({
        kind: 'assignment',
        title: `Week ${N} | Assignment ${N}.${idx} | ${item.verb}: ${item.description}`,
        points: item.points ?? config.defaults.pointsPossible,
        due_at: due_date,
        submission_types: ['online_url'],
      })
    }

    // Auto-generated reminders
    out.push({
      kind: 'assignment',
      title: `Week ${N} | Reminder | Attend Weekly Discussion`,
      points: 0,
      due_at: due_date,
      submission_types: ['no_submission'],
    })
    out.push({
      kind: 'assignment',
      title: `Week ${N} | Reminder | Check In With Your Instructor`,
      points: 0,
      due_at: due_date,
      submission_types: ['no_submission'],
    })

    out.push({ kind: 'exit_card_quiz', week: N })
  }

  return out
}
