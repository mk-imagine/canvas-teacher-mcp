### Result: 4.2
Status: complete
Objective: Remove dead config fields from user-directory config files (~/.config/mcp/canvas-mcp/).
Files changed: ~/.config/mcp/canvas-mcp/config.json, ~/.config/mcp/canvas-mcp/config.sfsu.json

Changes:
- config.json: removed `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate`; remaining keys: canvas, privacy, program
- config.sfsu.json: removed `defaults`, `assignmentDescriptionTemplate`, `exitCardTemplate`; remaining keys: canvas, program

Deviations from packet: none

Tests added/updated: none (user-directory files, no repo tests apply)

Validation:
- Verified both files re-parsed successfully after write
- Verified none of the three dead keys remain in either file
- No commit required (files outside repo)

Commit: N/A (user-machine files outside the repo)

Retry attempted: N/A

Carry-forward context:
- Both user config files are now clean of dead template/defaults keys
- Sensitive data (API tokens) was not logged or displayed
