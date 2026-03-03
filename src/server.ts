import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import * as rl from "./lib/rate-limiter.js";
import { COOKIE_NAME, nodeVerifyCookie, nodeBuildSetCookie, nodeTimingSafeMatch } from "./lib/cookie.js";
import { renderGate } from "./lib/token-gate.html.js";
import { ChatService, ChatBroadcaster } from "./lib/chat-service.js";
import { Signal } from "./lib/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MAX_HISTORY_BYTES = 12 * 1024 * 1024;
const COMMUNITY_TOKEN = process.env.COMMUNITY_TOKEN;
const TOKEN_COOKIE_SECRET = process.env.TOKEN_COOKIE_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!COMMUNITY_TOKEN || !TOKEN_COOKIE_SECRET) {
  console.error("FATAL: COMMUNITY_TOKEN and TOKEN_COOKIE_SECRET must be set.");
  process.exit(1);
}

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(__dirname, "../public");

// Infrastructure Adapter: SSE Broadcaster
class NodeBroadcaster implements ChatBroadcaster {
  constructor(private clients: Map<string, http.ServerResponse>) {}

  broadcast(data: any, excludeUserId: string | null = null): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const [userId, res] of this.clients.entries()) {
      if (userId !== excludeUserId) {
        res.write(payload);
      }
    }
  }

  sendTo(userId: string, data: any): void {
    const res = this.clients.get(userId);
    if (res) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }
}

const clients = new Map<string, http.ServerResponse>();
const broadcaster = new NodeBroadcaster(clients);
const chatService = new ChatService(broadcaster, MAX_HISTORY_BYTES);

const SIGNAL_RATE_LIMIT_WINDOW_MS = 10_000;
const SIGNAL_RATE_LIMIT_MAX = 200;
const signalRateBuckets = new Map<string, { count: number; start: number }>();

const ADMIN_RESET_RATE_LIMIT_WINDOW_MS = 10_000;
const ADMIN_RESET_RATE_LIMIT_MAX = 10;
const adminResetRateBuckets = new Map<string, { count: number; start: number }>();

function signalRateLimitOk(userId: string): boolean {
  const now = Date.now();
  const bucket = signalRateBuckets.get(userId) || { count: 0, start: now };
  if (now - bucket.start > SIGNAL_RATE_LIMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.start = now;
  }
  bucket.count += 1;
  signalRateBuckets.set(userId, bucket);
  return bucket.count <= SIGNAL_RATE_LIMIT_MAX;
}

function adminResetRateLimitOk(ip: string): boolean {
  const now = Date.now();
  const bucket = adminResetRateBuckets.get(ip) || { count: 0, start: now };
  if (now - bucket.start > ADMIN_RESET_RATE_LIMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.start = now;
  }
  bucket.count += 1;
  adminResetRateBuckets.set(ip, bucket);
  return bucket.count <= ADMIN_RESET_RATE_LIMIT_MAX;
}

function parseJsonEnv(value: string | undefined, fallback: any): any {
  if (!value) return fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

/**
 * Checks if an IP address is a private or loopback address.
 */
function isPrivateIp(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    (ip.startsWith("172.") &&
     parseInt(ip.split(".")[1], 10) >= 16 &&
     parseInt(ip.split(".")[1], 10) <= 31) ||
    ip.startsWith("fe80:") ||
    ip.startsWith("fc00:") ||
    ip.startsWith("fd00:")
  );
}

