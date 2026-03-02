import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const PORT = process.env.PORT || 3000;
const NICKNAME_MAX_LENGTH = 20;
const MESSAGE_MAX_LENGTH = 2000; // Increased to accommodate encrypted payload
const MAX_HISTORY_BYTES = 12 * 1024 * 1024; // 12MB in-memory history cap

// Resolve public directory: check local (bundled) or parent (dev)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(__dirname, "../public");

interface Message {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  timestamp: string;
  isEncrypted?: boolean;
}

interface User {
  userId: string;
  nickname: string;
  publicKey?: string;
}

interface AppState {
  clients_: Map<string, http.ServerResponse>;
  messages_: Message[];
  messagesBytes_: number;
  users_: Map<string, User>;
}

// Application State
const state: AppState = {
  clients_: new Map(),
  messages_: [],
  messagesBytes_: 0,
  users_: new Map(),
};

const encoder = new TextEncoder();

function messageSizeBytes_(msg: any): number {
  try {
    return encoder.encode(JSON.stringify(msg)).length;
  } catch {
    return 0;
  }
}

function pushHistory_(msg: Message): void {
  const size = messageSizeBytes_(msg);
  if (size === 0) return;
  state.messages_.push(msg);
  state.messagesBytes_ += size;
  while (state.messagesBytes_ > MAX_HISTORY_BYTES && state.messages_.length > 0) {
    const removed = state.messages_.shift();
    if (removed) {
        state.messagesBytes_ -= messageSizeBytes_(removed);
    }
  }
}

