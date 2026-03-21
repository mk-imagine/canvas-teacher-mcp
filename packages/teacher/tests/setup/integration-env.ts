import { config } from 'dotenv'
import { resolve } from 'node:path'

// Load .env.test for integration tests.
// Fails fast with a clear message if required variables are missing.
config({ path: resolve(process.cwd(), '.env.test') })

const required = [
  'CANVAS_INSTANCE_URL',
  'CANVAS_API_TOKEN',
  'CANVAS_TEST_COURSE_ID',
] as const

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(
      `Integration tests require ${key} in .env.test — see Section 13.4 of PLANNING.md`
    )
  }
}
