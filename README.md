# mcp-trunc-proxy

A **generic MCP stdio proxy** that saves tokens by **offloading large `tools/call` results** to an artifact store (**memory by default**) and returning only a compact preview + a retrieval tool (`proxy_artifact_get`).

This is for workflows where tool outputs are the token sink: test logs, build logs, large JSON blobs, long search results, stack traces, etc.

---

## What it does (in one minute)

**Normal MCP:**

```
client (LLM)  ── tools/call ──►  server
client (LLM)  ◄─ giant result ──  server   (giant result gets re-sent in context repeatedly)
```

**With `mcp-trunc-proxy`:**

```
client (LLM)  ── tools/call ──►  proxy ──► server
client (LLM)  ◄─ preview + id ──  proxy ◄── server
                         │
                         └── stores full payload (memory/file/redis)
```

Then, when the agent needs more detail, it calls the injected tool:

- `proxy_artifact_get({ id, mode:"grep" | "range" | "tail" ... })`

---

## Why this can drastically reduce token usage

If a single tool call returns 200KB of text and you spawn 20 subagents (each carrying history/tool outputs forward), you can accidentally “pay” for that output **many times**.

This proxy prevents those giant payloads from ever entering the conversation as raw text by replacing them with:

- an **artifact id** + metadata
- a **targeted preview** (errors/head/tail)
- a **retrieval tool** to fetch slices on demand

---

## Features

- ✅ Works with **any** downstream MCP server that speaks **stdio JSON-RPC**.
- ✅ Intercepts **`tools/call`** results above a size threshold.
- ✅ Stores full payload as **gzip-compressed JSON**:
  - **memory (default)**: fast, ephemeral
  - `file:<dir>`: persistent
  - `redis:<url>`: shared + TTL (optional dependency)
- ✅ Injects helper tools via `tools/list`:
  - `proxy_artifact_get` (always)
  - `proxy_artifact_info` (optional)
- ✅ Retrieval supports **head/tail/range/grep/regex** without pulling the entire artifact.
- ✅ Handles JSON-RPC **batch** messages (arrays).

---

## Install

### Option A: Use from a local repo

```bash
git clone <your repo url>
cd mcp-trunc-proxy
npm install
```

### Option B: Install as a CLI

```bash
npm install -g .
```

> Node 18+ required.

### Optional: Redis support

Redis storage is optional:

```bash
npm install redis
```

---

## Quick start

Wrap any MCP server by putting it **after `--`**:

```bash
mcp-trunc-proxy --max-bytes 80000 --   npx -y @modelcontextprotocol/server-filesystem /path/to/repo
```

---

## Configuration

### CLI flags

| Flag | Default | Description |
|---|---:|---|
| `--max-bytes` | `80000` | Offload any `tools/call` result whose JSON payload exceeds this size. |
| `--preview-max-chars` | `6000` | Maximum characters returned in the preview text. |
| `--head-lines` | `60` | Number of head lines included in preview (text). |
| `--tail-lines` | `60` | Number of tail lines included in preview (text). |
| `--store` | `memory` | `memory`, `file:<dir>`, `redis:<url>`. |
| `--ttl-seconds` | `604800` | TTL for artifacts where supported (Redis). Best-effort for memory/file. |
| `--max-artifacts` | `2000` | In-memory cap (oldest evicted best-effort). |
| `--tool-name` | `proxy_artifact_get` | Name of the injected retriever tool. |
| `--info-tool-name` | `proxy_artifact_info` | Name of optional metadata tool. |
| `--no-info-tool` |  | Disable the info tool. |
| `--log-level` | `info` | `silent`, `error`, `warn`, `info`, `debug`. |
| `--redis-key-prefix` | `mcp-trunc-proxy` | Prefix for Redis keys. |
| `-h, --help` | | Show help message. |
| `-v, --version` | | Show version number. |

### Environment variables

All flags can also be set as env vars (CLI wins):

- `MCP_TRUNC_PROXY_STORE`
- `MCP_TRUNC_PROXY_MAX_BYTES`
- `MCP_TRUNC_PROXY_TTL_SECONDS`
- `MCP_TRUNC_PROXY_LOG_LEVEL`
- etc.

---

## Using with OpenCode

