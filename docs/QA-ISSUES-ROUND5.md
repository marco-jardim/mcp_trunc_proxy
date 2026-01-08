# QA Issues Tracker - Round 5 (CTO Review)

**Review Date:** 2026-01-07  
**Reviewer:** CTO  
**Previous Reviews:** Senior QA (15), QA Manager (13), QA Director (11), VP Engineering (9) - all fixed  
**Project Version:** 0.1.0

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| Critical | 0 | - |
| High | 1 | ✅ Fixed |
| Medium | 3 | ✅ Fixed |
| Low | 3 | ✅ Fixed |
| **Total** | **7** | **✅ All Fixed** |

---

## 🟠 High Priority Issues

### ISSUE-049: Dynamic Import Inside Loop in FileStore Cleanup

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Line:** 169

**Problem:**
```javascript
for (const file of files) {
  // ...
  const { open } = await import("node:fs/promises");  // Dynamic import EVERY iteration!
```
Dynamic import is called inside the loop for every file. This is inefficient and unnecessary since `fs/promises` is already imported at the top of the file.

**Implementation:**
```javascript
// At top of file, add 'open' to the import
import { mkdir, readFile, writeFile, readdir, unlink, rename, open } from "node:fs/promises";

// In cleanup(), remove the dynamic import line entirely
```

**Acceptance Criteria:**
- [ ] `open` imported once at module level
- [ ] No dynamic import inside loop
- [ ] Cleanup performance improved

---

## 🟡 Medium Priority Issues

### ISSUE-050: depthStack in stableStringify Never Pops

**Status:** ✅ Fixed  
**File:** `src/util.mjs`  
**Lines:** 25-36

**Problem:**
```javascript
const depthStack = [];
// ...
if (typeof v === "object" && v !== null) {
  // ...
  depthStack.push(v);  // Pushes but never pops!
}
```
The `depthStack` array grows but never shrinks. After processing many objects, `depthStack.length > maxDepth` will trigger for ALL objects, causing false `[MaxDepth]` markers. The `currentDepth` variable is also declared but never used.

**Implementation:**
JSON.stringify's replacer doesn't easily support pop-on-exit. Simpler approach - track depth differently:
```javascript
export function stableStringify(obj, maxDepth = 100) {
  const seen = new WeakSet();

  function replacer(key, value) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  }

  // For depth limiting, we need recursive approach
  function stringifyWithDepth(val, depth) {
    if (depth > maxDepth) return '"[MaxDepth]"';
    if (val === null) return "null";
    if (typeof val === "bigint") return `"${val.toString()}"`;
    if (typeof val !== "object") return JSON.stringify(val);
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);

    if (Array.isArray(val)) {
      const items = val.map(v => stringifyWithDepth(v, depth + 1));
      return `[${items.join(",")}]`;
    }
    const pairs = Object.entries(val).map(([k, v]) => 
      `${JSON.stringify(k)}:${stringifyWithDepth(v, depth + 1)}`
    );
    return `{${pairs.join(",")}}`;
  }

  return stringifyWithDepth(obj, 0);
}
```

Or simpler - remove depth tracking since circular reference detection handles most pathological cases:
```javascript
export function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}
```

**Acceptance Criteria:**
- [ ] No false [MaxDepth] markers
- [ ] Remove unused currentDepth variable
- [ ] Either proper depth tracking OR remove broken depth feature

---

### ISSUE-051: FileStore Handle Double-Close on Success Path

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 179, 185

**Problem:**
```javascript
if (expiresAt && expiresAt <= now) {
  await handle.close();  // Close here
  await unlink(filePath).catch(() => {});
  continue;
}
// ...
} finally {
  await handle.close().catch(() => {});  // Close again in finally!
}
```
When file is expired, `handle.close()` is called twice - once explicitly and once in the `finally` block. While `.catch(() => {})` prevents errors, it's still wasteful.

**Implementation:**
```javascript
try {
  const buf = Buffer.alloc(200);
  await handle.read(buf, 0, 200, 0);
  const partial = buf.toString("utf8");
  const match = partial.match(/"expiresAt"\s*:\s*"([^"]+)"/);
  if (match) {
    const expiresAt = Date.parse(match[1]);
    if (expiresAt && expiresAt <= now) {
      await handle.close();
      await unlink(filePath).catch(() => {});
      continue;  // Skip finally since we already closed
    }
  }
  await handle.close();  // Normal close
} catch {
  await handle.close().catch(() => {});  // Error path close
}
```

