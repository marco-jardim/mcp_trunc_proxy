# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-07

### Added
- `-v, --version` flag to display version from package.json
- Redis reconnection with exponential backoff (up to 10 retries, max 3s delay)
- Graceful shutdown on SIGTERM/SIGINT with store cleanup
- Request timeout cleanup (5 minutes) to prevent memory leaks
- Tool name collision warnings when downstream server has conflicting tool names
- Proactive file cleanup interval (every 5 minutes) for expired FileStore artifacts
- JSDoc documentation for all store methods
- ESLint configuration for code quality

### Fixed
- **60 issues** identified and resolved across 6 comprehensive QA rounds:
  - Round 1 (Senior QA): 15 issues - Core functionality fixes
  - Round 2 (QA Manager): 13 issues - Consistency and error handling
  - Round 3 (QA Director): 11 issues - Robustness and edge cases
  - Round 4 (VP Engineering): 9 issues - Architecture and performance
  - Round 5 (CTO): 7 issues - Polish and optimization
  - Round 6 (Board): 5 issues - Final refinements

### Security
- Redis credentials automatically masked in log output
- Path traversal prevention in FileStore (artifact ID sanitization)
- Base64 validation on artifact retrieval to prevent corrupt data issues

### Performance
- FileStore async I/O (converted from sync operations)
- Atomic file writes with temp file + rename pattern
- MemoryStore sweep() only called when at 90%+ capacity
- FileStore cleanup reads only first 200 bytes for expiry check
- Base64 size estimation without full decode in info() methods
- RETRIEVAL_DEFAULTS moved to module level (no recreation per call)

### Changed
- Error context in previews increased from ±2 to ±5 lines for better stack traces
- All log messages standardized to lowercase
- Plain string patterns in grep now converted to escaped case-insensitive regex
- Invalid CLI arguments now show clear error messages with the invalid value
- Invalid environment variables now show consolidated warning message

### Architecture
- Created `src/state.mjs` to eliminate circular imports between cli.mjs and proxy.mjs
- Extracted shared file reading logic in FileStore to reduce code duplication

---

For detailed information about each issue, see the QA documents in `docs/`:
- `docs/QA-ISSUES.md` - Round 1
- `docs/QA-ISSUES-ROUND2.md` - Round 2
- `docs/QA-ISSUES-ROUND3.md` - Round 3
- `docs/QA-ISSUES-ROUND4.md` - Round 4
- `docs/QA-ISSUES-ROUND5.md` - Round 5
- `docs/QA-ISSUES-ROUND6.md` - Round 6
