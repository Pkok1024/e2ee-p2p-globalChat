import {
  ADJECTIVES,
  EVENT_TYPES,
  JSON_HEADERS,
  MAX_HISTORY_BYTES,
  NICKNAME_MAX_LENGTH,
  NOUNS,
  PATHS,
  PING_INTERVAL_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  SSE_HEADERS,
} from "./constants";

// Interfaces remain the same
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
    publicKey?: unknown;
}

// Refactored ChatRoom class
export class ChatRoom {
  state: DurableObjectState;
  env: unknown;
  sessions: Map<string, ReadableStreamDefaultController>;
  users: Map<string, User>;
  history: Message[];
  historyBytes: number;
  encoder: TextEncoder;
  rateBuckets: Map<string, { count: number; start: number }>;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.users = new Map();
    this.history = [];
    this.historyBytes = 0;
    this.encoder = new TextEncoder();
    this.rateBuckets = new Map();

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Message[]>("history");
      this.history = stored || [];
      this.history.forEach(msg => this.historyBytes += this.messageSizeBytes(msg));
    });
  }

  // Improved rate limiting
  isRateLimited(userId: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(userId) ?? { count: 0, start: now };
    if (now - bucket.start > RATE_LIMIT_WINDOW_MS) {
      bucket.count = 0;
      bucket.start = now;
    }
    bucket.count++;
    this.rateBuckets.set(userId, bucket);
    return bucket.count > RATE_LIMIT_MAX;
  }
  
  // More robust message size calculation
  messageSizeBytes(msg: unknown): number {
    try {
      return this.encoder.encode(JSON.stringify(msg)).length;
    } catch {
      return 0;
    }
  }

  // Optimized history management
  pushHistory(msg: Message): void {
    const size = this.messageSizeBytes(msg);
    if (size === 0) return;

    this.history.push(msg);
    this.historyBytes += size;

    while (this.historyBytes > MAX_HISTORY_BYTES && this.history.length > 0) {
      const removed = this.history.shift();
      if (removed) {
        this.historyBytes -= this.messageSizeBytes(removed);
      }
    }
    this.state.storage.put("history", this.history);
  }

  // Main fetch handler, refactored for clarity
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }
    
    switch (path) {
      case PATHS.EVENTS:
        return this.handleEvents(request);
      case PATHS.HISTORY:
        return this.handleHistory();
      case PATHS.SIGNAL:
        if (request.method === "POST") {
          return this.handleSignal(request);
        }
        break; // Fall through to 404
    }

    return new Response("Not Found", { status: 404 });
  }

  // SSE handler
  handleEvents(request: Request): Response {
    const userId = `user_${crypto.randomUUID().split('-')[0]}`;
    const nickname = this.generateRandomNickname();

    let pingTimer: unknown;

    const stream = new ReadableStream({
      start: (controller) => {
        this.sessions.set(userId, controller);
        this.users.set(userId, { userId, nickname });

        controller.enqueue(this.encoder.encode(":ok\n\n"));

        const initData = {
          type: EVENT_TYPES.SYSTEM_INIT,
          payload: {
            userId,
            nickname,
            history: this.history,
            users: Array.from(this.users.values()).filter(u => u.userId !== userId)
          }
        };
        this.sendEvent(controller, initData);

        this.broadcast({
          type: EVENT_TYPES.USER_JOINED,
          payload: { userId, nickname }
        }, userId);

        this.broadcast({ type: EVENT_TYPES.SYSTEM_ONLINE_COUNT, count: this.sessions.size });

        pingTimer = setInterval(() => {
          try {
            controller.enqueue(this.encoder.encode(":ping\n\n"));
          } catch (e) {
            clearInterval(pingTimer);
            this.removeSession(userId);
          }
        }, PING_INTERVAL_MS);
      },
      cancel: () => {
        clearInterval(pingTimer);
        this.removeSession(userId);
      }
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }
  
  // Session removal logic
  removeSession(userId: string) {
      this.sessions.delete(userId);
      this.users.delete(userId);
      this.broadcast({ type: EVENT_TYPES.USER_LEFT, payload: { userId } });
      this.broadcast({ type: EVENT_TYPES.SYSTEM_ONLINE_COUNT, count: this.sessions.size });
  }

  // History handler
  handleHistory(): Response {
    const result = { full: true, messages: this.history.slice(-100) };
    return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
  }

  // Signal handler with improved validation
  async handleSignal(request: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
    }
    
    const { type, payload, from } = body;

    if (!from || typeof from !== 'string' || !this.sessions.has(from)) {
      return new Response("Invalid session", { status: 401 });
    }
    if (this.isRateLimited(from)) {
      return new Response("Rate limit exceeded", { status: 429 });
    }

    const user = this.users.get(from);
    if (!user) {
      return new Response("User not found", { status: 404 });
    }

    switch (type) {
      case EVENT_TYPES.CHAT_MESSAGE:
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
          this.pushHistory(msg);
          this.broadcast({ type: EVENT_TYPES.CHAT_MESSAGE, payload: msg });
        }
        break;

      case EVENT_TYPES.UPDATE_NICKNAME:
        const newNick = payload?.nickname?.trim();
        const { publicKey } = payload;
        if (newNick && newNick.length <= NICKNAME_MAX_LENGTH) {
          user.nickname = newNick;
          if (publicKey) user.publicKey = publicKey; // Basic validation, could be improved
          this.broadcast({
              type: EVENT_TYPES.USER_UPDATED,
              payload: { userId: from, nickname: newNick, publicKey: user.publicKey }
          });
        }
        break;

      case EVENT_TYPES.SIGNAL:
        const { to, signal } = payload;
        const recipientController = this.sessions.get(to);
        if (recipientController) {
            this.sendEvent(recipientController, { type: EVENT_TYPES.SIGNAL, payload: { from, signal } });
        }
        break;
        
      default:
        // Optional: handle unknown event types
        break;
    }
    return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
  }
  
  // Utility to send a server-sent event
  sendEvent(controller: ReadableStreamDefaultController, data: unknown) {
      controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  }

  // Broadcast to all clients
  broadcast(data: unknown, excludeUserId: string | null = null): void {
    const msg = this.encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    for (const [userId, controller] of this.sessions.entries()) {
      if (userId !== excludeUserId) {
        try {
          controller.enqueue(msg);
        } catch (e) {
          this.removeSession(userId);
        }
      }
    }
  }

  // Nickname generator
  generateRandomNickname(): string {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    return `${adj}${noun}${num}`;
  }
}

// Default export refactored for clarity
export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    switch (url.pathname) {
      case PATHS.CONFIG:
        return new Response(JSON.stringify({ turnServers: [], signalToken: "", signalEndpoints: [PATHS.SIGNAL] }), {
          headers: JSON_HEADERS,
        });

      case PATHS.EVENTS:
      case PATHS.SIGNAL:
      case PATHS.HISTORY:
        const id = env.CHAT_ROOM.idFromName("global-chat");
        const stub = env.CHAT_ROOM.get(id);
        return stub.fetch(request);

      default:
        return env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
    }
  }
};
