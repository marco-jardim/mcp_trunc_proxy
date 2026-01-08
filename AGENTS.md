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

## TROUBLESHOOTING GUIDE (FOR AGENTS INSTALLING THE PROXY)

When helping users set up mcp-trunc-proxy, watch for these common issues:

### Symptom: MCPs Fail After Adding Proxy

**Errors to watch for:**
- `MCP error -32000: Connection closed`
- `Operation timed out after 30000ms`
- `ENOENT` or `command not found`

**Root cause:** Usually NOT the proxy, but slow-starting downstream servers.

### The `npx -y package@latest` Problem

Using `npx -y package@latest` inside the proxy command causes double startup delay:
1. Proxy starts (fast, <1s)
2. Proxy spawns `npx -y package@latest` which **downloads the package every time**

MCP clients typically have 30-second connection timeouts. If download + init exceeds this → connection fails.

### Fix: Pre-install Slow Packages Globally

```bash
# Identify and install problematic packages
npm install -g playwriter @morphllm/morphmcp @anthropic/mcp-server-puppeteer
```

**Before (slow):**
```json
["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
 "npx", "-y", "playwriter@latest"]
```

**After (fast):**
```json
["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
 "playwriter"]
```

### Known Slow Servers

| Package | Issue | Solution |
|---------|-------|----------|
| `playwriter` | Large deps | `npm install -g playwriter` |
| `@morphllm/morphmcp` | Heavy init | `npm install -g @morphllm/morphmcp` |
| `serverless mcp` | AWS SDK load | Pre-install or disable if unused |
| `@anthropic/mcp-server-puppeteer` | Chromium download | Pre-install globally |
| `context7` (from plugins) | Network calls | Not user-configurable, plugin issue |

### Diagnosis Steps

1. **Test WITHOUT proxy first** - If it still times out, issue is npx/package, not proxy
2. **Run command manually in terminal** - See actual error output
3. **Check if package is installed** - `npm list -g <package>`

### Agent Checklist When Installing Proxy

1. ✅ Wrap each MCP with proxy (correct `--` separator)
2. ✅ Preserve all env vars and args
3. ⚠️ If using `npx -y package@latest`, warn user about potential timeouts
4. ⚠️ For known slow packages, suggest global install
5. ✅ After config change, tell user to restart their MCP client
6. ✅ If errors persist, check if server works WITHOUT proxy first

## DRY-RUN VERIFICATION PROTOCOL (MANDATORY)

**ACCEPTANCE CRITERIA:** Before reporting success to the user, you MUST dry-run test EVERY MCP server through the proxy and present findings.

### Step 1: Extract Commands from Config

For each enabled MCP in the user's config, extract the full command that will be spawned.

### Step 2: Dry-Run Each MCP

Run each command with a 10-15 second timeout to verify it starts successfully:

```bash
# Test pattern (adjust timeout for your OS)
timeout 10 npx mcp-trunc-proxy --max-bytes <N> -- <downstream-command> 2>&1

# Expected success output:
# "Proxy started, waiting for JSON-RPC..."
# OR the proxy sits waiting for input (no errors)

# Failure indicators:
# - "spawn ENOENT" - command not found
# - "spawn EINVAL" - Windows .cmd script issue
# - "ETIMEDOUT" - package download too slow
# - "Cannot find module" - missing dependency
# - Any stack trace or error message
```

### Step 3: Present Findings Table

After testing ALL MCPs, present results to user:

```markdown
## MCP Proxy Verification Results

| MCP Name | Status | Command Tested | Issue Found | Fix Applied |
|----------|--------|----------------|-------------|-------------|
| stripe-sandbox | ✅ PASS | `node ...stripe/mcp/dist/index.js` | - | - |
| playwriter | ❌ FAIL | `playwriter` | spawn EINVAL | Changed to node + entry point |
| playwriter | ✅ PASS | `node .../playwriter/bin.js` | - | Fixed |
| morph-mcp | ❌ FAIL | `morphmcp` | Wrong binary name | Changed to `morph-mcp` |
| morph-mcp | ❌ FAIL | `morph-mcp` | spawn EINVAL | Changed to node + entry point |
| morph-mcp | ✅ PASS | `node .../morphmcp/dist/index.js` | - | Fixed |
| serverless | ❌ FAIL | `serverless mcp` | spawn EINVAL | Changed to node + entry point |
| serverless | ✅ PASS | `node .../serverless/run.js mcp` | - | Fixed |
| aws-docs | ✅ PASS | `uvx awslabs...` | - | - |

### Summary
- **Total MCPs:** 6
- **Passed:** 4
- **Fixed:** 3 (playwriter, morph-mcp, serverless)
- **Still Failing:** 0

### Action Required
Please restart OpenCode/your MCP client for changes to take effect.
```

### Step 4: Iterate Until All Pass

**DO NOT** report completion until:
1. Every enabled MCP has been tested
2. Every failing MCP has been fixed OR user acknowledges it should be disabled
3. Re-test after each fix to confirm resolution
4. Final table shows all MCPs passing

### Common Fix Patterns

| Error | Platform | Diagnosis | Fix |
|-------|----------|-----------|-----|
| `spawn ENOENT` | All | Command not in PATH | Use absolute path or `node` + entry point |
| `spawn EINVAL` | Windows | `.cmd`/`.bat` script | Use `node` + JS entry point |
| `ETIMEDOUT` | All | `npx -y` download slow | Pre-install globally, use direct command |
| `Cannot find module` | All | Package not installed | `npm install -g <package>` |
| `command not found` | All | Binary name wrong | Find correct binary: `npm bin -g`, `ls $(npm root -g)/<pkg>` |

### Windows-Specific Testing

On Windows, `.cmd` wrapper scripts often fail when spawned through the proxy. Always test and be prepared to:

1. **Find the package's node_modules location:**
   ```powershell
   npm root -g
   # Example: C:\Users\Name\scoop\persist\nodejs\bin\node_modules
   ```

2. **Find the entry point in package.json:**
   ```powershell
   cat "<npm-root>/<package>/package.json" | Select-String "bin" -Context 0,5
   ```

3. **Convert command to node + entry point:**
   ```json
   // Before (fails)
   ["playwriter"]
   
   // After (works)  
   ["node", "C:\\Users\\Name\\...\\node_modules\\playwriter\\bin.js"]
   ```

### Python/uvx Commands

For Python-based MCP servers using `uvx`:
- `uvx` usually works cross-platform
- If it fails, try: `python -m <module_name>` with absolute path
- Check if the Python environment is activated

### Verification Script (for agents)

```bash
# Batch test all MCPs - run each and capture result
for cmd in "${mcp_commands[@]}"; do
  echo "Testing: $cmd"
  timeout 10 $cmd 2>&1 | head -5
  echo "Exit code: $?"
  echo "---"
done
```

### Non-Negotiable Rules

1. **NEVER** skip dry-run testing
2. **NEVER** report success without presenting the findings table
3. **ALWAYS** re-test after applying fixes
4. **ALWAYS** iterate until all MCPs pass or user explicitly accepts failures
5. **ALWAYS** tell user to restart their MCP client after changes
