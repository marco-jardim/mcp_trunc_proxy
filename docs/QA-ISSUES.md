# QA Issues Tracker

**Review Date:** 2026-01-07  
**Reviewer:** Senior QA  
**Project Version:** 0.1.0

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 3 | ✅ Fixed |
| High | 5 | ✅ Fixed |
| Medium | 4 | ✅ Fixed |
| Low | 3 | ✅ Fixed |
| **Total** | **15** | **✅ All Fixed** |

---

## 🔴 Critical Issues

### ISSUE-001: Broken Test Script

**Status:** ✅ Fixed  
**File:** `package.json`  
**Line:** ~15 (scripts.test:smoke)

**Problem:**
```json
"test:smoke": "node examples/smoke-server.mjs"
```
File `smoke-server.mjs` does not exist. CI/CD fails.

**Implementation:**
- Change to `node examples/fake-mcp-server.mjs` OR
- Remove the script entirely

**Acceptance Criteria:**
- [ ] `npm run test:smoke` executes without "file not found" error
- [ ] Script either runs successfully or is removed from package.json
- [ ] CI pipeline passes (if applicable)

---

### ISSUE-002: FileStore Uses Synchronous I/O

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 85-130 (FileStore class)

**Problem:**
```javascript
mkdirSync(this.baseDir, { recursive: true });
writeFileSync(filePath, JSON.stringify(envelope));
const raw = readFileSync(filePath, "utf8");
```
Synchronous I/O blocks the event loop. Under load, proxy becomes unresponsive.

**Implementation:**
1. Import `fs/promises` instead of `fs`
2. Convert all sync methods to async equivalents:
   - `mkdirSync` → `await mkdir`
   - `writeFileSync` → `await writeFile`
   - `readFileSync` → `await readFile`
   - `existsSync` → `await access().then(() => true).catch(() => false)` or use try/catch
   - `readdirSync` → `await readdir`
   - `statSync` → `await stat`
   - `unlinkSync` → `await unlink`
3. Mark all FileStore methods as `async`
4. Update callers in proxy.mjs to await FileStore methods

**Acceptance Criteria:**
- [ ] No `Sync` functions remain in FileStore class
- [ ] All FileStore methods are async
- [ ] Proxy remains responsive during file operations (manual test with slow disk simulation)
- [ ] Existing functionality preserved (put/get/info/close work correctly)

---

### ISSUE-003: Unhandled gunzipSync Exception

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** ~380-420 (handleProxyToolCall function)

**Problem:**
```javascript
const raw = zlib.gunzipSync(rec.data);
```
Corrupt or truncated gzip data throws an exception that is not caught. This crashes the entire proxy.

**Implementation:**
```javascript
let raw;
try {
  raw = zlib.gunzipSync(rec.data);
} catch (err) {
  return {
    content: [{ type: "text", text: `Error decompressing artifact: ${err.message}` }],
    isError: true
  };
}
```

**Acceptance Criteria:**
- [ ] Corrupt gzip data returns error response, not crash
- [ ] Error message includes decompression failure reason
- [ ] Response has `isError: true` flag
- [ ] Proxy continues operating after corrupt artifact request

---

## 🟠 High Priority Issues

### ISSUE-004: No Graceful Shutdown

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** ~450-530 (runProxy function, end of file)

**Problem:**
No SIGTERM/SIGINT handlers. Child process may become zombie. Resources not cleaned up in containerized deployments.

**Implementation:**
```javascript
// Add at end of runProxy(), before return
const shutdown = async (signal) => {
  log.info(`Received ${signal}, shutting down...`);
  child.kill("SIGTERM");
  await store.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

**Acceptance Criteria:**
- [ ] SIGTERM triggers clean shutdown
- [ ] SIGINT (Ctrl+C) triggers clean shutdown
- [ ] Child process is killed before exit
- [ ] Store.close() is called before exit
- [ ] No zombie processes after termination

---

### ISSUE-005: Memory Leak - Pending Requests Map

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** ~100-150 (pending Map usage)

**Problem:**
```javascript
const pending = new Map();
```
If child crashes mid-request, entries in `pending` Map are never cleaned up, causing memory leak.

**Implementation:**
Option A: Cleanup on child exit
```javascript
child.on("exit", () => {
  pending.clear();
});
```

Option B: Add TTL to pending entries (more robust)
```javascript
// Store timestamp with each pending request
pending.set(id, { resolve, reject, timestamp: Date.now() });

