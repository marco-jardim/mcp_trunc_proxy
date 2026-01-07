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
 */
export function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    },
    0,
  );
}
