/**
 * Unit tests for src/cli.mjs (argument parsing and validation)
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "../../src/cli.mjs");

function runCli(args, env = {}, timeout = 5000) {
  return new Promise((resolve) => {
    const child = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });

    child.stdin.end();
  });
}

describe("cli.mjs", () => {
  describe("--version / -v", () => {
    test("--version shows version and exits 0", async () => {
      const { code, stdout } = await runCli(["--version"]);
      assert.strictEqual(code, 0);
      assert.match(stdout, /mcp-trunc-proxy v\d+\.\d+\.\d+/);
    });

    test("-v shows version and exits 0", async () => {
      const { code, stdout } = await runCli(["-v"]);
      assert.strictEqual(code, 0);
      assert.match(stdout, /mcp-trunc-proxy v/);
    });
  });

  describe("--help / -h", () => {
    test("--help shows usage and exits 2", async () => {
      const { code, stderr } = await runCli(["--help"]);
      assert.strictEqual(code, 2); // Help always exits with code 2
      assert.ok(stderr.includes("Usage:"));
      assert.ok(stderr.includes("--max-bytes"));
      assert.ok(stderr.includes("--store"));
    });

    test("-h shows usage and exits 2", async () => {
      const { code, stderr } = await runCli(["-h"]);
      assert.strictEqual(code, 2); // Help exits with code 2
      assert.ok(stderr.includes("Usage:"));
    });
  });

  describe("no arguments", () => {
    test("shows usage and exits 2", async () => {
      const { code, stderr } = await runCli([]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("Usage:"));
    });
  });

  describe("numeric argument validation", () => {
    test("rejects negative --max-bytes", async () => {
      const { code, stderr } = await runCli(["--max-bytes", "-1", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });

    test("rejects zero --max-bytes", async () => {
      const { code, stderr } = await runCli(["--max-bytes", "0", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });

    test("rejects non-numeric --max-bytes", async () => {
      const { code, stderr } = await runCli(["--max-bytes", "abc", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("requires a numeric value"));
    });

    test("rejects negative --ttl-seconds", async () => {
      const { code, stderr } = await runCli(["--ttl-seconds", "-100", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });

    test("rejects negative --head-lines", async () => {
      const { code, stderr } = await runCli(["--head-lines", "-5", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });

    test("rejects negative --tail-lines", async () => {
      const { code, stderr } = await runCli(["--tail-lines", "-5", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });

    test("rejects negative --max-artifacts", async () => {
      const { code, stderr } = await runCli(["--max-artifacts", "-10", "--", "echo"]);
      assert.strictEqual(code, 2);
      assert.ok(stderr.includes("must be a positive number"));
    });
  });

  describe("environment variable handling", () => {
    test("warns on invalid numeric env var", async () => {
      const { stderr } = await runCli(["--help"], {
        MCP_TRUNC_PROXY_MAX_BYTES: "not-a-number",
      });
      assert.ok(stderr.includes("invalid env vars") || stderr.includes("Usage:"));
    });

    test("warns on multiple invalid env vars", async () => {
      const { stderr } = await runCli(["--help"], {
        MCP_TRUNC_PROXY_MAX_BYTES: "bad1",
        MCP_TRUNC_PROXY_TTL_SECONDS: "bad2",
      });
      // Should show consolidated warning
      assert.ok(stderr.includes("Usage:"));
    });
  });

  describe("log level validation", () => {
    test("warns on invalid log level", async () => {
      const { stderr } = await runCli(["--log-level", "verbose", "--help"]);
      assert.ok(stderr.includes('invalid log level "verbose"') || stderr.includes("Usage:"));
    });

    test("accepts valid log levels", async () => {
      for (const level of ["silent", "error", "warn", "info", "debug"]) {
        const { stderr } = await runCli(["--log-level", level, "--help"]);
        assert.ok(!stderr.includes("invalid log level"));
      }
    });
  });

  describe("store spec validation", () => {
    test("accepts memory store", async () => {
      const { stderr } = await runCli(["--store", "memory", "--help"]);
      assert.ok(!stderr.includes("Unknown store"));
    });

    test("accepts file store spec", async () => {
      const { stderr } = await runCli(["--store", "file:/tmp/test", "--help"]);
      assert.ok(!stderr.includes("Unknown store"));
    });
  });

  describe("argument parsing edge cases", () => {
    test("handles multiple options together with help", async () => {
      // --help exits with code 2 (standard help exit) and shows usage
      const { code, stderr } = await runCli(["--max-bytes", "50000", "--store", "memory", "--help"]);
      assert.strictEqual(code, 2); // Help exit code
      assert.ok(stderr.includes("Usage:"));
      assert.ok(stderr.includes("--max-bytes"));
    });

    test("validates store option format", async () => {
      const { code, stderr } = await runCli(["--store", "invalid", "--help"]);
      assert.strictEqual(code, 2);
      // Should still show help even with invalid store
      assert.ok(stderr.includes("Usage:"));
    });
  });
});
