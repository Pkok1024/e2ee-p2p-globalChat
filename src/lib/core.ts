import { Message } from "./types.js";

/**
 * Platform-independent utility for generating random nicknames.
 * @complexity O(1) - Constant time random selection from fixed-size arrays.
 */
export function generateRandomNickname(): string {
  const adjectives = ["Swift", "Bright", "Cool", "Mighty", "Zen", "Hyper", "Neo"];
  const nouns = ["Coder", "User", "Falcon", "Ninja", "Ghost", "Pixel", "Sage"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}${noun}${num}`;
}

/**
 * Platform-independent robust UUID/ID generator.
 * Uses Web Crypto or Node.js crypto for high-entropy randomness.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Robust fallback for older environments using typed arrays
  const array = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    // In rare cases where crypto is totally absent, use high-entropy seed
    for (let i = 0; i < 16; i++) {
        array[i] = Math.floor(Math.random() * 256);
    }
  }

  array[6] = (array[6] & 0x0f) | 0x40; // Version 4
  array[8] = (array[8] & 0x3f) | 0x80; // Variant 10xx

  const hex = Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const encoder = new TextEncoder();

/**
 * Calculates the size of an object in bytes when stringified.
 * @complexity O(N) where N is the total character count/depth of the object due to JSON.stringify.
 */
export function getObjectSizeBytes(obj: any): number {
  try {
    return encoder.encode(JSON.stringify(obj)).length;
  } catch {
    return 0;
  }
}

/**
 * Manages message history with size-based pruning.
 * Optimized for O(1) pruning operations by caching sizes.
 */
export class HistoryManager {
  private messages_: { msg: Message; size: number }[] = [];
  private totalBytes_: number = 0;
  private readonly maxBytes_: number;

  constructor(maxBytes: number) {
    this.maxBytes_ = maxBytes;
  }

  /**
   * Adds a message and prunes history if it exceeds maxBytes.
   * @complexity O(1) average for adding (amortized). O(K) for pruning where K is number of items removed.
   */
  push(msg: Message): void {
    const size = getObjectSizeBytes(msg);
    if (size === 0) return;

    this.messages_.push({ msg, size });
    this.totalBytes_ += size;

    this.prune();
  }

  /**
   * Prunes messages from the start of the history until total size is within limits.
   * @complexity O(K) where K is the number of messages removed.
   */
  private prune(): void {
    while (this.totalBytes_ > this.maxBytes_ && this.messages_.length > 0) {
      const removed = this.messages_.shift();
      if (removed) {
        this.totalBytes_ -= removed.size;
      }
    }
  }

  /**
   * Returns current messages.
   * @complexity O(N) to map the internal structure.
   */
  getMessages(): Message[] {
    return this.messages_.map((m) => m.msg);
  }

  /**
   * Clears history.
   * @complexity O(1)
   */
  clear(): void {
    this.messages_ = [];
    this.totalBytes_ = 0;
  }

  get totalBytes(): number {
    return this.totalBytes_;
  }

  get count(): number {
    return this.messages_.length;
  }
}
