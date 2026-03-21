### Result: 3.2
Status: complete
Objective: Implement the submit action in import_attendance tool that posts grades for matched students, with dry-run preview and PII-blinded output.
Files changed:
- packages/teacher/src/tools/attendance.ts
- packages/teacher/tests/unit/tools/attendance.test.ts

Changes:
- Added `gradeSubmission` import from `@canvas-mcp/core`
- Replaced submit placeholder with full implementation: dry-run preview mode, live grade submission with per-student error handling, state clearing after successful submission
- All output PII-blinded via SecureStore tokenization and `blindedResponse()`

Deviations from packet:
- Moved "submit without prior parse" test to run first in describe block, since `lastParseResult` is module-scoped and shared across all test instances. Without this ordering, prior parse tests would set the state and the test would incorrectly pass/fail.

Tests added/updated:
- submit: returns error when no prior parse exists (moved to first position)
- submit: dry_run returns preview without posting grades (verifies 0 PUT calls, correct preview shape)
- submit: posts grades for matched students and returns confirmation (verifies PUT calls to correct user IDs)
- submit: clears parse state after successful submission (second submit returns error)
- submit: reports per-student errors when some grade posts fail (one 500, others succeed)
- submit: response contains only STUDENT tokens, never real names

Patch / Code:
- See commit c5cd9b7 on branch feature-3.2

Validation:
- Ran: `node --no-warnings ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/unit/tools/attendance.test.ts` → pass (15/15 tests)
- Ran: `npm run build` → pass (no errors)

Commit:
- Message: feat(teacher): implement import_attendance submit action
- Hash: c5cd9b7
- Branch: feature-3.2
- Files: packages/teacher/src/tools/attendance.ts, packages/teacher/tests/unit/tools/attendance.test.ts

Retry attempted: no

Escalation: N/A

Carry-forward context:
- Full `import_attendance` tool with both parse and submit actions is complete
- `lastParseResult` is module-scoped singleton -- tests sensitive to ordering
- Submit clears state after non-dry-run submission; dry-run preserves state for subsequent real submit
- Per-student error handling: individual grade POST failures are caught and reported, do not abort the batch
