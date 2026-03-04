# MCP Privacy Preservation Strategy: The "Jake" Experience

## 1. Overview
The goal of this strategy is to provide a **silent, seamless, and privacy-preserving** experience for users (e.g., teachers like "Jake") who need to analyze sensitive student PII (Personally Identifiable Information) using an LLM via the Canvas MCP server.

### The "Jake" User Story
Jake is a teacher who wants to ask his LLM: *"Who is in most danger of failing?"*
1. **Input Blinding:** Jake types a student's real name (e.g., "Jane Doe"). Before the LLM receives the prompt, the name is swapped for a token (e.g., `[STUDENT_001]`).
2. **Analysis:** The LLM performs analysis on blinded data (grades, missing assignments) using only tokens.
3. **Output Unblinding:** The LLM responds: *"I found that [STUDENT_001] is failing."* Before Jake sees the text, the client swaps the token back. Jake sees: *"I found that Jane Doe is failing."*

---

## 2. Technical Workflow: The Three-Hook Lifecycle

To achieve this experience in a CLI environment (like Gemini CLI), we use a bi-directional mapping strategy across three distinct hook points.

### A. `BeforeModel` Hook (Input Blinding)
*   **Trigger:** When Jake presses "Enter" on a prompt.
*   **Input:** Jake's raw prose (e.g., *"Is Jane Doe failing?"*).
*   **Action:** The hook script matches names against a local PII mapping file and replaces them with tokens.
*   **Output to LLM:** Masked prose (e.g., *"Is [STUDENT_001] failing?"*).
*   **Goal:** Ensure the model never learns a name from the user's input.

### B. `AfterTool` Hook (Visual Cleanup & Progress)
*   **Trigger:** When an MCP tool (e.g., `get_grades`) returns raw JSON data to the CLI.
*   **Input:** Raw, blinded JSON (e.g., `[{"student": "[STUDENT_001]", "score": 45}]`).
*   **Action:** 
    *   **Silence the JSON:** Intercept and hide the large, unreadable JSON blocks from Jake's terminal.
    *   **Minimalist Progress:** Instead of raw data, display a clean status indicator or progress bar (e.g., `[SYSTEM] Fetching data for 40 students... [████░░░░]`).
*   **Output to Terminal:** A clean, status message for Jake.
*   **Output to LLM:** The original, raw, blinded JSON (unchanged).
*   **Goal:** Keep the terminal clean while providing "alive" feedback to the user.

### C. `AfterModel` Hook (Output Unblinding)
*   **Trigger:** As the LLM streams its final text response back to the CLI.
*   **Input:** The model's generated prose or Markdown (e.g., *"I found that [STUDENT_001] has a low grade."*).
*   **Action:** Perform a real-time regex swap of `[STUDENT_NNN]` tokens for real names using the local mapping.
*   **Output to Terminal:** Unmasked, human-readable prose (e.g., *"I found that Jane Doe has a low grade."*).
*   **Goal:** Provide the "last mile" of seamlessness so Jake never sees a token in the final answer.

---

## 3. Server-Side Infrastructure (MCP Server)
- **`SecureStore`:** A session-based vault that maps `Canvas ID + Name` to tokens.
- **Sidecar Mapping:** The server maintains a temporary, restricted-access file (`.gemini/tmp/canvas-mcp/pii_session.json`) containing the `Token <-> Name` mapping for the CLI hooks to read. This file is deleted when the session ends.
- **Stable Tokens:** Tokens include a session-specific hash (e.g., `[STUDENT_001:A4F2]`) to prevent collisions if the server restarts. The total number of characters in the token should match the total number of characters from the student's unblinded name to ensure correct final formatting in the terminal/client output.

---

## 4. Inquiry for Claude Code (The "Claude Query")

**Context:** We have implemented a privacy-preserving PII masking layer using the Gemini CLI's 3-hook lifecycle (`BeforeModel`, `AfterTool`, `AfterModel`). We want to know if Claude Code can achieve the same "Jake" experience.

**Question for Claude:**
1. **Hook Support:** Does Claude Code have an equivalent to `BeforeModel` and `AfterModel` hooks that allow a local script to intercept and regex-replace text in the prompt/response stream?
2. **Tool Output Handling:** Can Claude Code be configured to suppress the raw JSON output of an MCP tool in the terminal, replacing it with a custom "Progress/Status" string (the `AfterTool` equivalent)?
3. **Dual Audience:** Does Claude Code respect MCP `annotations` (e.g., `audience: ["user"]` vs `audience: ["assistant"]`) to show different content to the human vs. the model?
4. **Custom Rendering:** Is there a way for an MCP server to provide a "Sidecar Mapping" that Claude Code can use natively for PII unblinding without an explicit "resolve" tool call from the model?

If these features are missing, what is the recommended architecture for a "Zero-PII-to-Model" experience in Claude Code?