function generateRandomNickname_(): string {
  const adjectives = ["Swift", "Bright", "Cool", "Mighty", "Zen", "Hyper", "Neo"];
  const nouns = ["Coder", "User", "Falcon", "Ninja", "Ghost", "Pixel", "Sage"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}${noun}${num}`;
}

// Basic in-memory rate limit for /signal
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 200; // Increased limit for signaling
const rateBuckets = new Map<string, { count: number; start: number }>();

function rateLimitOk_(userId: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(userId) || { count: 0, start: now };
  if (now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.start = now;
  }
  bucket.count += 1;
  rateBuckets.set(userId, bucket);
  return bucket.count <= RATE_LIMIT_MAX;
}

function parseJsonEnv_(value: string | undefined, fallback: any): any {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function sendToClient_(userId: string, data: any): void {
  const res = state.clients_.get(userId);
  if (res) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function broadcast_(data: any, excludeUserId: string | null = null): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const [userId, res] of state.clients_.entries()) {
    if (userId !== excludeUserId) {
      res.write(payload);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // JSON Body Parser for POST
  let body: any = {};
  if (method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks).toString();
      if (data) {
        body = JSON.parse(data);
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  }

  // Routes
  if (method === "GET" && pathname === "/config") {
    const turnServers = parseJsonEnv_(process.env.TURN_SERVERS_JSON, []);
    const signalEndpoints = parseJsonEnv_(process.env.SIGNAL_ENDPOINTS_JSON, ["/signal"]);
    const signalToken = process.env.SIGNAL_TOKEN || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ turnServers, signalToken, signalEndpoints }));
  }

  if (method === "GET" && pathname === "/history") {
    const after = parsedUrl.searchParams.get("after") || "";
    const before = parsedUrl.searchParams.get("before") || "";
    const limitParam = parsedUrl.searchParams.get("limit");
    const limit = Math.max(1, Math.min(parseInt(limitParam || "100", 10) || 100, 500));

    let result: any;
    if (after) {
      const idx = state.messages_.findIndex(m => m.id === after);
      if (idx === -1) result = { full: true, messages: state.messages_.slice(-limit) };
      else result = { full: false, messages: state.messages_.slice(idx + 1) };
    } else if (before) {
      const idx = state.messages_.findIndex(m => m.id === before);
      if (idx === -1) result = { full: true, messages: state.messages_.slice(-limit) };
      else {
        const start = Math.max(0, idx - limit);
        result = { full: false, messages: state.messages_.slice(start, idx) };
      }
    } else {
      result = { full: true, messages: state.messages_.slice(-limit) };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(result));
  }

  if (method === "GET" && pathname === "/events") {
    const userId = `user_${crypto.randomUUID().replace(/-/g, "").substring(0, 12)}`;
    const nickname = generateRandomNickname_();

    console.log(`INFO: SSE Connected: ${userId} (${nickname})`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    // Send initial comment to confirm stream
    res.write(":ok\n\n");

    state.clients_.set(userId, res);
    state.users_.set(userId, { userId, nickname });

    res.write(`data: ${JSON.stringify({
      type: "SYSTEM_INIT",
      payload: {
        userId,
        nickname,
        history: state.messages_,
        users: Array.from(state.users_.values()).filter(u => u.userId !== userId)
      }
    })}\n\n`);

    broadcast_({
      type: "USER_JOINED",
      payload: { userId, nickname }
    }, userId);

    broadcast_({ type: "SYSTEM_ONLINE_COUNT", count: state.clients_.size });

    const pingInterval = setInterval(() => {
        res.write(":ping\n\n");
    }, 30000);

    req.on("close", () => {
      console.log(`INFO: SSE Disconnected: ${userId}`);
      clearInterval(pingInterval);
      state.clients_.delete(userId);
      state.users_.delete(userId);

      broadcast_({
        type: "USER_LEFT",
        payload: { userId }
      });
      broadcast_({ type: "SYSTEM_ONLINE_COUNT", count: state.clients_.size });
    });
    return;
  }

  if (method === "POST" && pathname === "/signal") {
    const { type, payload, from } = body;
    const token = req.headers["x-signal-token"] || "";

    if (process.env.SIGNAL_TOKEN && token !== process.env.SIGNAL_TOKEN) {
      console.error(`ERROR: Unauthorized signal from ${from}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    if (!from || !state.clients_.has(from)) {
      console.warn(`WARN: Signal from unknown/expired session: ${from}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid session" }));
    }

    if (!rateLimitOk_(from)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Rate limit" }));
    }

    const user = state.users_.get(from);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "User not found" }));
    }

    if (typeof type === "string") {
      switch (type) {
        case "CHAT_MESSAGE":
          const text = payload?.text?.trim();
          if (text && text.length <= MESSAGE_MAX_LENGTH) {
            const messageData: Message = {
              id: payload.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
              userId: from,
              nickname: user.nickname,
              text,
              timestamp: payload.timestamp || new Date().toISOString(),
              isEncrypted: !!payload.isEncrypted
            };
            pushHistory_(messageData);
            broadcast_({ type: "CHAT_MESSAGE", payload: messageData }, from);
          }
          break;

        case "UPDATE_NICKNAME":
          const { publicKey } = payload;
          if (publicKey) user.publicKey = publicKey;
          const newNickname = payload?.nickname?.trim();
          if (newNickname && newNickname.length <= NICKNAME_MAX_LENGTH) {
            const oldNickname = user.nickname;
            user.nickname = newNickname;
            broadcast_({
              type: "SYSTEM_NOTIFICATION",
              payload: { text: `${oldNickname} changed their nickname to ${newNickname}` }
            });
            broadcast_({
              type: "USER_UPDATED",
              payload: { userId: from, nickname: newNickname, publicKey: user.publicKey }
            });
          }
          break;

        case "SIGNAL":
          const { to, signal } = payload;
          if (to && signal) {
            sendToClient_(to, {
              type: "SIGNAL",
              payload: { from, signal }
            });
          }
          break;

        case "ADMIN_RESET":
          if (payload?.token === process.env.ADMIN_TOKEN) {
            console.log("INFO: Admin history reset");
            state.messages_ = [];
            state.messagesBytes_ = 0;
            broadcast_({ type: "SYSTEM_NOTIFICATION", payload: { text: "Chat history cleared" } });
            broadcast_({ type: "CHAT_CLEARED" });
          }
          break;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true }));
  }

  // Static File Server
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
        filePath = path.join(PUBLIC_DIR, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
      ".png": "image/png", ".jpg": "image/jpg", ".gif": "image/gif", ".svg": "image/svg+xml",
      ".wav": "audio/wav", ".mp4": "video/mp4", ".woff": "application/font-woff", ".ttf": "application/font-ttf",
      ".wasm": "application/wasm",
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content, "utf-8");
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`INFO: Server listening on port ${PORT}`);
});
