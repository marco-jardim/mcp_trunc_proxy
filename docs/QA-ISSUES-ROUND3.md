# QA Issues Tracker - Round 3 (Director Review)

**Review Date:** 2026-01-07  
**Reviewer:** QA Director  
**Previous Reviews:** Senior QA (15 issues), QA Manager (13 issues) - all fixed  
**Project Version:** 0.1.0

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 0 | - |
| High | 2 | ✅ Fixed |
| Medium | 5 | ✅ Fixed |
| Low | 4 | ✅ Fixed |
| **Total** | **11** | **✅ All Fixed** |

---

## 🟠 High Priority Issues

### ISSUE-029: Buffer.from on Potentially Invalid Base64

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 155, 181, 252, 273

**Problem:**
```javascript
return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
```
If `rec.dataB64` is undefined, null, or not a valid base64 string, `Buffer.from()` may return garbage data or empty buffer silently. No validation.

**Implementation:**
```javascript
// Add validation helper at top of file
function decodeBase64Safe(b64, log, context) {
  if (typeof b64 !== "string" || !b64) {
    log?.error?.(`Invalid base64 data in ${context}: expected string, got ${typeof b64}`);
    return null;
  }
  try {
    return Buffer.from(b64, "base64");
  } catch (err) {
    log?.error?.(`Failed to decode base64 in ${context}: ${err.message}`);
    return null;
  }
}

// Usage in get():
const data = decodeBase64Safe(rec.dataB64, log, `artifact ${id}`);
if (!data) return null;
return { id, data, meta: rec.meta };
```

**Acceptance Criteria:**
- [ ] Invalid/missing dataB64 returns null instead of corrupt data
- [ ] Error is logged with context
- [ ] All 4 locations (FileStore get/info, RedisStore get/info) are protected

---

### ISSUE-030: Redis Client Not Reconnecting on Connection Loss

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 204-206

**Problem:**
```javascript
const client = createClient({ url });
client.on("error", (err) => log?.error?.(`redis error: ${err?.message ?? err}`));
await client.connect();
```
Redis client logs errors but doesn't attempt reconnection. If Redis connection drops mid-operation, all subsequent operations fail permanently.

**Implementation:**
```javascript
const client = createClient({ 
  url,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        log?.error?.("redis reconnect failed after 10 attempts");
        return new Error("Redis reconnect exhausted");
      }
      return Math.min(retries * 100, 3000); // Exponential backoff, max 3s
    }
  }
});
client.on("error", (err) => log?.error?.(`redis error: ${err?.message ?? err}`));
client.on("reconnecting", () => log?.warn?.("redis reconnecting..."));
await client.connect();
```

**Acceptance Criteria:**
- [ ] Redis client attempts reconnection on connection loss
- [ ] Exponential backoff between retries
- [ ] Gives up after reasonable number of attempts
- [ ] Reconnection attempts are logged

---

## 🟡 Medium Priority Issues

### ISSUE-031: parsePattern Returns Null for Plain Strings

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 562-575

**Problem:**
```javascript
function parsePattern(pattern) {
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    // ... returns RegExp or {error}
  }
  return null;  // Plain strings return null
}
```
When user provides plain text like `"error"` (not `/error/`), parsePattern returns null. The grep logic then does case-insensitive substring match, which works but is inconsistent. User might expect `error` to work same as `/error/i`.

**Implementation:**
```javascript
function parsePattern(pattern) {
  // Accept /re/flags style regex
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const last = pattern.lastIndexOf("/");
    const body = pattern.slice(1, last);
    const flags = pattern.slice(last + 1);
    try {
      return new RegExp(body, flags);
    } catch (err) {
      return { error: `Invalid regex: ${err.message}` };
    }
  }
  // Plain string: escape special chars and create case-insensitive regex
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}
```

**Acceptance Criteria:**
- [ ] Plain strings are converted to escaped, case-insensitive regex
- [ ] Regex syntax `/pattern/flags` still works
- [ ] Special regex chars in plain strings are escaped
- [ ] Behavior is consistent between plain string and regex input

---

