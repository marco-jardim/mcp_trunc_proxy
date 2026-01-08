# QA Issues Tracker - Round 4 (VP Engineering Review)

**Review Date:** 2026-01-07  
**Reviewer:** VP Engineering  
**Previous Reviews:** Senior QA (15), QA Manager (13), QA Director (11) - all fixed  
**Project Version:** 0.1.0

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 0 | - |
| High | 1 | ✅ Fixed |
| Medium | 4 | ✅ Fixed |
| Low | 4 | ✅ Fixed |
| **Total** | **9** | **✅ All Fixed** |

---

## 🟠 High Priority Issues

### ISSUE-040: Circular Import Between cli.mjs and proxy.mjs

**Status:** ✅ Fixed  
**Files:** `src/cli.mjs`, `src/proxy.mjs`

**Problem:**
```javascript
// cli.mjs exports setActiveStore
export function setActiveStore(store) { activeStore = store; }

// proxy.mjs imports from cli.mjs
import { setActiveStore } from "./cli.mjs";
```
This creates a circular dependency: `cli.mjs` imports from `proxy.mjs` (runProxy), and `proxy.mjs` imports from `cli.mjs` (setActiveStore). While Node.js ESM handles this, it's fragile and can cause issues with bundlers or future refactoring.

**Implementation:**
Create a separate module for shared state:
```javascript
// src/state.mjs
let activeStore = null;
export function setActiveStore(store) { activeStore = store; }
export function getActiveStore() { return activeStore; }
```

Update imports in both files to use `src/state.mjs`.

**Acceptance Criteria:**
- [ ] No circular imports between modules
- [ ] Store cleanup still works on fatal error
- [ ] All existing functionality preserved

---

## 🟡 Medium Priority Issues

### ISSUE-041: Redis Operations Not Wrapped in Try-Catch

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 321-332, 341, 362, 371

**Problem:**
```javascript
async put(id, data, meta) {
  // ...
  await client.set(key(id), JSON.stringify(rec), { EX: ttlSeconds });
  // No try-catch - Redis errors propagate uncaught
}
```
Redis operations can throw on connection issues. While reconnection is now handled, individual operation failures aren't caught, potentially crashing the proxy.

**Implementation:**
```javascript
async put(id, data, meta) {
  const rec = { ... };
  try {
    if (ttlSeconds) {
      await client.set(key(id), JSON.stringify(rec), { EX: ttlSeconds });
    } else {
      await client.set(key(id), JSON.stringify(rec));
    }
  } catch (err) {
    log?.error?.(`Redis put failed for ${id}: ${err.message}`);
    throw err; // Re-throw to let caller handle
  }
}
```
Apply similar pattern to get(), info(), and ttl() calls.

**Acceptance Criteria:**
- [ ] Redis operation errors are logged with context
- [ ] Errors still propagate to callers for handling
- [ ] Proxy doesn't crash silently on Redis issues

---

### ISSUE-042: summarizeLines Error Context Limited to ±2 Lines

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 192-195

**Problem:**
```javascript
for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) picked.push(j);
```
Error context is hardcoded to ±2 lines. Stack traces often need more context (e.g., 5-10 lines) to be useful.

**Implementation:**
```javascript
const ERROR_CONTEXT_LINES = 5; // Configurable context around error lines
for (let j = Math.max(0, i - ERROR_CONTEXT_LINES); j <= Math.min(lines.length - 1, i + ERROR_CONTEXT_LINES); j++) {
  picked.push(j);
}
```

**Acceptance Criteria:**
- [ ] Error context increased to ±5 lines
- [ ] Magic number extracted to named constant
- [ ] Stack traces more useful in previews

---

### ISSUE-043: RETRIEVAL_DEFAULTS Defined Inside Function

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 311-318

