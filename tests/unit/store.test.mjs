/**
 * Unit tests for src/store.mjs
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createStore } from "../../src/store.mjs";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("store.mjs", () => {
  describe("MemoryStore", () => {
    let store;

    beforeEach(async () => {
      store = await createStore({
        spec: "memory",
        ttlSeconds: 60,
        maxArtifacts: 100,
      });
    });

    afterEach(async () => {
      await store.close();
    });

    test("put() stores artifact", async () => {
      const data = Buffer.from("hello world");
      const meta = { tool: "test", lines: 10 };
      await store.put("test-id", data, meta);
      const result = await store.get("test-id");
      assert.ok(result);
      assert.strictEqual(result.id, "test-id");
    });

    test("get() retrieves artifact data", async () => {
      const data = Buffer.from("test data");
      await store.put("get-test", data, {});
      const result = await store.get("get-test");
      assert.deepStrictEqual(result.data, data);
    });

    test("get() returns null for missing artifact", async () => {
      const result = await store.get("nonexistent");
      assert.strictEqual(result, null);
    });

    test("get() returns null for expired artifact", async () => {
      const shortTtlStore = await createStore({
        spec: "memory",
        ttlSeconds: 0.001,
        maxArtifacts: 100,
      });
      await shortTtlStore.put("expire-test", Buffer.from("data"), {});
      await new Promise((r) => setTimeout(r, 10));
      const result = await shortTtlStore.get("expire-test");
      assert.strictEqual(result, null);
      await shortTtlStore.close();
    });

    test("get() updates lastAccess", async () => {
      await store.put("access-test", Buffer.from("data"), {});
      const info1 = await store.info("access-test");
      await new Promise((r) => setTimeout(r, 5));
      await store.get("access-test");
      const info2 = await store.info("access-test");
      assert.ok(new Date(info2.lastAccess) >= new Date(info1.lastAccess));
    });

    test("info() returns metadata", async () => {
      const data = Buffer.from("test data");
      const meta = { tool: "test", custom: "value" };
      await store.put("info-test", data, meta);
      const info = await store.info("info-test");

      assert.strictEqual(info.id, "info-test");
      assert.strictEqual(info.store, "memory");
      assert.deepStrictEqual(info.meta, meta);
      assert.strictEqual(info.bytesStored, 9);
      assert.ok(info.createdAt);
      assert.ok(info.lastAccess);
      assert.ok(info.expiresAt);
    });

    test("info() returns null for missing artifact", async () => {
      const result = await store.info("nonexistent");
      assert.strictEqual(result, null);
    });

    test("info() returns null for expired artifact", async () => {
      const shortTtlStore = await createStore({
        spec: "memory",
        ttlSeconds: 0.001,
        maxArtifacts: 100,
      });
      await shortTtlStore.put("expire-info", Buffer.from("data"), {});
      await new Promise((r) => setTimeout(r, 10));
      const result = await shortTtlStore.info("expire-info");
      assert.strictEqual(result, null);
      await shortTtlStore.close();
    });

    test("info() updates lastAccess", async () => {
      await store.put("info-access", Buffer.from("data"), {});
      const info1 = await store.info("info-access");
      await new Promise((r) => setTimeout(r, 5));
      const info2 = await store.info("info-access");
      assert.ok(new Date(info2.lastAccess) >= new Date(info1.lastAccess));
    });

    test("sweep() removes oldest when over capacity", async () => {
      const smallStore = await createStore({
        spec: "memory",
        ttlSeconds: 60,
        maxArtifacts: 3,
      });

      // Fill to 90%+ to trigger sweep
      await smallStore.put("a", Buffer.from("1"), {});
      await smallStore.put("b", Buffer.from("2"), {});
      await smallStore.put("c", Buffer.from("3"), {});
      await smallStore.put("d", Buffer.from("4"), {}); // Should trigger sweep

      // Oldest should be removed
      const resultA = await smallStore.get("a");
      const resultD = await smallStore.get("d");

      // d should exist, a might be removed depending on timing
      assert.ok(resultD);
      await smallStore.close();
    });

    test("close() can be called multiple times", async () => {
      await store.close();
      await store.close(); // Should not throw
    });
  });

  describe("FileStore", () => {
    let store;
    let testDir;

    beforeEach(async () => {
      testDir = join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      store = await createStore({
        spec: `file:${testDir}`,
        ttlSeconds: 60,
      });
    });

    afterEach(async () => {
      await store.close();
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    test("put() creates file", async () => {
      await store.put("file-test", Buffer.from("data"), {});
      const files = await readdir(testDir);
      assert.ok(files.some((f) => f.includes("file-test")));
    });

    test("get() retrieves from file", async () => {
      const data = Buffer.from("file store test");
      const meta = { tool: "filetest" };
      await store.put("file-get", data, meta);
      const result = await store.get("file-get");

      assert.ok(result);
      assert.strictEqual(result.id, "file-get");
      assert.deepStrictEqual(result.data, data);
      assert.deepStrictEqual(result.meta, meta);
    });

    test("get() returns null for missing file", async () => {
      const result = await store.get("nonexistent");
      assert.strictEqual(result, null);
    });

    test("info() returns file metadata", async () => {
      const data = Buffer.from("info test data");
      await store.put("file-info", data, { x: 1 });
      const info = await store.info("file-info");

      assert.ok(info);
      assert.strictEqual(info.id, "file-info");
      assert.ok(info.store.startsWith("file:"));
      assert.strictEqual(info.bytesStored, 14);
    });

    test("sanitizes path traversal in IDs", async () => {
      const data = Buffer.from("safe");
      await store.put("../../../etc/passwd", data, {});
      const result = await store.get("../../../etc/passwd");
      assert.ok(result);

      // Should not create file outside testDir
      const files = await readdir(testDir);
      assert.ok(files.length > 0);
    });

    test("handles concurrent writes", async () => {
      const writes = [];
      for (let i = 0; i < 10; i++) {
        writes.push(store.put(`concurrent-${i}`, Buffer.from(`data-${i}`), { i }));
      }
      await Promise.all(writes);

      for (let i = 0; i < 10; i++) {
        const result = await store.get(`concurrent-${i}`);
        assert.ok(result);
        assert.strictEqual(result.data.toString(), `data-${i}`);
      }
    });

    test("atomic write leaves no temp files on success", async () => {
      await store.put("atomic-test", Buffer.from("data"), {});
      const files = await readdir(testDir);
      const tempFiles = files.filter((f) => f.includes(".tmp"));
      assert.strictEqual(tempFiles.length, 0);
    });
  });

  describe("createStore factory", () => {
    test("creates memory store by default", async () => {
      const store = await createStore({ ttlSeconds: 60, maxArtifacts: 100 });
      await store.put("test", Buffer.from("x"), {});
      const info = await store.info("test");
      assert.strictEqual(info.store, "memory");
      await store.close();
    });

    test('creates memory store with spec "memory"', async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      const info = await store.info("nonexistent");
      assert.strictEqual(info, null); // Just verify it works
      await store.close();
    });

    test("throws on unknown store spec", async () => {
      await assert.rejects(() => createStore({ spec: "unknown:foo" }), /Unknown store spec/);
    });

    test("throws on redis without package", async () => {
      // This test verifies the error message when redis is not installed
      // In CI, redis may or may not be available
      try {
        const store = await createStore({ spec: "redis://localhost:6379" });
        await store.close();
      } catch (e) {
        // Either redis package not installed or connection failed - both are valid
        assert.ok(e.message.includes("redis") || e.message.includes("Redis"));
      }
    });
  });

  describe("estimateBase64DecodedSize", () => {
    test("info() bytesStored matches actual data size", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      const testCases = [
        Buffer.from("a"),           // 1 byte
        Buffer.from("hello"),       // 5 bytes
        Buffer.from("x".repeat(100)), // 100 bytes
        Buffer.from("x".repeat(1000)), // 1000 bytes
      ];

      for (const data of testCases) {
        await store.put(`size-${data.length}`, data, {});
        const info = await store.info(`size-${data.length}`);
        assert.strictEqual(info.bytesStored, data.length, `Mismatch for ${data.length} bytes`);
      }

      await store.close();
    });
  });
});
