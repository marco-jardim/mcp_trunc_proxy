# QA Issues Tracker - Round 2 (Manager Review)

**Review Date:** 2026-01-07  
**Reviewer:** QA Manager  
**Previous Review:** Senior QA (15 issues - all fixed)  
**Project Version:** 0.1.0

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 1 | ✅ Fixed |
| High | 4 | ✅ Fixed |
| Medium | 5 | ✅ Fixed |
| Low | 3 | ✅ Fixed |
| **Total** | **13** | **✅ All Fixed** |

---

## 🔴 Critical Issues

### ISSUE-016: RedisStore JSON.parse Not Wrapped

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 230-234, 238-241

**Problem:**
```javascript
async get(id) {
  const raw = await client.get(key(id));
  if (!raw) return null;
  const rec = JSON.parse(raw);  // UNHANDLED - can crash on corrupt data
  return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
}
```
FileStore got JSON.parse protection (ISSUE-012), but RedisStore was overlooked. Corrupt Redis data crashes the proxy.

**Implementation:**
```javascript
async get(id) {
  const raw = await client.get(key(id));
  if (!raw) return null;
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (err) {
    log?.error?.(`Corrupt Redis artifact ${id}: ${err.message}`);
    return null;
  }
  return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
}
```
Also apply to `info()` method at line 238-241.

**Acceptance Criteria:**
- [ ] Corrupt Redis JSON returns null, not crash
- [ ] Error is logged for debugging
- [ ] Both `get()` and `info()` are protected
- [ ] Proxy continues operating after corrupt Redis data

---

## 🟠 High Priority Issues

### ISSUE-017: FileStore Temp File Not Cleaned on Rename Failure

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 120-123

**Problem:**
```javascript
const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tempPath, JSON.stringify(rec), "utf8");
await rename(tempPath, filePath); // If this fails, temp file is orphaned
```
If `rename()` fails (permissions, disk full, cross-device), temp file remains on disk forever.

**Implementation:**
```javascript
const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tempPath, JSON.stringify(rec), "utf8");
try {
  await rename(tempPath, filePath);
} catch (err) {
  await unlink(tempPath).catch(() => {}); // Clean up temp file
  throw err; // Re-throw to signal failure
}
```

**Acceptance Criteria:**
- [ ] Temp file is deleted if rename fails
- [ ] Original error is still propagated
- [ ] No orphaned .tmp files on disk after failures

---

### ISSUE-018: No Timeout on Pending Requests

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 50, 402-407

**Problem:**
```javascript
const pending = new Map();
// ...
pending.set(msg.id, { method, toolName, at: Date.now() });
```
Requests are tracked with timestamps but never timed out. If child hangs without responding, entries accumulate indefinitely. ISSUE-005 only clears on child exit - not on individual request timeout.

**Implementation:**
```javascript
// Add periodic timeout check (every 60 seconds)
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes

const timeoutInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pending) {
    if (now - req.at > REQUEST_TIMEOUT_MS) {
      log.warn(`Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      pending.delete(id);
    }
  }
}, 60_000);
timeoutInterval.unref?.();

