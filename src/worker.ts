/**
 * Enterprise P2P Signaling Worker (SSE) - Durable Object Implementation
 */

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

export class ChatRoom {
  state_: DurableObjectState;
  env_: any;
  sessions_: Map<string, ReadableStreamDefaultController>;
  users_: Map<string, User>;
  history_: Message[];
  historyBytes_: number;
  MAX_HISTORY_BYTES_: number;
  encoder_: TextEncoder;
  rateBuckets_: Map<string, { count: number; start: number }>;
  RATE_LIMIT_WINDOW_MS_: number;
  RATE_LIMIT_MAX_: number;

  constructor(state: DurableObjectState, env: any) {
    this.state_ = state;
    this.env_ = env;
    this.sessions_ = new Map();
    this.users_ = new Map();
    this.history_ = [];
    this.historyBytes_ = 0;
    this.MAX_HISTORY_BYTES_ = 12 * 1024 * 1024;
    this.encoder_ = new TextEncoder();
    this.rateBuckets_ = new Map();
    this.RATE_LIMIT_WINDOW_MS_ = 10_000;
    this.RATE_LIMIT_MAX_ = 200;

    this.state_.blockConcurrencyWhile(async () => {
      const stored = await this.state_.storage.get<Message[]>("history");
      this.history_ = stored || [];
    });
  }

  rateLimitOk_(userId: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets_.get(userId) || { count: 0, start: now };
    if (now - bucket.start > this.RATE_LIMIT_WINDOW_MS_) {
      bucket.count = 0;
      bucket.start = now;
    }
    bucket.count += 1;
    this.rateBuckets_.set(userId, bucket);
    return bucket.count <= this.RATE_LIMIT_MAX_;
  }

  messageSizeBytes_(msg: any): number {
    try {
      return this.encoder_.encode(JSON.stringify(msg)).length;
    } catch {
      return 0;
    }
  }

  pushHistory_(msg: Message): void {
    const size = this.messageSizeBytes_(msg);
    if (size === 0) return;
    this.history_.push(msg);
    this.historyBytes_ += size;
    while (this.historyBytes_ > this.MAX_HISTORY_BYTES_ && this.history_.length > 0) {
      const removed = this.history_.shift();
      if (removed) {
        this.historyBytes_ -= this.messageSizeBytes_(removed);
      }
    }
    this.state_.storage.put("history", this.history_);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/events") {
      const userId = `user_${crypto.randomUUID().split('-')[0]}`;
      const nickname = this.generateRandomNickname_();

      let pingTimer: any;

      const stream = new ReadableStream({
        start: (controller) => {
          this.sessions_.set(userId, controller);
          this.users_.set(userId, { userId, nickname });

          // Immediate flush with :ok to bypass buffering
          controller.enqueue(this.encoder_.encode(":ok\n\n"));

          const initData = {
            type: "SYSTEM_INIT",
            payload: {
              userId,
              nickname,
              history: this.history_,
              users: Array.from(this.users_.values()).filter(u => u.userId !== userId)
            }
          };
          controller.enqueue(this.encoder_.encode(`data: ${JSON.stringify(initData)}\n\n`));

          this.broadcast_({
            type: "USER_JOINED",
            payload: { userId, nickname }
          }, userId);

          this.broadcast_({ type: "SYSTEM_ONLINE_COUNT", count: this.sessions_.size });

          pingTimer = setInterval(() => {
            try {
              controller.enqueue(this.encoder_.encode(":ping\n\n"));
            } catch (e) {
              clearInterval(pingTimer);
            }
          }, 15000); // Shorter ping
        },
        cancel: () => {
          clearInterval(pingTimer);
          this.sessions_.delete(userId);
          this.users_.delete(userId);
          this.broadcast_({ type: "USER_LEFT", payload: { userId } });
          this.broadcast_({ type: "SYSTEM_ONLINE_COUNT", count: this.sessions_.size });
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff"
        },
      });
    }

    if (url.pathname === "/history") {
      const result = { full: true, messages: this.history_.slice(-100) };
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/signal" && request.method === "POST") {
      const body: any = await request.json();
      const { type, payload, from } = body;

      if (!from || !this.sessions_.has(from)) return new Response("Invalid session", { status: 401 });
      if (!this.rateLimitOk_(from)) return new Response("Rate limit", { status: 429 });

      const user = this.users_.get(from);
      if (!user) return new Response("User not found", { status: 404 });

      switch (type) {
        case "CHAT_MESSAGE":
          const text = payload?.text?.trim();
          if (text) {
            const msg: Message = {
              id: payload.id || crypto.randomUUID(),
              userId: from,
              nickname: user.nickname,
              text,
              timestamp: payload.timestamp || new Date().toISOString(),
              isEncrypted: !!payload.isEncrypted
            };
            this.pushHistory_(msg);
            this.broadcast_({ type: "CHAT_MESSAGE", payload: msg }, from);
          }
          break;

        case "UPDATE_NICKNAME":
          const newNick = payload?.nickname?.trim();
          const { publicKey } = payload;
          if (newNick && newNick.length <= 20) {
            user.nickname = newNick;
            if (publicKey) user.publicKey = publicKey;
            this.broadcast_({
                type: "USER_UPDATED",
                payload: { userId: from, nickname: newNick, publicKey: user.publicKey }
            });
          }
          break;

        case "SIGNAL":
          const { to, signal } = payload;
          const controller = this.sessions_.get(to);
          if (controller) {
            controller.enqueue(this.encoder_.encode(`data: ${JSON.stringify({ type: "SIGNAL", payload: { from, signal } })}\n\n`));
          }
          break;
      }
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  }

  broadcast_(data: any, excludeUserId: string | null = null): void {
    const msg = this.encoder_.encode(`data: ${JSON.stringify(data)}\n\n`);
    for (const [userId, controller] of this.sessions_.entries()) {
      if (userId !== excludeUserId) {
        try {
          controller.enqueue(msg);
        } catch (e) {
          this.sessions_.delete(userId);
        }
      }
    }
  }

  generateRandomNickname_(): string {
    const adjectives = ["Swift", "Bright", "Cool", "Mighty", "Zen", "Hyper", "Neo"];
    const nouns = ["Coder", "User", "Falcon", "Ninja", "Ghost", "Pixel", "Sage"];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    return `${adj}${noun}${num}`;
  }
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname === "/config") {
      return new Response(JSON.stringify({ turnServers: [], signalToken: "", signalEndpoints: ["/signal"] }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/events" || url.pathname === "/signal" || url.pathname === "/history") {
      const id = env.CHAT_ROOM.idFromName("global-chat");
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  }
};
