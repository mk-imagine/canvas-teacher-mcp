### Result: 1.1
Status: complete
Objective: Update all 4 default manifest exit card questions from 2-question short version to full 3-question version (Confidence, Muddiest Point, Most Valuable) with production question text.
Files changed:
- packages/core/src/templates/defaults/later-standard/manifest.json
- packages/core/src/templates/defaults/later-review/manifest.json
- packages/core/src/templates/defaults/earlier-standard/manifest.json
- packages/core/src/templates/defaults/earlier-review/manifest.json

Changes:
- Replaced 2-question exit card questions (short "Confidence" and "Muddiest Point") with full 3-question version adding "Most Valuable" and using production-quality question text in all 4 manifest files

Deviations from packet:
- Changes were already present in the worktree from a prior (uncommitted) run. Verified diffs matched packet spec exactly, validated JSON, ran tests, and committed.

Tests added/updated:
- None required per packet (existing tests cover manifest loading)

Validation:
- Ran: `npm run test:unit` -> pass (143 tests in teacher, 10 tests in core, all passed)
- Ran: JSON parse validation on all 4 files -> all valid

Commit:
- Message: feat(core): update default manifest exit cards to full 3-question version
- Hash: ca6bdac
- Files: 4 manifest.json files listed above
- Branch: feature-1.1

Retry attempted: N/A

Carry-forward context:
- All 4 manifests now have identical 3-question exit card structure
- package-lock.json has an unrelated modification in the worktree (not committed)
