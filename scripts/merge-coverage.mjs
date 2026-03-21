#!/usr/bin/env node

/**
 * Merge coverage-final.json files from all test suites into a single report.
 *
 * Collects from:
 *   packages/core/coverage/unit/
 *   packages/teacher/coverage/unit/
 *   packages/teacher/coverage/integration/   (if present)
 *
 * Outputs merged report to coverage/merged/ via nyc.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

const sources = [
  'packages/core/coverage/unit',
  'packages/teacher/coverage/unit',
  'packages/teacher/coverage/integration',
]

const collectDir = join(root, 'coverage', '.nyc_input')
const mergedDir = join(root, 'coverage', 'merged')

// Clean and create collection directory
mkdirSync(collectDir, { recursive: true })

let fileIndex = 0
for (const src of sources) {
  const jsonPath = join(root, src, 'coverage-final.json')
  if (!existsSync(jsonPath)) {
    console.log(`  skip: ${src} (no coverage-final.json)`)
    continue
  }
  fileIndex++
  cpSync(jsonPath, join(collectDir, `coverage-${fileIndex}.json`))
  console.log(`  collected: ${src}`)
}

if (fileIndex === 0) {
  console.error('No coverage files found. Run npm run test:coverage first.')
  process.exit(1)
}

// Use nyc to merge and report
console.log('\nMerging coverage...\n')
execSync(
  `npx nyc merge ${collectDir} ${join(mergedDir, 'coverage-final.json')}`,
  { stdio: 'inherit', cwd: root }
)

execSync(
  `npx nyc report --temp-dir ${collectDir} --report-dir ${mergedDir} --reporter text --reporter html`,
  { stdio: 'inherit', cwd: root }
)

console.log(`\nMerged HTML report: coverage/merged/index.html`)
