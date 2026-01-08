import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { byteLengthUtf8, safeJsonParse, stableStringify } from "./util.mjs";
import { createStore } from "./store.mjs";
// ISSUE-040 FIX: Import from state.mjs to avoid circular dependency
import { setActiveStore } from "./state.mjs";

/**
 * Run the MCP truncation proxy.
 *
 * The proxy sits between an MCP client (stdin/stdout) and a downstream MCP server process (child).
 * It forwards all JSON-RPC messages, but:
 *  - augments tools/list to include proxy_artifact_get (+ proxy_artifact_info)
 *  - intercepts tools/call results above size threshold, stores them, and returns a compact preview
 *  - intercepts tools/call for the proxy tools and serves retrievals from the store
 */
export async function runProxy(config) {
  const log = makeLogger(config.logLevel);

  if (!config.childCommand?.length) {
    throw new Error("No downstream server command provided. Use: mcp-trunc-proxy [opts] -- <server> <args...>");
  }

  const store = await createStore({
    spec: config.store,
    ttlSeconds: config.ttlSeconds,
    maxArtifacts: config.maxArtifacts,
    keyPrefix: config.redisKeyPrefix,
    log,
  });

  // ISSUE-038 FIX: Register store for cleanup on uncaught errors
  setActiveStore(store);

  const child = spawn(config.childCommand[0], config.childCommand.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  // ISSUE-047 FIX: Handle child process spawn errors
  child.on("error", (err) => {
    log.error(`failed to start downstream server: ${err.message}`);
    process.exit(1);
  });

  // ISSUE-028 FIX: Standardize log message formats
  child.on("exit", (code, signal) => {
    log.info(`downstream exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
    // ISSUE-005 FIX: Clear pending map on child exit to prevent memory leak
    pending.clear();
    process.exitCode = code ?? 1;
  });

  child.stderr.on("data", (buf) => {
    // keep downstream logs on stderr so they don't break JSON-RPC
    process.stderr.write(buf);
  });

  // Track request ids -> method/name so we can patch responses.
  const pending = new Map();

  // ISSUE-018 FIX: Periodic timeout check for pending requests
  const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
  const timeoutInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, req] of pending) {
      if (now - req.at > REQUEST_TIMEOUT_MS) {
        log.warn(`request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        pending.delete(id);
      }
    }
  }, 60_000);
  timeoutInterval.unref?.();

  // --- Helpers -------------------------------------------------------------

  function mkArtifactId(payloadStr) {
    // deterministic-ish but unique: sha256(prefix+random) shortened
    const h = createHash("sha256");
    h.update(payloadStr);
    h.update(randomBytes(16));
    return `art_${h.digest("base64url").slice(0, 16)}`;
  }

  function makeInjectedTools() {
    const getTool = {
      name: config.toolName,
      description:
        "Fetch a targeted slice of an artifact that was offloaded by mcp-trunc-proxy. Use grep/range/tail to avoid pulling the entire artifact.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Artifact id (e.g., art_abcdef0123456789)" },
          mode: {
            type: "string",
            enum: ["auto", "head", "tail", "range", "grep", "full", "json"],
            default: "auto",
            description:
              "auto=head+tail for text; grep filters; range slices by line numbers; full/json returns large output (use cautiously).",
          },
          pattern: {
            type: "string",
            description:
              'For mode=grep: substring match (case-insensitive) or regex like "/TypeError:.*/i".',
          },
          startLine: { type: "integer", minimum: 1, description: "For mode=range: 1-based start line." },
          endLine: { type: "integer", minimum: 1, description: "For mode=range: 1-based end line." },
          headLines: { type: "integer", minimum: 1, default: 200, description: "For mode=head." },
          tailLines: { type: "integer", minimum: 1, default: 200, description: "For mode=tail." },
          maxLines: { type: "integer", minimum: 1, default: 400, description: "Hard cap on returned lines." },
          maxBytes: { type: "integer", minimum: 1024, default: 200000, description: "Hard cap on returned bytes." },
        },
        required: ["id"],
      },
    };

    const infoTool = {
      name: config.infoToolName,
      description: "Get metadata (size, timestamps, tool name) about an offloaded artifact.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    };

    const listTool = {
      name: config.listToolName,
      description: "List all artifacts currently stored in the proxy. Returns artifact IDs, tool names, sizes, and timestamps. Useful for debugging and inspecting stored data.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
            description: "Maximum number of artifacts to return (default: 20, max: 100).",
          },
        },
        required: [],
      },
    };

    return { getTool, infoTool, listTool };
  }

  function isFinalToolsListPage(result) {
    // MCP tools/list uses optional pagination cursor. If nextCursor is absent or falsy, assume final page.
    // Some servers may omit the field entirely.
    return !result || !result.nextCursor;
  }

  // ISSUE-037 FIX: Add warning for tool name collision
  function augmentToolsList(result) {
    if (!result || typeof result !== "object") return result;
    if (!Array.isArray(result.tools)) return result;
    if (!isFinalToolsListPage(result)) return result;

    const { getTool, infoTool, listTool } = makeInjectedTools();
    const names = new Set(result.tools.map((t) => t?.name).filter(Boolean));
    if (names.has(getTool.name)) {
      log.warn(`tool name collision: downstream already has "${getTool.name}", proxy tool not injected. Use --tool-name to change.`);
    } else {
      result.tools.push(getTool);
    }
    if (config.exposeInfoTool) {
      if (names.has(infoTool.name)) {
        log.warn(`tool name collision: downstream already has "${infoTool.name}", proxy info tool not injected. Use --info-tool-name to change.`);
      } else {
        result.tools.push(infoTool);
      }
    }
    if (config.exposeListTool) {
      if (names.has(listTool.name)) {
        log.warn(`tool name collision: downstream already has "${listTool.name}", proxy list tool not injected. Use --list-tool-name to change.`);
      } else {
        result.tools.push(listTool);
      }
    }
    return result;
  }

  // ISSUE-015 FIX: Extract magic number to named constant
  const EXTRACT_MAX_CHARS = 500;

  // ISSUE-043 FIX: Move RETRIEVAL_DEFAULTS to module level (inside runProxy scope)
  const RETRIEVAL_DEFAULTS = {
    MAX_LINES: 400,
    MAX_LINES_LIMIT: 5000,
    MAX_BYTES: 200000,
    MAX_BYTES_LIMIT: 2_000_000,
    HEAD_LINES: 200,
    TAIL_LINES: 200,
  };

  function extractTextLinesFromToolResult(toolResult) {
    // toolResult is expected to be a CallToolResult-like object with `content: [...]`.
    // We'll try to produce a line-oriented text for slicing/grepping.
    const content = toolResult?.content;
    if (Array.isArray(content)) {
      const texts = [];
      for (const item of content) {
        if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
        else if (item?.type === "resource" && typeof item?.resource?.uri === "string") {
          texts.push(`[resource] ${item.resource.uri}`);
        } else if (item?.type === "image") {
          texts.push("[image] (omitted)");
        } else if (typeof item === "object") {
          texts.push(`[content:${item.type ?? "unknown"}] ${stableStringify(item).slice(0, EXTRACT_MAX_CHARS)}`);
        } else {
          texts.push(String(item));
        }
      }
      const joined = texts.join("\n");
      return joined.split(/\r?\n/);
    }

    // Fallback: stringify entire result
    return stableStringify(toolResult).split(/\r?\n/);
  }

  function summarizeLines(lines) {
    const head = lines.slice(0, config.headLines);
    const tail = lines.slice(Math.max(0, lines.length - config.tailLines));

    // "error-ish" extraction
    // ISSUE-042 FIX: Increase error context to ±5 lines for better stack traces
    const ERROR_CONTEXT_LINES = 5;
    const errorish = /(error|fail|failed|exception|traceback|assert|panic|fatal)/i;
    const picked = [];
    for (let i = 0; i < lines.length; i++) {
      if (errorish.test(lines[i])) {
        for (let j = Math.max(0, i - ERROR_CONTEXT_LINES); j <= Math.min(lines.length - 1, i + ERROR_CONTEXT_LINES); j++) picked.push(j);
        if (picked.length > 120) break;
      }
    }
    const uniq = Array.from(new Set(picked)).sort((a, b) => a - b).slice(0, 120);
    const errors = uniq.map((i) => lines[i]);

    const parts = [];
    if (errors.length) {
      parts.push("### Error excerpts (best-effort)");
      parts.push(errors.join("\n"));
    }
    parts.push("### Head");
    parts.push(head.join("\n"));
    parts.push("### Tail");
    parts.push(tail.join("\n"));

    let preview = parts.join("\n");
    if (preview.length > config.previewMaxChars) {
      preview = preview.slice(0, config.previewMaxChars) + "\n…(preview truncated)…";
    }
    return preview;
  }

  function buildTruncatedToolResult({ artifactId, originalBytes, toolName, toolResult }) {
    const lines = extractTextLinesFromToolResult(toolResult);
    const preview = summarizeLines(lines);

    const msg =
      "⚠️ Large tool result offloaded by mcp-trunc-proxy\n" +
      `tool=${toolName ?? "?"} bytes=${originalBytes} artifact=${artifactId}\n` +
      `Fetch slices with ${config.toolName} (try grep first):\n` +
      `  ${config.toolName}({id:"${artifactId}", mode:"grep", pattern:"error"})\n` +
      `  ${config.toolName}({id:"${artifactId}", mode:"tail", tailLines:200})\n` +
      `  ${config.infoToolName}({id:"${artifactId}"})\n` +
      "--- preview ---\n" +
      preview;

    return {
      content: [{ type: "text", text: msg }],
      isError: !!toolResult?.isError,
    };
  }

  async function storeToolResultArtifact({ toolName, requestId, resultObj, originalBytes }) {
    const payload = {
      kind: "tools/call.result",
      toolName,
      requestId,
      storedAt: new Date().toISOString(),
      originalBytes,
      result: resultObj,
    };
    const payloadStr = stableStringify(payload);
    const artifactId = mkArtifactId(payloadStr);

    // ISSUE-019 FIX: Add try-catch around gzipSync with logging
    let gz;
    try {
      gz = gzipSync(Buffer.from(payloadStr, "utf8"));
    } catch (err) {
      log.error(`failed to compress artifact: ${err.message}`);
      throw err; // Let caller handle fallback
    }
    await store.put(artifactId, gz, {
      toolName,
      requestId,
      originalBytes,
      storedAt: payload.storedAt,
      bytesStored: gz.byteLength,
      kind: payload.kind,
    });

    return artifactId;
  }

  function makeJsonRpcResponse(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  function makeJsonRpcError(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    return { jsonrpc: "2.0", id, error: err };
  }

  async function handleProxyToolCall(req) {
    const id = req.id;
    const name = req?.params?.name;
    const args = req?.params?.arguments ?? {};

    if (name === config.toolName) {
      const artId = String(args.id ?? "");
      if (!artId) return makeJsonRpcError(id, -32602, "Missing required argument: id");

      const rec = await store.get(artId);
      if (!rec) {
        return makeJsonRpcResponse(id, { content: [{ type: "text", text: `artifact not found: ${artId}` }], isError: true });
      }

      // ISSUE-003 FIX: Wrap gunzipSync in try-catch to handle corrupt/truncated data
      let payloadStr;
      try {
        payloadStr = gunzipSync(rec.data).toString("utf8");
      } catch (decompressErr) {
        return makeJsonRpcResponse(id, {
          content: [{ type: "text", text: `Error decompressing artifact ${artId}: ${decompressErr.message}` }],
          isError: true
        });
      }
      let parsed = safeJsonParse(payloadStr);
      if (!parsed) {
        // fallback: treat as text
        parsed = { kind: "unknown", raw: payloadStr };
      }

      // ISSUE-043 FIX: RETRIEVAL_DEFAULTS now at module level
      const mode = String(args.mode ?? "auto");
      const maxLines = clampInt(args.maxLines ?? RETRIEVAL_DEFAULTS.MAX_LINES, 1, RETRIEVAL_DEFAULTS.MAX_LINES_LIMIT);
      const maxBytes = clampInt(args.maxBytes ?? RETRIEVAL_DEFAULTS.MAX_BYTES, 1024, RETRIEVAL_DEFAULTS.MAX_BYTES_LIMIT);

      // Prefer extracting content text if available; otherwise return JSON lines.
      let lines;
      if (parsed?.result) lines = extractTextLinesFromToolResult(parsed.result);
      else lines = stableStringify(parsed).split(/\r?\n/);

      let outLines = lines;

      if (mode === "range") {
        const start = clampInt(args.startLine ?? 1, 1, lines.length);
        const end = clampInt(args.endLine ?? start, start, lines.length);
        outLines = lines.slice(start - 1, end);
      } else if (mode === "head" || (mode === "auto" && lines.length > 300)) {
        const n = clampInt(args.headLines ?? RETRIEVAL_DEFAULTS.HEAD_LINES, 1, RETRIEVAL_DEFAULTS.MAX_LINES_LIMIT);
        outLines = lines.slice(0, n);
      } else if (mode === "tail") {
        const n = clampInt(args.tailLines ?? RETRIEVAL_DEFAULTS.TAIL_LINES, 1, RETRIEVAL_DEFAULTS.MAX_LINES_LIMIT);
        outLines = lines.slice(Math.max(0, lines.length - n));
      } else if (mode === "grep") {
        const pattern = String(args.pattern ?? "");
        if (!pattern) {
          return makeJsonRpcError(id, -32602, "Missing required argument: pattern for mode=grep");
        }
        const rx = parsePattern(pattern);
        // ISSUE-009 FIX: Check for regex parsing error
        if (rx?.error) {
          return makeJsonRpcResponse(id, { content: [{ type: "text", text: rx.error }], isError: true });
        }
        // ISSUE-031: parsePattern now always returns a RegExp for valid input
        outLines = lines.filter((l) => rx.test(l));
      } else if (mode === "json") {
        const jsonText = stableStringify(parsed.result ?? parsed);
        const clipped = clipBytes(jsonText, maxBytes);
        return makeJsonRpcResponse(id, { content: [{ type: "text", text: clipped }], isError: false });
      } else if (mode === "full") {
        // Return as much as allowed by maxBytes
        const text = outLines.join("\n");
        const clipped = clipBytes(text, maxBytes);
        return makeJsonRpcResponse(id, { content: [{ type: "text", text: clipped }], isError: false });
      } else {
        // auto mode: show head+tail summary if large, else show full (bounded)
        const text = outLines.join("\n");
        const clipped = clipBytes(text, maxBytes);
        outLines = clipped.split(/\r?\n/);
      }

      // Apply caps
      if (outLines.length > maxLines) outLines = outLines.slice(0, maxLines);
      const text = outLines.join("\n");
      const clipped = clipBytes(text, maxBytes);

      const header =
        `artifact=${artId}\n` +
        `meta: tool=${rec.meta?.toolName ?? "?"} storedAt=${rec.meta?.storedAt ?? "?"} originalBytes=${rec.meta?.originalBytes ?? "?"}\n` +
        "---\n";

      return makeJsonRpcResponse(id, { content: [{ type: "text", text: header + clipped }], isError: false });
    }

    if (config.exposeInfoTool && name === config.infoToolName) {
      const artId = String(args.id ?? "");
      if (!artId) return makeJsonRpcError(id, -32602, "Missing required argument: id");
      const info = await store.info(artId);
      if (!info) {
        return makeJsonRpcResponse(id, { content: [{ type: "text", text: `artifact not found: ${artId}` }], isError: true });
      }
      return makeJsonRpcResponse(id, { content: [{ type: "text", text: stableStringify(info) }], isError: false });
    }

    if (config.exposeListTool && name === config.listToolName) {
      const limit = clampInt(args.limit ?? 20, 1, 100);
      const artifacts = await store.list();
      const limited = artifacts.slice(0, limit);
      const summary = {
        total: artifacts.length,
        returned: limited.length,
        artifacts: limited,
      };
      return makeJsonRpcResponse(id, { content: [{ type: "text", text: stableStringify(summary) }], isError: false });
    }

    // Not ours
    return null;
  }

  // --- Wiring: client -> proxy -> server -------------------------------

  const rlClient = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rlClient.on("line", async (line) => {
    if (!line.trim()) return;
    const msg = safeJsonParse(line);
    if (!msg) {
      log.warn("failed to parse client line; passing through raw");
      child.stdin.write(line + "\n");
      return;
    }

    const { forward, immediateResponses } = await processClientMessage(msg);
    for (const resp of immediateResponses) writeToClient(resp);
    if (forward !== null) writeToServer(forward);
  });

  rlClient.on("close", () => {
    log.info("client stdin closed");
    child.stdin.end();
  });

  async function processClientMessage(msg) {
    const immediateResponses = [];

    // Batch array
    if (Array.isArray(msg)) {
      const forwardBatch = [];
      for (const part of msg) {
        const { forward, immediateResponses: resps } = await processClientMessage(part);
        immediateResponses.push(...resps);
        if (forward !== null) forwardBatch.push(forward);
      }
      return { forward: forwardBatch.length ? forwardBatch : null, immediateResponses };
    }

    // Notifications: no id
    if (msg && typeof msg === "object" && "method" in msg && !("id" in msg)) {
      return { forward: msg, immediateResponses };
    }

    // Requests
    if (msg && typeof msg === "object" && "method" in msg && "id" in msg) {
      const method = msg.method;
      if (method === "tools/call") {
        const toolName = msg?.params?.name;
        // If it's our injected tool, handle locally
        if (toolName === config.toolName || (config.exposeInfoTool && toolName === config.infoToolName) || (config.exposeListTool && toolName === config.listToolName)) {
          const resp = await handleProxyToolCall(msg);
          if (resp) immediateResponses.push(resp);
          return { forward: null, immediateResponses };
        }
        pending.set(msg.id, { method, toolName, at: Date.now() });
      } else if (method === "tools/list") {
        pending.set(msg.id, { method, at: Date.now() });
      } else {
        pending.set(msg.id, { method, at: Date.now() });
      }
      return { forward: msg, immediateResponses };
    }

    // Responses from client side shouldn't exist, but just forward.
    return { forward: msg, immediateResponses };
  }

  function writeToServer(obj) {
    const out = stableStringify(obj);
    child.stdin.write(out + "\n");
  }

  function writeToClient(obj) {
    const out = stableStringify(obj);
    process.stdout.write(out + "\n");
  }

  // --- Wiring: server -> proxy -> client -------------------------------

  const rlServer = createInterface({ input: child.stdout, crlfDelay: Infinity });

  rlServer.on("line", async (line) => {
    if (!line.trim()) return;
    const msg = safeJsonParse(line);
    if (!msg) {
      log.warn("failed to parse server line; passing through raw");
      process.stdout.write(line + "\n");
      return;
    }

    const patched = await processServerMessage(msg);
    if (patched !== null) writeToClient(patched);
  });

  async function processServerMessage(msg) {
    // Batch response
    if (Array.isArray(msg)) {
      const out = [];
      for (const part of msg) {
        const patched = await processServerMessage(part);
        if (patched !== null) out.push(patched);
      }
      return out;
    }

    // We only patch JSON-RPC responses with matching ids.
    if (msg && typeof msg === "object" && "id" in msg && ("result" in msg || "error" in msg)) {
      const req = pending.get(msg.id);
      if (req) pending.delete(msg.id);

      if (req?.method === "tools/list" && msg.result) {
        msg.result = augmentToolsList(msg.result);
        return msg;
      }

      if (req?.method === "tools/call" && msg.result) {
        // Decide if we should offload.
        const bytes = byteLengthUtf8(stableStringify(msg.result));
        if (bytes > config.maxBytes) {
          try {
            const artifactId = await storeToolResultArtifact({
              toolName: req.toolName,
              requestId: msg.id,
              resultObj: msg.result,
              originalBytes: bytes,
            });
            msg.result = buildTruncatedToolResult({
              artifactId,
              originalBytes: bytes,
              toolName: req.toolName,
              toolResult: msg.result,
            });
          } catch (e) {
            log.error(`store artifact failed: ${e?.message ?? e}`);
            // Fallback: truncate content without storing
            msg.result = buildTruncatedToolResult({
              artifactId: "STORE_FAILED",
              originalBytes: bytes,
              toolName: req.toolName,
              toolResult: msg.result,
            });
          }
        }
        return msg;
      }
    }

    // Notifications / other messages: pass through unchanged.
    return msg;
  }

  // ISSUE-004 FIX: Graceful shutdown handlers
  // ISSUE-020 FIX: Add timeout to prevent hanging forever
  const shutdown = async (signal) => {
    log.info(`received ${signal}: shutting down`);
    child.kill("SIGTERM");
    clearInterval(timeoutInterval);

    // Force exit after 5 seconds if store.close() hangs
    const forceExit = setTimeout(() => {
      log.warn("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceExit.unref?.();

    try {
      await store.close();
    } catch (err) {
      log.error(`error closing store: ${err.message}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Friendly boot log
  log.info(
    `mcp-trunc-proxy started: maxBytes=${config.maxBytes} store=${config.store} tool=${config.toolName}` +
      (config.exposeInfoTool ? ` infoTool=${config.infoToolName}` : ""),
  );
}

// --- Utils ---------------------------------------------------------------

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// ISSUE-009 FIX: Return error object for invalid regex patterns
// ISSUE-031 FIX: Handle plain strings as escaped case-insensitive regex
function parsePattern(pattern) {
  // Accept /re/flags style regex
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
  // Plain string: escape special chars and create case-insensitive regex
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

function clipBytes(s, maxBytes) {
  const b = Buffer.from(String(s), "utf8");
  if (b.byteLength <= maxBytes) return String(s);
  const sliced = b.subarray(0, maxBytes);
  return sliced.toString("utf8") + "\n…(clipped)…";
}

function makeLogger(level) {
  const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  // ISSUE-045 FIX: Add log level validation warning
  if (level && !(level in levels)) {
    process.stderr.write(`[mcp-trunc-proxy] warn: invalid log level "${level}", using "info"\n`);
  }
  const cur = levels[level] ?? 3;

  const fmt = (kind, msg) => `[mcp-trunc-proxy] ${kind}: ${msg}\n`;
  return {
    error: (m) => cur >= 1 && process.stderr.write(fmt("error", m)),
    warn: (m) => cur >= 2 && process.stderr.write(fmt("warn", m)),
    info: (m) => cur >= 3 && process.stderr.write(fmt("info", m)),
    debug: (m) => cur >= 4 && process.stderr.write(fmt("debug", m)),
  };
}
