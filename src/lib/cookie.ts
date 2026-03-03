/**
 * Secure cookie helpers — zero external dependencies.
 */

export const COOKIE_NAME = "__tg";

// ---------------------------------------------------------------------------
// Node.js implementation (uses node:crypto)
// ---------------------------------------------------------------------------

/**
 * Timing-safe string comparison for Node.js using SHA-256 hashing.
 */
export async function nodeTimingSafeMatch(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const h1 = createHash("sha256").update(a).digest();
  const h2 = createHash("sha256").update(b).digest();
  return timingSafeEqual(h1, h2);
}

/**
 * Timing-safe cookie verification for Node.js.
 */
export async function nodeVerifyCookie(
  cookieHeader: string | undefined,
  validToken: string,
  cookieSecret: string
): Promise<boolean> {
  const value = parseCookie(cookieHeader ?? "", COOKIE_NAME);
  if (!value) return false;

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", cookieSecret).update(validToken).digest("hex");

  if (value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

/**
 * Build a Set-Cookie header string for Node.js.
 */
export async function nodeBuildSetCookie(
  validToken: string,
  cookieSecret: string,
  maxAgeSeconds = 60 * 60 * 24 * 7 // 7 days
): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const value = createHmac("sha256", cookieSecret).update(validToken).digest("hex");
  return buildSetCookie(value, maxAgeSeconds);
}

// ---------------------------------------------------------------------------
// Cloudflare Workers implementation (uses Web Crypto API)
// ---------------------------------------------------------------------------

/**
 * Timing-safe string comparison for Cloudflare Workers using SHA-256 hashing.
 */
export async function workerTimingSafeMatch(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [h1, h2] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const b1 = new Uint8Array(h1);
  const b2 = new Uint8Array(h2);
  let diff = 0;
  for (let i = 0; i < b1.length; i++) {
    diff |= b1[i] ^ b2[i];
  }
  return diff === 0;
}

/**
 * Timing-safe cookie verification for Cloudflare Workers.
 */
export async function workerVerifyCookie(
  cookieHeader: string | undefined,
  validToken: string,
  cookieSecret: string
): Promise<boolean> {
  const value = parseCookie(cookieHeader ?? "", COOKIE_NAME);
  if (!value) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(cookieSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(validToken));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (value.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a Set-Cookie header string for Workers.
 */
export async function workerBuildSetCookie(
  validToken: string,
  cookieSecret: string,
  maxAgeSeconds = 60 * 60 * 24 * 7
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(cookieSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(validToken));
  const value = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return buildSetCookie(value, maxAgeSeconds);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function parseCookie(
  cookieHeader: string,
  name: string
): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

function buildSetCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];

  // Conditionally add Secure flag in production environments
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
    parts.push("Secure");
  } else if (typeof (globalThis as any).WRANGLER !== "undefined") {
    // Basic heuristic for Cloudflare Workers context, though env is usually passed in fetch
    // In Workers, we often want Secure by default in production.
  }

  return parts.join("; ");
}
