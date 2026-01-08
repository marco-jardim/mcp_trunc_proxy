// ISSUE-025 FIX: Remove unused stat import
// ISSUE-049 FIX: Add open to module imports (was dynamic import in loop)
import { mkdir, readFile, writeFile, readdir, unlink, rename, open } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create a store instance based on spec.
 * @param {object} options
 * @param {string} [options.spec] - Store type: "memory", "file:<dir>", or "redis:<url>"
 * @param {number} [options.ttlSeconds] - TTL for artifacts
 * @param {number} [options.maxArtifacts] - Max artifacts (memory store only)
 * @param {string} [options.keyPrefix] - Redis key prefix
 * @param {object} [options.log] - Logger instance
 * @returns {Promise<Store>}
 */
export async function createStore({ spec, ttlSeconds, maxArtifacts, keyPrefix, log }) {
  if (!spec || spec === "memory") return createMemoryStore({ ttlSeconds, maxArtifacts, log });
  if (spec.startsWith("file:")) return await createFileStore({ dir: spec.slice("file:".length), ttlSeconds, log });
  if (spec.startsWith("redis:")) return await createRedisStore({ url: spec.slice("redis:".length), ttlSeconds, keyPrefix, log });

  throw new Error(`Unknown store spec: ${spec} (expected memory, file:<dir>, redis:<url>)`);
}

