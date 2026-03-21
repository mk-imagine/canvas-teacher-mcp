import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

// Shared msw server instance for all unit tests.
// Imported by vitest.config.ts as a setupFile — runs before every test file.
export const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
