#!/usr/bin/env node
/**
 * Performance Benchmark for mcp-trunc-proxy
 * 
 * Measures latency, throughput, and memory usage for storage operations.
 * 
 * Usage:
 *   node benchmarks/performance.mjs
 *   node benchmarks/performance.mjs --json     # JSON output
 *   node benchmarks/performance.mjs --stores memory,file  # Specific stores
 */

import { createStore } from "../src/store.mjs";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const formatBytes = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
const formatDuration = (ms) => ms < 1 ? `${(ms * 1000).toFixed(0)}μs` : ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;

/**
 * Generate test payloads of various sizes
 */
function generatePayload(sizeKB) {
  const target = sizeKB * 1024;
  const line = "Test log line with some content that simulates real data. ";
  const lines = [];
  let size = 0;
  while (size < target) {
    lines.push(line + Math.random().toString(36));
    size += line.length + 15;
  }
  return lines.join("\n");
}

/**
 * Run a single benchmark iteration
 */
async function benchmarkOperation(fn, iterations = 100) {
  // Warmup
  for (let i = 0; i < Math.min(10, iterations); i++) {
    await fn();
  }

  // Measure
  const times = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const opStart = performance.now();
    await fn();
    times.push(performance.now() - opStart);
  }
  const totalTime = performance.now() - start;

  times.sort((a, b) => a - b);
  return {
    iterations,
    totalMs: totalTime,
    avgMs: totalTime / iterations,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p50Ms: times[Math.floor(times.length * 0.5)],
    p95Ms: times[Math.floor(times.length * 0.95)],
    p99Ms: times[Math.floor(times.length * 0.99)],
    opsPerSec: (iterations / totalTime) * 1000
  };
}

/**
 * Benchmark a specific store implementation
 */