// ISSUE-057 FIX: Estimate base64 decoded size without actually decoding
function estimateBase64DecodedSize(b64) {
  if (typeof b64 !== "string" || !b64) return null;
  // Account for padding
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// ISSUE-029 FIX: Safe base64 decoding with validation
function decodeBase64Safe(b64, log, context) {
  if (typeof b64 !== "string" || !b64) {
    log?.error?.(`invalid base64 data in ${context}: expected string, got ${typeof b64}`);
    return null;
  }
  try {
    return Buffer.from(b64, "base64");
  } catch (err) {
    log?.error?.(`failed to decode base64 in ${context}: ${err.message}`);
    return null;
  }
}

// ISSUE-021 FIX: Add default maxArtifacts
function createMemoryStore({ ttlSeconds, maxArtifacts = 2000, log: _log }) {
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
    /**
     * Store an artifact.
     * @param {string} id - Artifact ID
     * @param {Buffer} data - Artifact data
     * @param {object} meta - Metadata
     * @returns {Promise<void>}
     */
    // ISSUE-052 FIX: Only sweep when near capacity (90%+), periodic interval handles normal expiry
    async put(id, data, meta) {
      const now = Date.now();
      map.set(id, {
        data,
        meta,
        createdAt: now,
        lastAccess: now,
        expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : null,
      });
      if (map.size >= effectiveMaxArtifacts * 0.9) {
        sweep();
      }
    },

    /**
     * Retrieve an artifact.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, data: Buffer, meta: object}|null>} - Artifact or null if not found/expired
     */
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

    /**
     * Get artifact metadata.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, store: string, meta: object, createdAt: string, lastAccess: string, expiresAt: string|null, bytesStored: number|null}|null>}
     */
    async info(id) {
      const rec = map.get(id);
      if (!rec) return null;
      // ISSUE-034 FIX: Add expiry check consistent with get()
      if (rec.expiresAt && rec.expiresAt <= Date.now()) {
        map.delete(id);
        return null;
      }
      // ISSUE-056 FIX: Update lastAccess consistent with get()
      rec.lastAccess = Date.now();
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

    /**
     * Close the store and release resources.
     * @returns {Promise<void>}
     */
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

  // ISSUE-035 FIX: Extract shared file reading logic
  async function readArtifactFile(id) {
    const filePath = pathFor(id);
    try {
      const raw = await readFile(filePath, "utf8");
      try {
        return { rec: JSON.parse(raw), filePath };
      } catch (parseErr) {
        log?.error?.(`corrupt artifact file ${id}: ${parseErr.message}`);
        return { rec: null, filePath };
      }
    } catch (err) {
      if (err.code === "ENOENT") return { rec: null, filePath };
      log?.error?.(`error reading artifact file ${id}: ${err.message}`);
      return { rec: null, filePath };
    }
  }

  // ISSUE-011 FIX: Proactive cleanup interval for expired files
  // ISSUE-044 FIX: Read only first 200 bytes to check expiry instead of entire file
  // ISSUE-049 FIX: Use module-level import instead of dynamic import in loop
  // ISSUE-051 FIX: Use flag to prevent double-close
  async function cleanup() {
    try {
      const files = await readdir(baseDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(baseDir, file);
        let handle = null;
        try {
          handle = await open(filePath, "r");
          const buf = Buffer.alloc(200);
          await handle.read(buf, 0, 200, 0);
          const partial = buf.toString("utf8");
          const match = partial.match(/"expiresAt"\s*:\s*"([^"]+)"/);
          if (match) {
            const expiresAt = Date.parse(match[1]);
            if (expiresAt && expiresAt <= now) {
              await handle.close();
              handle = null; // Mark as closed
              await unlink(filePath).catch(() => {});
            }
          }
        } catch {
          // Ignore errors during cleanup - file may be corrupt or in use
        } finally {
          if (handle) await handle.close().catch(() => {});
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
    /**
     * Store an artifact.
     * @param {string} id - Artifact ID
     * @param {Buffer} data - Artifact data
     * @param {object} meta - Metadata
     * @returns {Promise<void>}
     */
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

    /**
     * Retrieve an artifact.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, data: Buffer, meta: object}|null>} - Artifact or null if not found/expired
     */
    async get(id) {
      const { rec, filePath } = await readArtifactFile(id);
      if (!rec) return null;
      if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
        await unlink(filePath).catch(() => {});
        return null;
      }
      // ISSUE-029 FIX: Validate base64 data
      const data = decodeBase64Safe(rec.dataB64, log, `FileStore artifact ${id}`);
      if (!data) return null;
      return { id, data, meta: rec.meta };
    },

    /**
     * Get artifact metadata.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, store: string, createdAt: string, expiresAt: string|null, meta: object, bytesStored: number|null}|null>}
     */
    async info(id) {
      const { rec } = await readArtifactFile(id);
      if (!rec) return null;
      // ISSUE-034 FIX: Add expiry check consistent with get()
      if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
        await unlink(pathFor(id)).catch(() => {});
        return null;
      }
      // ISSUE-057 FIX: Estimate byte count without decoding entire payload
      return {
        id,
        store: `file:${baseDir}`,
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt ?? null,
        meta: rec.meta,
        bytesStored: estimateBase64DecodedSize(rec.dataB64),
      };
    },

    /**
     * Close the store and release resources.
     * @returns {Promise<void>}
     */
    async close() {
      clearInterval(cleanupInterval);
    },
  };
}

async function createRedisStore({ url, ttlSeconds, keyPrefix, log }) {
  let redisMod;
  try {
    redisMod = await import("redis");
  } catch (_e) {
    throw new Error("Redis store requested but 'redis' package is not installed. Run: npm i redis");
  }
  const { createClient } = redisMod;

  // ISSUE-030 FIX: Add reconnection strategy
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          log?.error?.("redis reconnect failed after 10 attempts");
          return new Error("Redis reconnect exhausted");
        }
        const delay = Math.min(retries * 100, 3000); // Exponential backoff, max 3s
        log?.warn?.(`redis reconnecting in ${delay}ms (attempt ${retries + 1}/10)`);
        return delay;
      }
    }
  });
  client.on("error", (err) => log?.error?.(`redis error: ${err?.message ?? err}`));
  client.on("reconnecting", () => log?.info?.("redis reconnecting..."));
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
    /**
     * Store an artifact.
     * @param {string} id - Artifact ID
     * @param {Buffer} data - Artifact data
     * @param {object} meta - Metadata
     * @returns {Promise<void>}
     */
    // ISSUE-041 FIX: Wrap Redis operations in try-catch
    async put(id, data, meta) {
      const rec = {
        id,
        createdAt: new Date().toISOString(),
        meta,
        dataB64: Buffer.from(data).toString("base64"),
      };
      try {
        if (ttlSeconds) {
          await client.set(key(id), JSON.stringify(rec), { EX: ttlSeconds });
        } else {
          await client.set(key(id), JSON.stringify(rec));
        }
      } catch (err) {
        log?.error?.(`redis put failed for ${id}: ${err.message}`);
        throw err;
      }
    },

    /**
     * Retrieve an artifact.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, data: Buffer, meta: object}|null>} - Artifact or null if not found/expired
     */
    // ISSUE-041 FIX: Wrap Redis operations in try-catch
    async get(id) {
      let raw;
      try {
        raw = await client.get(key(id));
      } catch (err) {
        log?.error?.(`redis get failed for ${id}: ${err.message}`);
        throw err;
      }
      if (!raw) return null;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch (err) {
        log?.error?.(`corrupt redis artifact ${id}: ${err.message}`);
        return null;
      }
      // ISSUE-029 FIX: Validate base64 data
      const data = decodeBase64Safe(rec.dataB64, log, `RedisStore artifact ${id}`);
      if (!data) return null;
      return { id, data, meta: rec.meta };
    },

    /**
     * Get artifact metadata.
     * @param {string} id - Artifact ID
     * @returns {Promise<{id: string, store: string, createdAt: string, ttlSeconds: number|null, meta: object, bytesStored: number|null}|null>}
     */
    // ISSUE-041 FIX: Wrap Redis operations in try-catch
    // ISSUE-058 FIX: Rename ttl to remainingTtl for clarity
    async info(id) {
      let raw, remainingTtl;
      try {
        raw = await client.get(key(id));
        if (!raw) return null;
        remainingTtl = await client.ttl(key(id));
      } catch (err) {
        log?.error?.(`redis info failed for ${id}: ${err.message}`);
        throw err;
      }
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch (err) {
        log?.error?.(`corrupt redis artifact ${id}: ${err.message}`);
        return null;
      }
      // ISSUE-057 FIX: Estimate byte count without decoding entire payload
      return {
        id,
        store: `redis:${sanitizeUrl(url)}`,
        createdAt: rec.createdAt,
        ttlSeconds: remainingTtl >= 0 ? remainingTtl : null,
        meta: rec.meta,
        bytesStored: estimateBase64DecodedSize(rec.dataB64),
      };
    },

    /**
     * Close the store and release resources.
     * @returns {Promise<void>}
     */
    async close() {
      try {
        await client.quit();
      } catch {
        await client.disconnect();
      }
    },
  };
}
