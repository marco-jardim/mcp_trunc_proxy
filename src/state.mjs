// ISSUE-040 FIX: Shared state module to avoid circular imports between cli.mjs and proxy.mjs

/**
 * Active store instance for cleanup on uncaught errors.
 * @type {import('./store.mjs').Store|null}
 */
let activeStore = null;

/**
 * Register the active store for cleanup on fatal errors.
 * @param {import('./store.mjs').Store} store
 */
export function setActiveStore(store) {
  activeStore = store;
}

/**
 * Get the active store instance.
 * @returns {import('./store.mjs').Store|null}
 */
export function getActiveStore() {
  return activeStore;
}
