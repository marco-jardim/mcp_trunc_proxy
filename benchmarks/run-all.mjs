#!/usr/bin/env node
/**
 * Run all benchmarks for mcp-trunc-proxy
 * 
 * Usage:
 *   node benchmarks/run-all.mjs
 *   node benchmarks/run-all.mjs --json
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runBenchmark(name, script, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`Running: ${name}`);
    console.log(`${"═".repeat(70)}\n`);

    const proc = spawn("node", [script, ...args], {
      stdio: "inherit",
      cwd: __dirname
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${name} exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");

  const benchmarks = [
    ["Token Reduction Benchmark", join(__dirname, "token-reduction.mjs")],
    ["Performance Benchmark", join(__dirname, "performance.mjs")]
  ];

  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║                   mcp-trunc-proxy Benchmark Suite                  ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");

  for (const [name, script] of benchmarks) {
    try {
      await runBenchmark(name, script, jsonOutput ? ["--json"] : []);
    } catch (err) {
      console.error(`❌ ${name} failed: ${err.message}`);
      if (!jsonOutput) {
        // Continue with other benchmarks in non-JSON mode
        continue;
      }
      process.exit(1);
    }
  }

  console.log("\n✅ All benchmarks completed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
