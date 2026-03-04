/**
 * P2P WebRTC E2EE Chat Client - Refactored for SOLID and Performance
 */

import { Signal, User, Message } from "./lib/types.js";

// --- Types & Interfaces ---

interface ClientConfig {
    turnServers: RTCIceServer[];
    signalToken: string;
    signalEndpoints: string[];
}

// --- Utilities ---

const ab2b64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b642ab = (base64: string): ArrayBuffer => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
};

/**
 * Message Deduplicator with fixed-size LRU-like buffer.
 * Prevents memory leaks in long-running sessions.
 * @complexity O(1) for checks and insertions.
 */
class MessageDeduplicator {
    private seen = new Set<string>();
    private queue: string[] = [];
    private readonly maxSize: number;

    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
    }

    isDuplicate(id: string): boolean {
        if (this.seen.has(id)) return true;
        this.seen.add(id);
        this.queue.push(id);
        if (this.queue.length > this.maxSize) {
            const old = this.queue.shift();
            if (old) this.seen.delete(old);
        }
        return false;
    }

    clear() {
        this.seen.clear();
        this.queue = [];
    }
}

// --- UI Layer ---

class UIManager {
    private chatWindow = document.getElementById("chatWindow")!;
    private emptyState = document.getElementById("emptyState");
    private netStats = document.getElementById("netStats")!;
    private nodeRole = document.getElementById("nodeRole")!;
    private onlineCount = document.getElementById("onlineCount")!;
    private e2eeStatus = document.getElementById("e2eeStatus")!;

    removeEmptyState() {
        if (this.emptyState) {
            this.emptyState.remove();
            this.emptyState = null;
        }
    }

    renderMessage(nick: string, text: string, isSelf: boolean) {
        const div = document.createElement("div");
        div.className = `flex flex-col ${isSelf ? "items-end" : "items-start"}`;

        const headerDiv = document.createElement("div");
        headerDiv.className = "flex items-center gap-2 mb-1";
        const nickSpan = document.createElement("span");
        nickSpan.className = "text-xs font-bold text-white/50";
        nickSpan.textContent = nick;
        headerDiv.appendChild(nickSpan);

        const bubbleDiv = document.createElement("div");
        bubbleDiv.className = `px-4 py-2 rounded-2xl ${isSelf ? "bubble-self" : "bubble-other"} max-w-[85%] break-words`;
        const textP = document.createElement("p");
        textP.className = "text-sm";
        textP.textContent = text;
        bubbleDiv.appendChild(textP);

        div.appendChild(headerDiv);
        div.appendChild(bubbleDiv);

        this.chatWindow.appendChild(div);
        this.chatWindow.scrollTop = this.chatWindow.scrollHeight;
        this.removeEmptyState();
    }

    renderPlaceholder(nick: string) {
        const div = document.createElement("div");
        div.className = "text-center text-[10px] text-white/20 italic my-1";
        div.textContent = `[Encrypted message from ${nick}]`;
        this.chatWindow.appendChild(div);
        this.chatWindow.scrollTop = this.chatWindow.scrollHeight;
        this.removeEmptyState();
    }

    updateStats(openPeers: number) {
        this.nodeRole.textContent = openPeers > 1 ? "Hub" : "Leaf";
        this.netStats.textContent = `Mesh: ${openPeers} Conns`;
    }

    updateOnlineCount(count: number) {
        this.onlineCount.textContent = `${count} Nodes Active`;
    }

    showE2EE() {
        this.e2eeStatus.classList.remove("opacity-0");
    }

    clearChat() {
        this.chatWindow.innerHTML = "";
    }
}

// --- Mesh Controller ---

