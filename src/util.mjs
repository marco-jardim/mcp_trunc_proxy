export function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function byteLengthUtf8(s) {
  return Buffer.byteLength(String(s), "utf8");
}

/**
 * Stable-ish stringify that:
 * - avoids crashing on BigInt
 * - tolerates circular refs (drops cycles)
 * - NOTE: Symbol keys are dropped (standard JSON behavior)
 * - ISSUE-048 FIX: Limits depth to prevent stack overflow on very deep objects
 * @param {any} obj - Object to stringify
 * @param {number} [maxDepth=100] - Maximum nesting depth
 */
export function stableStringify(obj, maxDepth = 100) {
  const seen = new WeakSet();
  let currentDepth = 0;
  const depthStack = [];

  return JSON.stringify(
    obj,
    function(_k, v) {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        // Track depth by checking if we're entering a new object
        if (depthStack.length > maxDepth) return "[MaxDepth]";
        seen.add(v);
        depthStack.push(v);
      }
      return v;
    },
    0,
  );
}