// Periodic cleanup (every 60s)
setInterval(() => {
  const now = Date.now();
  const timeout = 300000; // 5 minutes
  for (const [id, entry] of pending) {
    if (now - entry.timestamp > timeout) {
      entry.reject(new Error("Request timeout"));
      pending.delete(id);
    }
  }
}, 60000);
```

**Acceptance Criteria:**
- [ ] Pending map is cleared when child process exits
- [ ] OR: Pending entries older than 5 minutes are automatically cleaned
- [ ] Memory usage stays stable under repeated child crashes
- [ ] Timeout errors are properly propagated to callers

---

### ISSUE-006: RedisStore Exposes Credentials

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** ~160-180 (RedisStore.info method)

**Problem:**
```javascript
info: `RedisStore: url=${this.url}`
```
Redis URL may contain password (`redis://:password@host`). Credentials leak in logs/errors.

**Implementation:**
```javascript
info() {
  // Sanitize URL - remove password if present
  let sanitized = this.url;
  try {
    const parsed = new URL(this.url);
    if (parsed.password) {
      parsed.password = "***";
    }
    sanitized = parsed.toString();
  } catch {
    sanitized = "[invalid url]";
  }
  return { type: "redis", info: `RedisStore: url=${sanitized}` };
}
```

**Acceptance Criteria:**
- [ ] Redis password is masked in info() output
- [ ] URLs like `redis://:secret@localhost` become `redis://:***@localhost`
- [ ] Invalid URLs don't crash, show "[invalid url]"
- [ ] Logs/error messages don't contain raw credentials

---

### ISSUE-007: FileStore No Concurrent Write Protection

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 85-130 (FileStore.put method)

**Problem:**
No file locking. Two proxy instances writing same artifact ID = file corruption.

**Implementation:**
Option A: Use atomic write pattern
```javascript
async put(id, data, meta) {
  const filePath = this._path(id);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(envelope));
  await rename(tempPath, filePath); // Atomic on same filesystem
}
```

Option B: Use proper-lockfile package (adds dependency)

**Acceptance Criteria:**
- [ ] Concurrent writes to same artifact don't corrupt file
- [ ] Temporary files are cleaned up on success
- [ ] Atomic rename used for final write
- [ ] Works across multiple proxy processes

---

### ISSUE-008: Negative Values Accepted for Numeric Args

**Status:** ✅ Fixed  
**File:** `src/cli.mjs`  
**Lines:** ~30-80 (parseArgs and validation)

**Problem:**
`--max-bytes -1` is accepted. Negative values cause undefined behavior.

**Implementation:**
```javascript
// After parsing, add validation
const numericArgs = ['maxBytes', 'previewMaxChars', 'headLines', 'tailLines', 'ttlSeconds', 'maxArtifacts'];
for (const arg of numericArgs) {
  if (opts[arg] !== undefined && opts[arg] <= 0) {
    console.error(`Error: --${arg.replace(/([A-Z])/g, '-$1').toLowerCase()} must be a positive number`);
    process.exit(1);
  }
}
```

**Acceptance Criteria:**
- [ ] `--max-bytes 0` exits with error
- [ ] `--max-bytes -1` exits with error
- [ ] `--ttl-seconds -100` exits with error
- [ ] Error message clearly states which arg is invalid
- [ ] Valid positive values still work

---

## 🟡 Medium Priority Issues

### ISSUE-009: Invalid Regex Silent Failure

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** ~50-70 (parsePattern function)

**Problem:**
```javascript
function parsePattern(str) {
  // ... returns null on invalid regex, no user feedback
}
```
User gets no indication their regex is invalid.

