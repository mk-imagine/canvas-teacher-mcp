/**
 * Gemini CLI AfterTool Hook
 *
 * PURPOSE:
 * 1. Parse tool outputs to generate a concise summary.
 * 2. Inject this summary as a 'systemMessage' to guide the model.
 */

function buildSummary(toolName: string, data: Record<string, unknown>): string | null {
  // get_submission_status (Missing)
  if (typeof data['total_missing_submissions'] === 'number') {
    return `Found ${data['total_missing_submissions']} missing submissions.`
  }
  // get_submission_status (Late)
  if (typeof data['total_late_submissions'] === 'number') {
    return `Found ${data['total_late_submissions']} late submissions.`
  }
  // get_grades (Class Overview)
  if (typeof data['student_count'] === 'number') {
    return `Fetched grades for ${data['student_count']} students.`
  }
  // get_grades (Specific Student)
  if (Array.isArray(data['assignments']) && typeof data['student_token'] === 'string') {
    return `Fetched ${data['assignments'].length} assignments for ${data['student_token']}.`
  }
  // get_assignments (Course filtered)
  if (Array.isArray(data['assignments']) && typeof data['course_id'] === 'number') {
    return `Found ${data['assignments'].length} assignments for course ${data['course_id']}.`
  }
  // Generic Fallback for Lists
  if (Array.isArray(data['items'])) {
    return `Retrieved ${data['items'].length} items.`
  }
  return null
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')

  let hookInput: Record<string, unknown>
  try {
    hookInput = JSON.parse(raw)
  } catch {
    process.stdout.write('{}')
    return
  }

  const toolName = hookInput.tool_name
  if (!toolName) {
    process.stdout.write('{}')
    return
  }

  const llmContent = (hookInput.tool_response as Record<string, unknown>)?.llmContent as Record<string, unknown>[] | undefined
  const textPayload = llmContent?.[0]?.text
  if (!textPayload) {
    process.stdout.write('{}')
    return
  }

  try {
    const data = JSON.parse(textPayload as string)
    const summary = buildSummary(toolName as string, data)

    if (summary) {
      process.stdout.write(JSON.stringify({
        systemMessage: `[canvas-mcp] ${summary}`
      }))
    } else {
      process.stdout.write('{}')
    }
  } catch {
    process.stdout.write('{}')
  }
}

main().catch((err) => {
  process.stderr.write(`[canvas-mcp/after_tool] Error: ${(err as Error).message}\n`)
  process.exit(1)
})
