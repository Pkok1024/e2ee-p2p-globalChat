/**
 * In-memory rate limiter with exponential backoff.
 *
 * Delay formula: min(BASE_MS * 2^attempts, MAX_DELAY_MS)
 *   attempt 0 -> 500ms
 *   attempt 1 -> 1000ms
 *   attempt 2 -> 2000ms
 *   attempt 3 -> 4000ms
 *   attempt 4 -> 8000ms
 *   attempt 5+ -> 30000ms (cap)
 */

const BASE_MS = 500;
const MAX_DELAY_MS = 30_000;
const WINDOW_MS = 10 * 60 * 1_000; // reset after 10 min of no attempts

interface Entry {
  count: number;
  /** Earliest timestamp at which a new attempt is allowed (ms). */
  nextAllowed: number;
  lastSeen: number;
}

const store = new Map<string, Entry>();

/** Prune stale entries so the map doesn't grow unbounded. */
function prune(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.lastSeen > WINDOW_MS) store.delete(key);
  }
}

export interface RateCheckResult {
  /** How many milliseconds the caller must wait before this attempt is valid. */
  waitMs: number;
  /** True if the attempt is allowed right now (waitMs === 0). */
  allowed: boolean;
}

/**
 * Check whether key (typically client IP) is allowed to make an attempt.
 */
export function check(key: string): RateCheckResult {
  prune();
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) return { waitMs: 0, allowed: true };

  const waitMs = Math.max(0, entry.nextAllowed - now);
  return { waitMs, allowed: waitMs === 0 };
}

/**
 * Record a FAILED attempt for key. Increases backoff.
 */
export function recordFailure(key: string): void {
  const now = Date.now();
  const entry = store.get(key) ?? { count: 0, nextAllowed: 0, lastSeen: 0 };

  const newCount = entry.count + 1;
  const delayMs = Math.min(BASE_MS * 2 ** (newCount - 1), MAX_DELAY_MS);

  store.set(key, {
    count: newCount,
    nextAllowed: now + delayMs,
    lastSeen: now,
  });
}

/**
 * Clear rate limit for key on SUCCESS.
 */
export function recordSuccess(key: string): void {
  store.delete(key);
}
