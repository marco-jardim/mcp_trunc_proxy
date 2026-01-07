import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export async function createStore({ spec, ttlSeconds, maxArtifacts, keyPrefix, log }) {
  if (!spec || spec === "memory") return createMemoryStore({ ttlSeconds, maxArtifacts, log });
  if (spec.startsWith("file:")) return createFileStore({ dir: spec.slice("file:".length), ttlSeconds, log });
  if (spec.startsWith("redis:")) return await createRedisStore({ url: spec.slice("redis:".length), ttlSeconds, keyPrefix, log });

  throw new Error(`Unknown store spec: ${spec} (expected memory, file:<dir>, redis:<url>)`);
}

function createMemoryStore({ ttlSeconds, maxArtifacts, log }) {
  const map = new Map(); // id -> {data: Buffer, meta, createdAt, lastAccess, expiresAt?}

  function sweep() {
    const now = Date.now();
    for (const [id, rec] of map.entries()) {
      if (rec.expiresAt && rec.expiresAt <= now) map.delete(id);
    }
    // cap size (oldest createdAt)
    if (map.size > maxArtifacts) {
      const entries = Array.from(map.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = entries.slice(0, map.size - maxArtifacts);
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

function createFileStore({ dir, ttlSeconds, log }) {
  const baseDir = dir || ".mcp-artifacts";
  mkdirSync(baseDir, { recursive: true });

  function pathFor(id) {
    return join(baseDir, `${id}.json`);
  }

  return {
    async put(id, data, meta) {
      const rec = {
        id,
        createdAt: new Date().toISOString(),
        expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
        meta,
        dataB64: Buffer.from(data).toString("base64"),
      };
      writeFileSync(pathFor(id), JSON.stringify(rec), "utf8");
    },
    async get(id) {
      const p = pathFor(id);
      if (!existsSync(p)) return null;
      const rec = JSON.parse(readFileSync(p, "utf8"));
      if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
        // best-effort cleanup
        try { unlinkSync(p); } catch {}
        return null;
      }
      return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
    },
    async info(id) {
      const p = pathFor(id);
      if (!existsSync(p)) return null;
      const rec = JSON.parse(readFileSync(p, "utf8"));
      return {
        id,
        store: `file:${baseDir}`,
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt ?? null,
        meta: rec.meta,
        bytesStored: rec.dataB64 ? Buffer.from(rec.dataB64, "base64").byteLength : null,
      };
    },
    async close() {},
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
    async get(id) {
      const raw = await client.get(key(id));
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return { id, data: Buffer.from(rec.dataB64, "base64"), meta: rec.meta };
    },
    async info(id) {
      const raw = await client.get(key(id));
      if (!raw) return null;
      const rec = JSON.parse(raw);
      const ttl = await client.ttl(key(id));
      return {
        id,
        store: `redis:${url}`,
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
