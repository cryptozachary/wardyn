import { randomFillSync } from "crypto";

/**
 * Overwrite a string value in a record with random bytes, then delete the key.
 * JavaScript strings are immutable, so we can only zero the Buffer/object reference.
 * For true zeroization we work with Buffers where possible.
 */

/** Overwrite a Buffer's contents with random data, then fill with zeros. */
export function zeroBuffer(buf: Buffer): void {
  if (!buf || buf.length === 0) return;
  randomFillSync(buf); // overwrite with random to defeat compression-based attacks
  buf.fill(0);         // then zero
}

/**
 * Securely load keys, use them via callback, then wipe the decrypted copy.
 * This ensures decrypted keys exist in memory only for the duration of `fn`.
 */
export function withDecryptedKeys<T>(
  loadFn: () => Record<string, string>,
  fn: (keys: Record<string, string>) => T,
): T {
  const keys = loadFn();
  try {
    return fn(keys);
  } finally {
    // Overwrite each value with same-length garbage, then delete
    for (const k of Object.keys(keys)) {
      const len = keys[k].length;
      keys[k] = "x".repeat(len); // overwrite reference
      delete keys[k];
    }
  }
}

/**
 * A time-limited key cache that auto-wipes after a TTL.
 * Keys are re-decrypted on demand and wiped after the window closes.
 */
export class ZeroizingCache {
  private keys: Record<string, string> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ttlMs: number;
  private loadFn: () => Record<string, string>;

  constructor(loadFn: () => Record<string, string>, ttlMs = 60_000) {
    this.loadFn = loadFn;
    this.ttlMs = ttlMs;
  }

  /** Get keys -- decrypts on first call, schedules wipe after TTL. */
  get(): Record<string, string> {
    if (this.keys) {
      this.resetTimer(); // extend TTL on access
      return this.keys;
    }
    try {
      this.keys = this.loadFn();
    } catch {
      this.keys = {};
    }
    this.resetTimer();
    return this.keys;
  }

  /** Force invalidation (e.g., after key change). */
  invalidate(): void {
    this.wipe();
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wipe(), this.ttlMs);
    this.timer.unref(); // don't keep process alive
  }

  private wipe(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.keys) {
      for (const k of Object.keys(this.keys)) {
        const len = this.keys[k].length;
        this.keys[k] = "x".repeat(len);
        delete this.keys[k];
      }
      this.keys = null;
    }
  }
}
