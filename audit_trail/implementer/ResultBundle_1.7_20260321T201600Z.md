### Result: 1.7
Status: complete
Objective: Add `writeReviewFile` function that writes ambiguous/unmatched attendance entries to a local JSON file for human review.
Files changed:
- `packages/core/src/attendance/review-file.ts` (new)
- `packages/core/src/attendance/types.ts` (updated — added `ReviewEntry` interface)
- `packages/core/src/attendance/index.ts` (updated barrel — added `ReviewEntry` type export and `writeReviewFile` export)
- `packages/core/tests/unit/attendance/review-file.test.ts` (new)

Changes:
- Added `ReviewEntry` type to `types.ts` with `zoomName`, `status` ('ambiguous' | 'unmatched'), and optional `candidates` array
- Created `writeReviewFile(dir, entries)` that writes `attendance-review.json` with pretty-printed JSON, returns full path
- Updated barrel and core index already re-exports via `export * from './attendance/index.js'`

Deviations from packet: none

Tests added/updated:
- `review-file.test.ts`: (1) writes valid JSON to expected path, (2) overwrites existing file, (3) contains expected entries — all using `tmpdir`

Validation:
- Ran: `vitest run packages/core/tests/unit/attendance/review-file.test.ts` → 3/3 passed
- Ran: `npm run build` → ok (no errors)

Commit:
- Message: `feat(core): add attendance review file writer`
- Hash: `d25d4b5`
- Branch: `feature-1.7`
- Files: review-file.ts, types.ts, index.ts, review-file.test.ts

Retry attempted: N/A

Carry-forward context:
- `writeReviewFile(dir: string, entries: ReviewEntry[]): string` exported from `@canvas-mcp/core`
- `ReviewEntry` type exported from `@canvas-mcp/core`
- Review file is written as `attendance-review.json` in the specified directory
