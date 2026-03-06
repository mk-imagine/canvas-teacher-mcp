# Security Implementation Details

## Overview
`canvas-mcp` is designed to be a high-security bridge between your Canvas LMS data and an AI assistant. To ensure student privacy and data integrity, several low-level security features are implemented.

## Secure Store Architecture
The `SecureStore` (found in `packages/core/src/security/secure-store.ts`) is responsible for PII blinding and managing student identity tokens.

### In-Memory Encryption
- **AES-256-GCM:** Each PII entry (Canvas ID and student name) is encrypted using AES-256-GCM before being stored in a local `Map`.
- **Per-Session Key:** A fresh 32-byte encryption key is generated using `node:crypto.randomBytes()` every time the server starts. This key never touches the disk.
- **Counter-Based Tokens:** Student tokens (e.g., `[STUDENT_001]`) are generated in the order they are first encountered in the session, preventing any information leakage through token ID patterns.

### Memory Locking (`mlock`)
To prevent the session encryption key from being swapped to disk (where it could potentially be recovered from a swap file or hibernation file), the server attempts to "pin" the key in physical RAM.
- **Dependency:** `posix-node`
- **Implementation:** `posixNode.mlock(this.sessionKey)`
- **Benefit:** Reduces the risk of "cold boot" attacks or forensic analysis of the host's disk.

### Secure Heap Protection
For maximum security, the server should be run with the `--secure-heap` flag. This flag (available in modern Node.js) instructs OpenSSL to use a dedicated, protected memory region for its internal cryptographic buffers.
- **Recommended Usage:** `node --secure-heap=65536 packages/teacher/dist/index.js`

### Anti-Core Dump
To prevent student PII or encryption keys from appearing in a core dump (created if the process crashes), users are encouraged to set OS-level limits:
- **macOS/Linux:** `ulimit -c 0`
- **macOS (launchctl):** `launchctl limit core 0`

## Data Lifecycle
1.  **Ingestion:** Student data is fetched via the Canvas API.
2.  **Encryption:** PII is immediately tokenized and encrypted by `SecureStore`.
3.  **Transmission:** Only the blinded data (containing tokens) is sent to the AI client.
4.  **Destruction:** When `SecureStore.destroy()` is called (or the process exits), the session key is zero-filled in memory (`Buffer.fill(0)`), rendering the stored encrypted data unrecoverable.

## FERPA Compliance
See [FERPA.md](./FERPA.md) for the legal and privacy justification for these security measures.