### ISSUE-032: envInt Silently Falls Back on Invalid Env Vars

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Lines:** 67-72

**Problem:**
```javascript
function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;  // Silent fallback
}
```
If user sets `MCP_TRUNC_PROXY_MAX_BYTES=abc`, it silently uses default 80000. User has no idea their config was ignored.

**Implementation:**
```javascript
function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    process.stderr.write(`[mcp-trunc-proxy] warn: invalid ${name}="${v}", using default ${fallback}\n`);
    return fallback;
  }
  return n;
}
```

**Acceptance Criteria:**
- [ ] Invalid env var values log a warning
- [ ] Warning shows the env var name and invalid value
- [ ] Warning shows what default is being used
- [ ] Valid values still work silently

---

### ISSUE-033: --error-pattern Documented But Not Implemented

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Line:** 90

**Problem:**
```javascript
--error-pattern <regex>   Custom regex for error extraction (default: error|fail|exception|...)
```
This option is documented in help text but never implemented. The error pattern is hardcoded in proxy.mjs line 175.

**Implementation:**
Option A: Remove from help text (minimal fix)
Option B: Implement the feature (full fix):
```javascript
// In cli.mjs parseArgs:
case "--error-pattern": args.errorPattern = String(next); i += val ? 1 : 2; break;

// In proxy.mjs summarizeLines:
const errorish = config.errorPattern 
  ? new RegExp(config.errorPattern, "i")
  : /(error|fail|failed|exception|traceback|assert|panic|fatal)/i;
```

**Acceptance Criteria:**
- [ ] Either remove --error-pattern from help OR implement it
- [ ] If implemented: custom pattern works for error extraction
- [ ] If implemented: invalid regex shows clear error

---

### ISSUE-034: MemoryStore info() Doesn't Check Expiry

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 58-70

**Problem:**
```javascript
async info(id) {
  const rec = map.get(id);
  if (!rec) return null;
  // Missing: expiry check that exists in get()
  return { ... };
}
```
`get()` checks `rec.expiresAt` and deletes expired entries, but `info()` returns metadata for expired artifacts. Inconsistent behavior.

**Implementation:**
```javascript
async info(id) {
  const rec = map.get(id);
  if (!rec) return null;
  // Add expiry check consistent with get()
  if (rec.expiresAt && rec.expiresAt <= Date.now()) {
    map.delete(id);
    return null;
  }
  return { ... };
}
```

**Acceptance Criteria:**
- [ ] info() returns null for expired artifacts
- [ ] Expired artifacts are deleted on info() call
- [ ] Behavior matches get()

---

### ISSUE-035: Duplicate Code in FileStore get() and info()

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 138-161, 164-188

**Problem:**
Both methods have nearly identical error handling, JSON parsing, and file reading logic. DRY violation makes maintenance harder.

**Implementation:**
```javascript
// Extract shared logic
async function readArtifactFile(filePath, id, log) {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      log?.error?.(`Corrupt artifact file ${id}: ${parseErr.message}`);
      return null;
    }
  } catch (err) {
    if (err.code === "ENOENT") return null;
    log?.error?.(`Error reading artifact file ${id}: ${err.message}`);
    return null;
  }
}

// Simplify get() and info() to use shared helper
async get(id) {
  const rec = await readArtifactFile(pathFor(id), id, log);
  if (!rec) return null;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
    await unlink(pathFor(id)).catch(() => {});
    return null;
  }
  return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
}
```

**Acceptance Criteria:**
- [ ] Shared file reading logic extracted to helper
- [ ] get() and info() use the same helper
- [ ] Error handling remains identical
- [ ] All tests still pass

---

## 🟢 Low Priority Issues

### ISSUE-036: Magic Numbers in clampInt Calls

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 296-297, 307-308, 311, 314

**Problem:**
```javascript
const maxLines = clampInt(args.maxLines ?? 400, 1, 5000);
const maxBytes = clampInt(args.maxBytes ?? 200000, 1024, 2_000_000);
```
Multiple magic numbers (400, 5000, 200000, 2_000_000) scattered throughout the code.