class MeshController {
    private peers = new Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel | null }>();
    private deduplicator = new MessageDeduplicator();
    private groupKey: CryptoKey | null = null;
    private keyPair!: CryptoKeyPair;
    private config: ClientConfig = { turnServers: [], signalToken: "", signalEndpoints: ["/signal"] };
    private currentUser = { id: "", nick: "" };
    private allUsers: User[] = [];
    private ui: UIManager;

    private readonly GOSSIP_TTL = 3;
    private readonly GOSSIP_FANOUT = 3;

    constructor(ui: UIManager) {
        this.ui = ui;
    }

    async init() {
        await this.setupCrypto();
        await this.fetchConfig();
        this.setupSSE();
    }

    private async setupCrypto() {
        this.keyPair = await crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true, ["encrypt", "decrypt"]
        );
        const savedKey = localStorage.getItem("chat_group_key");
        if (savedKey) {
            try {
                this.groupKey = await crypto.subtle.importKey("raw", b642ab(savedKey), "AES-GCM", true, ["encrypt", "decrypt"]);
            } catch(e) { localStorage.removeItem("chat_group_key"); }
        }
        if (!this.groupKey) {
            const raw = crypto.getRandomValues(new Uint8Array(32));
            this.groupKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
            localStorage.setItem("chat_group_key", ab2b64(raw));
        }
        this.ui.showE2EE();
    }

    private async fetchConfig() {
        try {
            const res = await fetch("/config");
            this.config = await res.json();
        } catch(e) {}
    }

    private setupSSE() {
        const es = new EventSource("/events");
        es.onmessage = (e) => this.handleSystemEvent(JSON.parse(e.data));
    }

    private async handleSystemEvent(data: unknown) {
        const { type, payload } = data;
        switch (type) {
            case "SYSTEM_INIT":
                this.currentUser.id = payload.userId;
                this.currentUser.nick = payload.nickname;
                (document.getElementById("nicknameInput") as HTMLInputElement).value = this.currentUser.nick;
                this.allUsers = [{ userId: this.currentUser.id, nickname: this.currentUser.nick, publicKey: ab2b64(await crypto.subtle.exportKey("spki", this.keyPair.publicKey)) }, ...payload.users];
                void this.postSignal("UPDATE_NICKNAME", { nickname: this.currentUser.nick, publicKey: ab2b64(await crypto.subtle.exportKey("spki", this.keyPair.publicKey)) });
                if (payload.history) await this.renderHistory(payload.history);
                this.refreshTopology();
                break;
            case "USER_JOINED":
                this.allUsers.push(payload); this.refreshTopology(); break;
            case "USER_UPDATED":
                const u = this.allUsers.find(x => x.userId === payload.userId);
                if (u) {
                    u.nickname = payload.nickname;
                    if (payload.publicKey) {
                        u.publicKey = payload.publicKey;
                        void this.shareKeyWithPeer(u.userId);
                    }
                }
                this.refreshTopology(); break;
            case "USER_LEFT":
                this.allUsers = this.allUsers.filter(x => x.userId !== payload.userId);
                this.peers.get(payload.userId)?.pc.close();
                this.peers.delete(payload.userId);
                this.refreshTopology(); break;
            case "CHAT_MESSAGE":
                void this.handleIncomingMessage(payload); break;
            case "SIGNAL":
                void this.handleRTCSignal(payload); break;
            case "SYSTEM_ONLINE_COUNT":
                this.ui.updateOnlineCount(data.payload ?? data.count); break;
            case "CHAT_CLEARED":
                this.ui.clearChat(); this.deduplicator.clear(); break;
        }
    }

    private async handleIncomingMessage(msg: unknown) {
        if (this.deduplicator.isDuplicate(msg.id)) return;
        const dec = await this.decryptPayload(msg.text);
        if (dec) this.ui.renderMessage(msg.nickname, dec, msg.userId === this.currentUser.id);
        else this.ui.renderPlaceholder(msg.nickname);
    }

    private async handleRTCSignal(payload: unknown) {
        const { from, signal } = payload;
        if (signal.sdp) {
            let peer = this.peers.get(from);
            if (!peer) { await this.startConnection(from, false); peer = this.peers.get(from)!; }
            await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            if (signal.sdp.type === 'offer') {
                const ans = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(ans);
                void this.postSignal("SIGNAL", { to: from, signal: { sdp: peer.pc.localDescription } });
            }
        } else if (signal.candidate) {
            this.peers.get(from)?.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(()=>{});
        } else if (signal.groupKey) {
            try {
                const dec = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, this.keyPair.privateKey, b642ab(signal.groupKey));
                this.groupKey = await crypto.subtle.importKey("raw", dec, "AES-GCM", true, ["encrypt", "decrypt"]);
                localStorage.setItem("chat_group_key", ab2b64(dec));
                this.ui.clearChat();
                const res = await fetch("/history");
                const hist = await res.json();
                await this.renderHistory(hist.messages);
            } catch(e) {}
        }
    }

    private async startConnection(peerId: string, initiator: boolean) {
        if (this.peers.has(peerId)) return;
        const pc = new RTCPeerConnection({ iceServers: this.config.turnServers });
        const pObj = { pc, dc: null as unknown };
        this.peers.set(peerId, pObj);

        pc.onicecandidate = (e) => { if (e.candidate) void this.postSignal("SIGNAL", { to: peerId, signal: { candidate: e.candidate } }); };

        const setupDC = (dc: RTCDataChannel) => {
            pObj.dc = dc;
            dc.onopen = () => { this.ui.updateStats(this.getOpenPeerCount()); void this.shareKeyWithPeer(peerId); };
            dc.onclose = () => { this.peers.delete(peerId); this.ui.updateStats(this.getOpenPeerCount()); };
            dc.onmessage = async (e) => {
                const msg = JSON.parse(e.data);
                if (this.deduplicator.isDuplicate(msg.id)) return;
                if (msg.ttl > 0) {
                    msg.ttl--;
                    this.pickFanoutPeers(peerId, this.GOSSIP_FANOUT).forEach(tid => {
                        const target = this.peers.get(tid);
                        if (target?.dc?.readyState === "open") target.dc.send(JSON.stringify(msg));
                    });
                }
                if (msg.type === "TEXT") {
                    const text = await this.decryptPayload(msg.payload);
                    if (text) this.ui.renderMessage(msg.nick, text, false);
                    else this.ui.renderPlaceholder(msg.nick);
                }
            };
        };

        if (initiator) {
            setupDC(pc.createDataChannel("chat", { ordered: true }));
            const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            void this.postSignal("SIGNAL", { to: peerId, signal: { sdp: pc.localDescription } });
        } else {
            pc.ondatachannel = (e) => { setupDC(e.channel); };
        }
    }

    private refreshTopology() {
        this.allUsers.forEach(u => {
            if (u.userId !== this.currentUser.id && !this.peers.has(u.userId)) {
                if (this.currentUser.id < u.userId) void this.startConnection(u.userId, true);
            }
        });
        this.ui.updateStats(this.getOpenPeerCount());
    }

    private getOpenPeerCount() {
        return Array.from(this.peers.values()).filter(p => p.dc?.readyState === "open").length;
    }

    private async shareKeyWithPeer(userId: string) {
        const user = this.allUsers.find(u => u.userId === userId);
        if (!user?.publicKey || !this.groupKey) return;
        try {
            const raw = await crypto.subtle.exportKey("raw", this.groupKey);
            const pub = await crypto.subtle.importKey("spki", b642ab(user.publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
            const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
            void this.postSignal("SIGNAL", { to: userId, signal: { groupKey: ab2b64(enc) } });
        } catch(e) {}
    }

    private pickFanoutPeers(exclude: string | null, count: number): string[] {
        let pool = Array.from(this.peers.keys()).filter(id => id !== exclude && this.peers.get(id).dc?.readyState === "open");
        const result: string[] = [];
        for (let i = 0; i < count && pool.length; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            result.push(pool.splice(idx, 1)[0]);
        }
        return result;
    }

    async sendMessage(text: string) {
        if (!text || !this.groupKey) return;
        const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const encrypted = await this.encryptPayload(text);
        this.ui.renderMessage("You", text, true);
        this.deduplicator.isDuplicate(id); // mark as seen
        const gossipMsg = { type: "TEXT", id, nick: this.currentUser.nick, payload: encrypted, timestamp: new Date().toISOString(), ttl: this.GOSSIP_TTL };
        this.pickFanoutPeers(null, this.GOSSIP_FANOUT).forEach(pid => {
            const target = this.peers.get(pid);
            if (target?.dc?.readyState === "open") target.dc.send(JSON.stringify(gossipMsg));
        });
        void this.postSignal("CHAT_MESSAGE", { id, text: encrypted, isEncrypted: true });
    }

    async updateNickname(nick: string) {
        if (nick && nick.length <= 20) {
            this.currentUser.nick = nick;
            void this.postSignal("UPDATE_NICKNAME", { nickname: nick, publicKey: ab2b64(await crypto.subtle.exportKey("spki", this.keyPair.publicKey)) });
        }
    }

    private async encryptPayload(text: string): Promise<string> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.groupKey!, new TextEncoder().encode(text));
        const combined = new Uint8Array(iv.length + enc.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(enc), iv.length);
        return ab2b64(combined.buffer);
    }

    private async decryptPayload(base64: string): Promise<string | null> {
        if (!this.groupKey) return null;
        try {
            const data = b642ab(base64);
            const iv = data.slice(0, 12);
            const enc = data.slice(12);
            const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.groupKey, enc);
            return new TextDecoder().decode(dec);
        } catch (e) { return null; }
    }

    private async renderHistory(messages: Message[]) {
        for (const m of messages) {
            const dec = await this.decryptPayload(m.text);
            if (dec) this.ui.renderMessage(m.nickname, dec, m.userId === this.currentUser.id);
            else this.ui.renderPlaceholder(m.nickname);
        }
    }

    private async postSignal(type: string, payload: unknown) {
        const endpoint = this.config.signalEndpoints[Math.floor(Math.random() * this.config.signalEndpoints.length)];
        try {
            await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-signal-token": this.config.signalToken },
                body: JSON.stringify({ type, payload, from: this.currentUser.id })
            });
        } catch (e) {}
    }
}

// --- Bootstrap ---

const ui = new UIManager();
const mesh = new MeshController(ui);

void mesh.init();

(document.getElementById("chatForm") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("messageInput") as HTMLInputElement;
    void mesh.sendMessage(input.value.trim());
    input.value = "";
};

document.getElementById("nicknameInput")?.onchange = (e) => {
    void mesh.updateNickname((e.target as HTMLInputElement).value.trim());
};
