/**
 * Minimal fake MCP server over stdio, for demo purposes only.
 * Supports:
 *  - initialize
 *  - tools/list
 *  - tools/call (name: "huge_log" and "small")
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function toolList() {
  return {
    tools: [
      {
        name: "small",
        description: "Return a small response",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
      {
        name: "huge_log",
        description: "Return a giant fake test log",
        inputSchema: { type: "object", properties: { lines: { type: "integer", default: 5000 } } },
      },
    ],
  };
}

function huge(lines = 5000) {
  const parts = [];
  parts.push("RUN  v1.0.0");
  for (let i = 1; i <= lines; i++) {
    parts.push(`test ${i} ... ok`);
    if (i % 97 === 0) parts.push(`ERROR at test ${i}: AssertionError: expected true to be false`);
  }
  parts.push("Done.");
  return parts.join("\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // batch
  if (Array.isArray(msg)) {
    for (const part of msg) handle(part);
    return;
  }
  handle(msg);
});

function handle(msg) {
  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fake-mcp-server", version: "0.0.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    write({ jsonrpc: "2.0", id: msg.id, result: toolList() });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "small") {
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "small ok" }] } });
      return;
    }
    if (name === "huge_log") {
      const n = Number(args.lines ?? 5000);
      const txt = huge(n);
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: txt }] } });
      return;
    }
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Tool not found" } });
    return;
  }
}