**Implementation:**
```javascript
function parsePattern(str) {
  if (!str) return null;
  const m = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    try {
      return new RegExp(m[1], m[2]);
    } catch (err) {
      return { error: `Invalid regex: ${err.message}` };
    }
  }
  // Plain string - escape special chars
  return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// In handleProxyToolCall, check for error:
const pattern = parsePattern(args.pattern);
if (pattern?.error) {
  return { content: [{ type: "text", text: pattern.error }], isError: true };
}
```

**Acceptance Criteria:**
- [ ] Invalid regex `/[unclosed/` returns error message
- [ ] Error includes specific regex parsing failure
- [ ] Response has `isError: true` flag
- [ ] Valid regexes still work normally

---

### ISSUE-010: MemoryStore Sweep is O(n log n)

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** ~30-60 (MemoryStore.sweep method)

**Problem:**
```javascript
sweep() {
  // Sorts all entries every 30 seconds
  const sorted = [...this.map.entries()].sort((a, b) => a[1].ts - b[1].ts);
}
```
At scale (>10k artifacts), this becomes expensive.

**Implementation:**
Option A: Use min-heap for O(log n) eviction
Option B: Two-pass approach (cheaper than sort for typical cases):
```javascript
sweep() {
  const now = Date.now();
  // First pass: remove expired (O(n))
  for (const [id, entry] of this.map) {
    if (now - entry.ts > this.ttl * 1000) {
      this.map.delete(id);
    }
  }
  // Second pass: if still over limit, remove oldest (only when needed)
  if (this.map.size > this.maxArtifacts) {
    const sorted = [...this.map.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = this.map.size - this.maxArtifacts;
    for (let i = 0; i < toRemove; i++) {
      this.map.delete(sorted[i][0]);
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Sweep with 10k artifacts completes in <100ms
- [ ] TTL-based cleanup doesn't require sorting
- [ ] Capacity-based eviction only triggers when needed
- [ ] Memory usage stays bounded

---

### ISSUE-011: FileStore Never Proactively Cleans Expired Files

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 85-130 (FileStore class)

**Problem:**
TTL only checked on `get()`. Disk fills with stale files that are never cleaned.

**Implementation:**
```javascript
class FileStore {
  constructor(baseDir, ttl) {
    this.baseDir = baseDir;
    this.ttl = ttl;
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this._cleanup(), 300000); // 5 minutes
  }

  async _cleanup() {
    try {
      const files = await readdir(this.baseDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.baseDir, file);
        const stat = await stat(filePath);
        if (now - stat.mtimeMs > this.ttl * 1000) {
          await unlink(filePath);
        }
      }
    } catch { /* ignore cleanup errors */ }
  }

  close() {
    clearInterval(this.cleanupInterval);
  }
}
```

**Acceptance Criteria:**
- [ ] Expired files are deleted within 5 minutes of expiry
- [ ] Cleanup runs automatically in background
- [ ] Cleanup errors don't crash the proxy
- [ ] close() stops the cleanup interval

---

### ISSUE-012: FileStore JSON.parse Not Wrapped

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** ~100-110 (FileStore.get method)

**Problem:**
```javascript
const envelope = JSON.parse(raw);
```
Corrupt file = unhandled exception = crash.

**Implementation:**
```javascript
async get(id) {
  const filePath = this._path(id);
  try {
    const raw = await readFile(filePath, "utf8");
    const envelope = JSON.parse(raw);
    // ... rest of method
  } catch (err) {
    if (err.code === 'ENOENT') return null; // File not found
    // Corrupt file - log and return null
    console.error(`Corrupt artifact file ${id}: ${err.message}`);
    return null;
  }
}
```

**Acceptance Criteria:**
- [ ] Corrupt JSON file returns null, not crash
- [ ] Error is logged for debugging
- [ ] ENOENT (file not found) still returns null silently
- [ ] Proxy continues operating after corrupt file

---

## 🟢 Low Priority Issues

### ISSUE-013: demo-client.mjs Wrong Command in Comment

**Status:** ✅ Fixed  
**File:** `examples/demo-client.mjs`  
**Line:** ~1-5 (header comment)

**Problem:**
```javascript
// node src/cli.mjs -- -- node examples/fake-mcp-server.mjs
```
Double `--` is incorrect. Should be single `--`.

**Implementation:**
```javascript
// node src/cli.mjs -- node examples/fake-mcp-server.mjs
```

**Acceptance Criteria:**
- [ ] Comment shows correct command
- [ ] Command in comment actually works when copy-pasted

---

### ISSUE-014: No Real Linting

**Status:** ✅ Fixed  
**File:** `package.json`  
**Line:** ~14 (scripts.lint)

**Problem:**
```json
"lint": "node -c src/*.mjs"
```
Only syntax check, no style enforcement.

**Implementation:**
1. Add ESLint dependency: `npm install -D eslint`
2. Create `.eslintrc.json`:
```json
{
  "env": { "node": true, "es2022": true },
  "parserOptions": { "sourceType": "module" },
  "rules": {
    "no-unused-vars": "warn",
    "no-console": "off",
    "semi": ["error", "always"],
    "quotes": ["error", "double"]
  }
}
```
3. Update script: `"lint": "eslint src/ examples/"`

**Acceptance Criteria:**
- [ ] `npm run lint` runs ESLint
- [ ] Style violations are reported
- [ ] Current code passes (or issues documented)
- [ ] CI can enforce lint rules

---

### ISSUE-015: Magic Number 500 Char Truncation

**Status:** ✅ Fixed  
**File:** `src/proxy.mjs`  
**Lines:** ~200-220 (extractTextLinesFromToolResult function)

**Problem:**
```javascript
const raw = typeof c.text === "string" ? c.text : JSON.stringify(c.text).slice(0, 500);
```
Hardcoded 500 char limit. Not configurable or documented.

**Implementation:**
Option A: Add CLI flag `--extract-max-chars` (full solution)
Option B: Add constant at top of file with comment (minimal)
```javascript
// Maximum chars to extract from non-string content for line splitting
const EXTRACT_MAX_CHARS = 500;
```

**Acceptance Criteria:**
- [ ] Magic number replaced with named constant OR configurable flag
- [ ] Behavior is documented in README if user-facing
- [ ] Value can be adjusted without code search

---

## Implementation Order

### Phase 1: Critical Fixes (Block Release)
1. ISSUE-001: Broken test script (5 min)
2. ISSUE-003: gunzipSync exception handling (15 min)
3. ISSUE-002: FileStore async I/O (1 hour) - most complex

### Phase 2: High Priority (Next Release)
4. ISSUE-008: Numeric arg validation (15 min)
5. ISSUE-006: Redis credential sanitization (20 min)
6. ISSUE-004: Graceful shutdown (30 min)
7. ISSUE-005: Pending map cleanup (30 min)
8. ISSUE-007: FileStore atomic writes (30 min) - depends on ISSUE-002

### Phase 3: Medium Priority (Backlog)
9. ISSUE-012: FileStore JSON.parse (15 min) - depends on ISSUE-002
10. ISSUE-009: Regex error feedback (20 min)
11. ISSUE-011: FileStore cleanup sweep (30 min) - depends on ISSUE-002
12. ISSUE-010: MemoryStore sweep optimization (45 min)

### Phase 4: Low Priority (Nice to Have)
13. ISSUE-013: Comment fix (2 min)
14. ISSUE-015: Magic number (10 min)
15. ISSUE-014: ESLint setup (30 min)

---

## Final Acceptance Checklist

Before closing this QA review, ALL critical issues must pass:

- [x] ISSUE-001: `npm run test:smoke` works or removed
- [x] ISSUE-002: No sync I/O in FileStore
- [x] ISSUE-003: Corrupt gzip doesn't crash proxy

High priority should be reviewed:
- [x] ISSUE-004: Clean shutdown on SIGTERM
- [x] ISSUE-005: No memory leak on child crash
- [x] ISSUE-006: No credentials in logs
- [x] ISSUE-007: Atomic file writes
- [x] ISSUE-008: Invalid args rejected

---

**Document Maintained By:** QA Team  
**Last Updated:** 2026-01-07  
**All Issues Resolved:** 2026-01-07