async function benchmarkStore(storeType, storeUri) {
  const results = {
    storeType,
    payloadSizes: {},
    operations: {}
  };

  const store = await createStore(storeUri, {
    ttlSeconds: 3600,
    maxArtifacts: 10000,
    redisKeyPrefix: "bench"
  });

  const PAYLOAD_SIZES = [1, 10, 50, 100, 500]; // KB
  const ITERATIONS = 50;

  // Test different payload sizes
  for (const sizeKB of PAYLOAD_SIZES) {
    const payload = generatePayload(sizeKB);
    const compressed = gzipSync(Buffer.from(payload, "utf8"));
    const actualSize = compressed.length;

    results.payloadSizes[`${sizeKB}KB`] = {
      uncompressed: Buffer.byteLength(payload, "utf8"),
      compressed: actualSize,
      compressionRatio: (Buffer.byteLength(payload, "utf8") / actualSize).toFixed(2)
    };

    // PUT benchmark
    let ids = [];
    const putResult = await benchmarkOperation(async () => {
      const id = `bench_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      ids.push(id);
      await store.put(id, compressed, { originalBytes: payload.length, lines: payload.split("\n").length });
      return id;
    }, ITERATIONS);
    results.operations[`put_${sizeKB}KB`] = putResult;

    // GET benchmark (using stored IDs)
    let getIdx = 0;
    const getResult = await benchmarkOperation(async () => {
      const id = ids[getIdx % ids.length];
      getIdx++;
      return await store.get(id);
    }, ITERATIONS);
    results.operations[`get_${sizeKB}KB`] = getResult;

    // INFO benchmark
    let infoIdx = 0;
    const infoResult = await benchmarkOperation(async () => {
      const id = ids[infoIdx % ids.length];
      infoIdx++;
      return await store.info(id);
    }, ITERATIONS);
    results.operations[`info_${sizeKB}KB`] = infoResult;

    // Cleanup test artifacts
    for (const id of ids) {
      try {
        // Memory and Redis don't have explicit delete, but file store cleanup happens on close
      } catch { /* ignore */ }
    }
  }

  // Throughput test: rapid sequential operations
  const throughputPayload = generatePayload(10);
  const throughputCompressed = gzipSync(Buffer.from(throughputPayload, "utf8"));
  const throughputIds = [];

  const throughputStart = performance.now();
  const THROUGHPUT_OPS = 200;
  for (let i = 0; i < THROUGHPUT_OPS; i++) {
    const id = `throughput_${i}`;
    await store.put(id, throughputCompressed, { originalBytes: throughputPayload.length });
    throughputIds.push(id);
  }
  const throughputPutTime = performance.now() - throughputStart;

  const getStart = performance.now();
  for (const id of throughputIds) {
    await store.get(id);
  }
  const throughputGetTime = performance.now() - getStart;

  results.throughput = {
    putOpsPerSec: (THROUGHPUT_OPS / throughputPutTime) * 1000,
    getOpsPerSec: (THROUGHPUT_OPS / throughputGetTime) * 1000,
    totalOps: THROUGHPUT_OPS
  };

  // Memory usage (approximate for memory store)
  if (storeType === "memory") {
    const used = process.memoryUsage();
    results.memory = {
      heapUsedMB: (used.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (used.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (used.rss / 1024 / 1024).toFixed(2)
    };
  }

  await store.close();
  return results;
}

/**
 * Benchmark compression performance
 */
function benchmarkCompression() {
  const results = {};
  const SIZES = [10, 50, 100, 500, 1000]; // KB

  for (const sizeKB of SIZES) {
    const payload = generatePayload(sizeKB);
    const payloadBuffer = Buffer.from(payload, "utf8");

    // Compression benchmark
    const compressStart = performance.now();
    const COMPRESS_ITERS = 20;
    let compressed;
    for (let i = 0; i < COMPRESS_ITERS; i++) {
      compressed = gzipSync(payloadBuffer);
    }
    const compressTime = (performance.now() - compressStart) / COMPRESS_ITERS;

    // Decompression benchmark
    const decompressStart = performance.now();
    for (let i = 0; i < COMPRESS_ITERS; i++) {
      gunzipSync(compressed);
    }
    const decompressTime = (performance.now() - decompressStart) / COMPRESS_ITERS;

    results[`${sizeKB}KB`] = {
      originalBytes: payloadBuffer.length,
      compressedBytes: compressed.length,
      ratio: (payloadBuffer.length / compressed.length).toFixed(2),
      compressMs: compressTime.toFixed(2),
      decompressMs: decompressTime.toFixed(2),
      compressMBps: ((payloadBuffer.length / 1024 / 1024) / (compressTime / 1000)).toFixed(1),
      decompressMBps: ((payloadBuffer.length / 1024 / 1024) / (decompressTime / 1000)).toFixed(1)
    };
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const storesArg = args.find(a => a.startsWith("--stores="));
  const requestedStores = storesArg ? storesArg.split("=")[1].split(",") : ["memory", "file"];

  if (!jsonOutput) {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║              mcp-trunc-proxy Performance Benchmark             ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");
  }

  const allResults = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    compression: {},
    stores: {}
  };

  // Compression benchmark
  if (!jsonOutput) {
    console.log("━━━ Compression Performance ━━━\n");
  }
  allResults.compression = benchmarkCompression();

  if (!jsonOutput) {
    console.log("  Size      Original    Compressed   Ratio    Compress    Decompress");
    console.log("  ────────────────────────────────────────────────────────────────────");
    for (const [size, data] of Object.entries(allResults.compression)) {
      console.log(`  ${size.padEnd(8)} ${formatBytes(data.originalBytes).padEnd(11)} ${formatBytes(data.compressedBytes).padEnd(12)} ${data.ratio}x     ${data.compressMs.padStart(6)}ms   ${data.decompressMs.padStart(6)}ms`);
    }
    console.log(`\n  Throughput: ~${allResults.compression["100KB"].compressMBps} MB/s compress, ~${allResults.compression["100KB"].decompressMBps} MB/s decompress\n`);
  }

  // Store benchmarks
  const storeConfigs = [];

  if (requestedStores.includes("memory")) {
    storeConfigs.push({ type: "memory", uri: "memory" });
  }

  if (requestedStores.includes("file")) {
    const tempDir = mkdtempSync(join(tmpdir(), "mcp-bench-"));
    storeConfigs.push({ type: "file", uri: `file:${tempDir}`, tempDir });
  }

  // Note: Redis benchmark requires running Redis server
  if (requestedStores.includes("redis")) {
    storeConfigs.push({ type: "redis", uri: "redis://localhost:6379" });
  }

  for (const config of storeConfigs) {
    if (!jsonOutput) {
      console.log(`━━━ ${config.type.toUpperCase()} Store Performance ━━━\n`);
    }

    try {
      const results = await benchmarkStore(config.type, config.uri);
      allResults.stores[config.type] = results;

      if (!jsonOutput) {
        // Payload sizes and compression
        console.log("  Payload Compression:");
        for (const [size, data] of Object.entries(results.payloadSizes)) {
          console.log(`    ${size}: ${formatBytes(data.uncompressed)} → ${formatBytes(data.compressed)} (${data.compressionRatio}x)`);
        }
        console.log("");

        // Operation latencies
        console.log("  Operation Latencies (avg / p95 / p99):");
        const ops = ["put", "get", "info"];
        for (const op of ops) {
          const sizes = Object.keys(results.operations).filter(k => k.startsWith(op)).map(k => {
            const data = results.operations[k];
            return `${k.split("_")[1]}: ${formatDuration(data.avgMs)} / ${formatDuration(data.p95Ms)} / ${formatDuration(data.p99Ms)}`;
          });
          console.log(`    ${op.toUpperCase().padEnd(5)} ${sizes.join("  |  ")}`);
        }
        console.log("");

        // Throughput
        console.log("  Throughput (10KB payloads):");
        console.log(`    PUT: ${results.throughput.putOpsPerSec.toFixed(0)} ops/sec`);
        console.log(`    GET: ${results.throughput.getOpsPerSec.toFixed(0)} ops/sec`);

        // Memory (if available)
        if (results.memory) {
          console.log(`\n  Memory Usage:`);
          console.log(`    Heap: ${results.memory.heapUsedMB} MB used / ${results.memory.heapTotalMB} MB total`);
          console.log(`    RSS:  ${results.memory.rssMB} MB`);
        }
        console.log("");
      }
    } catch (err) {
      if (!jsonOutput) {
        console.log(`  ❌ Error: ${err.message}\n`);
      }
      allResults.stores[config.type] = { error: err.message };
    }

    // Cleanup temp directory for file store
    if (config.tempDir) {
      try {
        rmSync(config.tempDir, { recursive: true });
      } catch { /* ignore */ }
    }
  }

  // Summary
  if (!jsonOutput && Object.keys(allResults.stores).length > 1) {
    console.log("━━━ Store Comparison ━━━\n");
    console.log("  Store     PUT ops/s    GET ops/s    Avg PUT latency    Avg GET latency");
    console.log("  ──────────────────────────────────────────────────────────────────────");
    for (const [type, data] of Object.entries(allResults.stores)) {
      if (data.error) continue;
      const putOps = data.throughput.putOpsPerSec.toFixed(0).padStart(8);
      const getOps = data.throughput.getOpsPerSec.toFixed(0).padStart(8);
      const putLatency = formatDuration(data.operations["put_10KB"].avgMs).padStart(12);
      const getLatency = formatDuration(data.operations["get_10KB"].avgMs).padStart(12);
      console.log(`  ${type.padEnd(8)} ${putOps}    ${getOps}        ${putLatency}        ${getLatency}`);
    }
    console.log("");
  }

  if (!jsonOutput) {
    console.log("════════════════════════════════════════════════════════════════");
    console.log("💡 Tips:");
    console.log("   • Memory store is fastest but ephemeral");
    console.log("   • File store persists but has I/O overhead");
    console.log("   • Redis store enables sharing across processes");
    console.log("════════════════════════════════════════════════════════════════");
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  }
}

main().catch(console.error);
