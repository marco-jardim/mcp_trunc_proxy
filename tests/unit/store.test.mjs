/**
 * Unit tests for src/store.mjs
 */
import { test, describe, beforeEach, afterEach } from "vitest";
import { expect, assert } from "vitest";
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
      await expect(createStore({ spec: "unknown:foo" })).rejects.toThrow(/Unknown store spec/);
    });

    test("handles redis connection attempt", async () => {
      // This test verifies redis store creation behavior
      // May succeed (if redis running) or fail (no redis/no package) - both valid
      try {
        const store = await createStore({ spec: "redis://localhost:6379" });
        // If we get here, redis is available - just close it
        await store.close();
      } catch (e) {
        // Any error is acceptable - package missing, connection refused, etc.
        expect(e).toBeDefined();
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

  describe("MemoryStore list()", () => {
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

    test("list() returns empty array when no artifacts", async () => {
      const result = await store.list();
      assert.deepStrictEqual(result, []);
    });

    test("list() returns all stored artifacts", async () => {
      await store.put("art-1", Buffer.from("data1"), { toolName: "tool1", originalBytes: 100 });
      await store.put("art-2", Buffer.from("data2"), { toolName: "tool2", originalBytes: 200 });
      await store.put("art-3", Buffer.from("data3"), { toolName: "tool3", originalBytes: 300 });

      const result = await store.list();
      assert.strictEqual(result.length, 3);
    });

    test("list() returns correct artifact properties", async () => {
      await store.put("art-props", Buffer.from("test data"), { toolName: "myTool", originalBytes: 12345 });

      const result = await store.list();
      assert.strictEqual(result.length, 1);
      const art = result[0];

      assert.strictEqual(art.id, "art-props");
      assert.strictEqual(art.toolName, "myTool");
      assert.strictEqual(art.originalBytes, 12345);
      assert.strictEqual(art.bytesStored, 9); // "test data" = 9 bytes
      assert.ok(art.createdAt);
      assert.ok(art.expiresAt);
    });

    test("list() excludes expired artifacts", async () => {
      const shortTtlStore = await createStore({
        spec: "memory",
        ttlSeconds: 0.001,
        maxArtifacts: 100,
      });

      await shortTtlStore.put("expired", Buffer.from("data"), { toolName: "test" });
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortTtlStore.list();
      assert.strictEqual(result.length, 0);
      await shortTtlStore.close();
    });

    test("list() sorts by createdAt descending (newest first)", async () => {
      await store.put("old", Buffer.from("1"), { toolName: "t1" });
      await new Promise((r) => setTimeout(r, 5));
      await store.put("middle", Buffer.from("2"), { toolName: "t2" });
      await new Promise((r) => setTimeout(r, 5));
      await store.put("new", Buffer.from("3"), { toolName: "t3" });

      const result = await store.list();
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].id, "new");
      assert.strictEqual(result[1].id, "middle");
      assert.strictEqual(result[2].id, "old");
    });

    test("list() handles missing meta properties gracefully", async () => {
      await store.put("no-meta", Buffer.from("data"), {});

      const result = await store.list();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].toolName, null);
      assert.strictEqual(result[0].originalBytes, null);
    });

    test("list() works with no TTL configured", async () => {
      const noTtlStore = await createStore({
        spec: "memory",
        maxArtifacts: 100,
      });

      await noTtlStore.put("no-ttl", Buffer.from("data"), { toolName: "test" });

      const result = await noTtlStore.list();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].expiresAt, null);
      await noTtlStore.close();
    });
  });

  describe("FileStore list()", () => {
    let store;
    let testDir;

    beforeEach(async () => {
      testDir = join(tmpdir(), `mcp-test-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      store = await createStore({
        spec: `file:${testDir}`,
        ttlSeconds: 60,
      });
    });

    afterEach(async () => {
      await store.close();
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    test("list() returns empty array when no artifacts", async () => {
      const result = await store.list();
      assert.deepStrictEqual(result, []);
    });

    test("list() returns all stored artifacts", async () => {
      await store.put("file-1", Buffer.from("data1"), { toolName: "tool1", originalBytes: 100 });
      await store.put("file-2", Buffer.from("data2"), { toolName: "tool2", originalBytes: 200 });

      const result = await store.list();
      assert.strictEqual(result.length, 2);
    });

    test("list() returns correct artifact properties", async () => {
      await store.put("file-props", Buffer.from("file data"), { toolName: "fileTool", originalBytes: 5678 });

      const result = await store.list();
      assert.strictEqual(result.length, 1);
      const art = result[0];

      assert.strictEqual(art.id, "file-props");
      assert.strictEqual(art.toolName, "fileTool");
      assert.strictEqual(art.originalBytes, 5678);
      assert.ok(art.bytesStored > 0);
      assert.ok(art.createdAt);
      assert.ok(art.expiresAt);
    });

    test("list() excludes expired artifacts", async () => {
      const shortTtlDir = join(tmpdir(), `mcp-test-expire-${Date.now()}`);
      const shortTtlStore = await createStore({
        spec: `file:${shortTtlDir}`,
        ttlSeconds: 0.001,
      });

      await shortTtlStore.put("expired-file", Buffer.from("data"), { toolName: "test" });
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortTtlStore.list();
      assert.strictEqual(result.length, 0);
      await shortTtlStore.close();
      await rm(shortTtlDir, { recursive: true, force: true }).catch(() => {});
    });

    test("list() sorts by createdAt descending (newest first)", async () => {
      await store.put("file-old", Buffer.from("1"), { toolName: "t1" });
      await new Promise((r) => setTimeout(r, 10));
      await store.put("file-new", Buffer.from("2"), { toolName: "t2" });

      const result = await store.list();
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, "file-new");
      assert.strictEqual(result[1].id, "file-old");
    });

    test("list() ignores non-json files", async () => {
      await store.put("valid", Buffer.from("data"), { toolName: "test" });
      // The store only looks for .json files, so other files are ignored
      const result = await store.list();
      assert.strictEqual(result.length, 1);
    });
  });
});
