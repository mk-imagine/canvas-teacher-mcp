### Result: 1.2
Status: complete
Objective: Update user-directory manifest copies to match the 3-question exit card format.
Files changed:
- ~/.config/mcp/canvas-mcp/templates/earlier-review/manifest.json
- ~/.config/mcp/canvas-mcp/templates/earlier-standard/manifest.json
- ~/.config/mcp/canvas-mcp/templates/later-review/manifest.json
- ~/.config/mcp/canvas-mcp/templates/later-standard/manifest.json

Changes:
- Replaced the 2-question exit card `questions` array with the standardized 3-question array (Confidence, Muddiest Point, Most Valuable) in all 4 user-directory manifest files

Deviations from packet: none

Tests added/updated: N/A (user-directory config files, no repo tests)

Patch / Code:
- In each manifest, the Quiz entry with `quiz_type: "graded_survey"` had its `questions` array updated from 2 questions to 3 questions with expanded question text

Validation:
- Ran: Python script reading each manifest, checking exit card question count = 3 and verifying question names/text -> PASS (all 4 files)

Commit: N/A (user-machine config files outside the repo, per packet instructions)

Retry attempted: N/A

Carry-forward context:
- All 4 user-directory manifests now match the 3-question exit card format from the in-repo defaults (updated in Packet 1.1)
- No repo changes were made; no git commit needed