// Clear in shutdown handler
```

**Acceptance Criteria:**
- [ ] Requests older than 5 minutes are automatically cleaned up
- [ ] Timeout is logged for debugging
- [ ] Interval is cleared on shutdown

---

### ISSUE-019: gzipSync Can Throw on OOM

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Line:** 221

**Problem:**
```javascript
const gz = gzipSync(Buffer.from(payloadStr, "utf8"));
```
`gzipSync` can throw if payload is too large or system is OOM. This would crash `storeToolResultArtifact()` and potentially the proxy.

**Implementation:**
```javascript
let gz;
try {
  gz = gzipSync(Buffer.from(payloadStr, "utf8"));
} catch (err) {
  log.error(`Failed to compress artifact: ${err.message}`);
  throw err; // Let caller handle fallback
}
```
The caller already has try-catch at line 467-489, so this just ensures proper error context.

**Acceptance Criteria:**
- [ ] Compression failures are logged with context
- [ ] Error propagates to existing fallback handler
- [ ] Proxy doesn't crash silently

---

### ISSUE-020: Shutdown Handler Can Hang Forever

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 499-508

**Problem:**
```javascript
const shutdown = async (signal) => {
  log.info(`Received ${signal}, shutting down...`);
  child.kill("SIGTERM");
  await store.close();  // Can hang if Redis is unresponsive
  process.exit(0);
};
```
If `store.close()` hangs (Redis connection issues, file locks), shutdown never completes.

**Implementation:**
```javascript
const shutdown = async (signal) => {
  log.info(`Received ${signal}, shutting down...`);
  child.kill("SIGTERM");
  
  // Timeout for graceful shutdown
  const forceExit = setTimeout(() => {
    log.warn("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 5000);
  forceExit.unref?.();
  
  try {
    await store.close();
  } catch (err) {
    log.error(`Error closing store: ${err.message}`);
  }
  clearTimeout(forceExit);
  process.exit(0);
};
```

**Acceptance Criteria:**
- [ ] Shutdown completes within 5 seconds max
- [ ] Force exit if store.close() hangs
- [ ] Store close errors are logged, not thrown

---

## 🟡 Medium Priority Issues

### ISSUE-021: MemoryStore maxArtifacts Can Be Undefined

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Line:** 22

**Problem:**
```javascript
if (map.size > maxArtifacts) {
```
If `maxArtifacts` is not passed (undefined), `map.size > undefined` is always false. Store grows unbounded.

**Implementation:**
```javascript
function createMemoryStore({ ttlSeconds, maxArtifacts = 2000, log }) {
  // ...
  if (maxArtifacts && map.size > maxArtifacts) {
```

**Acceptance Criteria:**
- [ ] Default maxArtifacts is applied if not provided
- [ ] Explicit check prevents undefined comparison

---

### ISSUE-022: FileStore baseDir Path Injection

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 78-79

**Problem:**
```javascript
function pathFor(id) {
  return join(baseDir, `${id}.json`);
}
```
If artifact ID contains `../`, it could write outside baseDir. Artifact IDs come from `mkArtifactId()` which uses base64url, so current implementation is safe, but this is defense-in-depth.

**Implementation:**
```javascript
function pathFor(id) {
  // Sanitize ID to prevent path traversal
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(baseDir, `${safeId}.json`);
}
```

**Acceptance Criteria:**
- [ ] Path traversal characters are stripped/replaced
- [ ] Valid artifact IDs still work
- [ ] Cannot write outside baseDir

---

### ISSUE-023: CLI Accepts Non-Numeric Strings Silently

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Lines:** 37-42

**Problem:**
```javascript
case "--max-bytes": args.maxBytes = Number(next); // Number("abc") = NaN
```
`--max-bytes abc` becomes `NaN`, which passes through until later validation catches it. But error message says "must be a positive number (minimum 1024)" which is confusing for `NaN`.

**Implementation:**
```javascript
function parseNumericArg(value, argName) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`--${argName} requires a numeric value, got: ${value}`);
  }
  return n;
}

// In switch cases:
case "--max-bytes": args.maxBytes = parseNumericArg(next, "max-bytes"); i += val ? 1 : 2; break;
```

**Acceptance Criteria:**
- [ ] Non-numeric values throw clear error at parse time
- [ ] Error message shows the invalid value
- [ ] Valid numbers still work

---

### ISSUE-024: stableStringify Doesn't Handle Symbol Keys

**Status:** ✅ Fixed  
**File:** `src/util.mjs`  
**Lines:** 18-32

**Problem:**
```javascript
export function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, ...);
}
```
Objects with Symbol keys are silently dropped by JSON.stringify. This is standard behavior but could cause data loss for tool results with Symbol properties.

**Implementation:**
Add a note in the JSDoc that Symbol keys are not preserved, or convert them:
```javascript
/**
 * Stable-ish stringify that:
 * - avoids crashing on BigInt
 * - tolerates circular refs (drops cycles)
 * - NOTE: Symbol keys are dropped (standard JSON behavior)
 */
```

**Acceptance Criteria:**
- [ ] Behavior is documented
- [ ] No crash on objects with Symbol keys

---

### ISSUE-025: Missing `stat` Import in FileStore

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Line:** 1

**Problem:**
```javascript
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from "node:fs/promises";
```
`stat` is imported but never used. The cleanup function reads file content to check expiry instead of using `stat.mtimeMs`. This works but is less efficient.

**Implementation:**
Option A: Remove unused import
```javascript
import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
```

Option B: Use stat for more efficient expiry check (avoids reading entire file)
```javascript
// In cleanup():
const fileStat = await stat(filePath);
if (now - fileStat.mtimeMs > ttlSeconds * 1000) {
  await unlink(filePath).catch(() => {});
}
```

**Acceptance Criteria:**
- [ ] No unused imports
- [ ] OR: Use stat for efficient cleanup

---

## 🟢 Low Priority Issues

### ISSUE-026: Hardcoded Error Pattern in summarizeLines

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** 160-161

**Problem:**
```javascript
const errorish = /(error|fail|failed|exception|traceback|assert|panic|fatal)/i;
```
Hardcoded regex. Not configurable. May miss language-specific error patterns (e.g., "Fehler" in German, "エラー" in Japanese).

**Implementation:**
Add CLI flag `--error-pattern` or document the pattern for users who want to customize.

**Acceptance Criteria:**
- [ ] Error pattern is documented in --help
- [ ] OR: Made configurable via CLI flag

---

### ISSUE-027: No Shebang in cli.mjs

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Line:** 1

**Problem:**
Missing `#!/usr/bin/env node` shebang. When installed globally via npm, the script may not execute properly on Unix systems.

**Implementation:**
```javascript
#!/usr/bin/env node
import { runProxy } from "./proxy.mjs";
// ...
```

**Acceptance Criteria:**
- [ ] Script runs with `./src/cli.mjs` after `chmod +x`
- [ ] Global npm install works on Unix

---

### ISSUE-028: Inconsistent Log Message Formats

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Various lines

**Problem:**
Log messages have inconsistent formats:
- `downstream exited code=${code} signal=${signal}`
- `Received ${signal}, shutting down...`
- `failed to store artifact; falling back to preview-only: ${e?.message}`

Some use `=`, some use `:`, some have trailing `...`.

**Implementation:**
Standardize on one format:
```javascript
// Consistent format: key=value for structured, colon for messages
log.info(`downstream exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
log.info(`received ${signal}: shutting down`);
log.error(`store artifact failed: ${e?.message ?? e}`);
```

**Acceptance Criteria:**
- [ ] All log messages follow consistent format
- [ ] Easier to parse logs programmatically

---

## Implementation Order

### Phase 1: Critical (Block Release)
1. ISSUE-016: RedisStore JSON.parse protection (15 min)

### Phase 2: High Priority (Next Release)
2. ISSUE-017: Temp file cleanup on rename failure (10 min)
3. ISSUE-020: Shutdown timeout (15 min)
4. ISSUE-018: Pending request timeout (20 min)
5. ISSUE-019: gzipSync error logging (5 min)

### Phase 3: Medium Priority (Backlog)
6. ISSUE-021: MemoryStore maxArtifacts default (5 min)
7. ISSUE-023: CLI numeric arg validation (15 min)
8. ISSUE-022: FileStore path sanitization (10 min)
9. ISSUE-025: Remove unused stat import (2 min)
10. ISSUE-024: Document Symbol key behavior (5 min)

### Phase 4: Low Priority (Nice to Have)
11. ISSUE-027: Add shebang (2 min)
12. ISSUE-028: Log format consistency (15 min)
13. ISSUE-026: Document error pattern (5 min)

---

## Final Notes

The previous senior review was thorough on obvious issues but missed:
1. **Consistency** - FileStore got JSON.parse protection but RedisStore didn't
2. **Edge cases** - Temp file orphaning, shutdown hangs, gzip OOM
3. **Defense in depth** - Path traversal, undefined checks
4. **Polish** - Shebang, log formats, documentation

Overall code quality is good. These are refinements, not fundamental flaws.

---

**Document Maintained By:** QA Manager  
**Last Updated:** 2026-01-07  
**All Issues Resolved:** 2026-01-07
