import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TemplateService } from '../../../src/templates/service.js'

function createFixtureDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'ts-test-'))
  const templateDir = join(base, 'test-template')
  mkdirSync(templateDir, { recursive: true })
  return base
}

describe('TemplateService – Assignment body_file rendering', () => {
  const fixtureDirs: string[] = []

  afterAll(() => {
    for (const dir of fixtureDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders body_file content into assignment description', () => {
    const base = createFixtureDir()
    fixtureDirs.push(base)
    const templateDir = join(base, 'test-template')

    // Create a body template file
    writeFileSync(join(templateDir, 'test-body.hbs'), '<p>Hello {{name}}</p>')

    // Create manifest with an Assignment that references body_file
    const manifest = {
      version: 1,
      name: 'Test Template',
      description: 'A test',
      structure: [
        {
          type: 'Assignment',
          title: 'HW {{week}}',
          points: 10,
          body_file: 'test-body.hbs',
        },
      ],
    }
    writeFileSync(join(templateDir, 'manifest.json'), JSON.stringify(manifest))

    const service = new TemplateService(base)
    const result = service.render('test-template', {
      week: 5,
      name: 'World',
      due_date: '2026-01-15',
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'assignment',
      title: 'HW 5',
      points: 10,
      due_at: '2026-01-15',
      description: '<p>Hello World</p>',
    })
  })

  it('produces description: undefined when no body_file is specified', () => {
    const base = createFixtureDir()
    fixtureDirs.push(base)
    const templateDir = join(base, 'test-template')

    const manifest = {
      version: 1,
      name: 'Test Template',
      description: 'A test',
      structure: [
        {
          type: 'Assignment',
          title: 'HW {{week}}',
          points: 10,
        },
      ],
    }
    writeFileSync(join(templateDir, 'manifest.json'), JSON.stringify(manifest))

    const service = new TemplateService(base)
    const result = service.render('test-template', {
      week: 3,
      due_date: '2026-02-01',
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'assignment',
      title: 'HW 3',
      points: 10,
      due_at: '2026-02-01',
    })
    // Explicitly verify description is undefined
    expect((result[0] as any).description).toBeUndefined()
  })
})
