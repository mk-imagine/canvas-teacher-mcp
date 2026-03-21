import Handlebars from 'handlebars'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Manifest types ───────────────────────────────────────────────────────────

export interface ManifestStructureItem {
  type: 'SubHeader' | 'Page' | 'Assignment' | 'Quiz' | 'ExternalUrl'
  title?: string
  body_file?: string
  for_each?: string
  points?: string | number
  quiz_type?: string
  time_limit?: number
  allowed_attempts?: number
  questions?: Array<{ question_text: string; question_name?: string; question_type?: string }>
  url?: string
  submission_types?: string[]
}

export interface TemplateManifest {
  version: 1
  name: string
  description: string
  variables_schema?: Record<string, { type: string; required?: boolean }>
  structure: ManifestStructureItem[]
}

export interface TemplateDescriptor {
  template_name: string
  name: string
  description: string
  variables_schema?: Record<string, { type: string; required?: boolean }>
}

// ─── RenderableItem types (shared with existing executeRenderables) ────────────

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

// ─── TemplateService ──────────────────────────────────────────────────────────

interface CachedTemplate {
  manifest: TemplateManifest
  compiledBodies: Map<string, Handlebars.TemplateDelegate>
}

export class TemplateService {
  private readonly templatesDir: string
  private readonly cache: Map<string, CachedTemplate> = new Map()

  constructor(templatesDir: string) {
    this.templatesDir = templatesDir
    this._loadAll()
  }

  private _loadAll(): void {
    if (!existsSync(this.templatesDir)) return

    const entries = readdirSync(this.templatesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const templateName = entry.name
      const templateDir = join(this.templatesDir, templateName)
      const manifestPath = join(templateDir, 'manifest.json')

      if (!existsSync(manifestPath)) continue

      let manifest: TemplateManifest
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        manifest = JSON.parse(raw) as TemplateManifest
      } catch {
        continue
      }

      if (manifest.version !== 1) continue
      if (!manifest.name || !manifest.description || !Array.isArray(manifest.structure)) continue

      // Compile all body_file references
      const compiledBodies = new Map<string, Handlebars.TemplateDelegate>()
      let valid = true
      for (const item of manifest.structure) {
        if (item.body_file) {
          const bodyPath = join(templateDir, item.body_file)
          if (!existsSync(bodyPath)) {
            valid = false
            break
          }
          if (!compiledBodies.has(item.body_file)) {
            const src = readFileSync(bodyPath, 'utf-8')
            compiledBodies.set(item.body_file, Handlebars.compile(src))
          }
        }
      }

      if (!valid) continue

      this.cache.set(templateName, { manifest, compiledBodies })
    }
  }

  list(): TemplateDescriptor[] {
    const result: TemplateDescriptor[] = []
    for (const [templateName, { manifest }] of this.cache) {
      result.push({
        template_name: templateName,
        name: manifest.name,
        description: manifest.description,
        variables_schema: manifest.variables_schema,
      })
    }
    return result
  }

  render(templateName: string, variables: Record<string, unknown>): RenderableItem[] {
    const cached = this.cache.get(templateName)
    if (!cached) {
      throw new Error(`Unknown template: "${templateName}". Available: ${[...this.cache.keys()].join(', ') || 'none'}`)
    }

    const { manifest, compiledBodies } = cached
    const out: RenderableItem[] = []

    for (const item of manifest.structure) {
      if (item.for_each) {
        const arr = variables[item.for_each]
        if (!Array.isArray(arr)) {
          throw new Error(
            `Template "${templateName}": for_each key "${item.for_each}" is not an array in supplied variables (got ${typeof arr})`
          )
        }
        for (const element of arr) {
          const itemVars = { ...variables, item: element }
          out.push(...this._renderOne(item, itemVars, compiledBodies, templateName))
        }
      } else {
        out.push(...this._renderOne(item, variables, compiledBodies, templateName))
      }
    }

    return out
  }

  renderFile(templateName: string, bodyFile: string, variables: Record<string, unknown>): string {
    const cached = this.cache.get(templateName)
    if (!cached) {
      throw new Error(`Unknown template: "${templateName}"`)
    }
    const compiled = cached.compiledBodies.get(bodyFile)
    if (!compiled) {
      throw new Error(`Template "${templateName}": body file "${bodyFile}" not found or not compiled`)
    }
    return compiled(variables)
  }

  private _renderOne(
    item: ManifestStructureItem,
    variables: Record<string, unknown>,
    compiledBodies: Map<string, Handlebars.TemplateDelegate>,
    templateName: string
  ): RenderableItem[] {
    const title = item.title ? Handlebars.compile(item.title)(variables) : ''
    const due_at = (variables['due_date'] as string) ?? ''

    switch (item.type) {
      case 'SubHeader':
        return [{ kind: 'subheader', title }]

      case 'Page': {
        let body: string | undefined
        if (item.body_file) {
          const compiled = compiledBodies.get(item.body_file)
          if (!compiled) {
            throw new Error(`Template "${templateName}": body_file "${item.body_file}" not compiled`)
          }
          body = compiled(variables)
        }
        return [{ kind: 'page', title, body }]
      }

      case 'Assignment': {
        const rawPoints = item.points
        let points: number
        if (typeof rawPoints === 'number') {
          points = rawPoints
        } else if (typeof rawPoints === 'string') {
          const resolved = Handlebars.compile(rawPoints)(variables)
          points = Number(resolved)
          if (isNaN(points)) points = 0
        } else {
          points = 0
        }
        const submissionTypes = item.submission_types ?? ['online_url']
        let description: string | undefined
        if (item.body_file) {
          const compiled = compiledBodies.get(item.body_file)
          if (!compiled) {
            throw new Error(`Template "${templateName}": body_file "${item.body_file}" not compiled`)
          }
          description = compiled(variables)
        }
        return [{ kind: 'assignment', title, points, due_at, submission_types: submissionTypes, description }]
      }

      case 'Quiz': {
        const rawPoints = item.points
        let points: number
        if (typeof rawPoints === 'number') {
          points = rawPoints
        } else if (typeof rawPoints === 'string') {
          const resolved = Handlebars.compile(rawPoints)(variables)
          points = Number(resolved)
          if (isNaN(points)) points = 0
        } else {
          points = 0
        }
        const questions: QuizQuestionInput[] | undefined = item.questions?.map((q, i) => ({
          question_name: q.question_name ?? `Question ${i + 1}`,
          question_text: q.question_text,
          question_type: q.question_type ?? 'essay_question',
        }))
        return [{
          kind: 'quiz',
          title,
          points,
          due_at,
          quiz_type: item.quiz_type ?? 'assignment',
          time_limit: item.time_limit,
          allowed_attempts: item.allowed_attempts,
          questions,
        }]
      }

      case 'ExternalUrl': {
        const url = item.url ? Handlebars.compile(item.url)(variables) : ''
        return [{ kind: 'external_url', title, url }]
      }

      default:
        return []
    }
  }
}
