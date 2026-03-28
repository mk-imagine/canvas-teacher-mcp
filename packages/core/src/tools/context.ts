import { z } from 'zod'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CanvasClient } from '../canvas/client.js'
import { fetchTeacherCourses, type CanvasCourse } from '../canvas/courses.js'
import { type ConfigManager } from '../config/manager.js'
import { type RosterStore } from '../roster/store.js'
import { syncRosterFromEnrollments } from '../roster/sync.js'
import { type SecureStore } from '../security/secure-store.js'

function tokenize(str: string): string[] {
  return str.toLowerCase().split(/[\s/]+/).filter(Boolean)
}

function scoreMatch(course: CanvasCourse, queryTokens: string[]): number {
  const haystack =
    `${course.course_code} ${course.name} ${course.term?.name ?? ''}`.toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    if (haystack.includes(token)) score++
  }
  return score
}

export function registerContextTools(
  server: McpServer,
  client: CanvasClient,
  configManager: ConfigManager,
  rosterStore?: RosterStore,
  secureStore?: SecureStore
): void {
  // list_courses
  server.registerTool(
    'list_courses',
    {
      description: 'List Canvas courses where you are the teacher. Filters by program course codes unless all=true.',
      inputSchema: z.object({
        all: z.boolean().optional().describe('Return all courses, not just program courses'),
      }),
    },
    async (args) => {
      const config = configManager.read()
      const courses = await fetchTeacherCourses(client)

      const filtered =
        args.all || config.program.courseCodes.length === 0
          ? courses
          : courses.filter((c) =>
              config.program.courseCodes.some((code) =>
                c.course_code.toLowerCase().includes(code.toLowerCase())
              )
            )

      const activeId = config.program.activeCourseId
      const result = filtered.map((c) => ({
        id: c.id,
        courseCode: c.course_code,
        name: c.name,
        term: c.term?.name ?? null,
        isActive: c.id === activeId,
      }))

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // set_active_course
  server.registerTool(
    'set_active_course',
    {
      description: 'Set the active course by fuzzy-matching a query string against course code, name, and term.',
      inputSchema: z.object({
        query: z.string().describe('Search string, e.g. "CSC408" or "408 spring"'),
      }),
    },
    async (args) => {
      const config = configManager.read()
      const courses = await fetchTeacherCourses(client)
      const queryTokens = tokenize(args.query)

      const scored = courses
        .map((c) => ({ course: c, score: scoreMatch(c, queryTokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)

      const maxScore = scored[0]?.score ?? 0
      const topMatches = scored.filter((x) => x.score === maxScore)

      if (topMatches.length === 1) {
        const { course } = topMatches[0]
        const term = course.term?.name ?? ''
        const cacheEntry = { code: course.course_code, name: course.name, term }

        configManager.update({
          program: {
            activeCourseId: course.id,
            courseCache: {
              ...config.program.courseCache,
              [String(course.id)]: cacheEntry,
            },
          },
        })

        if (rosterStore && secureStore) {
          syncRosterFromEnrollments(rosterStore, client, course.id)
            .then((students) =>
              secureStore.preload(
                students.map((s) => ({ canvasUserId: s.canvasUserId, name: s.name }))
              )
            )
            .catch((err: Error) =>
              process.stderr.write(
                `[roster] Sync failed for course ${course.id}: ${err.message}\n`
              )
            )
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Active course set to: ${course.name} (${course.course_code})${term ? `, ${term}` : ''}, Canvas ID: ${course.id}`,
            },
          ],
        }
      }

      if (topMatches.length > 1) {
        const list = topMatches
          .map((x) => `- ${x.course.course_code}: ${x.course.name} (${x.course.term?.name ?? 'no term'}) [id: ${x.course.id}]`)
          .join('\n')
        return {
          content: [
            {
              type: 'text' as const,
              text: `Multiple courses match "${args.query}". Please be more specific:\n${list}`,
            },
          ],
        }
      }

      // No match — return program course list
      const programCourses =
        config.program.courseCodes.length === 0
          ? courses
          : courses.filter((c) =>
              config.program.courseCodes.some((code) =>
                c.course_code.toLowerCase().includes(code.toLowerCase())
              )
            )

      const list = programCourses
        .map((c) => `- ${c.course_code}: ${c.name} (${c.term?.name ?? 'no term'}) [id: ${c.id}]`)
        .join('\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `No courses match "${args.query}". Available program courses:\n${list}`,
          },
        ],
      }
    }
  )

  // get_active_course
  server.registerTool(
    'get_active_course',
    {
      description: 'Get the currently active course from local config (no Canvas API call).',
      inputSchema: z.object({}),
    },
    async () => {
      const config = configManager.read()
      const { activeCourseId, courseCache } = config.program

      if (activeCourseId === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  activeCourseId: null,
                  message: 'No active course set. Use set_active_course to select one.',
                },
                null,
                2
              ),
            },
          ],
        }
      }

      const cached = courseCache[String(activeCourseId)]
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                activeCourseId,
                courseCode: cached?.code ?? null,
                name: cached?.name ?? null,
                term: cached?.term ?? null,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
