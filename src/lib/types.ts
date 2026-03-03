export interface Message {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  timestamp: string;
  isEncrypted?: boolean;
}

export interface User {
  userId: string;
  nickname: string;
  publicKey?: string;
}

export interface SignalPayload {
  to?: string;
  signal?: any;
  text?: string;
  id?: string;
  nickname?: string;
  publicKey?: string;
  timestamp?: string;
  isEncrypted?: boolean;
  token?: string;
}

export interface Signal {
  type: string;
  payload: SignalPayload;
  from?: string;
}

export interface AppState {
  users: Map<string, User>;
  messages: Message[];
  messagesBytes: number;
}
