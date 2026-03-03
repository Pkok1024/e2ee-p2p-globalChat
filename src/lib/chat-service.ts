import { Message, User, Signal } from "./types.js";
import { HistoryManager, generateRandomNickname, uuid } from "./core.js";

export interface ChatBroadcaster {
  broadcast(data: any, excludeUserId?: string | null): void;
  sendTo(userId: string, data: any): void;
}

export const MESSAGE_MAX_LENGTH = 2000;
export const NICKNAME_MAX_LENGTH = 20;
export const PUBLIC_KEY_MAX_LENGTH = 1000;

export class ChatService {
  private users_ = new Map<string, User>();
  private history_: HistoryManager;
  private broadcaster_: ChatBroadcaster;

  constructor(broadcaster: ChatBroadcaster, maxHistoryBytes: number) {
    this.broadcaster_ = broadcaster;
    this.history_ = new HistoryManager(maxHistoryBytes);
  }

  addUser(userId: string, nickname?: string): User {
    const user: User = {
      userId,
      nickname: nickname || generateRandomNickname()
    };
    this.users_.set(userId, user);
    return user;
  }

  removeUser(userId: string): void {
    this.users_.delete(userId);
  }

  getUser(userId: string): User | undefined {
    return this.users_.get(userId);
  }

  getAllUsers(): User[] {
    return Array.from(this.users_.values());
  }

  getHistory(limit: number = 100): Message[] {
    return this.history_.getMessages().slice(-limit);
  }

  broadcastPresence(type: "USER_JOINED" | "USER_LEFT" | "SYSTEM_ONLINE_COUNT", payload: any, excludeUserId: string | null = null): void {
    this.broadcaster_.broadcast({ type, payload }, excludeUserId);
  }

  handleSignal(from: string, signal: Signal): { success: boolean; error?: string } {
    const user = this.users_.get(from);
    if (!user) return { success: false, error: "User not found" };

    const { type, payload } = signal;
    if (!payload) return { success: false, error: "Missing payload" };

    switch (type) {
      case "CHAT_MESSAGE": {
        const text = payload.text?.trim();
        if (text && text.length <= MESSAGE_MAX_LENGTH) {
          const msg: Message = {
            id: payload.id || uuid(),
            userId: from,
            nickname: user.nickname,
            text,
            timestamp: payload.timestamp || new Date().toISOString(),
            isEncrypted: !!payload.isEncrypted
          };
          this.history_.push(msg);
          this.broadcaster_.broadcast({ type: "CHAT_MESSAGE", payload: msg }, from);
        }
        break;
      }

      case "UPDATE_NICKNAME": {
        const newNick = payload.nickname?.trim();
        if (newNick && newNick.length <= NICKNAME_MAX_LENGTH) {
          const oldNickname = user.nickname;
          user.nickname = newNick;
          const pk = payload.publicKey;
          if (pk && typeof pk === "string" && pk.length <= PUBLIC_KEY_MAX_LENGTH) {
            user.publicKey = pk;
          }
          this.broadcaster_.broadcast({
            type: "USER_UPDATED",
            payload: { userId: from, nickname: newNick, publicKey: user.publicKey }
          });
          this.broadcaster_.broadcast({
            type: "SYSTEM_NOTIFICATION",
            payload: { text: `${oldNickname} changed their nickname to ${newNick}` }
          }, from);
        }
        break;
      }

      case "SIGNAL": {
        const { to, signal: rtcSignal } = payload;
        if (to) {
          this.broadcaster_.sendTo(to, { type: "SIGNAL", payload: { from, signal: rtcSignal } });
        }
        break;
      }

      default:
        break;
    }

    return { success: true };
  }

  adminReset(match: boolean): boolean {
    if (match) {
      this.history_.clear();
      this.broadcaster_.broadcast({ type: "SYSTEM_NOTIFICATION", payload: { text: "Chat history cleared" } });
      this.broadcaster_.broadcast({ type: "CHAT_CLEARED" });
      return true;
    }
    return false;
  }

  get onlineCount(): number {
    return this.users_.size;
  }
}
