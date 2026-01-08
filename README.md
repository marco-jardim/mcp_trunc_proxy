# mcp-trunc-proxy

[![CI](https://github.com/marco-jardim/mcp_trunc_proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/marco-jardim/mcp_trunc_proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-trunc-proxy.svg)](https://www.npmjs.com/package/mcp-trunc-proxy)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Token Savings](https://img.shields.io/badge/tokens%20saved-98%25-ff69b4.svg)](https://github.com/marco-jardim/mcp_trunc_proxy#benchmark-results)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/marco-jardim/mcp_trunc_proxy/pulls)
[![Made with Mate](https://img.shields.io/badge/made%20with-🧉-green.svg)](https://github.com/marco-jardim)
[![Works on My Machine](https://img.shields.io/badge/works%20on-my%20machine-success.svg)](https://github.com/marco-jardim/mcp_trunc_proxy)
[![Powered by Gzip](https://img.shields.io/badge/powered%20by-gzip-orange.svg)](https://en.wikipedia.org/wiki/Gzip)

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
- [Troubleshooting](#troubleshooting)
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

### Phase 0: Prerequisites

1. **Check if mcp-trunc-proxy is installed globally:**
   ```bash
   npm list -g mcp-trunc-proxy
   ```

2. **If NOT installed, install it globally** (faster startup, no npx overhead):
   ```bash
   npm install -g mcp-trunc-proxy
   ```
   
3. **Verify installation:**
   ```bash
   mcp-trunc-proxy --version
   # Should output version number like "1.x.x"
   ```

4. **If global install fails** (permissions, corporate proxy, etc.), fall back to npx:
   - The prompt will still work with `npx mcp-trunc-proxy`
   - Just slightly slower startup per MCP

### Phase 1: Discovery

5. **Find my MCP configuration file** (check in order, use first found):
   - Claude Desktop/Code: ~/.claude/claude_desktop_config.json or %APPDATA%\Claude\claude_desktop_config.json
   - Cursor: .cursor/mcp.json or ~/.cursor/mcp.json  
   - OpenCode: mcp.json or opencode.json or ~/.config/opencode/config.json or ~/.config/opencode/opencode.json
   - Cline: .vscode/cline_mcp_settings.json
   - Continue: ~/.continue/config.json
   - Zed: ~/.config/zed/settings.json
   - Windsurf: ~/.windsurf/config.json or .windsurf/mcp.json

6. **Read the config and analyze each MCP server**

7. **Detect my operating system** (Windows requires special handling)

### Phase 2: Configuration

8. **For each MCP, choose optimal --max-bytes based on this table:**

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

9. **Additional optimizations based on MCP type:**
   - Database MCPs: Add `--store file:.mcp-artifacts` for persistence (queries worth caching)
   - Filesystem MCPs with large repos: Consider `--max-bytes 100000`
   - Search MCPs: Can use lower `--max-bytes 40000` (results are summarized)

10. **Transform each MCP entry:**
   
    If mcp-trunc-proxy is installed globally, use direct command (preferred):
    ```json
    {
      "command": "mcp-trunc-proxy",
      "args": [
        "--max-bytes", "120000",
        "--store", "file:.mcp-artifacts",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-postgres"
      ],
      "env": { "DATABASE_URL": "..." }
    }
    ```
    
    If using npx (fallback):
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

11. **Preserve all existing environment variables and arguments**

12. **Save the updated config file**

### Phase 3: Verification (MANDATORY - DO NOT SKIP)

13. **Dry-run test EVERY enabled MCP** before telling me to restart:

    ```bash
    # For each MCP, run with timeout (10-15 seconds)
    # Use mcp-trunc-proxy directly if installed globally:
    timeout 10 mcp-trunc-proxy --max-bytes <N> -- <downstream-command> 2>&1
    
    # Or with npx:
    timeout 10 npx mcp-trunc-proxy --max-bytes <N> -- <downstream-command> 2>&1
    
    # Success: Shows "Proxy started..." or waits silently for input
    # Failure: Shows error (spawn ENOENT, spawn EINVAL, ETIMEDOUT, etc.)
    ```

14. **If a test fails, diagnose and fix:**

    | Error | Cause | Fix |
    |-------|-------|-----|
    | `spawn ENOENT` | Command not found | Use absolute path or check package installed |
    | `spawn EINVAL` | Windows .cmd script issue | Use `node` + JS entry point (see below) |
    | `ETIMEDOUT` | npx download too slow | Pre-install globally: `npm install -g <pkg>` |
    | `Cannot find module` | Package not installed | `npm install -g <package>` |

15. **Windows .cmd fix pattern:**
    
    When a command like `playwriter` or `serverless` fails with `spawn EINVAL` on Windows:
    
    ```bash
    # Step 1: Find entry point
    npm root -g  # Get global node_modules path
    # Then check: <npm-root>/<package>/package.json for "bin" field
    
    # Step 2: Convert command to node + entry point
    # Before: ["playwriter"]
    # After:  ["node", "C:\\path\\to\\node_modules\\playwriter\\bin.js"]
    ```

16. **Re-test after each fix** until the MCP passes

17. **Present final verification table:**

    ```
    ## MCP Proxy Verification Results
    
    | MCP Name | Status | Command | Issue | Fix Applied |
    |----------|--------|---------|-------|-------------|
    | github | ✅ PASS | npx ... server-github | - | - |
    | filesystem | ✅ PASS | npx ... server-filesystem | - | - |
    | playwriter | ✅ PASS | node .../bin.js | spawn EINVAL | node + entry point |
    | morph-mcp | ✅ PASS | node .../dist/index.js | wrong binary name + EINVAL | fixed name + node |
    | serverless | ✅ PASS | node .../run.js mcp | spawn EINVAL | node + entry point |
    
    ### Summary
    - Total MCPs: 5
    - Passed: 5
    - Fixed: 3
    - Still Failing: 0
    ```

18. **Only after ALL MCPs pass**, tell me to restart my application

### Phase 4: Completion

19. **Show configuration summary:**
    | MCP Name | --max-bytes | --store | Notes |
    |----------|-------------|---------|-------|
    | ... | ... | ... | ... |

20. **Tell me to restart** (only after Phase 3 passes completely)

## Important Rules

- ALWAYS check/install mcp-trunc-proxy globally first (faster, more reliable)
- Do NOT modify MCPs already wrapped with mcp-trunc-proxy
- Do NOT skip the verification phase
- Do NOT report success until ALL MCPs pass dry-run tests
- If an MCP keeps failing after 3 fix attempts, ask me if I want to disable it
- If unsure about an MCP type, use --max-bytes 80000 (safe default)

## Platform-Specific Notes

### Windows
- `.cmd` and `.bat` scripts WILL fail with `spawn EINVAL` when spawned through the proxy
- ALWAYS convert to `node` + JavaScript entry point for Node.js packages
- Use `\\` for path separators in JSON, or `/` which Node.js accepts
- PATH inheritance is unreliable - prefer absolute paths

### macOS/Linux  
- Most commands work directly
- If using nvm/volta, ensure the shell has the right Node version
- uvx/pipx commands usually work fine

### Common Package Entry Points

| Package | Entry Point |
|---------|-------------|
| playwriter | `<npm-root>/playwriter/bin.js` |
| @morphllm/morphmcp | `<npm-root>/@morphllm/morphmcp/dist/index.js` |
| serverless | `<npm-root>/serverless/run.js` (+ `mcp` arg) |
| @anthropic/mcp-server-puppeteer | `<npm-root>/@anthropic/mcp-server-puppeteer/dist/index.js` |
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

## Troubleshooting

### MCP Servers Fail to Connect After Adding Proxy

If you see errors like `Connection closed (-32000)` or `Operation timed out` after wrapping MCPs with the proxy, the issue is usually **not the proxy itself** but slow-starting downstream servers.

#### Common Errors and Causes

| Error | Likely Cause | Solution |
|-------|--------------|----------|
| `MCP error -32000: Connection closed` | Downstream server crashed or `npx -y` download too slow | Pre-install package globally |
| `Operation timed out after 30000ms` | Server initialization exceeds client timeout | Pre-install or increase client timeout |
| `ENOENT` or `command not found` | Package not installed, wrong path | Verify command works standalone |

#### Root Cause: `npx -y package@latest`

Using `npx -y package@latest` inside the proxy command causes **double startup delay**:
1. The proxy starts (fast)
2. The proxy spawns `npx -y package@latest` which **downloads the package every time**

Many MCP clients (Claude Desktop, OpenCode, Cursor) have a 30-second connection timeout. If download + startup exceeds this, the connection fails.

#### Solution: Pre-install Slow Packages Globally

```bash
# Install problematic packages globally
npm install -g playwriter @morphllm/morphmcp @anthropic/mcp-server-puppeteer

# Then update config to use the global command directly
```

**Before (slow - downloads every time):**
```json
{
  "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
              "npx", "-y", "playwriter@latest"]
}
```

**After (fast - uses pre-installed package):**
```json
{
  "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
              "playwriter"]
}
```

#### Solution: Test Without Proxy First

To confirm the proxy isn't the issue, temporarily remove it:

```json
// Test: Does the MCP work WITHOUT the proxy?
{ "command": ["npx", "-y", "playwriter@latest"] }

// If this also times out, the issue is npx download time, not the proxy
```

#### Servers Known to Be Slow

| Package | Issue | Recommendation |
|---------|-------|----------------|
| `playwriter` | Large dependency tree | `npm install -g playwriter` |
| `@morphllm/morphmcp` | Heavy initialization | `npm install -g @morphllm/morphmcp` |
| `serverless mcp` | AWS SDK initialization | Increase timeout or disable if unused |
| `@anthropic/mcp-server-puppeteer` | Downloads Chromium | Pre-install globally |

#### Client-Side Timeout (Not Proxy's Fault)

Some MCP servers are genuinely slow to initialize (e.g., `serverless mcp` loads AWS SDK). The 30-second timeout is enforced by the **MCP client** (Claude Desktop, OpenCode, etc.), not by mcp-trunc-proxy.

Options:
1. **Pre-install globally** to eliminate download time
2. **Check if client supports timeout config** (most don't expose this)
3. **Disable** servers you don't frequently use
4. **File an issue** with your MCP client to support configurable timeouts

#### Verifying the Fix

After making changes:
1. Restart your MCP client completely
2. Check the MCP status panel
3. If still failing, run the command manually in terminal to see actual errors:

```bash
# Test the full command manually
npx mcp-trunc-proxy --max-bytes 60000 -- playwriter
# Should output: "Proxy started, waiting for JSON-RPC..."
```

### Windows-Specific Issues

Windows has unique challenges when spawning processes through the proxy.

#### `spawn EINVAL` or `spawn ENOENT` on Windows

**Symptom:** MCPs fail with `spawn EINVAL` or `spawn ENOENT` even though the command works in terminal.

**Root Cause:** Node.js `spawn()` on Windows cannot directly execute `.cmd`/`.bat` scripts when invoked through the proxy's subprocess. The proxy spawns child processes without a shell wrapper.

**Solution:** Use `node` + the package's JavaScript entry point directly instead of the `.cmd` wrapper.

**Step 1: Find the package's entry point**
```powershell
# Find where the package is installed
npm root -g
# Example output: C:\Users\YourName\scoop\persist\nodejs\bin\node_modules

# Check the package.json for "bin" entry
cat <npm-root>\<package>\package.json | Select-String '"bin"' -Context 0,3
```

**Step 2: Update your config to use node + entry point**

| Package | Entry Point Path |
|---------|------------------|
| `playwriter` | `node_modules/playwriter/bin.js` |
| `@morphllm/morphmcp` | `node_modules/@morphllm/morphmcp/dist/index.js` |
| `serverless` | `node_modules/serverless/run.js` |

**Before (fails on Windows):**
```json
{
  "command": ["npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--", "playwriter"]
}
```

**After (works on Windows):**
```json
{
  "command": [
    "npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
    "node", "C:\\Users\\YourName\\scoop\\persist\\nodejs\\bin\\node_modules\\playwriter\\bin.js"
  ]
}
```

#### PATH Not Inherited on Windows

**Symptom:** Commands work in terminal but fail when spawned by the proxy.

**Root Cause:** Package managers like Scoop, NVM, or Volta modify PATH in shell profiles, but the proxy's subprocess may not inherit the full PATH.

**Solution:** Use absolute paths to executables:

```json
{
  "command": [
    "npx", "mcp-trunc-proxy", "--max-bytes", "60000", "--",
    "node", "C:\\absolute\\path\\to\\package\\entry.js"
  ]
}
```

#### Finding Entry Points for Common Packages

```powershell
# Generic method to find any package's entry point
npm root -g  # Get global node_modules path

# Then check the package's package.json for "bin" or "main"
cat "<npm-root>/<package>/package.json"

# Look for:
#   "bin": { "command-name": "./path/to/entry.js" }
# or
#   "main": "./dist/index.js"
```

#### Windows Quick Reference

| Issue | Error | Fix |
|-------|-------|-----|
| `.cmd` scripts fail | `spawn EINVAL` | Use `node` + entry point path |
| Command not found | `spawn ENOENT` | Use absolute path |
| PATH not inherited | `ENOENT` for installed package | Use absolute path to executable |
| uvx/pipx commands | `spawn ENOENT` | Use `python -m <module>` instead |

---

## Debugging & Inspection

The proxy provides several tools and methods to inspect stored artifacts and debug behavior.

### Inspection Tools

The proxy injects three tools (all enabled by default):

| Tool | Purpose | Disable Flag |
|------|---------|--------------|
| `proxy_artifact_get` | Retrieve artifact content (grep/range/tail) | N/A (core tool) |
| `proxy_artifact_info` | Get metadata for a single artifact | `--no-info-tool` |
| `proxy_artifact_list` | List all stored artifacts | `--no-list-tool` |

### List All Artifacts

Use `proxy_artifact_list` to see what's currently stored:

```json
// List artifacts (default: 20, max: 100)
{"tool": "proxy_artifact_list", "arguments": {}}
{"tool": "proxy_artifact_list", "arguments": {"limit": 50}}
```

**Response:**
```json
{
  "total": 3,
  "returned": 3,
  "artifacts": [
    {
      "id": "art_abc123",
      "toolName": "filesystem",
      "originalBytes": 245760,
      "bytesStored": 12345,
      "createdAt": "2025-01-08T12:34:56.789Z",
      "expiresAt": "2025-01-15T12:34:56.789Z"
    },
    ...
  ]
}
```

### Get Artifact Metadata

Use `proxy_artifact_info` to inspect a specific artifact:

```json
{"tool": "proxy_artifact_info", "arguments": {"id": "art_abc123"}}
```

**Response:**
```json
{
  "id": "art_abc123",
  "store": "memory",
  "meta": {
    "toolName": "filesystem",
    "requestId": 42,
    "originalBytes": 245760,
    "storedAt": "2025-01-08T12:34:56.789Z",
    "bytesStored": 12345,
    "kind": "tools/call.result"
  },
  "createdAt": "2025-01-08T12:34:56.789Z",
  "lastAccess": "2025-01-08T12:35:10.123Z",
  "expiresAt": "2025-01-15T12:34:56.789Z",
  "bytesStored": 12345
}
```

### Debug Logging

Enable verbose logging to see all artifact operations:

```bash
mcp-trunc-proxy --log-level debug --max-bytes 60000 -- <your-mcp-server>
```

**Log levels:**
- `silent` - No output
- `error` - Only errors
- `warn` - Errors + warnings
- `info` - Default, includes startup messages
- `debug` - Verbose, shows all operations

**Example debug output:**
```
[mcp-trunc-proxy] info: mcp-trunc-proxy started: maxBytes=60000 store=memory tool=proxy_artifact_get infoTool=proxy_artifact_info
[mcp-trunc-proxy] debug: storing artifact art_abc123 (245760 bytes -> 12345 compressed)
[mcp-trunc-proxy] debug: retrieved artifact art_abc123 (mode=grep, pattern=error)
```

### File Store Inspection

For easier debugging, use file-based storage to inspect artifacts directly:

```bash
mcp-trunc-proxy --store file:.mcp-artifacts --max-bytes 60000 -- <server>
```

Then browse the artifacts directory:

```bash
# List stored artifacts
ls .mcp-artifacts/

# Inspect a specific artifact (files are gzipped JSON)
zcat .mcp-artifacts/art_abc123.json.gz | jq .

# Or on Windows with PowerShell
$content = [System.IO.File]::ReadAllBytes(".mcp-artifacts\art_abc123.json")
$stream = New-Object System.IO.MemoryStream(,$content)
$gzip = New-Object System.IO.Compression.GzipStream($stream, [System.IO.Compression.CompressionMode]::Decompress)
$reader = New-Object System.IO.StreamReader($gzip)
$reader.ReadToEnd() | ConvertFrom-Json
```

### Quick Debugging Checklist

| Symptom | Debug Method |
|---------|--------------|
| "Which artifacts are stored?" | Call `proxy_artifact_list` |
| "What's in artifact X?" | Call `proxy_artifact_get` with `mode: "head"` or `mode: "grep"` |
| "When was artifact X created?" | Call `proxy_artifact_info` |
| "Is the proxy working?" | Run with `--log-level debug` |
| "Need to inspect raw data?" | Use `--store file:<dir>` and browse files |

### Environment Variables for Debugging

```bash
# Enable debug logging via env var
MCP_TRUNC_PROXY_LOG_LEVEL=debug

# Use file store for inspection
MCP_TRUNC_PROXY_STORE=file:.mcp-debug-artifacts

# Lower threshold to trigger more offloading (for testing)
MCP_TRUNC_PROXY_MAX_BYTES=10000
```

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
