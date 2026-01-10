#!/usr/bin/env node
/**
 * Token Reduction Benchmark for mcp-trunc-proxy
 * 
 * Measures token savings when using the proxy with high-token MCP servers.
 * Tests against simulated payloads matching real-world MCP outputs.
 * 
 * Usage:
 *   node benchmarks/token-reduction.mjs
 *   node benchmarks/token-reduction.mjs --json    # JSON output
 *   node benchmarks/token-reduction.mjs --verbose # Detailed output
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "src/cli.mjs");
// Approximate tokens = chars / 4 (rough estimate for GPT-style tokenizers)
const estimateTokens = (str) => Math.ceil(str.length / 4);
const formatBytes = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

/**
 * Simulated MCP payloads matching real-world scenarios
 */
const SCENARIOS = {
  // @modelcontextprotocol/server-filesystem - directory listing
  filesystem_large_dir: () => {
    const files = [];
    for (let i = 0; i < 2000; i++) {
      files.push({
        name: `file_${i.toString().padStart(4, "0")}.${["ts", "js", "json", "md", "tsx"][i % 5]}`,
        path: `/project/src/components/feature_${Math.floor(i / 50)}/file_${i}.ts`,
        size: Math.floor(Math.random() * 50000) + 1000,
        modified: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
        isDirectory: false
      });
    }
    return JSON.stringify({ type: "directory_listing", files }, null, 2);
  },

  // @modelcontextprotocol/server-filesystem - file content
  filesystem_large_file: () => {
    const lines = [];
    lines.push("/**");
    lines.push(" * Large TypeScript file with many functions");
    lines.push(" */");
    lines.push("");
    for (let i = 0; i < 500; i++) {
      lines.push(`export function processItem${i}(data: Record<string, unknown>): Result {`);
      lines.push(`  const validated = validateInput(data);`);
      lines.push(`  if (!validated.success) {`);
      lines.push(`    throw new Error(\`Validation failed for item ${i}: \${validated.error}\`);`);
      lines.push(`  }`);
      lines.push(`  return transformData(validated.data);`);
      lines.push(`}`);
      lines.push("");
    }
    return lines.join("\n");
  },

  // @modelcontextprotocol/server-github - PR with comments
  github_large_pr: () => {
    const comments = [];
    for (let i = 0; i < 200; i++) {
      comments.push({
        id: 1000000 + i,
        user: { login: `developer_${i % 10}`, avatar_url: `https://github.com/avatars/${i % 10}` },
        body: `This is comment ${i}. ${i % 5 === 0 ? "LGTM! 🚀" : "Please address the feedback on line " + (i * 10)}\n\nSome additional context about the change:\n- Point 1\n- Point 2\n- Point 3`,
        created_at: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - i * 30 * 60 * 1000).toISOString(),
        path: `src/file_${i % 50}.ts`,
        line: (i * 10) % 500
      });
    }
    return JSON.stringify({
      number: 1234,
      title: "feat: Add comprehensive feature implementation",
      body: "This PR implements the feature as described in issue #999.\n\n## Changes\n- Added new components\n- Updated tests\n- Fixed edge cases\n\n## Testing\n- [x] Unit tests\n- [x] Integration tests\n- [ ] E2E tests",
      state: "open",
      comments: comments.length,
      review_comments: comments
    }, null, 2);
  },

  // @modelcontextprotocol/server-github - repo file tree
  github_file_tree: () => {
    const tree = [];
    for (let i = 0; i < 1500; i++) {
      const depth = i % 5;
      const path = Array(depth + 1).fill(0).map((_, j) => `dir_${(i + j) % 20}`).join("/") + `/file_${i}.ts`;
      tree.push({
        path,
        mode: "100644",
        type: "blob",
        sha: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        size: Math.floor(Math.random() * 10000) + 500,
        url: `https://api.github.com/repos/owner/repo/git/blobs/${Math.random().toString(36).slice(2)}`
      });
    }
    return JSON.stringify({ sha: "abc123", tree, truncated: false }, null, 2);
  },

  // @modelcontextprotocol/server-fetch - web page content
  fetch_webpage: () => {
    const paragraphs = [];
    for (let i = 0; i < 100; i++) {
      paragraphs.push(`<p>This is paragraph ${i} of the article. It contains important information about the topic at hand. The content continues with more details and explanations that help readers understand the subject matter thoroughly.</p>`);
    }
    return `<!DOCTYPE html>
<html>
<head>
  <title>Comprehensive Technical Documentation</title>
  <meta charset="utf-8">
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; }
    .section { padding: 20px; margin: 10px 0; }
  </style>
</head>
<body>
  <header>
    <h1>Technical Documentation</h1>
    <nav>
      <a href="#intro">Introduction</a>
      <a href="#guide">Guide</a>
      <a href="#api">API Reference</a>
    </nav>
  </header>
  <main>
    <section id="intro">
      <h2>Introduction</h2>
      ${paragraphs.slice(0, 30).join("\n")}
    </section>
    <section id="guide">
      <h2>User Guide</h2>
      ${paragraphs.slice(30, 60).join("\n")}
    </section>
    <section id="api">
      <h2>API Reference</h2>
      ${paragraphs.slice(60).join("\n")}
    </section>
  </main>
  <footer>
    <p>Copyright 2024</p>
  </footer>
</body>
</html>`;
  },

  // Build/test output logs
  test_output_log: () => {
    const lines = [];
    lines.push("$ npm test");
    lines.push("");
    lines.push("> project@1.0.0 test");
    lines.push("> vitest run");
    lines.push("");
    for (let i = 0; i < 500; i++) {
      lines.push(` ✓ src/module_${Math.floor(i / 20)}/test_${i}.test.ts (${Math.floor(Math.random() * 500) + 50}ms)`);
      if (i % 73 === 0) {
        lines.push(` ✗ src/module_${Math.floor(i / 20)}/test_${i}_fail.test.ts`);
        lines.push(`   AssertionError: expected 'actual' to equal 'expected'`);
        lines.push(`     at Object.<anonymous> (src/module_${Math.floor(i / 20)}/test_${i}_fail.test.ts:42:10)`);
        lines.push(`     at processTicksAndRejections (node:internal/process/task_queues:95:5)`);
      }
    }
    lines.push("");
    lines.push(" Test Files  493 passed | 7 failed (500)");
    lines.push(" Tests       493 passed | 7 failed (500)");
    lines.push(" Duration    12.34s");
    return lines.join("\n");
  },
    const randomIdSegment = (bytes = 8) => randomBytes(bytes).toString("hex");

  // Database query results
  database_query_result: () => {
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        id: i + 1,
        uuid: `${randomIdSegment()}-${randomIdSegment()}`,
        name: `User ${i}`,
        email: `user${i}@example.com`,
        created_at: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: {
          lastLogin: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
          preferences: { theme: i % 2 === 0 ? "dark" : "light", language: ["en", "es", "fr", "de"][i % 4] },
          stats: { posts: Math.floor(Math.random() * 100), followers: Math.floor(Math.random() * 1000) }
        }
      });
    }
    return JSON.stringify({ rows, rowCount: rows.length, duration: "0.342s" }, null, 2);
  }
};

