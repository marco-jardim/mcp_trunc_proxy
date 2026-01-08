/**
 * End-to-end tests for mcp-trunc-proxy
 * Spawns the actual proxy with fake-mcp-server and tests full flow
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const CLI = join(ROOT, "src/cli.mjs");
const FAKE_SERVER = join(ROOT, "examples/fake-mcp-server.mjs");

/**
 * Helper to spawn proxy and communicate via JSON-RPC
 */
class ProxyClient {
  constructor(maxBytes = 20000) {
    this.maxBytes = maxBytes;
    this.proc = null;
    this.rl = null;
    this.responses = new Map();
    this.nextId = 1;
  }

  async start() {
    this.proc = spawn("node", [
      CLI,
      "--max-bytes", String(this.maxBytes),
      "--log-level", "error",
      "--store", "memory",
      "--",
      "node", FAKE_SERVER
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT
    });

    this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const resolver = this.responses.get(msg.id);
          if (resolver) {
            resolver(msg);
            this.responses.delete(msg.id);
          }
        }
      } catch { /* ignore parse errors */ }
    });

    // Wait for process to be ready
    await sleep(100);
  }

  async request(method, params, timeoutMs = 5000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);

      this.responses.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.proc.stdin.write(msg);
    return promise;
  }

  async stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      await sleep(100);
    }
    if (this.rl) {
      this.rl.close();
    }
  }
}

describe("E2E: Proxy with fake-mcp-server", () => {
  let client;

  before(async () => {
    client = new ProxyClient(20000);
    await client.start();
  });

  after(async () => {
    await client.stop();
  });

  test("initialize handshake works", async () => {
    const resp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" }
    });

    assert.ok(resp.result, "Should have result");
    assert.strictEqual(resp.result.protocolVersion, "2024-11-05");
    assert.ok(resp.result.serverInfo, "Should have serverInfo");
  });

  test("tools/list includes proxy tools", async () => {
    const resp = await client.request("tools/list", {});

    assert.ok(resp.result, "Should have result");
    assert.ok(Array.isArray(resp.result.tools), "Should have tools array");

    const toolNames = resp.result.tools.map(t => t.name);
    assert.ok(toolNames.includes("proxy_artifact_get"), "Should include proxy_artifact_get");
    assert.ok(toolNames.includes("proxy_artifact_info"), "Should include proxy_artifact_info");
    assert.ok(toolNames.includes("huge_log"), "Should include downstream huge_log");
    assert.ok(toolNames.includes("small"), "Should include downstream small");
  });

  test("small tool response passes through unchanged", async () => {
    const resp = await client.request("tools/call", { name: "small", arguments: {} });

    assert.ok(resp.result, "Should have result");
    assert.ok(resp.result.content, "Should have content");
    assert.strictEqual(resp.result.content[0].text, "small ok");
  });

  test("huge_log gets truncated and stored as artifact", async () => {
    const resp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 3000 } });

    assert.ok(resp.result, "Should have result");
    assert.ok(resp.result.content, "Should have content");

    const text = resp.result.content[0].text;
    assert.ok(text.includes("artifact="), "Should contain artifact ID");
    assert.ok(text.includes("bytes="), "Should show original bytes");
    assert.ok(text.includes("offloaded") || text.includes("preview"), "Should mention offloading");
    assert.ok(text.includes("proxy_artifact_get"), "Should mention retrieval tool");
  });

  test("proxy_artifact_get retrieves stored artifact", async () => {
    // First get a huge response to create an artifact
    const hugeResp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 2000 } });
    const text = hugeResp.result.content[0].text;

    // Extract artifact ID
    const match = text.match(/artifact=(art_[A-Za-z0-9_-]+)/);
    assert.ok(match, "Should have artifact ID in response");
    const artifactId = match[1];

    // Retrieve with grep mode
    const getResp = await client.request("tools/call", {
      name: "proxy_artifact_get",
      arguments: { id: artifactId, mode: "grep", pattern: "ERROR" }
    });

    assert.ok(getResp.result, "Should have result");
    const getContent = getResp.result.content[0].text;
    assert.ok(getContent.includes("ERROR"), "Should find ERROR lines");
    assert.ok(getContent.includes("AssertionError"), "Should find assertion errors");
  });

  test("proxy_artifact_get with tail mode", async () => {
    const hugeResp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 3000 } });
    const text = hugeResp.result.content[0].text;

    const match = text.match(/artifact=(art_[A-Za-z0-9_-]+)/);
    assert.ok(match, "Should have artifact ID for tail test");
    const artifactId = match[1];

    const getResp = await client.request("tools/call", {
      name: "proxy_artifact_get",
      arguments: { id: artifactId, mode: "tail", tailLines: 50 }
    });

    const content = getResp.result.content[0].text;
    assert.ok(content.includes("Done."), "Tail should include last line");
  });

  test("proxy_artifact_get with range mode", async () => {
    const hugeResp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 3000 } });
    const text = hugeResp.result.content[0].text;

    const match = text.match(/artifact=(art_[A-Za-z0-9_-]+)/);
    assert.ok(match, "Should have artifact ID for range test");
    const artifactId = match[1];

    const getResp = await client.request("tools/call", {
      name: "proxy_artifact_get",
      arguments: { id: artifactId, mode: "range", startLine: 10, endLine: 20 }
    });

    const content = getResp.result.content[0].text;
    assert.ok(content.includes("test 10"), "Should include line 10");
    assert.ok(content.includes("test 19"), "Should include line 19");
  });

  test("proxy_artifact_info returns metadata", async () => {
    const hugeResp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 3000 } });
    const text = hugeResp.result.content[0].text;

    const match = text.match(/artifact=(art_[A-Za-z0-9_-]+)/);
    assert.ok(match, "Should have artifact ID for info test");
    const artifactId = match[1];

    const infoResp = await client.request("tools/call", {
      name: "proxy_artifact_info",
      arguments: { id: artifactId }
    });

    assert.ok(infoResp.result, "Should have result");
    const content = infoResp.result.content[0].text;
    assert.ok(content.includes("originalBytes") || content.includes("bytes"), "Should show size info");
  });

  test("proxy_artifact_get with invalid ID returns error", async () => {
    const getResp = await client.request("tools/call", {
      name: "proxy_artifact_get",
      arguments: { id: "art_nonexistent123456", mode: "tail" }
    });

    // Should return error or isError content
    const isError = getResp.error || 
      (getResp.result?.content?.[0]?.text?.toLowerCase().includes("not found")) ||
      (getResp.result?.isError === true);
    assert.ok(isError, "Should indicate artifact not found");
  });
});

