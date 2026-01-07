// ISSUE-025 FIX: Remove unused stat import
import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";

export async function createStore({ spec, ttlSeconds, maxArtifacts, keyPrefix, log }) {
  if (!spec || spec === "memory") return createMemoryStore({ ttlSeconds, maxArtifacts, log });
  if (spec.startsWith("file:")) return await createFileStore({ dir: spec.slice("file:".length), ttlSeconds, log });
  if (spec.startsWith("redis:")) return await createRedisStore({ url: spec.slice("redis:".length), ttlSeconds, keyPrefix, log });

  throw new Error(`Unknown store spec: ${spec} (expected memory, file:<dir>, redis:<url>)`);
}

// ISSUE-021 FIX: Add default maxArtifacts
function createMemoryStore({ ttlSeconds, maxArtifacts = 2000, log }) {
  const map = new Map(); // id -> {data: Buffer, meta, createdAt, lastAccess, expiresAt?}
  const effectiveMaxArtifacts = maxArtifacts || 2000; // Ensure not undefined/null/0

  function sweep() {
    const now = Date.now();
    // ISSUE-010 FIX: First pass - remove expired entries (O(n), no sorting needed)
    for (const [id, rec] of map.entries()) {
      if (rec.expiresAt && rec.expiresAt <= now) map.delete(id);
    }
    // Second pass - only sort if still over capacity (avoids O(n log n) when not needed)
    if (map.size > effectiveMaxArtifacts) {
      const entries = Array.from(map.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = entries.slice(0, map.size - effectiveMaxArtifacts);
      for (const [id] of toRemove) map.delete(id);
    }
  }

  // best-effort periodic sweep
  const interval = setInterval(sweep, 30_000);
  interval.unref?.();

  return {
    async put(id, data, meta) {
      const now = Date.now();
      map.set(id, {
        data,
        meta,
        createdAt: now,
        lastAccess: now,
        expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : null,
      });
      sweep();
    },
    async get(id) {
      const rec = map.get(id);
      if (!rec) return null;
      if (rec.expiresAt && rec.expiresAt <= Date.now()) {
        map.delete(id);
        return null;
      }
      rec.lastAccess = Date.now();
      return { id, data: rec.data, meta: rec.meta };
    },
    async info(id) {
      const rec = map.get(id);
      if (!rec) return null;
      return {
        id,
        store: "memory",
        meta: rec.meta,
        createdAt: new Date(rec.createdAt).toISOString(),
        lastAccess: new Date(rec.lastAccess).toISOString(),
        expiresAt: rec.expiresAt ? new Date(rec.expiresAt).toISOString() : null,
        bytesStored: rec.data?.byteLength ?? null,
      };
    },
    async close() {
      clearInterval(interval);
    },
  };
}

async function createFileStore({ dir, ttlSeconds, log }) {
  const baseDir = dir || ".mcp-artifacts";
  await mkdir(baseDir, { recursive: true });

  // ISSUE-022 FIX: Sanitize artifact ID to prevent path traversal
  function pathFor(id) {
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(baseDir, `${safeId}.json`);
  }

  // ISSUE-011 FIX: Proactive cleanup interval for expired files
  async function cleanup() {
    try {
      const files = await readdir(baseDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(baseDir, file);
        try {
          const raw = await readFile(filePath, "utf8");
          const rec = JSON.parse(raw);
          if (rec.expiresAt && Date.parse(rec.expiresAt) <= now) {
            await unlink(filePath).catch(() => {});
          }
        } catch {
          // Ignore errors during cleanup - file may be corrupt or in use
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // Start cleanup interval (every 5 minutes)
  const cleanupInterval = setInterval(cleanup, 300_000);
  cleanupInterval.unref?.();

  return {
    // ISSUE-002 FIX: All async I/O
    // ISSUE-007 FIX: Atomic write with temp file + rename
    async put(id, data, meta) {
      const rec = {
        id,
        createdAt: new Date().toISOString(),
        expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
        meta,
        dataB64: Buffer.from(data).toString("base64"),
      };
      const filePath = pathFor(id);
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, JSON.stringify(rec), "utf8");
      // ISSUE-017 FIX: Clean up temp file if rename fails
      try {
        await rename(tempPath, filePath); // Atomic on same filesystem
      } catch (err) {
        await unlink(tempPath).catch(() => {}); // Clean up orphaned temp file
        throw err; // Re-throw to signal failure
      }
    },
    // ISSUE-002 FIX: Async I/O
    // ISSUE-012 FIX: JSON.parse wrapped in try-catch
    async get(id) {
      const p = pathFor(id);
      try {
        const raw = await readFile(p, "utf8");
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch (parseErr) {
          // ISSUE-012 FIX: Corrupt file - log and return null
          log?.error?.(`Corrupt artifact file ${id}: ${parseErr.message}`);
          return null;
        }
        if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
          // best-effort cleanup
          await unlink(p).catch(() => {});
          return null;
        }
        return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
      } catch (err) {
        if (err.code === "ENOENT") return null; // File not found
        log?.error?.(`Error reading artifact file ${id}: ${err.message}`);
        return null;
      }
    },
    // ISSUE-002 FIX: Async I/O
    // ISSUE-012 FIX: JSON.parse wrapped in try-catch
    async info(id) {
      const p = pathFor(id);
      try {
        const raw = await readFile(p, "utf8");
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch (parseErr) {
          log?.error?.(`Corrupt artifact file ${id}: ${parseErr.message}`);
          return null;
        }
        return {
          id,
          store: `file:${baseDir}`,
          createdAt: rec.createdAt,
          expiresAt: rec.expiresAt ?? null,
          meta: rec.meta,
          bytesStored: rec.dataB64 ? Buffer.from(rec.dataB64, "base64").byteLength : null,
        };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        log?.error?.(`Error reading artifact file ${id}: ${err.message}`);
        return null;
      }
    },
    async close() {
      clearInterval(cleanupInterval);
    },
  };
}

async function createRedisStore({ url, ttlSeconds, keyPrefix, log }) {
  let redisMod;
  try {
    redisMod = await import("redis");
  } catch (e) {
    throw new Error(`Redis store requested but 'redis' package is not installed. Run: npm i redis`);
  }
  const { createClient } = redisMod;

  const client = createClient({ url });
  client.on("error", (err) => log?.error?.(`redis error: ${err?.message ?? err}`));
  await client.connect();

  const prefix = keyPrefix || "mcp-trunc-proxy";

  function key(id) {
    return `${prefix}:artifact:${id}`;
  }

  // ISSUE-006 FIX: Sanitize URL to hide credentials
  function sanitizeUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        parsed.password = "***";
      }
      return parsed.toString();
    } catch {
      return "[invalid url]";
    }
  }

  return {
    async put(id, data, meta) {
      const rec = {
        id,
        createdAt: new Date().toISOString(),
        meta,
        dataB64: Buffer.from(data).toString("base64"),
      };
      if (ttlSeconds) {
        await client.set(key(id), JSON.stringify(rec), { EX: ttlSeconds });
      } else {
        await client.set(key(id), JSON.stringify(rec));
      }
    },
    // ISSUE-016 FIX: Wrap JSON.parse in try-catch
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
    },
    // ISSUE-006 FIX: Sanitize Redis URL in info output
    // ISSUE-016 FIX: Wrap JSON.parse in try-catch
    async info(id) {
      const raw = await client.get(key(id));
      if (!raw) return null;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch (err) {
        log?.error?.(`Corrupt Redis artifact ${id}: ${err.message}`);
        return null;
      }
      const ttl = await client.ttl(key(id));
      return {
        id,
        store: `redis:${sanitizeUrl(url)}`,
        createdAt: rec.createdAt,
        ttlSeconds: ttl >= 0 ? ttl : null,
        meta: rec.meta,
        bytesStored: rec.dataB64 ? Buffer.from(rec.dataB64, "base64").byteLength : null,
      };
    },
    async close() {
      try {
        await client.quit();
      } catch {
        await client.disconnect();
      }
    },
  };
}