OpenCode runs local MCP servers using a `"command": [...]` array. Replace the MCP server command with the proxy and pass the real server after `--`.

Example (wrap GitHub MCP):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "local",
      "enabled": true,
      "command": [
        "node",
        "/absolute/path/to/mcp-trunc-proxy/src/cli.mjs",
        "--max-bytes",
        "80000",
        "--store",
        "memory",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "environment": {
        "GITHUB_TOKEN": "{env:GITHUB_TOKEN}"
      }
    }
  }
}
```

> Tip: Wrap the noisiest MCPs first (filesystem, github, DB, anything that returns huge JSON).

---

## What the agent sees (and how to retrieve)

When a downstream tool returns a huge result, the proxy replaces it with a compact result that looks like:

- `artifact=art_...`
- `bytes=...`
- preview (errors/head/tail)
- instructions for retrieval

### Retrieval tool: `proxy_artifact_get`

Call styles:

**grep substring**
```json
{"id":"art_1234","mode":"grep","pattern":"error","maxLines":200}
```

**regex**
```json
{"id":"art_1234","mode":"grep","pattern":"/TypeError:.*/i"}
```

**tail**
```json
{"id":"art_1234","mode":"tail","tailLines":200}
```

**range**
```json
{"id":"art_1234","mode":"range","startLine":1200,"endLine":1350}
```

**JSON view (use sparingly)**
```json
{"id":"art_1234","mode":"json","maxBytes":150000}
```

---

## Storage modes

### Memory (default)

- Fast, ephemeral
- Clears when proxy exits
- Best for local dev / short sessions

### File

```bash
mcp-trunc-proxy --store file:.mcp-artifacts -- ...
```

- Persists across restarts
- No automatic garbage collection (delete the directory when done)

### Redis

```bash
mcp-trunc-proxy --store redis:redis://localhost:6379 --ttl-seconds 86400 -- ...
```

- Shared store across proxies/agents
- TTL-based expiry

---

## How it works (wire-level behavior)

1. The proxy reads **newline-delimited JSON** on stdin (from the MCP client).
2. It spawns the downstream MCP server and forwards messages unchanged *except*:
   - It remembers the `id` of outgoing requests so it can patch the matching response.
3. For `tools/list` responses:
   - It appends the proxy tools to the final page (when `nextCursor` is absent).
4. For `tools/call` responses:
   - It computes the size of `result` as JSON.
   - If above `--max-bytes`, it stores the full `result` payload as gzip JSON and returns a compact text preview instead.
5. For `tools/call` requests whose `params.name` is `proxy_artifact_get` / `proxy_artifact_info`:
   - It handles them locally (does not forward to downstream).

---

## Tuning recommendations

- Start with `--max-bytes 60000` to `120000`.
- If your model frequently needs more detail than the preview:
  - increase `--preview-max-chars`, `--head-lines`, `--tail-lines`
- If you’re seeing too many retrieval calls:
  - bump `--max-bytes` a bit (the “sweet spot” depends on your model and tool noise)

---

## Security notes

Tool outputs can contain secrets (tokens, env vars, internal URLs, payloads).

- Prefer **memory** store unless persistence is necessary.
- If you use file/redis, lock down access and consider your organization's data retention policies.
- Redis credentials in URLs are automatically masked in logs.
- FileStore sanitizes artifact IDs to prevent path traversal attacks.

---

## Reliability features

- **Graceful shutdown**: SIGTERM/SIGINT triggers clean shutdown with store cleanup.
- **Redis reconnection**: Automatic reconnection with exponential backoff (up to 10 retries).
- **Request timeouts**: Pending requests are cleaned up after 5 minutes.
- **Error handling**: Corrupt artifacts, decompression failures, and spawn errors are handled gracefully.
- **Tool name collision**: Warns if downstream server already has a tool with the same name.

---

## Demo

A tiny fake MCP server and demo client are included:

```bash
# Terminal A: run proxy wrapping fake server
node src/cli.mjs --max-bytes 20000 --store memory -- node examples/fake-mcp-server.mjs

# Terminal B: send demo requests into the proxy
node examples/demo-client.mjs
```

In the proxy output, locate the `artifact=art_...` id and then issue a `tools/call` for `proxy_artifact_get` using your MCP client.

---

## License

GPL-3.0-only. See [LICENSE](./LICENSE).