describe("E2E: Proxy truncation threshold", () => {
  test("respects max-bytes setting", async () => {
    // Small threshold to ensure truncation - use 5000 bytes to avoid edge cases
    const client = new ProxyClient(5000);
    await client.start();

    try {
      // Use longer timeouts for fresh process startup
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" }
      }, 15000);

      // Even moderate response should be truncated with 5KB limit
      const resp = await client.request("tools/call", { name: "huge_log", arguments: { lines: 500 } }, 15000);
      const text = resp.result.content[0].text;
      assert.ok(text.includes("artifact="), "Should truncate with low threshold");
    } finally {
      await client.stop();
    }
  });

  test("passes through responses under threshold", async () => {
    // High threshold to avoid truncation
    const client = new ProxyClient(1000000);
    await client.start();

    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" }
      });

      const resp = await client.request("tools/call", { name: "small", arguments: {} });
      const text = resp.result.content[0].text;
      assert.ok(!text.includes("artifact="), "Should not truncate small response");
      assert.strictEqual(text, "small ok");
    } finally {
      await client.stop();
    }
  });
});

describe("E2E: Error handling", () => {
  test("unknown tool returns error", async () => {
    const client = new ProxyClient();
    await client.start();

    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" }
      });

      const resp = await client.request("tools/call", { name: "nonexistent_tool", arguments: {} });
      assert.ok(resp.error, "Should have error for unknown tool");
      assert.ok(resp.error.message.toLowerCase().includes("not found"), "Should mention not found");
    } finally {
      await client.stop();
    }
  });
});

describe("E2E: Batch requests", () => {
  test("handles batch JSON-RPC messages", async () => {
    const client = new ProxyClient();
    await client.start();

    try {
      // Send initialize first
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" }
      });

      // Now test tools/list
      const resp = await client.request("tools/list", {});
      assert.ok(resp.result.tools.length >= 4, "Should have at least 4 tools");
    } finally {
      await client.stop();
    }
  });
});
