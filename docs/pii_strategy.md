# Implementation Plan: Gemini CLI Privacy Preservation

## 1. Overview
This document outlines the implementation of a **silent, seamless, and privacy-preserving** layer for the Canvas MCP server when used with the Gemini CLI. It enables the "Jake" experience: allowing a teacher to interact with student data using real names while ensuring the LLM only ever processes blinded tokens.

This is an **opt-in feature**. The MCP server remains fully compatible with all other MCP clients (Claude Code, Cursor, etc.) by defaulting to standard blinding if the Gemini CLI hooks are not configured.

---

## 2. The Three-Hook Lifecycle

The implementation relies on three Gemini CLI hook points to intercept and transform text and data.

### A. Input Blinding (`BeforeModel`)
*   **Action:** Intercepts the user's raw prompt before it is sent to the LLM.
*   **Mechanism:** A script matches real student names against the `pii_session.json` sidecar and replaces them with stable tokens.
*   **Goal:** The model never receives PII from the user's typing.

### B. Visual Cleanup (`AfterTool`)
*   **Action:** Intercepts raw JSON tool results (e.g., from `get_grades`).
*   **Mechanism:** 
    *   Hides the raw JSON from the terminal output to keep the UI clean.
    *   Displays a minimalist progress indicator (e.g., `[SYSTEM] Analyzing data for 40 students... [████░░░░]`).
*   **Goal:** Provides user feedback without leaking raw PII or cluttering the terminal.

### C. Output Unblinding (`AfterModel`)
*   **Action:** Intercepts the LLM's response stream.
*   **Mechanism:** Performs a real-time regex swap of `[STUDENT_NNN:HASH]` tokens back to real names.
*   **Goal:** Jake sees a natural, unblinded conversation.

---

## 3. Technical Requirements

### A. Token Design (Formatting Alignment)
To ensure that LLM-generated tables and formatted text remain aligned after unblinding, tokens will be **character-length matched** to the real names they replace.
*   **Example:** If the student's name is "Jane Doe" (8 characters), the token will be exactly 8 characters (e.g., `[S:A4F2]`). 
*   **Note:** If the name is too short for a secure token, the system will use a minimum token length and accept minor formatting shifts.

### B. Sidecar Mapping File
The MCP server will maintain a temporary mapping file at `.gemini/tmp/canvas-mcp/pii_session.json`.
*   **Security:** Permissions set to `600` (User-only).
*   **Persistence:** Created on first student encounter; deleted on MCP server shutdown.
*   **Format:**
    ```json
    {
      "mapping": {
        "[ST_001:A4F2]": "Jane Doe",
        "Jane Doe": "[ST_001:A4F2]"
      },
      "last_updated": "2026-03-03T..."
    }
    ```

### C. Opt-In Configuration
Users enable this feature by adding the following to their Gemini CLI `settings.json`:
```json
{
  "hooks": [
    {
      "matcher": "mcp__canvas_mcp__.*",
      "after": "packages/gemini-hooks/dist/after_tool.js"
    },
    {
      "matcher": "llm_request",
      "before": "packages/gemini-hooks/dist/before_model.js"
    },
    {
      "matcher": "llm_response",
      "after": "packages/gemini-hooks/dist/after_model.js"
    }
  ]
}
```

---

## 4. Implementation Roadmap

### Phase 1: Server Enhancement
- [ ] Modify `SecureStore` to support character-length-matched tokens.
- [ ] Implement `SidecarManager` to write and prune the `pii_session.json` file.
- [ ] Ensure the file is deleted on `SIGINT`/`SIGTERM`.

### Phase 2: Hook Development (`packages/gemini-hooks`)
- [ ] Create `before_model` script (Input → Token).
- [ ] Create `after_model` script (Token → Name).
- [ ] Create `after_tool` script (JSON → Progress Bar).

### Phase 3: Validation
- [ ] Test alignment in LLM-generated Markdown tables.
- [ ] Verify zero PII leakage in `server.log` and LLM history.
- [ ] Confirm compatibility with Claude Code (standard behavior remains active).
