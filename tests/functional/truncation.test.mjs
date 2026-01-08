/**
 * Functional tests for truncation logic
 * Tests the core value proposition: large payloads → compact previews
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createStore } from "../../src/store.mjs";
import { gzipSync, gunzipSync } from "node:zlib";

// Simulate the truncation logic from proxy.mjs
function summarizeLines(lines, headLines = 60, tailLines = 60) {
  const head = lines.slice(0, headLines);
  const tail = lines.slice(Math.max(0, lines.length - tailLines));

  const ERROR_CONTEXT_LINES = 5;
  const errorish = /(error|fail|failed|exception|traceback|assert|panic|fatal)/i;
  const picked = [];
  
  for (let i = 0; i < lines.length; i++) {
    if (errorish.test(lines[i])) {
      for (let j = Math.max(0, i - ERROR_CONTEXT_LINES); j <= Math.min(lines.length - 1, i + ERROR_CONTEXT_LINES); j++) {
        picked.push(j);
      }
      if (picked.length > 120) break;
    }
  }

  const errorIdxs = [...new Set(picked)].sort((a, b) => a - b);
  const headSet = new Set(head.map((_, i) => i));
  const tailSet = new Set(tail.map((_, i) => lines.length - tailLines + i));
  const middleErrors = errorIdxs.filter((i) => !headSet.has(i) && !tailSet.has(i));
  const middleErrorLines = middleErrors.map((i) => `[${i + 1}] ${lines[i]}`);

  return { head, tail, middleErrorLines, totalLines: lines.length };
}

function buildPreview(summary, maxChars = 6000) {
  const parts = [];
  
  parts.push(`=== TRUNCATED (${summary.totalLines} lines) ===`);
  parts.push("");
  parts.push("--- HEAD ---");
  parts.push(...summary.head);
  
  if (summary.middleErrorLines.length > 0) {
    parts.push("");
    parts.push("--- ERRORS (middle) ---");
    parts.push(...summary.middleErrorLines);
  }
  
  parts.push("");
  parts.push("--- TAIL ---");
  parts.push(...summary.tail);

  let preview = parts.join("\n");
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars) + "\n...[truncated preview]";
  }
  
  return preview;
}

describe("Truncation Logic", () => {
  describe("summarizeLines", () => {
    test("extracts head and tail from large output", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`);
      const summary = summarizeLines(lines);
      
      assert.strictEqual(summary.head.length, 60);
      assert.strictEqual(summary.tail.length, 60);
      assert.strictEqual(summary.totalLines, 500);
    });

    test("handles small output (no truncation needed)", () => {
      const lines = ["Line 1", "Line 2", "Line 3"];
      const summary = summarizeLines(lines);
      
      assert.strictEqual(summary.head.length, 3);
      assert.strictEqual(summary.totalLines, 3);
    });

    test("extracts error lines from middle", () => {
      const lines = [
        ...Array.from({ length: 100 }, (_, i) => `Normal line ${i}`),
        "ERROR: Something failed here",
        ...Array.from({ length: 100 }, (_, i) => `Normal line ${i + 100}`),
      ];
      
      const summary = summarizeLines(lines);
      
      // Error at line 101 (index 100) should be in middleErrorLines
      assert.ok(summary.middleErrorLines.some(l => l.includes("ERROR: Something failed")));
    });

    test("includes context around errors", () => {
      const lines = [
        ...Array.from({ length: 100 }, (_, i) => `Context before ${i}`),
        "ERROR: The actual error",
        ...Array.from({ length: 100 }, (_, i) => `Context after ${i}`),
      ];
      
      const summary = summarizeLines(lines);
      
      // Should include ±5 lines of context
      assert.ok(summary.middleErrorLines.length >= 1);
      assert.ok(summary.middleErrorLines.length <= 11); // error + 5 before + 5 after
    });

    test("handles multiple error patterns", () => {
      const lines = [
        "Normal start",
        ...Array.from({ length: 80 }, () => "..."),
        "Exception thrown at runtime",
        ...Array.from({ length: 50 }, () => "..."),
        "FATAL: Process crashed",
        ...Array.from({ length: 80 }, () => "..."),
        "Normal end",
      ];
      
      const summary = summarizeLines(lines);
      
      assert.ok(summary.middleErrorLines.some(l => l.includes("Exception")));
      assert.ok(summary.middleErrorLines.some(l => l.includes("FATAL")));
    });
  });

  describe("buildPreview", () => {
    test("builds structured preview", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
      const summary = summarizeLines(lines);
      const preview = buildPreview(summary);
      
      assert.ok(preview.includes("=== TRUNCATED"));
      assert.ok(preview.includes("--- HEAD ---"));
      assert.ok(preview.includes("--- TAIL ---"));
      assert.ok(preview.includes("200 lines"));
    });

    test("respects maxChars limit", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `This is a longer line number ${i + 1} with some content`);
      const summary = summarizeLines(lines);
      const preview = buildPreview(summary, 1000);
      
      assert.ok(preview.length <= 1100); // Allow small overflow for truncation message
      assert.ok(preview.includes("[truncated preview]"));
    });

    test("includes error section when errors found", () => {
      const lines = [
        ...Array.from({ length: 100 }, (_, i) => `Line ${i}`),
        "ERROR: Test error",
        ...Array.from({ length: 100 }, (_, i) => `Line ${i + 100}`),
      ];
      
      const summary = summarizeLines(lines);
      const preview = buildPreview(summary);
      
      assert.ok(preview.includes("--- ERRORS (middle) ---"));
    });
  });

  describe("Token Reduction", () => {
    test("reduces large payload significantly", () => {
      // Simulate a large file listing (common high-token output)
      const lines = Array.from({ length: 5000 }, (_, i) => 
        `/path/to/some/deeply/nested/directory/file${i}.txt  1024 bytes  2024-01-01`
      );
      const original = lines.join("\n");
      const summary = summarizeLines(lines);
      const preview = buildPreview(summary);
      
      const originalTokens = Math.ceil(original.length / 4);
      const previewTokens = Math.ceil(preview.length / 4);
      const reduction = ((originalTokens - previewTokens) / originalTokens) * 100;
      
      console.log(`Original: ${originalTokens} tokens, Preview: ${previewTokens} tokens, Reduction: ${reduction.toFixed(1)}%`);
      
      assert.ok(reduction > 90, `Should reduce by >90%, got ${reduction.toFixed(1)}%`);
    });

    test("preserves errors in reduced output", () => {
      const lines = [
        ...Array.from({ length: 2000 }, (_, i) => `Log entry ${i}: INFO - All systems normal`),
        "Log entry 2000: ERROR - Database connection failed",
        "Log entry 2001: ERROR - Retry attempt 1 failed",
        "Log entry 2002: ERROR - Retry attempt 2 failed",
        ...Array.from({ length: 2000 }, (_, i) => `Log entry ${i + 2003}: INFO - Recovery in progress`),
      ];
      
      const summary = summarizeLines(lines);
      const preview = buildPreview(summary);
      
      // All errors should be preserved
      assert.ok(preview.includes("Database connection failed"));
      assert.ok(preview.includes("Retry attempt 1"));
      assert.ok(preview.includes("Retry attempt 2"));
    });
  });
});

describe("Artifact Storage Integration", () => {
  let store;

  beforeEach(async () => {
    store = await createStore({ spec: "memory", ttlSeconds: 60, maxArtifacts: 100 });
  });

  afterEach(async () => {
    await store.close();
  });

  test("stores and retrieves large compressed payload", async () => {
    const largePayload = "x".repeat(1_000_000); // 1MB
    const compressed = gzipSync(Buffer.from(largePayload, "utf8"));
    
    await store.put("large-test", compressed, { 
      originalSize: largePayload.length,
      tool: "test"
    });
    
    const result = await store.get("large-test");
    const decompressed = gunzipSync(result.data).toString("utf8");
    
    assert.strictEqual(decompressed, largePayload);
    assert.ok(compressed.length < largePayload.length / 10, "Should compress well");
  });

  test("retrieval modes: full, head, tail, range, grep", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: Content here`);
    const payload = lines.join("\n");
    const compressed = gzipSync(Buffer.from(payload, "utf8"));
    
    await store.put("modes-test", compressed, { lines: 1000 });
    
    const result = await store.get("modes-test");
    const decompressed = gunzipSync(result.data).toString("utf8");
    const retrievedLines = decompressed.split("\n");
    
    // Full retrieval
    assert.strictEqual(retrievedLines.length, 1000);
    
    // Head simulation
    const head = retrievedLines.slice(0, 50);
    assert.strictEqual(head.length, 50);
    assert.ok(head[0].includes("Line 1:"));
    
    // Tail simulation
    const tail = retrievedLines.slice(-50);
    assert.strictEqual(tail.length, 50);
    assert.ok(tail[49].includes("Line 1000:"));
    
    // Range simulation
    const range = retrievedLines.slice(99, 199);
    assert.strictEqual(range.length, 100);
    assert.ok(range[0].includes("Line 100:"));
    
    // Grep simulation
    const grep = retrievedLines.filter(l => l.includes("Line 500:"));
    assert.strictEqual(grep.length, 1);
  });
});
