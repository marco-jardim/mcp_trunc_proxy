/**
 * Unit tests for src/proxy.mjs (internal functions)
 * Tests the pure functions without spawning child processes
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { gzipSync, gunzipSync } from "node:zlib";

// Since proxy.mjs doesn't export internal functions, we test via integration
// But we can test the compression/decompression logic patterns here

describe("proxy.mjs patterns", () => {
  describe("gzip compression", () => {
    test("compresses and decompresses correctly", () => {
      const original = "Hello, World! ".repeat(1000);
      const compressed = gzipSync(Buffer.from(original, "utf8"));
      const decompressed = gunzipSync(compressed).toString("utf8");
      assert.strictEqual(decompressed, original);
    });

    test("compression reduces size for repetitive content", () => {
      const original = "ERROR: Something failed\n".repeat(100);
      const originalSize = Buffer.byteLength(original, "utf8");
      const compressed = gzipSync(Buffer.from(original, "utf8"));
      assert.ok(compressed.length < originalSize / 2, "Should compress to less than half");
    });

    test("handles empty string", () => {
      const compressed = gzipSync(Buffer.from("", "utf8"));
      const decompressed = gunzipSync(compressed).toString("utf8");
      assert.strictEqual(decompressed, "");
    });

    test("handles binary data", () => {
      const binary = Buffer.from([0, 1, 2, 255, 254, 253]);
      const compressed = gzipSync(binary);
      const decompressed = gunzipSync(compressed);
      assert.deepStrictEqual(decompressed, binary);
    });

    test("throws on corrupt data", () => {
      const corrupt = Buffer.from("not gzip data");
      assert.throws(() => gunzipSync(corrupt), /incorrect header check|invalid/i);
    });
  });

  describe("line extraction patterns", () => {
    test("splits lines correctly", () => {
      const text = "line1\nline2\nline3";
      const lines = text.split(/\r?\n/);
      assert.deepStrictEqual(lines, ["line1", "line2", "line3"]);
    });

    test("handles Windows line endings", () => {
      const text = "line1\r\nline2\r\nline3";
      const lines = text.split(/\r?\n/);
      assert.deepStrictEqual(lines, ["line1", "line2", "line3"]);
    });

    test("handles mixed line endings", () => {
      const text = "line1\nline2\r\nline3";
      const lines = text.split(/\r?\n/);
      assert.deepStrictEqual(lines, ["line1", "line2", "line3"]);
    });

    test("handles trailing newline", () => {
      const text = "line1\nline2\n";
      const lines = text.split(/\r?\n/);
      assert.deepStrictEqual(lines, ["line1", "line2", ""]);
    });
  });

  describe("error pattern matching", () => {
    const errorish = /(error|fail|failed|exception|traceback|assert|panic|fatal)/i;

    test("matches ERROR", () => {
      assert.ok(errorish.test("ERROR: something went wrong"));
    });

    test("matches error (lowercase)", () => {
      assert.ok(errorish.test("error: something went wrong"));
    });

    test("matches Exception", () => {
      assert.ok(errorish.test("NullPointerException at line 42"));
    });

    test("matches Traceback", () => {
      assert.ok(errorish.test("Traceback (most recent call last):"));
    });

    test("matches FATAL", () => {
      assert.ok(errorish.test("FATAL: Cannot continue"));
    });

    test("matches panic", () => {
      assert.ok(errorish.test("panic: runtime error"));
    });

    test("matches assertion", () => {
      assert.ok(errorish.test("AssertionError: expected true"));
    });

    test("does not match normal text", () => {
      assert.ok(!errorish.test("All systems operational"));
      assert.ok(!errorish.test("Success: operation completed"));
    });
  });

  describe("regex pattern parsing", () => {
    function parsePattern(pattern) {
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
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(escaped, "i");
    }

    test("parses regex with flags", () => {
      const rx = parsePattern("/error/i");
      assert.ok(rx instanceof RegExp);
      assert.ok(rx.test("ERROR"));
      assert.ok(rx.test("error"));
    });

    test("parses regex without flags", () => {
      const rx = parsePattern("/error/");
      assert.ok(rx instanceof RegExp);
      assert.ok(!rx.test("ERROR")); // Case sensitive
      assert.ok(rx.test("error"));
    });

    test("returns error for invalid regex", () => {
      const result = parsePattern("/[unclosed/");
      assert.ok(result.error);
      assert.ok(result.error.includes("Invalid regex"));
    });

    test("escapes plain strings", () => {
      const rx = parsePattern("file.txt");
      assert.ok(rx instanceof RegExp);
      assert.ok(rx.test("file.txt"));
      assert.ok(!rx.test("filextxt")); // . should be escaped
    });

    test("plain strings are case insensitive", () => {
      const rx = parsePattern("error");
      assert.ok(rx.test("ERROR"));
      assert.ok(rx.test("Error"));
      assert.ok(rx.test("error"));
    });
  });

  describe("clamp function pattern", () => {
    function clampInt(n, min, max) {
      if (!Number.isFinite(n)) return min;
      return Math.max(min, Math.min(max, Math.floor(n)));
    }

    test("clamps to min", () => {
      assert.strictEqual(clampInt(-5, 0, 100), 0);
    });

    test("clamps to max", () => {
      assert.strictEqual(clampInt(150, 0, 100), 100);
    });

    test("passes through valid value", () => {
      assert.strictEqual(clampInt(50, 0, 100), 50);
    });

    test("floors float values", () => {
      assert.strictEqual(clampInt(50.9, 0, 100), 50);
    });

    test("returns min for NaN", () => {
      assert.strictEqual(clampInt(NaN, 0, 100), 0);
    });

    test("returns min for Infinity", () => {
      assert.strictEqual(clampInt(Infinity, 0, 100), 0);
    });
  });

  describe("artifact ID generation pattern", () => {
    function mkArtifactId() {
      const bytes = new Uint8Array(12);
      for (let i = 0; i < 12; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
      return Buffer.from(bytes).toString("base64url");
    }

    test("generates 16 character IDs", () => {
      const id = mkArtifactId();
      assert.strictEqual(id.length, 16);
    });

    test("generates URL-safe IDs", () => {
      for (let i = 0; i < 100; i++) {
        const id = mkArtifactId();
        assert.ok(/^[A-Za-z0-9_-]+$/.test(id), `ID should be URL-safe: ${id}`);
      }
    });

    test("generates unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 1000; i++) {
        ids.add(mkArtifactId());
      }
      assert.strictEqual(ids.size, 1000, "All IDs should be unique");
    });
  });
});