**Problem:**
```javascript
async function handleProxyToolCall(req) {
  // ...
  const RETRIEVAL_DEFAULTS = { ... }; // Recreated on every call
```
The RETRIEVAL_DEFAULTS object is recreated on every tool call. Should be defined once at module level.

**Implementation:**
Move to module level (near line 157 with other constants):
```javascript
const EXTRACT_MAX_CHARS = 500;

const RETRIEVAL_DEFAULTS = {
  MAX_LINES: 400,
  MAX_LINES_LIMIT: 5000,
  MAX_BYTES: 200000,
  MAX_BYTES_LIMIT: 2_000_000,
  HEAD_LINES: 200,
  TAIL_LINES: 200,
};
```

**Acceptance Criteria:**
- [ ] Constants defined at module level
- [ ] No object recreation on each call
- [ ] Slight performance improvement

---

### ISSUE-044: FileStore Cleanup Reads Entire File Just for Expiry Check

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 166-171

**Problem:**
```javascript
const raw = await readFile(filePath, "utf8");
const rec = JSON.parse(raw);
if (rec.expiresAt && Date.parse(rec.expiresAt) <= now) {
```
The cleanup function reads entire artifact files (potentially megabytes) just to check the expiresAt timestamp in the first ~50 bytes of JSON.

**Implementation:**
Option A: Use streaming JSON parser (adds dependency)
Option B: Store expiry in filename for O(1) check:
```javascript
// Filename format: {id}_{expiresAt}.json
function pathFor(id, expiresAt) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const expiry = expiresAt ? new Date(expiresAt).getTime() : 0;
  return join(baseDir, `${safeId}_${expiry}.json`);
}

// Cleanup just checks filename
async function cleanup() {
  const files = await readdir(baseDir);
  const now = Date.now();
  for (const file of files) {
    const match = file.match(/_(\d+)\.json$/);
    if (match && parseInt(match[1], 10) <= now && parseInt(match[1], 10) > 0) {
      await unlink(join(baseDir, file)).catch(() => {});
    }
  }
}
```

Option C (minimal): Read only first 200 bytes:
```javascript
const handle = await open(filePath, "r");
const buf = Buffer.alloc(200);
await handle.read(buf, 0, 200, 0);
await handle.close();
const partial = buf.toString("utf8");
const match = partial.match(/"expiresAt"\s*:\s*"([^"]+)"/);
```

**Acceptance Criteria:**
- [ ] Cleanup doesn't read entire multi-MB files
- [ ] Expiry check is O(1) or O(small constant)
- [ ] Existing files still work (migration path)

---

## 🟢 Low Priority Issues

### ISSUE-045: Log Level Validation Missing

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 613-615

**Problem:**
```javascript
const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const cur = levels[level] ?? 3;
```
Invalid log level like `--log-level verbose` silently defaults to `info`. User has no idea their config was ignored.

**Implementation:**
```javascript
function makeLogger(level) {
  const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  if (level && !(level in levels)) {
    process.stderr.write(`[mcp-trunc-proxy] warn: invalid log level "${level}", using "info"\n`);
  }
  const cur = levels[level] ?? 3;
  // ...
}
```

**Acceptance Criteria:**
- [ ] Invalid log levels show warning
- [ ] Valid levels still work
- [ ] Default behavior unchanged

---

### ISSUE-046: envInt Called Multiple Times for Same Var

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Lines:** 15-20

**Problem:**
```javascript
maxBytes: envInt("MCP_TRUNC_PROXY_MAX_BYTES", 80000),
previewMaxChars: envInt("MCP_TRUNC_PROXY_PREVIEW_MAX_CHARS", 6000),
// ... 6 total calls
```
Each envInt call potentially writes to stderr if invalid. If user has multiple invalid env vars, they get multiple warnings. Minor inefficiency and noisy output.

