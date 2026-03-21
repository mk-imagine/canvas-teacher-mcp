### Result: 1.3
Status: complete
Objective: Add `getConfigDir()` public method to ConfigManager that returns the directory containing the config file.
Files changed:
- `packages/core/src/config/manager.ts`
- `packages/core/tests/unit/config/manager.test.ts` (new)

Changes:
- Added `getConfigDir(): string` method to `ConfigManager` class, returning `dirname(this.configPath)`
- `dirname` was already imported; no new imports needed

Deviations from packet:
- Packet said "Inline verification" for tests, but user instruction requested test-first approach. Wrote a dedicated test file with two cases instead of relying on inline verification.

Tests added/updated:
- `packages/core/tests/unit/config/manager.test.ts`
  - `returns the directory containing the config file` -- creates a temp config, verifies `getConfigDir()` returns the parent directory
  - `returns the directory for a nested config path` -- verifies with a deeper nested path

Validation:
- Ran: `vitest run tests/unit/config/manager.test.ts` -> 2 passed
- Ran: all core unit tests -> 14 passed (0 regressions)
- Ran: `npm run build` -> exit 0 (core + teacher both compile)

Commit:
- Message: `feat(core): expose getConfigDir on ConfigManager`
- Hash: `c5f05f7`
- Branch: `feature-1.3`
- Files: `packages/core/src/config/manager.ts`, `packages/core/tests/unit/config/manager.test.ts`

Retry attempted: N/A

Carry-forward context:
- `configManager.getConfigDir()` returns the config directory path as a string
- Attendance module can use this to locate `zoom-name-map.json` and `attendance-review.json` relative to config
- No changes to core's public API exports needed -- `ConfigManager` is already exported and the new method is available on instances
