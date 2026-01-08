/**
 * Unit tests for src/util.mjs
 */
import { test, describe } from "vitest";
import { expect, assert } from "vitest";
import { stableStringify, safeJsonParse, byteLengthUtf8 } from "../../src/util.mjs";

describe("util.mjs", () => {
  describe("stableStringify", () => {
    test("handles normal objects", () => {
      const obj = { a: 1, b: "hello", c: [1, 2, 3] };
      const result = stableStringify(obj);
      assert.strictEqual(result, '{"a":1,"b":"hello","c":[1,2,3]}');
    });

    test("handles BigInt values", () => {
      const obj = { big: BigInt("12345678901234567890") };
      const result = stableStringify(obj);
      assert.strictEqual(result, '{"big":"12345678901234567890"}');
    });

    test("handles circular references", () => {
      const obj = { a: 1 };
      obj.self = obj;
      const result = stableStringify(obj);
      assert.ok(result.includes("[Circular]"));
    });

    test("handles null", () => {
      assert.strictEqual(stableStringify(null), "null");
    });

    test("handles arrays", () => {
      assert.strictEqual(stableStringify([1, 2, 3]), "[1,2,3]");
    });

    test("handles nested objects", () => {
      const obj = { a: { b: { c: 1 } } };
      const result = stableStringify(obj);
      assert.strictEqual(result, '{"a":{"b":{"c":1}}}');
    });

    test("handles undefined values in objects", () => {
      const obj = { a: 1, b: undefined };
      const result = stableStringify(obj);
      assert.strictEqual(result, '{"a":1}');
    });

    test("handles deeply nested objects", () => {
      let obj = { value: "deep" };
      for (let i = 0; i < 50; i++) {
        obj = { nested: obj };
      }
      const result = stableStringify(obj);
      assert.ok(result.includes("deep"));
    });

    test("handles mixed arrays", () => {
      const arr = [1, "two", { three: 3 }, [4, 5]];
      const result = stableStringify(arr);
      assert.strictEqual(result, '[1,"two",{"three":3},[4,5]]');
    });
  });

  describe("safeJsonParse", () => {
    test("parses valid JSON object", () => {
      const result = safeJsonParse('{"a":1}');
      assert.deepStrictEqual(result, { a: 1 });
    });

    test("parses valid JSON array", () => {
      const result = safeJsonParse("[1,2,3]");
      assert.deepStrictEqual(result, [1, 2, 3]);
    });

    test("returns null for invalid JSON", () => {
      assert.strictEqual(safeJsonParse("not json"), null);
    });

    test("returns null for empty string", () => {
      assert.strictEqual(safeJsonParse(""), null);
    });

    test("returns null for undefined", () => {
      assert.strictEqual(safeJsonParse(undefined), null);
    });

    test("returns null for null input", () => {
      assert.strictEqual(safeJsonParse(null), null);
    });

    test("parses primitives", () => {
      assert.strictEqual(safeJsonParse("123"), 123);
      assert.strictEqual(safeJsonParse('"hello"'), "hello");
      assert.strictEqual(safeJsonParse("true"), true);
      assert.strictEqual(safeJsonParse("false"), false);
      assert.strictEqual(safeJsonParse("null"), null);
    });

    test("handles malformed JSON gracefully", () => {
      assert.strictEqual(safeJsonParse("{a:1}"), null); // Missing quotes
      assert.strictEqual(safeJsonParse('{"a":}'), null); // Missing value
      assert.strictEqual(safeJsonParse("{"), null); // Incomplete
    });
  });

  describe("byteLengthUtf8", () => {
    test("calculates ASCII string length", () => {
      assert.strictEqual(byteLengthUtf8("hello"), 5);
      assert.strictEqual(byteLengthUtf8("Hello, World!"), 13);
    });

    test("calculates UTF-8 2-byte characters", () => {
      assert.strictEqual(byteLengthUtf8("café"), 5); // é is 2 bytes
      assert.strictEqual(byteLengthUtf8("über"), 5); // ü is 2 bytes
    });

    test("calculates UTF-8 3-byte characters", () => {
      assert.strictEqual(byteLengthUtf8("世界"), 6); // Each Chinese char is 3 bytes
      assert.strictEqual(byteLengthUtf8("日本語"), 9);
    });

    test("calculates UTF-8 4-byte characters (emoji)", () => {
      assert.strictEqual(byteLengthUtf8("🎉"), 4);
      assert.strictEqual(byteLengthUtf8("🌍🌎🌏"), 12);
    });

    test("handles empty string", () => {
      assert.strictEqual(byteLengthUtf8(""), 0);
    });

    test("handles mixed content", () => {
      const str = "Hello 世界 🌍!";
      // "Hello " = 6, "世界" = 6, " " = 1, "🌍" = 4, "!" = 1
      assert.strictEqual(byteLengthUtf8(str), 18);
    });

    test("handles newlines and special chars", () => {
      assert.strictEqual(byteLengthUtf8("a\nb\tc"), 5);
      assert.strictEqual(byteLengthUtf8("\n\n\n"), 3);
    });
  });
});