Or use a flag:
```javascript
let closed = false;
try {
  // ...
  if (expiresAt && expiresAt <= now) {
    await handle.close();
    closed = true;
    await unlink(filePath).catch(() => {});
    continue;
  }
} finally {
  if (!closed) await handle.close().catch(() => {});
}
```

**Acceptance Criteria:**
- [ ] File handle closed exactly once per iteration
- [ ] No double-close attempts
- [ ] All error paths still close handle

---

### ISSUE-052: MemoryStore sweep() Called on Every put()

**Status:** ✅ Fixed  
**File:** `src/store.mjs`  
**Lines:** 68-78

**Problem:**
```javascript
async put(id, data, meta) {
  // ...
  map.set(id, { ... });
  sweep();  // Called on EVERY put, even when far from capacity
}
```
`sweep()` is O(n) for expiry check and potentially O(n log n) for sorting. Calling it on every `put()` is wasteful when the store is mostly empty.

**Implementation:**
Only sweep when approaching capacity:
```javascript
async put(id, data, meta) {
  const now = Date.now();
  map.set(id, { ... });
  // Only sweep if we're at 90% capacity or more
  if (map.size >= effectiveMaxArtifacts * 0.9) {
    sweep();
  }
}
```
The periodic interval (every 30s) already handles normal expiry cleanup.

**Acceptance Criteria:**
- [ ] sweep() only called when near capacity
- [ ] Normal expiry handled by periodic interval
- [ ] Reduced CPU usage on low-volume stores

---

## 🟢 Low Priority Issues

### ISSUE-053: Inconsistent Error Message Casing

**Status:** ✅ Fixed  
**Files:** Various

**Problem:**
```javascript
log.error(`failed to start downstream server: ${err.message}`);  // lowercase
log.error(`Redis put failed for ${id}: ${err.message}`);  // Capitalized
log.error(`Corrupt Redis artifact ${id}: ${err.message}`);  // Capitalized
```
Some error messages start with lowercase, others with uppercase. Inconsistent.

**Implementation:**
Standardize on lowercase for log messages (common convention):
```javascript
log.error(`redis put failed for ${id}: ${err.message}`);
log.error(`corrupt redis artifact ${id}: ${err.message}`);
```

**Acceptance Criteria:**
- [ ] All log messages start with lowercase
- [ ] Consistent style throughout codebase

---

### ISSUE-054: Missing "use strict" (ESM Implicit)

**Status:** ✅ Fixed (N/A - ESM is implicitly strict)  
**Files:** All `.mjs` files

**Problem:**
ESM modules are implicitly strict mode, but explicit `"use strict"` at the top of each file would make this clear to readers and serve as documentation.

**Implementation:**
This is technically unnecessary for ESM - marking as "Won't Fix" or documenting in README that ESM strict mode is implicit.

**Acceptance Criteria:**
- [ ] Document ESM strict mode in README OR add "use strict" to all files

---

### ISSUE-055: No Version Export

**Status:** ✅ Fixed  
**File:** `src/cli.mjs` or new `src/version.mjs`

**Problem:**
No way to check the proxy version programmatically. No `--version` flag.

**Implementation:**
```javascript
// In cli.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

// In parseArgs:
if (a === "--version" || a === "-v") {
  process.stdout.write(`mcp-trunc-proxy v${pkg.version}\n`);
  process.exit(0);
}

// In usage():
// Add: -v, --version           Show version
```

**Acceptance Criteria:**
- [ ] `--version` flag shows version from package.json
- [ ] `-v` shorthand works
- [ ] Version shown in help text

---

## Implementation Order

### Phase 1: High Priority
1. ISSUE-049: Fix dynamic import in loop (5 min)

### Phase 2: Medium Priority
2. ISSUE-050: Fix stableStringify depth tracking (15 min)
3. ISSUE-051: Fix double-close in FileStore cleanup (10 min)
4. ISSUE-052: Optimize MemoryStore sweep() calls (5 min)

### Phase 3: Low Priority
5. ISSUE-053: Standardize log message casing (10 min)
6. ISSUE-055: Add --version flag (10 min)
7. ISSUE-054: Document ESM strict mode (2 min) - or skip

---

## Final Notes

After four rounds of comprehensive fixes (48 issues total), the codebase is highly mature. Round 5 findings are:
- **Performance**: Dynamic import in loop, unnecessary sweep() calls
- **Correctness**: Broken depth tracking in stableStringify, double-close
- **Polish**: Log message casing, version flag

No critical issues. No security issues. The proxy is production-ready.

---

**Document Maintained By:** CTO  
**Last Updated:** 2026-01-07  
**All Issues Resolved:** 2026-01-07