**Implementation:**
```javascript
// Add constants at top of function or file
const DEFAULTS = {
  MAX_LINES: 400,
  MAX_LINES_LIMIT: 5000,
  MAX_BYTES: 200000,
  MAX_BYTES_LIMIT: 2_000_000,
  HEAD_LINES: 200,
  TAIL_LINES: 200,
};
```

**Acceptance Criteria:**
- [ ] Magic numbers extracted to named constants
- [ ] Constants are grouped and documented
- [ ] Easier to adjust limits in one place

---

### ISSUE-037: No Input Validation for Tool Name Collision

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 135-137

**Problem:**
```javascript
if (!names.has(getTool.name)) result.tools.push(getTool);
```
If downstream server already has a tool named `proxy_artifact_get`, the proxy silently doesn't inject its tool. User has no warning that their configured tool name collides.

**Implementation:**
```javascript
if (names.has(getTool.name)) {
  log.warn(`tool name collision: downstream already has "${getTool.name}", proxy tool not injected`);
} else {
  result.tools.push(getTool);
}
```

**Acceptance Criteria:**
- [ ] Warning logged when tool name collides
- [ ] User knows to use --tool-name to change the name
- [ ] Proxy still functions (just without the colliding tool)

---

### ISSUE-038: Process Exit Without Cleanup on Uncaught Main Error

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Lines:** 147-150

**Problem:**
```javascript
main().catch((e) => {
  process.stderr.write(`[mcp-trunc-proxy] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
```
If main() throws after proxy starts, store.close() is never called. Redis connections left open, intervals not cleared.

**Implementation:**
```javascript
let store = null; // Track for cleanup

main().catch(async (e) => {
  process.stderr.write(`[mcp-trunc-proxy] fatal: ${e?.stack ?? e}\n`);
  // Attempt cleanup if store was created
  if (store) {
    try { await store.close(); } catch {}
  }
  process.exit(1);
});
```
Note: This requires runProxy to expose the store reference, or use a different cleanup pattern.

**Acceptance Criteria:**
- [ ] Uncaught errors attempt store cleanup
- [ ] Redis connections are closed on fatal error
- [ ] Intervals are cleared

---

### ISSUE-039: Inconsistent Null vs Undefined Returns

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Various lines

**Problem:**
Store methods return `null` for not-found, but some internal checks use `!rec` which would also match `undefined`. The API contract should be explicit.

**Implementation:**
Add JSDoc to clarify return types:
```javascript
/**
 * @param {string} id - Artifact ID
 * @returns {Promise<{id: string, data: Buffer, meta: object}|null>} - Artifact or null if not found/expired
 */
async get(id) { ... }
```

**Acceptance Criteria:**
- [ ] All store methods have JSDoc with return types
- [ ] Consistently return null (not undefined) for not-found
- [ ] API contract is documented

---

## Implementation Order

### Phase 1: High Priority
1. ISSUE-029: Base64 validation (20 min)
2. ISSUE-030: Redis reconnection (15 min)

### Phase 2: Medium Priority  
3. ISSUE-034: MemoryStore info() expiry check (5 min)
4. ISSUE-033: Remove or implement --error-pattern (10 min)
5. ISSUE-031: parsePattern plain string handling (10 min)
6. ISSUE-032: envInt warning on invalid values (5 min)
7. ISSUE-035: FileStore DRY refactor (20 min)

### Phase 3: Low Priority
8. ISSUE-037: Tool name collision warning (5 min)
9. ISSUE-036: Extract magic numbers (10 min)
10. ISSUE-039: JSDoc for store methods (15 min)
11. ISSUE-038: Cleanup on uncaught error (15 min)

---

## Final Notes

The codebase has matured significantly after two rounds of fixes. Round 3 findings are:
- **Robustness**: Base64 validation, Redis reconnection
- **Consistency**: Expiry checks, null returns, pattern handling
- **DRY/Maintenance**: Duplicate code, magic numbers, documentation
- **User Experience**: Silent failures, undocumented options

No critical issues remain. The proxy is production-ready for most use cases.

---

**Document Maintained By:** QA Director  
**Last Updated:** 2026-01-07  
**All Issues Resolved:** 2026-01-07
