import * as rl from "./lib/rate-limiter.js";
import { workerVerifyCookie, workerBuildSetCookie, workerTimingSafeMatch } from "./lib/cookie.js";
import { renderGate } from "./lib/token-gate.html.js";
import { ChatService, ChatBroadcaster } from "./lib/chat-service.js";
import { Signal } from "./lib/types.js";

class WorkerBroadcaster implements ChatBroadcaster {
  constructor(private sessions: Map<string, ReadableStreamDefaultController>) {}

  broadcast(data: any, excludeUserId: string | null = null): void {
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
    for (const [userId, controller] of this.sessions.entries()) {
      if (userId !== excludeUserId) {
        try { controller.enqueue(payload); } catch { this.sessions.delete(userId); }
      }
    }
  }

  sendTo(userId: string, data: any): void {
    const controller = this.sessions.get(userId);
    if (controller) {
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch { this.sessions.delete(userId); }
    }
  }
}

export class ChatRoom {
  private service: ChatService;
  private sessions = new Map<string, ReadableStreamDefaultController>();
  private rateBuckets = new Map<string, { count: number; start: number }>;
  private readonly RATE_LIMIT_WINDOW_MS = 10_000;
  private readonly RATE_LIMIT_MAX = 200;

  constructor(private state: DurableObjectState, private env: any) {
    const broadcaster = new WorkerBroadcaster(this.sessions);
    this.service = new ChatService(broadcaster, 12 * 1024 * 1024);

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<any[]>("history");
      if (stored) {
        stored.forEach(m => (this.service as any).history_.push(m));
      }
    });
  }

  private rateLimitOk(userId: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(userId) || { count: 0, start: now };
    if (now - bucket.start > this.RATE_LIMIT_WINDOW_MS) {
      bucket.count = 0;
      bucket.start = now;
    }
    bucket.count += 1;
    this.rateBuckets.set(userId, bucket);
    return bucket.count <= this.RATE_LIMIT_MAX;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/events") {
      const userId = `user_${crypto.randomUUID().split('-')[0]}`;
      const user = this.service.addUser(userId);
      let pingTimer: any;

      const stream = new ReadableStream({
        start: (controller) => {
          this.sessions.set(userId, controller);
          controller.enqueue(new TextEncoder().encode(":ok\n\n"));
          const initData = {
            type: "SYSTEM_INIT",
            payload: {
              userId,
              nickname: user.nickname,
              history: this.service.getHistory(100),
              users: this.service.getAllUsers().filter(u => u.userId !== userId)
            }
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(initData)}\n\n`));

          this.service.broadcastPresence("USER_JOINED", { userId, nickname: user.nickname }, userId);
          this.service.broadcastPresence("SYSTEM_ONLINE_COUNT", this.service.onlineCount);

          pingTimer = setInterval(() => {
            try { controller.enqueue(new TextEncoder().encode(":ping\n\n")); } catch { clearInterval(pingTimer); }
          }, 15000);
        },
        cancel: () => {
          clearInterval(pingTimer);
          this.sessions.delete(userId);
          this.service.removeUser(userId);
          this.service.broadcastPresence("USER_LEFT", { userId });
          this.service.broadcastPresence("SYSTEM_ONLINE_COUNT", this.service.onlineCount);
        }
      });

      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
      });
    }

    if (url.pathname === "/history") {
      return new Response(JSON.stringify({ full: true, messages: this.service.getHistory(100) }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/signal" && request.method === "POST") {
      const signal: Signal = await request.json();
      if (signal.type === "ADMIN_RESET") {
        const match = await workerTimingSafeMatch(signal.payload?.token || "", this.env.ADMIN_TOKEN || "");
        if (this.service.adminReset(match)) {
          this.state.storage.delete("history");
          return new Response(JSON.stringify({ success: true }));
        }
        return new Response("Unauthorized", { status: 401 });
      }

      if (!signal.from || !this.sessions.has(signal.from)) return new Response("Invalid session", { status: 401 });
      if (!this.rateLimitOk(signal.from)) return new Response("Rate limit", { status: 429 });

      const result = this.service.handleSignal(signal.from, signal);
      if (!result.success) return new Response(result.error, { status: 400 });

      this.state.storage.put("history", this.service.getHistory(500));
      return new Response(JSON.stringify({ success: true }));
    }

    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (method === "GET" && url.pathname === "/gate") {
      const { allowed, waitMs } = rl.check(ip);
      return new Response(renderGate({ waitUntil: allowed ? 0 : Date.now() + waitMs }), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (method === "POST" && url.pathname === "/verify-token") {
      const { allowed, waitMs } = rl.check(ip);
      if (!allowed) return new Response(JSON.stringify({ ok: false, waitMs }), { status: 429 });

      const body = await request.text();
      const params = new URLSearchParams(body);
      const token = params.get("token")?.trim();

      const match = await workerTimingSafeMatch(token || "", env.COMMUNITY_TOKEN || "");
      if (match) {
        rl.recordSuccess(ip);
        const setCookie = await workerBuildSetCookie(env.COMMUNITY_TOKEN, env.TOKEN_COOKIE_SECRET);
        return new Response(JSON.stringify({ ok: true, redirect: "/" }), {
          headers: { "Set-Cookie": setCookie, "Content-Type": "application/json" },
        });
      }
      rl.recordFailure(ip);
      return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }

    const cookieHeader = request.headers.get("Cookie") || "";
    if (!(await workerVerifyCookie(cookieHeader, env.COMMUNITY_TOKEN, env.TOKEN_COOKIE_SECRET))) {
      return Response.redirect(new URL("/gate", request.url).toString(), 302);
    }

    if (url.pathname === "/config") {
      return new Response(JSON.stringify({ turnServers: [], signalToken: "", signalEndpoints: ["/signal"] }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (["/events", "/signal", "/history"].includes(url.pathname)) {
      const id = env.CHAT_ROOM.idFromName("global-chat");
      return env.CHAT_ROOM.get(id).fetch(request);
    }

    return env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  }
};
