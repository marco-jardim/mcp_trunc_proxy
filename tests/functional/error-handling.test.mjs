/**
 * Functional tests for error handling
 * Tests edge cases and error conditions
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createStore } from "../../src/store.mjs";
import { gzipSync } from "node:zlib";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Error Handling", () => {
  describe("Corrupt Data Handling", () => {
    let store;

    beforeEach(async () => {
      store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
    });

    afterEach(async () => {
      await store.close();
    });

    test("handles retrieval of missing artifact", async () => {
      const result = await store.get("does-not-exist");
      assert.strictEqual(result, null);
    });

    test("handles info of missing artifact", async () => {
      const result = await store.info("does-not-exist");
      assert.strictEqual(result, null);
    });

    test("handles empty buffer storage", async () => {
      await store.put("empty", Buffer.alloc(0), {});
      const result = await store.get("empty");
      assert.ok(result);
      assert.strictEqual(result.data.length, 0);
    });

    test("handles binary data storage", async () => {
      const binary = Buffer.from([0, 1, 2, 3, 255, 254, 253, 252]);
      await store.put("binary", binary, {});
      const result = await store.get("binary");
      assert.deepStrictEqual(result.data, binary);
    });
  });

  describe("FileStore Error Handling", () => {
    let testDir;

    beforeEach(async () => {
      testDir = join(tmpdir(), `mcp-err-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    test("handles corrupt JSON file gracefully", async () => {
      // Create store and add a valid artifact
      const store = await createStore({ spec: `file:${testDir}`, ttlSeconds: 60 });
      await store.put("test", Buffer.from("data"), {});
      await store.close();

      // Corrupt the file
      const files = await (await import("node:fs/promises")).readdir(testDir);
      const jsonFile = files.find(f => f.endsWith(".json"));
      if (jsonFile) {
        await writeFile(join(testDir, jsonFile), "not valid json{{{");
      }

      // Try to read with a new store instance
      const store2 = await createStore({ spec: `file:${testDir}`, ttlSeconds: 60 });
      const result = await store2.get("test");
      
      // Should return null, not throw
      assert.strictEqual(result, null);
      await store2.close();
    });

    test("handles missing directory gracefully", async () => {
      // Creating store should create the directory
      const store = await createStore({ spec: `file:${testDir}/deep/nested/path`, ttlSeconds: 60 });
      await store.put("test", Buffer.from("data"), {});
      const result = await store.get("test");
      assert.ok(result);
      await store.close();
    });

    test("handles special characters in artifact ID", async () => {
      const store = await createStore({ spec: `file:${testDir}`, ttlSeconds: 60 });
      
      const specialIds = [
        "simple",
        "with-dash",
        "with_underscore",
        "with.dot",
        "with space",
        "with/slash",
        "with\\backslash",
        "../parent",
        "..\\..\\windows",
        "<script>alert</script>",
        "unicode-日本語-🎉",
      ];

      for (const id of specialIds) {
        await store.put(id, Buffer.from(`data for ${id}`), {});
        const result = await store.get(id);
        assert.ok(result, `Should handle ID: ${id}`);
      }

      await store.close();
    });
  });

  describe("Edge Cases", () => {
    test("handles very long lines", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      const longLine = "x".repeat(100_000);
      const compressed = gzipSync(Buffer.from(longLine, "utf8"));
      
      await store.put("long-line", compressed, { length: longLine.length });
      const result = await store.get("long-line");
      
      assert.ok(result);
      assert.ok(result.data.length < longLine.length); // Compressed
      
      await store.close();
    });

    test("handles maximum artifacts limit", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 5 });
      
      // Add more than max
      for (let i = 0; i < 10; i++) {
        await store.put(`item-${i}`, Buffer.from(`data-${i}`), {});
      }
      
      // Latest should exist
      const latest = await store.get("item-9");
      assert.ok(latest);
      
      await store.close();
    });

    test("handles rapid sequential writes", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 1000 });
      
      // Rapid fire writes
      for (let i = 0; i < 100; i++) {
        await store.put(`rapid-${i}`, Buffer.from(`${i}`), { seq: i });
      }
      
      // All should be retrievable
      for (let i = 0; i < 100; i++) {
        const result = await store.get(`rapid-${i}`);
        assert.ok(result, `Missing rapid-${i}`);
      }
      
      await store.close();
    });

    test("handles concurrent reads and writes", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 1000 });
      
      // Pre-populate
      for (let i = 0; i < 50; i++) {
        await store.put(`pre-${i}`, Buffer.from(`pre-${i}`), {});
      }
      
      // Concurrent operations
      const ops = [];
      for (let i = 0; i < 50; i++) {
        ops.push(store.put(`new-${i}`, Buffer.from(`new-${i}`), {}));
        ops.push(store.get(`pre-${i % 50}`));
        ops.push(store.info(`pre-${(i + 25) % 50}`));
      }
      
      await Promise.all(ops);
      
      await store.close();
    });

    test("handles null and undefined in metadata", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      await store.put("meta-test", Buffer.from("data"), {
        nullValue: null,
        undefinedValue: undefined,
        normalValue: "test",
        nestedNull: { a: null },
      });
      
      const result = await store.get("meta-test");
      assert.ok(result);
      assert.strictEqual(result.meta.nullValue, null);
      assert.strictEqual(result.meta.normalValue, "test");
      
      await store.close();
    });
  });

  describe("Pessimistic Cases", () => {
    test("handles extremely large metadata", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      const largeMeta = {
        data: "x".repeat(10000),
        nested: { deep: { data: "y".repeat(10000) } },
      };
      
      await store.put("large-meta", Buffer.from("small data"), largeMeta);
      const info = await store.info("large-meta");
      
      assert.ok(info);
      assert.ok(info.meta.data.length === 10000);
      
      await store.close();
    });

    test("handles store close during operations", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      // Start some operations
      const ops = [];
      for (let i = 0; i < 10; i++) {
        ops.push(store.put(`item-${i}`, Buffer.from(`${i}`), {}));
      }
      
      // Close immediately
      await store.close();
      
      // Should not throw, but results may vary
      try {
        await Promise.all(ops);
      } catch {
        // Expected - store may be closed
      }
    });

    test("handles TTL edge case (exactly expired)", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 0.05, maxArtifacts: 100 });
      
      await store.put("ttl-test", Buffer.from("data"), {});
      
      // Wait exactly at expiry boundary
      await new Promise(r => setTimeout(r, 50));
      
      const result = await store.get("ttl-test");
      // May or may not be expired depending on timing
      // Just verify no crash
      assert.ok(result === null || result.data);
      
      await store.close();
    });
  });

  describe("Optimistic Cases", () => {
    test("handles typical small payload", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      const payload = JSON.stringify({ result: "success", data: [1, 2, 3] });
      await store.put("small", Buffer.from(payload), { type: "json" });
      
      const result = await store.get("small");
      assert.ok(result);
      assert.strictEqual(result.data.toString(), payload);
      
      await store.close();
    });

    test("handles typical medium payload", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      // ~100KB of JSON
      const data = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        description: "This is a sample item with some description text",
        tags: ["tag1", "tag2", "tag3"],
      }));
      const payload = JSON.stringify(data);
      const compressed = gzipSync(Buffer.from(payload, "utf8"));
      
      await store.put("medium", compressed, { 
        originalSize: payload.length,
        compressedSize: compressed.length 
      });
      
      const result = await store.get("medium");
      assert.ok(result);
      
      const info = await store.info("medium");
      assert.ok(info.meta.originalSize > info.meta.compressedSize);
      
      await store.close();
    });

    test("handles typical file listing payload", async () => {
      const store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
      
      // Simulate ls -la output
      const files = Array.from({ length: 500 }, (_, i) => 
        `-rw-r--r-- 1 user group ${1000 + i} Jan  1 12:00 file${i.toString().padStart(4, "0")}.txt`
      );
      const payload = files.join("\n");
      const compressed = gzipSync(Buffer.from(payload, "utf8"));
      
      await store.put("files", compressed, { 
        tool: "filesystem",
        lines: files.length 
      });
      
      const result = await store.get("files");
      assert.ok(result);
      assert.ok(result.meta.lines === 500);
      
      await store.close();
    });
  });
});
