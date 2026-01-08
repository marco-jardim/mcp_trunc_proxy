# mcp-trunc-proxy

[![CI](https://github.com/marco-jardim/mcp-trunc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/marco-jardim/mcp-trunc-proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-trunc-proxy.svg)](https://www.npmjs.com/package/mcp-trunc-proxy)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A **generic MCP stdio proxy** that saves tokens by **offloading large `tools/call` results** to an artifact store and returning only a compact preview + a retrieval tool.

**98% token reduction** on large payloads. Works with any MCP server.

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Benchmark Results](#benchmark-results)
- [Quick Start](#quick-start)
- [Installation & Setup](#installation--setup)
  - [Claude Code (CLI)](#claude-code-cli)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [OpenCode](#opencode)
  - [Windsurf](#windsurf)
  - [Cline (VS Code)](#cline-vs-code)
  - [Continue (VS Code/JetBrains)](#continue-vs-codejetbrains)
  - [Zed](#zed)
  - [Custom MCP Client](#custom-mcp-client)
- [One-Click Setup Prompt](#one-click-setup-prompt)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Storage Backends](#storage-backends)
- [Tuning Guide](#tuning-guide)
- [Security](#security)
- [Reliability](#reliability)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## The Problem

MCP tools like `@modelcontextprotocol/server-filesystem`, `server-github`, and `server-fetch` can return massive payloads:

| MCP Server | Common Output | Typical Size |
|------------|---------------|--------------|
| **server-filesystem** | Directory listings, file contents | 50-500 KB |
| **server-github** | PR comments, file trees, issues | 30-200 KB |
| **server-fetch** | Web page content | 20-100 KB |
| **Database MCPs** | Query results | 50-500 KB |

When these outputs enter the conversation context, they get re-sent with **every subsequent message**. With 20 subagents carrying history forward, a single 200KB response costs tokens **20+ times**.

---

## The Solution

```
Without proxy:
  LLM ◄── 200KB response ── MCP Server
  LLM ◄── 200KB (again, in context) ── ...
  LLM ◄── 200KB (again) ── ...
  Total: 200KB × N messages = massive token burn

With mcp-trunc-proxy:
  LLM ◄── 3KB preview + artifact ID ── Proxy ◄── MCP Server
  LLM ── "get lines 100-150" ──► Proxy ──► 2KB slice
  Total: 3KB + targeted retrievals = 98% savings
```

The proxy:
1. Intercepts large tool responses (configurable threshold)
2. Stores full payload compressed (memory/file/Redis)
3. Returns a **smart preview** (errors detected + head/tail)
4. Injects a **retrieval tool** for targeted access (grep/range/tail)

---

## Benchmark Results

Tested against simulated payloads matching real MCP server outputs:

| Scenario | Original | After Proxy | Savings |
|----------|----------|-------------|---------|
| Filesystem: 2000 files directory | ~50,000 tokens | ~750 tokens | **98.5%** |
| GitHub: PR with 200 comments | ~35,000 tokens | ~750 tokens | **97.9%** |
| GitHub: 1500 files tree | ~30,000 tokens | ~750 tokens | **97.5%** |
| Web page: 100 paragraphs | ~12,000 tokens | ~750 tokens | **93.8%** |
| Test output: 500 test results | ~8,000 tokens | ~750 tokens | **90.6%** |
| Database: 1000 row query | ~45,000 tokens | ~750 tokens | **98.3%** |

**Average: 98.1% token reduction**

### Performance

| Store | PUT ops/sec | GET ops/sec | Latency |
|-------|-------------|-------------|---------|
| Memory | ~15,000 | ~30,000 | <1ms |
| File | ~1,500 | ~3,000 | 2-5ms |

Compression: ~50 MB/s compress, ~200 MB/s decompress (gzip)

---

## Quick Start

```bash
# Install globally
npm install -g mcp-trunc-proxy

# Wrap any MCP server
mcp-trunc-proxy -- npx -y @modelcontextprotocol/server-filesystem /path/to/repo

# Or use npx directly (no install)
npx mcp-trunc-proxy -- npx -y @modelcontextprotocol/server-github
```

---

## Installation & Setup

### Claude Code (CLI)

Claude Code uses `~/.claude/claude_desktop_config.json` (same as Claude Desktop).

**Location:**
- macOS/Linux: `~/.claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Step 1: Install the proxy**
```bash
npm install -g mcp-trunc-proxy
```

**Step 2: Edit your config to wrap existing MCPs**

Before:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

After (wrapped with proxy):
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"
      ]
    },
    "github": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

**Step 3: Restart Claude Code**

---

### Claude Desktop

Same configuration as Claude Code above.

**Config location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Example with multiple MCPs:**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/you/code"
      ]
    },
    "fetch": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "60000", "--",
        "npx", "-y", "@modelcontextprotocol/server-fetch"
      ]
    },
    "postgres": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "100000", "--store", "file:.mcp-artifacts", "--",
        "npx", "-y", "@modelcontextprotocol/server-postgres"
      ],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost/db"
      }
    }
  }
}
```

---

### Cursor

Cursor uses `.cursor/mcp.json` in your project root or `~/.cursor/mcp.json` globally.

**Step 1: Create or edit `.cursor/mcp.json`**
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "."
      ]
    }
  }
}
```

**Step 2: Restart Cursor or reload window**

---

### OpenCode

OpenCode uses `mcp.json` or `opencode.json` in your project root, or `~/.config/opencode/config.json` globally.

**Step 1: Edit your MCP config**
```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "80000", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "environment": {
        "GITHUB_TOKEN": "{env:GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "80000", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "fetch": {
      "type": "local",
      "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--", "npx", "-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
```

**Step 2: Restart OpenCode**

---

### Windsurf

Windsurf uses `~/.windsurf/config.json` or `.windsurf/mcp.json` in your project.

**Config example:**
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

---

### Cline (VS Code)

Cline stores MCP config in VS Code settings or `.vscode/cline_mcp_settings.json`.

**Step 1: Open VS Code settings (JSON)**

**Step 2: Add MCP servers:**
```json
{
  "cline.mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"
      ]
    }
  }
}
```

Or use `.vscode/cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

---

### Continue (VS Code/JetBrains)

Continue uses `~/.continue/config.json`.

**Step 1: Edit `~/.continue/config.json`**
```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": [
        "mcp-trunc-proxy", "--max-bytes", "80000", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"
      ]
    }
  ]
}
```

**Step 2: Reload Continue extension**

---

### Zed

Zed uses `~/.config/zed/settings.json`.

**Add to your settings:**
```json
{
  "language_models": {
    "mcp_servers": {
      "github": {
        "command": "npx",
        "args": [
          "mcp-trunc-proxy", "--max-bytes", "80000", "--",
          "npx", "-y", "@modelcontextprotocol/server-github"
        ],
        "env": {
          "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
        }
      }
    }
  }
}
```

---

### Custom MCP Client

If you're building a custom MCP client, wrap the server spawn:

```javascript
import { spawn } from "child_process";

// Instead of:
const server = spawn("npx", ["-y", "@modelcontextprotocol/server-github"]);

// Use:
const server = spawn("npx", [
  "mcp-trunc-proxy",
  "--max-bytes", "80000",
  "--",
  "npx", "-y", "@modelcontextprotocol/server-github"
]);
```

---

## One-Click Setup Prompt

**Copy and paste this prompt into your AI tool to automatically set up mcp-trunc-proxy with optimized settings for each MCP:**

````
I want you to wrap all my existing MCP servers with mcp-trunc-proxy to reduce token usage.

## What is mcp-trunc-proxy?
An npm package that intercepts large MCP tool outputs, stores them compressed, and returns a compact preview with a retrieval tool. Reduces token usage by ~98% for large responses.

## Your Task

1. **Find my MCP configuration file** (check in order, use first found):
   - Claude Desktop/Code: ~/.claude/claude_desktop_config.json or %APPDATA%\Claude\claude_desktop_config.json
   - Cursor: .cursor/mcp.json or ~/.cursor/mcp.json  
   - OpenCode: mcp.json or opencode.json or ~/.config/opencode/config.json
   - Cline: .vscode/cline_mcp_settings.json
   - Continue: ~/.continue/config.json
   - Zed: ~/.config/zed/settings.json
   - Windsurf: ~/.windsurf/config.json or .windsurf/mcp.json

2. **Read the config and analyze each MCP server**

3. **For each MCP, choose optimal --max-bytes based on this table:**

   | MCP Server Pattern | --max-bytes | Reason |
   |--------------------|-------------|--------|
   | server-filesystem, filesystem | 80000 | Directory listings can be huge |
   | server-github, github | 80000 | PR comments, issues, file trees |
   | server-gitlab, gitlab | 80000 | Similar to GitHub |
   | server-fetch, fetch, puppeteer, playwright | 60000 | Web pages vary, often moderate |
   | server-postgres, postgres, server-sqlite, sqlite, server-mysql, mysql, database, db, supabase, prisma | 120000 | Query results can be massive |
   | server-brave-search, search, tavily, exa | 50000 | Search results are moderate |
   | server-memory, memory, knowledge | 40000 | Usually smaller payloads |
   | server-slack, slack, discord | 60000 | Message history moderate |
   | server-notion, notion | 80000 | Page content can be large |
   | server-google-drive, gdrive, drive | 100000 | File listings and content |
   | server-aws, aws, s3 | 100000 | Listings can be large |
   | server-kubernetes, k8s | 80000 | Resource listings |
   | server-docker | 60000 | Container/image lists |
   | everything-else | 80000 | Safe default |

4. **Additional optimizations based on MCP type:**
   - Database MCPs: Add `--store file:.mcp-artifacts` for persistence (queries worth caching)
   - Filesystem MCPs with large repos: Consider `--max-bytes 100000`
   - Search MCPs: Can use lower `--max-bytes 40000` (results are summarized)

5. **Transform each MCP entry:**
   
   Before:
   ```json
   {
     "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-postgres"],
     "env": { "DATABASE_URL": "..." }
   }
   ```
   
   After (with optimized params):
   ```json
   {
     "command": "npx",
     "args": [
       "mcp-trunc-proxy",
       "--max-bytes", "120000",
       "--store", "file:.mcp-artifacts",
       "--",
       "npx", "-y", "@modelcontextprotocol/server-postgres"
     ],
     "env": { "DATABASE_URL": "..." }
   }
   ```

6. **Preserve all existing environment variables and arguments**

7. **Save the updated config file**

8. **Show me a summary table of what you configured:**
   | MCP Name | --max-bytes | --store | Reason |
   |----------|-------------|---------|--------|
   | ... | ... | ... | ... |

9. **Tell me to restart my application**

## Important Notes
- Do NOT install anything globally - npx handles it
- Do NOT modify MCPs that are already wrapped with mcp-trunc-proxy
- If unsure about an MCP type, use --max-bytes 80000 (safe default)
- For MCPs you don't recognize, try to infer from the name/package
````

---

## How It Works

### Normal Flow

```
Client ── tools/call ──► Proxy ──► MCP Server
Client ◄── response ──── Proxy ◄── MCP Server
```

### When Response Exceeds Threshold

```
Client ── tools/call ──────────────► Proxy ──► MCP Server
                                       │
                                       ▼
                              Store full payload (gzip)
                                       │
Client ◄── preview + artifact ID ◄─────┘
```

### Preview Format

When a tool returns a large result, the agent sees:

```
═══ RESULT OFFLOADED ═══
artifact=art_abc123  bytes=245760  lines=3847

══ Errors/Warnings (12 found) ══
line 847: ERROR: Connection refused
line 1203: FAIL: assertion failed
line 2341: Exception: NullPointerException
...

══ Head (first 60 lines) ══
Starting build process...
Compiling src/main.ts...
...

══ Tail (last 60 lines) ══
...
Build completed with 3 errors.
Total time: 45.2s

═══ RETRIEVAL ═══
Use proxy_artifact_get to fetch specific content:
  • grep:  {"id":"art_abc123", "mode":"grep", "pattern":"ERROR"}
  • range: {"id":"art_abc123", "mode":"range", "startLine":800, "endLine":900}
  • tail:  {"id":"art_abc123", "mode":"tail", "tailLines":100}
```

### Retrieval Tool

The proxy injects `proxy_artifact_get` into `tools/list`:

```json
// Grep for errors (substring or regex)
{"id": "art_abc123", "mode": "grep", "pattern": "ERROR", "maxLines": 200}
{"id": "art_abc123", "mode": "grep", "pattern": "/TypeError:.*/i"}

// Get specific line range
{"id": "art_abc123", "mode": "range", "startLine": 1200, "endLine": 1350}

// Get last N lines
{"id": "art_abc123", "mode": "tail", "tailLines": 200}

// Full content (use sparingly - defeats the purpose)
{"id": "art_abc123", "mode": "full"}
```

---

## Configuration

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-bytes` | `80000` | Offload threshold (bytes) |
| `--preview-max-chars` | `6000` | Max preview size |
| `--head-lines` | `60` | Head lines in preview |
| `--tail-lines` | `60` | Tail lines in preview |
| `--store` | `memory` | `memory`, `file:<dir>`, `redis:<url>` |
| `--ttl-seconds` | `604800` | Artifact TTL (7 days) |
| `--max-artifacts` | `2000` | Memory store cap |
| `--tool-name` | `proxy_artifact_get` | Retrieval tool name |
| `--info-tool-name` | `proxy_artifact_info` | Info tool name |
| `--no-info-tool` | | Disable info tool |
| `--log-level` | `info` | `silent`/`error`/`warn`/`info`/`debug` |
| `--redis-key-prefix` | `mcp-trunc-proxy` | Redis key prefix |
| `-h, --help` | | Show help |
| `-v, --version` | | Show version |

### Environment Variables

All flags have env var equivalents (CLI takes precedence):

```bash
MCP_TRUNC_PROXY_MAX_BYTES=60000
MCP_TRUNC_PROXY_STORE=file:.artifacts
MCP_TRUNC_PROXY_LOG_LEVEL=debug
```

---

## Storage Backends

### Memory (Default)

```bash
mcp-trunc-proxy --store memory -- ...
```

- **Fastest**: <1ms latency
- **Ephemeral**: Clears on exit
- **Best for**: Local dev, short sessions

### File

```bash
mcp-trunc-proxy --store file:.mcp-artifacts -- ...
```

- **Persistent**: Survives restarts
- **Moderate speed**: 2-5ms latency
- **Best for**: Long sessions, debugging

### Redis

```bash
npm install redis  # Optional dependency
mcp-trunc-proxy --store redis://localhost:6379 --ttl-seconds 86400 -- ...
```

- **Shared**: Multiple proxies/agents can access
- **TTL expiry**: Automatic cleanup
- **Best for**: Production, multi-agent workflows

---

## Tuning Guide

### Recommended Settings by MCP Type

| MCP Server | `--max-bytes` | Notes |
|------------|---------------|-------|
| server-filesystem | `80000` | Directory listings can be huge |
| server-github | `80000` | PR comments, file trees |
| server-fetch | `60000` | Web pages vary widely |
| server-postgres | `100000` | Query results can be massive |
| server-sqlite | `100000` | Same as postgres |
| server-puppeteer | `60000` | Screenshots are base64 |
| server-brave-search | `40000` | Search results are moderate |

### When to Adjust `--max-bytes`

| Symptom | Solution |
|---------|----------|
| Too many retrieval calls | Increase `--max-bytes` |
| Context still too large | Decrease `--max-bytes` |
| Missing important details in preview | Increase `--head-lines` / `--tail-lines` |
| Preview too verbose | Decrease `--preview-max-chars` |

### Recommended Starting Points

| Use Case | `--max-bytes` | Notes |
|----------|---------------|-------|
| Aggressive savings | `40000` | More truncation, more retrievals |
| Balanced (default) | `80000` | Good for most workflows |
| Conservative | `120000` | Less truncation, fewer retrievals |
| Large context models | `200000` | For Claude 3.5, GPT-4 Turbo |

---

## Security

Tool outputs can contain secrets (tokens, env vars, credentials).

- **Prefer memory store** unless persistence is required
- **File store**: Lock down directory permissions
- **Redis**: Use authentication, consider encryption
- **Logs**: Redis credentials are automatically masked

The proxy includes:
- Path traversal prevention in FileStore
- Base64 validation for artifact data
- Graceful handling of corrupt artifacts

---

## Reliability

- **Graceful shutdown**: SIGTERM/SIGINT triggers clean store cleanup
- **Redis reconnection**: Exponential backoff, up to 10 retries
- **Request timeouts**: Stale requests cleaned after 5 minutes
- **Error isolation**: Corrupt artifacts don't crash the proxy
- **Tool collision warning**: Alerts if downstream has conflicting tool names

---

## Development

### Run Tests

```bash
npm test              # Unit + functional tests (141 tests)
npm run test:e2e      # End-to-end tests
npm run test:all      # Everything
```

### Run Benchmarks

```bash
npm run benchmark           # All benchmarks
npm run benchmark:tokens    # Token reduction benchmark
npm run benchmark:perf      # Performance benchmark
```

### Demo

```bash
# Terminal 1: Proxy with fake MCP server
node src/cli.mjs --max-bytes 20000 -- node examples/fake-mcp-server.mjs

# Terminal 2: Send test requests
node examples/demo-client.mjs
```

---

## How It Compares

| Approach | Token Savings | Latency | Complexity |
|----------|---------------|---------|------------|
| No optimization | 0% | Lowest | None |
| Prompt truncation | 30-50% | Low | Medium |
| **mcp-trunc-proxy** | **90-98%** | Low | Low |
| Custom per-tool logic | 90-98% | Varies | High |

This proxy is a **drop-in solution** that works with any MCP server without modifications.

---

## Contributing

1. Fork the repo: https://github.com/marco-jardim/mcp-trunc-proxy
2. Create a feature branch
3. Run tests: `npm run test:all`
4. Submit a PR

---

## License

GPL-3.0-only. See [LICENSE](./LICENSE).

---

## Author

**Marco Jardim** - [GitHub](https://github.com/marco-jardim)

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.
