# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-08
**Commit:** 2c67a54
**Branch:** main

## OVERVIEW

MCP stdio proxy that offloads large tool results to artifact storage (memory/file/redis), returning compact previews + retrieval tool. Saves tokens by preventing giant payloads from entering LLM context.

## STRUCTURE

```
mcp-trunc-proxy/
├── src/
│   ├── cli.mjs       # Entry point, CLI arg parsing
│   ├── proxy.mjs     # Core: JSON-RPC interception, artifact creation
│   ├── store.mjs     # Storage backends (memory/file/redis)
│   ├── state.mjs     # Shared state (avoids circular deps)
│   └── util.mjs      # Helpers: JSON parsing, byte length
├── tests/
│   ├── unit/         # Pure function tests
│   ├── functional/   # Integration with fake server
│   └── e2e/          # Full CLI subprocess tests
├── examples/
│   ├── demo-client.mjs      # Test client
│   └── fake-mcp-server.mjs  # Mock MCP server for testing
├── benchmarks/       # Token savings & perf metrics
├── docs/             # QA-ISSUES-*.md documentation
└── tools/            # Empty (README only)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add CLI flag | `src/cli.mjs` | parseArgs() + pass to runProxy() |
| Change truncation logic | `src/proxy.mjs` | summarizeLines(), buildTruncatedToolResult() |
| Add storage backend | `src/store.mjs` | Follow MemoryStore pattern, implement put/get/info/close |
| Add retrieval mode | `src/proxy.mjs` | handleProxyToolCall(), update makeInjectedTools() schema |
| Add shared state | `src/state.mjs` | Avoids circular deps between modules |
| Add unit tests | `tests/unit/` | Vitest, pure functions |
| Add integration tests | `tests/functional/` | Uses ProxyClient helper |
| Add CLI tests | `tests/e2e/` | Spawns subprocess |

## CODE MAP

| Symbol | Location | Role |
|--------|----------|------|
| `runProxy()` | proxy.mjs | Main entry, spawns child, intercepts JSON-RPC |
| `createStore()` | store.mjs | Factory for storage backends |
| `handleProxyToolCall()` | proxy.mjs | Handles proxy_artifact_get/info requests |
| `storeToolResultArtifact()` | proxy.mjs | Gzip + store, returns truncated result |
| `summarizeLines()` | proxy.mjs | Extract errors + head/tail for preview |
| `makeInjectedTools()` | proxy.mjs | JSON schema for proxy tools |
| `globalState` | state.mjs | Shared mutable state object |

## CONVENTIONS

- **ESM only** (.mjs), no TypeScript, no build step
- **Naming**: `mk*` for ID generators, `make*` for factories, `UPPER_SNAKE` for constants
- **Style**: 2-space indent, double quotes, semicolons, camelCase
- **Env vars**: `MCP_TRUNC_PROXY_*` prefix, CLI flags take precedence
- **Error handling**: Best-effort cleanup, silent failures acceptable for TTL/sweep
- **Node**: Requires >=18

## ANTI-PATTERNS

- **NEVER** return full artifacts in preview - use targeted retrieval (grep/range/tail)
- **NEVER** assume tool outputs are safe - may contain secrets, prefer memory store
- **AVOID** synchronous file I/O in hot paths
- Error extraction is heuristic - patterns like ERROR, FAIL, Exception, not exhaustive

## TESTING

```bash
npm test              # All tests (unit + functional + e2e)
npm run test:unit     # Unit tests only
npm run test:functional  # Integration tests
npm run test:e2e      # CLI subprocess tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

- **Framework**: Vitest (fork pool, 30s timeout)
- **Helpers**: `ProxyClient` spawns proxy+server for integration tests
- **Manual**: Run fake-mcp-server + demo-client for smoke testing

## COMMANDS

```bash
# Run proxy wrapping any MCP server
node src/cli.mjs --max-bytes 80000 -- <mcp-server-command>

# Lint (syntax check only)
npm run lint

# Benchmarks
npm run benchmark:tokens  # Token savings metrics
npm run benchmark:perf    # Performance metrics

# Manual smoke test
node src/cli.mjs --max-bytes 20000 -- node examples/fake-mcp-server.mjs
# Then in another terminal:
node examples/demo-client.mjs
```

## CI/CD

- **GitHub Actions**: `.github/workflows/ci.yml`
  - 9-matrix: 3 OS × 3 Node versions
  - Pipeline: lint → unit → functional → e2e → benchmark upload
- **Auto-versioning**: `version-bump.yml` uses conventional commits
- **Dependencies**: `auto-merge-dependabot.yml`
- **Publishing**: Trusted npm publishing via OIDC

## NOTES

- Redis is optional dependency - graceful fallback if not installed
- `.serverless/` dir is deployment artifact, ignore
- `docs/QA-ISSUES-*.md` documents historical bug fixes (58 ISSUE-* comments in code)
- JSON-RPC batch messages (arrays) are supported
- Security: Redis creds masked in logs, path traversal prevention, base64 validation