/**
 * Mock MCP server that returns predetermined payload
 */
function createMockServer(payload) {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const payload = ${JSON.stringify(payload)};

function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (Array.isArray(msg)) { msg.forEach(handle); return; }
  handle(msg);
});

function handle(msg) {
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "mock", version: "0.0.0" }, capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    write({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "get_data", description: "Get data", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: payload }] } });
  }
}
`;
}

/**
 * Run a single benchmark scenario
 */
async function runScenario(name, payload, maxBytes) {
  const serverCode = createMockServer(payload);
  
  // Write mock server to temp file to avoid command line length limits on Windows
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-bench-"));
  const tempFile = join(tempDir, "mock-server.mjs");
  writeFileSync(tempFile, serverCode, "utf8");

  return new Promise((resolve, reject) => {
    const proc = spawn("node", [
      CLI,
      "--max-bytes", String(maxBytes),
      "--log-level", "silent",
      "--store", "memory",
      "--",
      "node", tempFile
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    let result = null;

    const cleanup = () => {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
      try { unlinkSync(tempDir); } catch { /* ignore */ }
    };

    const timeout = setTimeout(() => {
      proc.kill();
      cleanup();
      reject(new Error(`Timeout for scenario: ${name}`));
    }, 30000);

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.result?.content?.[0]?.text) {
          result = msg.result.content[0].text;
        }
      } catch { /* ignore */ }
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      rl.close();
      cleanup();
      resolve(result);
    });

    // Send requests
    (async () => {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0.0.0" } } }) + "\n");
      await sleep(50);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_data", arguments: {} } }) + "\n");
      await sleep(200);
      proc.stdin.end();
    })();
  });
}

/**
 * Calculate retrieval overhead tokens
 */
function estimateRetrievalOverhead(artifactId) {
  // Typical retrieval request
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "proxy_artifact_get",
      arguments: { id: artifactId, mode: "grep", pattern: "error", maxLines: 100 }
    }
  });

  // Typical retrieval response (assume 2KB of matched lines)
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{
        type: "text",
        text: "Matched 15 lines:\n" + "ERROR: something went wrong at line X\n".repeat(15)
      }]
    }
  });

  return estimateTokens(request) + estimateTokens(response);
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const verbose = args.includes("--verbose");
  const maxBytes = 80000; // Default proxy threshold

  if (!jsonOutput) {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║           mcp-trunc-proxy Token Reduction Benchmark            ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log(`\nProxy threshold: ${formatBytes(maxBytes)}\n`);
  }

  const results = [];

  for (const [name, generator] of Object.entries(SCENARIOS)) {
    const payload = generator();
    const originalBytes = Buffer.byteLength(payload, "utf8");
    const originalTokens = estimateTokens(payload);
    const compressedBytes = gzipSync(Buffer.from(payload)).length;

    try {
      const truncatedResult = await runScenario(name, payload, maxBytes);
      const wasTruncated = truncatedResult?.includes("artifact=");
      const truncatedBytes = Buffer.byteLength(truncatedResult || "", "utf8");
      const truncatedTokens = estimateTokens(truncatedResult || "");

      // Extract artifact ID for overhead calculation
      let retrievalOverhead = 0;
      if (wasTruncated) {
        const match = truncatedResult.match(/artifact=(art_[A-Za-z0-9_-]+)/);
        if (match) {
          retrievalOverhead = estimateRetrievalOverhead(match[1]);
        }
      }

      const tokensSaved = originalTokens - truncatedTokens;
      const netSavings = tokensSaved - retrievalOverhead;
      const savingsPercent = ((tokensSaved / originalTokens) * 100).toFixed(1);
      const netSavingsPercent = ((netSavings / originalTokens) * 100).toFixed(1);

      const result = {
        scenario: name,
        originalBytes,
        originalTokens,
        compressedBytes,
        truncatedBytes,
        truncatedTokens,
        wasTruncated,
        tokensSaved,
        retrievalOverhead,
        netSavings,
        savingsPercent: parseFloat(savingsPercent),
        netSavingsPercent: parseFloat(netSavingsPercent)
      };
      results.push(result);

      if (!jsonOutput) {
        console.log(`━━━ ${name} ━━━`);
        console.log(`  Original:    ${formatBytes(originalBytes).padEnd(12)} (~${originalTokens.toLocaleString()} tokens)`);
        console.log(`  Compressed:  ${formatBytes(compressedBytes).padEnd(12)} (gzip)`);
        console.log(`  Truncated:   ${formatBytes(truncatedBytes).padEnd(12)} (~${truncatedTokens.toLocaleString()} tokens)`);
        console.log(`  Was truncated: ${wasTruncated ? "✅ Yes" : "⚪ No (under threshold)"}`);
        if (wasTruncated) {
          console.log(`  Tokens saved:  ${tokensSaved.toLocaleString()} (${savingsPercent}%)`);
          console.log(`  Retrieval overhead: ~${retrievalOverhead} tokens (for 1 grep call)`);
          console.log(`  Net savings:   ${netSavings.toLocaleString()} tokens (${netSavingsPercent}%)`);
        }
        console.log("");
      }
    } catch (err) {
      if (!jsonOutput) {
        console.log(`━━━ ${name} ━━━`);
        console.log(`  ❌ Error: ${err.message}`);
        console.log("");
      }
      results.push({ scenario: name, error: err.message });
    }
  }

  // Summary
  const successful = results.filter(r => !r.error && r.wasTruncated);
  if (successful.length > 0) {
    const totalOriginalTokens = successful.reduce((sum, r) => sum + r.originalTokens, 0);
    const totalTruncatedTokens = successful.reduce((sum, r) => sum + r.truncatedTokens, 0);
    const totalNetSavings = successful.reduce((sum, r) => sum + r.netSavings, 0);
    const avgSavings = (totalNetSavings / totalOriginalTokens * 100).toFixed(1);

    if (!jsonOutput) {
      console.log("════════════════════════════════════════════════════════════════");
      console.log("SUMMARY (truncated scenarios only)");
      console.log("────────────────────────────────────────────────────────────────");
      console.log(`  Scenarios tested:     ${successful.length}`);
      console.log(`  Total original tokens: ${totalOriginalTokens.toLocaleString()}`);
      console.log(`  Total after proxy:     ${totalTruncatedTokens.toLocaleString()}`);
      console.log(`  Average net savings:   ${avgSavings}%`);
      console.log("");
      console.log("💡 With 20 subagents carrying context forward, savings multiply!");
      console.log(`   Potential savings: ${(totalNetSavings * 20).toLocaleString()} tokens`);
      console.log("════════════════════════════════════════════════════════════════");
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ maxBytes, results }, null, 2));
  }
}

main().catch(console.error);
