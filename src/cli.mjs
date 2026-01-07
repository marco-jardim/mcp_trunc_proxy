#!/usr/bin/env node
import { runProxy } from "./proxy.mjs";

// ISSUE-023 FIX: Helper for parsing numeric arguments with clear errors
function parseNumericArg(value, argName) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`--${argName} requires a numeric value, got: ${value}`);
  }
  return n;
}

function parseArgs(argv) {
  const args = {
    maxBytes: envInt("MCP_TRUNC_PROXY_MAX_BYTES", 80000),
    previewMaxChars: envInt("MCP_TRUNC_PROXY_PREVIEW_MAX_CHARS", 6000),
    headLines: envInt("MCP_TRUNC_PROXY_HEAD_LINES", 60),
    tailLines: envInt("MCP_TRUNC_PROXY_TAIL_LINES", 60),
    ttlSeconds: envInt("MCP_TRUNC_PROXY_TTL_SECONDS", 604800),
    maxArtifacts: envInt("MCP_TRUNC_PROXY_MAX_ARTIFACTS", 2000),
    store: process.env.MCP_TRUNC_PROXY_STORE || "memory",
    toolName: process.env.MCP_TRUNC_PROXY_TOOL_NAME || "proxy_artifact_get",
    infoToolName: process.env.MCP_TRUNC_PROXY_INFO_TOOL_NAME || "proxy_artifact_info",
    exposeInfoTool: (process.env.MCP_TRUNC_PROXY_EXPOSE_INFO_TOOL || "true") !== "false",
    redisKeyPrefix: process.env.MCP_TRUNC_PROXY_REDIS_KEY_PREFIX || "mcp-trunc-proxy",
    logLevel: process.env.MCP_TRUNC_PROXY_LOG_LEVEL || "info",
    childCommand: null,
  };

  const out = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      args.childCommand = argv.slice(i + 1);
      break;
    }
    if (a === "--help" || a === "-h") {
      args.help = true;
      i++;
      continue;
    }
    const [key, val] = a.startsWith("--") && a.includes("=") ? a.split("=", 2) : [a, null];
    const next = val ?? argv[i + 1];

    switch (key) {
      case "--max-bytes": args.maxBytes = parseNumericArg(next, "max-bytes"); i += val ? 1 : 2; break;
      case "--preview-max-chars": args.previewMaxChars = parseNumericArg(next, "preview-max-chars"); i += val ? 1 : 2; break;
      case "--head-lines": args.headLines = parseNumericArg(next, "head-lines"); i += val ? 1 : 2; break;
      case "--tail-lines": args.tailLines = parseNumericArg(next, "tail-lines"); i += val ? 1 : 2; break;
      case "--ttl-seconds": args.ttlSeconds = parseNumericArg(next, "ttl-seconds"); i += val ? 1 : 2; break;
      case "--max-artifacts": args.maxArtifacts = parseNumericArg(next, "max-artifacts"); i += val ? 1 : 2; break;
      case "--store": args.store = String(next); i += val ? 1 : 2; break;
      case "--tool-name": args.toolName = String(next); i += val ? 1 : 2; break;
      case "--info-tool-name": args.infoToolName = String(next); i += val ? 1 : 2; break;
      case "--no-info-tool": args.exposeInfoTool = false; i += 1; break;
      case "--log-level": args.logLevel = String(next); i += val ? 1 : 2; break;
      case "--redis-key-prefix": args.redisKeyPrefix = String(next); i += val ? 1 : 2; break;
      default:
        // Allow unknown flags before `--`? Treat as error so users notice typos.
        throw new Error(`Unknown argument: ${a}\nUse --help for usage.`);
    }
  }
  return args;
}

// ISSUE-032 FIX: Add warning for invalid env var values
function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    process.stderr.write(`[mcp-trunc-proxy] warn: invalid ${name}="${v}", using default ${fallback}\n`);
    return fallback;
  }
  return n;
}

function usage() {
  return `
mcp-trunc-proxy — Generic MCP stdio proxy with artifact offloading (memory default)

Usage:
  mcp-trunc-proxy [options] -- <downstream-mcp-server> [args...]

Example:
  mcp-trunc-proxy --max-bytes 80000 --store memory -- \\
    npx -y @modelcontextprotocol/server-filesystem /path/to/repo

Options:
  --max-bytes <n>           Offload tools/call results larger than n bytes (default 80000)
  --preview-max-chars <n>   Max chars in preview returned to LLM (default 6000)
  --head-lines <n>          Preview head lines (default 60)
  --tail-lines <n>          Preview tail lines (default 60)

  --store <spec>            memory (default) | file:<dir> | redis:<url>
  --ttl-seconds <n>         TTL seconds (default 604800; best-effort for memory/file)
  --max-artifacts <n>       In-memory cap (default 2000)
  --tool-name <name>        Retriever tool name (default proxy_artifact_get)
  --info-tool-name <name>   Info tool name (default proxy_artifact_info)
  --no-info-tool            Disable info tool injection
  --redis-key-prefix <p>    Redis key prefix (default mcp-trunc-proxy)
  --log-level <level>       silent|error|warn|info|debug (default info)
  -h, --help                Show this help

Environment variables (optional):
  MCP_TRUNC_PROXY_STORE, MCP_TRUNC_PROXY_MAX_BYTES, MCP_TRUNC_PROXY_TTL_SECONDS, MCP_TRUNC_PROXY_LOG_LEVEL, ...

`.trim() + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(String(e?.message ?? e) + "\n\n");
    process.stderr.write(usage());
    process.exit(2);
    return;
  }

  if (args.help || !args.childCommand?.length) {
    process.stderr.write(usage());
    process.exit(args.childCommand?.length ? 0 : 2);
    return;
  }

  // ISSUE-008 FIX: Validate numeric arguments - reject negative/zero values
  const numericValidations = [
    { name: "max-bytes", value: args.maxBytes, min: 1024 },
    { name: "preview-max-chars", value: args.previewMaxChars, min: 500 },
    { name: "head-lines", value: args.headLines, min: 1 },
    { name: "tail-lines", value: args.tailLines, min: 1 },
    { name: "ttl-seconds", value: args.ttlSeconds, min: 1 },
    { name: "max-artifacts", value: args.maxArtifacts, min: 1 },
  ];

  for (const { name, value, min } of numericValidations) {
    if (!Number.isFinite(value) || value < min) {
      process.stderr.write(`Error: --${name} must be a positive number (minimum ${min})\n\n`);
      process.stderr.write(usage());
      process.exit(2);
      return;
    }
  }

  await runProxy(args);
}

// ISSUE-038 FIX: Track store for cleanup on uncaught error
let activeStore = null;

export function setActiveStore(store) {
  activeStore = store;
}

main().catch(async (e) => {
  process.stderr.write(`[mcp-trunc-proxy] fatal: ${e?.stack ?? e}\n`);
  // Attempt cleanup if store was created
  if (activeStore) {
    try {
      await activeStore.close();
    } catch {
      // Ignore cleanup errors during fatal exit
    }
  }
  process.exit(1);
});
