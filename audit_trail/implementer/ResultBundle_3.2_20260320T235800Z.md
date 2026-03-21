### Result: 3.2
Status: complete
Objective: Remove dead config fields (defaults, assignmentDescriptionTemplate, exitCardTemplate) from all integration test config fixtures.
Files changed:
- packages/teacher/tests/integration/find.test.ts
- packages/teacher/tests/integration/modules.test.ts
- packages/teacher/tests/integration/reset.test.ts
- packages/teacher/tests/integration/content.test.ts
- packages/teacher/tests/integration/context.test.ts
- packages/teacher/tests/integration/reporting.test.ts

Changes:
- Removed `defaults` block from all 6 integration test `makeConfig` functions
- Removed `assignmentDescriptionTemplate` block from find, modules, reset, and content test files
- Removed `exitCardTemplate` block from find, modules, reset, and content test files
- context.test.ts and reporting.test.ts had simpler configs with only `defaults` -- removed those too

Deviations from packet: none

Tests added/updated: none (this packet only modifies test fixtures, not test logic)

Validation:
- Ran: `npm run build` -> pass (0 TypeScript errors)
- Ran: `npm run test:unit` -> pass (155 tests: 12 core + 143 teacher)

Commit:
- Message: test: remove dead config fields from integration test fixtures
- Hash: 44eeb53
- Branch: feature-3.2
- Files: 6 files changed, 72 deletions

Retry attempted: N/A

Carry-forward context:
- Integration tests cannot be run without Canvas credentials; TypeScript build and unit tests are the validation proxy
- All integration test configs now contain only `canvas` and `program` top-level keys
- ConfigManager.read() deep-merges with DEFAULT_CONFIG, so omitted fields get defaults automatically