function clientIp(req: http.IncomingMessage): string {
  const remoteAddr = req.socket.remoteAddress ?? "unknown";
  const xff = req.headers["x-forwarded-for"];

  // Smart IP resolution: trust XFF if explicitly configured OR if connection is from a local/private address
  const trustProxy = process.env.TRUST_PROXY === "true" || isPrivateIp(remoteAddr);

  if (xff && trustProxy) {
    const first = Array.isArray(xff) ? xff[0] : xff.split(",")[0];
    return first.trim();
  }

  return remoteAddr;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method?.toUpperCase() || "GET";

  // --- PUBLIC ROUTES ---
  if (method === "GET" && pathname === "/gate") {
    const { allowed, waitMs } = rl.check(ip);
    const html = renderGate({ waitUntil: allowed ? 0 : Date.now() + waitMs });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }

  if (method === "POST" && pathname === "/verify-token") {
    const { allowed, waitMs } = rl.check(ip);
    if (!allowed) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, message: "Too many attempts.", waitUntil: Date.now() + waitMs }));
    }
    const start = Date.now();
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const token = params.get("token")?.trim();
    const match = await nodeTimingSafeMatch(token || "", COMMUNITY_TOKEN || "");
    const elapsed = Date.now() - start;
    if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));

    if (!match) {
      rl.recordFailure(ip);
      const { waitMs: newWait } = rl.check(ip);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, message: "Invalid token.", waitUntil: newWait > 0 ? Date.now() + newWait : undefined }));
    }

    rl.recordSuccess(ip);
    const setCookie = await nodeBuildSetCookie(COMMUNITY_TOKEN!, TOKEN_COOKIE_SECRET!);
    res.writeHead(200, { "Set-Cookie": setCookie, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, redirect: "/" }));
  }

  // --- AUTH CHECK ---
  const authed = await nodeVerifyCookie(req.headers["cookie"], COMMUNITY_TOKEN!, TOKEN_COOKIE_SECRET!);
  if (!authed) {
    res.writeHead(302, { "Location": "/gate", "Cache-Control": "no-store" });
    return res.end();
  }

  // --- PROTECTED ROUTES ---
  if (method === "GET" && pathname === "/config") {
    const turnServers = parseJsonEnv(process.env.TURN_SERVERS_JSON, []);
    const signalEndpoints = parseJsonEnv(process.env.SIGNAL_ENDPOINTS_JSON, ["/signal"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ turnServers, signalToken: process.env.SIGNAL_TOKEN || "", signalEndpoints }));
  }

  if (method === "GET" && pathname === "/history") {
    const limit = Math.max(1, Math.min(parseInt(parsedUrl.searchParams.get("limit") || "100", 10) || 100, 500));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ full: true, messages: chatService.getHistory(limit) }));
  }

  if (method === "GET" && pathname === "/events") {
    const userId = `user_${crypto.randomUUID().replace(/-/g, "").substring(0, 12)}`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write(":ok\n\n");
    const user = chatService.addUser(userId);
    clients.set(userId, res);
    res.write(`data: ${JSON.stringify({ type: "SYSTEM_INIT", payload: { userId, nickname: user.nickname, history: chatService.getHistory(), users: chatService.getAllUsers().filter(u => u.userId !== userId) } })}\n\n`);
    chatService.broadcastPresence("USER_JOINED", { userId, nickname: user.nickname }, userId);
    chatService.broadcastPresence("SYSTEM_ONLINE_COUNT", chatService.onlineCount);
    const pingInterval = setInterval(() => res.write(":ping\n\n"), 30000);
    req.on("close", () => {
      clearInterval(pingInterval);
      clients.delete(userId);
      chatService.removeUser(userId);
      chatService.broadcastPresence("USER_LEFT", { userId });
      chatService.broadcastPresence("SYSTEM_ONLINE_COUNT", chatService.onlineCount);
    });
    return;
  }

  if (method === "POST" && pathname === "/signal") {
    const bodyText = await readBody(req);
    let signal: Signal;
    try { signal = JSON.parse(bodyText); } catch {
      res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }

    if (signal.type === "ADMIN_RESET") {
      if (!adminResetRateLimitOk(ip)) {
        res.writeHead(429); return res.end(JSON.stringify({ error: "Rate limit" }));
      }
      const match = await nodeTimingSafeMatch(signal.payload?.token || "", ADMIN_TOKEN || "");
      if (chatService.adminReset(match)) {
        res.writeHead(200); return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(401); return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    const from = signal.from;
    if (!from || !clients.has(from)) {
      res.writeHead(401); return res.end(JSON.stringify({ error: "Invalid session" }));
    }

    if (!signalRateLimitOk(from)) {
      res.writeHead(429); return res.end(JSON.stringify({ error: "Rate limit" }));
    }

    const result = chatService.handleSignal(from, signal);
    if (!result.success) {
      res.writeHead(result.error === "User not found" ? 404 : 400);
      return res.end(JSON.stringify({ error: result.error }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify({ success: true }));
  }

  // --- STATIC FILES ---
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) filePath = path.join(PUBLIC_DIR, "index.html");
    const mimeTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    fs.readFile(filePath, (error, content) => {
      if (error) { res.writeHead(500); res.end(); }
      else { res.writeHead(200, { "Content-Type": contentType }); res.end(content); }
    });
  });
});

server.listen(PORT, () => { console.log(`INFO: Server listening on port ${PORT}`); });
