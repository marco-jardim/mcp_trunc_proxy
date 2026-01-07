# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-07
**Commit:** 6befae4
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
│   └── util.mjs      # Helpers: JSON parsing, byte length
├── examples/
│   ├── demo-client.mjs      # Test client
│   └── fake-mcp-server.mjs  # Mock MCP server for testing
└── tools/                   # Empty (README only)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add CLI flag | `src/cli.mjs` | parseArgs() + pass to runProxy() |
| Change truncation logic | `src/proxy.mjs` | summarizeLines(), buildTruncatedToolResult() |
| Add storage backend | `src/store.mjs` | Follow MemoryStore pattern, implement put/get/info/close |
| Add retrieval mode | `src/proxy.mjs` | handleProxyToolCall(), update makeInjectedTools() schema |
| Test changes | `examples/` | Run fake-mcp-server + demo-client manually |

## CODE MAP

| Symbol | Location | Role |
|--------|----------|------|
| `runProxy()` | proxy.mjs | Main entry, spawns child, intercepts JSON-RPC |
| `createStore()` | store.mjs | Factory for storage backends |
| `handleProxyToolCall()` | proxy.mjs | Handles proxy_artifact_get/info requests |
| `storeToolResultArtifact()` | proxy.mjs | Gzip + store, returns truncated result |
| `summarizeLines()` | proxy.mjs | Extract errors + head/tail for preview |
| `makeInjectedTools()` | proxy.mjs | JSON schema for proxy tools |

## CONVENTIONS

- **ESM only** (.mjs), no TypeScript, no build step
- **Naming**: `mk*` for ID generators, `make*` for factories
- **Style**: 2-space indent, double quotes, semicolons, camelCase
- **Env vars**: `MCP_TRUNC_PROXY_*` prefix, CLI flags take precedence
- **Error handling**: Best-effort cleanup, silent failures acceptable for TTL/sweep

## ANTI-PATTERNS

- **NEVER** return full artifacts in preview - use targeted retrieval (grep/range/tail)
- **NEVER** assume tool outputs are safe - may contain secrets, prefer memory store
- **AVOID** synchronous file I/O in hot paths
- Error extraction is heuristic - patterns like ERROR, FAIL, Exception, not exhaustive

## COMMANDS

```bash
# Run proxy wrapping any MCP server
node src/cli.mjs --max-bytes 80000 -- <mcp-server-command>

# Syntax check (no real linting)
npm run lint

# Manual smoke test
node src/cli.mjs --max-bytes 20000 -- node examples/fake-mcp-server.mjs
# Then in another terminal:
node examples/demo-client.mjs
```

## NOTES

- Redis is optional dependency - graceful fallback if not installed
- `.serverless/` dir is deployment artifact, ignore
- No test framework - integration testing only via examples
- JSON-RPC batch messages (arrays) are supported
