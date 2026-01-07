/**
 * Demo client that speaks enough JSON-RPC to:
 *  - initialize
 *  - tools/list
 *  - tools/call huge_log
 *
 * Run:
 *   node examples/demo-client.mjs | node src/cli.mjs --max-bytes 20000 -- -- node examples/fake-mcp-server.mjs
 *
 * Or run the proxy first and pipe this client into it.
 */
import { setTimeout as sleep } from "node:timers/promises";

let id = 1;
function req(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) + "\n");
}

async function main() {
  req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo-client", version: "0.0.0" } });
  await sleep(50);
  req("tools/list", {});
  await sleep(50);
  req("tools/call", { name: "huge_log", arguments: { lines: 3000 } });
  await sleep(50);
  // now attempt to call the injected tool (proxy_artifact_get) if present in downstream
  // (you'll see it in tools/list output)
  // NOTE: you need to copy the artifact id from output and paste it here to test retrieval manually.
}

main();