**Implementation:**
Batch validate all env vars at startup:
```javascript
function loadEnvConfig() {
  const envVars = [
    { key: "MCP_TRUNC_PROXY_MAX_BYTES", default: 80000 },
    { key: "MCP_TRUNC_PROXY_PREVIEW_MAX_CHARS", default: 6000 },
    // ...
  ];
  const result = {};
  const warnings = [];
  for (const { key, default: def } of envVars) {
    const v = process.env[key];
    if (v == null) { result[key] = def; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      warnings.push(`${key}="${v}"`);
      result[key] = def;
    } else {
      result[key] = n;
    }
  }
  if (warnings.length) {
    process.stderr.write(`[mcp-trunc-proxy] warn: invalid env vars: ${warnings.join(", ")}, using defaults\n`);
  }
  return result;
}
```

**Acceptance Criteria:**
- [ ] Single consolidated warning for all invalid env vars
- [ ] Cleaner startup output
- [ ] Same validation behavior

---

### ISSUE-047: Child Process Spawn Errors Not Handled

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 36-39

**Problem:**
```javascript
const child = spawn(config.childCommand[0], config.childCommand.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
```
If the downstream command doesn't exist (e.g., typo in path), spawn emits an 'error' event that's not handled. This can crash the proxy with an uncaught error.

**Implementation:**
```javascript
const child = spawn(config.childCommand[0], config.childCommand.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

child.on("error", (err) => {
  log.error(`failed to start downstream server: ${err.message}`);
  process.exit(1);
});
```

**Acceptance Criteria:**
- [ ] Spawn errors are caught and logged
- [ ] Clear error message for missing/invalid commands
- [ ] Graceful exit instead of uncaught exception

---

### ISSUE-048: stableStringify Could Exceed Call Stack on Deep Objects

**Status:** ✅ Fixed  
**File:** `src/util.mjs`  
**Lines:** 19-33

**Problem:**
```javascript
export function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    // Recursive replacer on very deep objects
  });
}
```
While circular refs are handled, extremely deep objects (1000+ levels) can still cause stack overflow in the replacer function. Rare but possible with malformed tool outputs.

**Implementation:**
Add depth tracking:
```javascript
export function stableStringify(obj, maxDepth = 100) {
  const seen = new WeakSet();
  let depth = 0;
  return JSON.stringify(
    obj,
    function(_k, v) {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        if (depth > maxDepth) return "[MaxDepth]";
        seen.add(v);
        depth++;
      }
      return v;
    },
    0,
  );
}
```
Note: This is approximate since JSON.stringify's traversal order makes exact depth tracking complex.

**Acceptance Criteria:**
- [ ] Very deep objects don't crash
- [ ] Depth-limited output indicates truncation
- [ ] Normal objects unaffected

---

## Implementation Order

### Phase 1: High Priority
1. ISSUE-040: Fix circular import (15 min)

### Phase 2: Medium Priority
2. ISSUE-041: Redis try-catch wrappers (15 min)
3. ISSUE-043: Move RETRIEVAL_DEFAULTS to module level (5 min)
4. ISSUE-042: Increase error context to ±5 lines (5 min)
5. ISSUE-044: Optimize FileStore cleanup (30 min)

### Phase 3: Low Priority
6. ISSUE-047: Handle child spawn errors (5 min)
7. ISSUE-045: Log level validation warning (5 min)
8. ISSUE-046: Batch env var validation (15 min)
9. ISSUE-048: Depth limit in stableStringify (10 min)

---

## Final Notes

After three rounds of fixes (39 issues total), the codebase is mature. Round 4 findings are:
- **Architecture**: Circular import should be resolved for maintainability
- **Resilience**: Redis operation errors, spawn errors
- **Performance**: Unnecessary object creation, inefficient file reads
- **Polish**: Validation warnings, depth limits

No critical issues. The proxy is production-ready. These are refinements for edge cases and long-term maintainability.

---

**Document Maintained By:** VP Engineering  
**Last Updated:** 2026-01-07  
**All Issues Resolved:** 2026-01-07
