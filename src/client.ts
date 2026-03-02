/**
 * P2P WebRTC E2EE Chat Client
 */

let config_ = { turnServers: [] as RTCIceServer[], signalToken: "", signalEndpoints: ["/signal"] };
const currentUser_ = { id: "", nick: "" };
let allUsers_ : any[] = [];
const peers_ = new Map<string, any>();
const seenMessages_ = new Set<string>();
let keyPair_: CryptoKeyPair;
let groupKey_: CryptoKey | null = null;
const GOSSIP_TTL_ = 3;
const gossipFanout_ = 3;
let localStream_: MediaStream | null = null;

function removeEmptyState_() {
    const el = document.getElementById("emptyState");
    if (el) el.remove();
}

function ab2b64_(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b642ab_(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

async function setupCrypto_(): Promise<string> {
    keyPair_ = await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true, ["encrypt", "decrypt"]
    );
    const pub = await crypto.subtle.exportKey("spki", keyPair_.publicKey);
    const savedKey = localStorage.getItem("chat_group_key");
    if (savedKey) {
        try {
            groupKey_ = await crypto.subtle.importKey("raw", b642ab_(savedKey), "AES-GCM", true, ["encrypt", "decrypt"]);
        } catch(e) { localStorage.removeItem("chat_group_key"); }
    }
    if (!groupKey_) {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        groupKey_ = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
        localStorage.setItem("chat_group_key", ab2b64_(raw));
    }
    document.getElementById("e2eeStatus")!.classList.remove("opacity-0");
    return ab2b64_(pub);
}

async function encryptPayload_(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, groupKey_!, new TextEncoder().encode(text));
    const combined = new Uint8Array(iv.length + enc.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(enc), iv.length);
    return ab2b64_(combined.buffer);
}

async function decryptPayload_(base64: string): Promise<string | null> {
    if (!groupKey_) return null;
    try {
        const data = b642ab_(base64);
        const iv = data.slice(0, 12);
        const enc = data.slice(12);
        const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, groupKey_, enc);
        return new TextDecoder().decode(dec);
    } catch (e) { return null; }
}

async function postSignal_(type: string, payload: any): Promise<void> {
    const endpoint = config_.signalEndpoints[Math.floor(Math.random() * config_.signalEndpoints.length)];
    try {
        await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-signal-token": config_.signalToken },
            body: JSON.stringify({ type, payload, from: currentUser_.id })
        });
    } catch (e) {}
}

function renderMessage_(nick: string, text: string, isSelf: boolean): void {
    const div = document.createElement("div");
    div.className = `flex flex-col ${isSelf ? "items-end" : "items-start"}`;
    const inner = `
        <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-bold text-white/50">${nick}</span>
        </div>
        <div class="px-4 py-2 rounded-2xl ${isSelf ? "bubble-self" : "bubble-other"} max-w-[85%] break-words">
            <p class="text-sm">${text}</p>
        </div>
    `;
    div.innerHTML = inner;
    const chat = document.getElementById("chatWindow")!;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    removeEmptyState_();
}

function renderPlaceholder_(nick: string): void {
    const div = document.createElement("div");
    div.className = "text-center text-[10px] text-white/20 italic my-1";
    div.textContent = `[Encrypted message from ${nick}]`;
    const chat = document.getElementById("chatWindow")!;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    removeEmptyState_();
}

async function shareKeyWithPeer_(userId: string): Promise<void> {
    const user = allUsers_.find(u => u.userId === userId);
    if (!user?.publicKey || !groupKey_) return;
    try {
        const raw = await crypto.subtle.exportKey("raw", groupKey_);
        const pub = await crypto.subtle.importKey("spki", b642ab_(user.publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const enc = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
        postSignal_("SIGNAL", { to: userId, signal: { groupKey: ab2b64_(enc) } });
    } catch(e) {}
}

function pickFanoutPeers_(exclude: string | null, count: number): string[] {
    let pool = Array.from(peers_.keys()).filter(id => id !== exclude && peers_.get(id).dc?.readyState === "open");
    const result: string[] = [];
    for (let i = 0; i < count && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        result.push(pool.splice(idx, 1)[0]);
    }
    return result;
}

async function startPeerConnection_(peerId: string, initiator: boolean): Promise<void> {
    if (peers_.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: config_.turnServers });
    const pObj = { pc, dc: null as any };
    peers_.set(peerId, pObj);

    pc.onicecandidate = (e) => { if (e.candidate) postSignal_("SIGNAL", { to: peerId, signal: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
        const audio = document.createElement("audio");
        audio.srcObject = e.streams[0]; audio.autoplay = true;
        document.getElementById("audioContainer")!.appendChild(audio);
    };

    if (localStream_) localStream_.getTracks().forEach(t => pc.addTrack(t, localStream_!));

    const setupDC = (dc: RTCDataChannel) => {
        pObj.dc = dc;
        dc.onopen = () => { refreshTopology_(); shareKeyWithPeer_(peerId); };
        dc.onclose = () => { peers_.delete(peerId); refreshTopology_(); };
        dc.onmessage = async (e) => {
            if (typeof e.data === "string") {
                const msg = JSON.parse(e.data);
                if (seenMessages_.has(msg.id)) return;
                seenMessages_.add(msg.id);
                if (msg.ttl > 0) {
                    msg.ttl--;
                    pickFanoutPeers_(peerId, gossipFanout_).forEach(tid => {
                        const target = peers_.get(tid);
                        if (target?.dc?.readyState === "open") target.dc.send(JSON.stringify(msg));
                    });
                }
                if (msg.type === "TEXT") {
                    const text = await decryptPayload_(msg.payload);
                    if (text) renderMessage_(msg.nick, text, false);
                    else renderPlaceholder_(msg.nick);
                }
            }
        };
    };

    if (initiator) {
        setupDC(pc.createDataChannel("chat", { ordered: true }));
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        postSignal_("SIGNAL", { to: peerId, signal: { sdp: pc.localDescription } });
    } else {
        pc.ondatachannel = (e) => setupDC(e.channel);
    }
}

function refreshTopology_(): void {
    allUsers_.forEach(u => {
        if (u.userId !== currentUser_.id && !peers_.has(u.userId)) {
            if (currentUser_.id < u.userId) startPeerConnection_(u.userId, true);
        }
    });
    const openPeers = Array.from(peers_.values()).filter(p => p.dc?.readyState === "open").length;
    document.getElementById("nodeRole")!.textContent = openPeers > 1 ? "Hub" : "Leaf";
    document.getElementById("netStats")!.textContent = `Mesh: ${openPeers} Conns`;
}

async function renderHistoryMessages_(messages: any[]): Promise<void> {
    for (const m of messages) {
        if (m.text) {
            const dec = await decryptPayload_(m.text);
            if (dec) renderMessage_(m.nickname || "User", dec, m.userId === currentUser_.id);
            else renderPlaceholder_(m.nickname || "User");
        }
    }
}

async function refreshHistory_() {
    const chat = document.getElementById("chatWindow")!;
    chat.innerHTML = "";
    const res = await fetch("/history");
    const hist = await res.json();
    if (hist.messages) await renderHistoryMessages_(hist.messages);
}

async function startApp_() {
    const pk = await setupCrypto_();

    // SSE First
    const eventSource = new EventSource("/events");
    eventSource.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        switch (data.type) {
            case "SYSTEM_INIT":
                currentUser_.id = data.payload.userId; currentUser_.nick = data.payload.nickname;
                (document.getElementById("nicknameInput") as HTMLInputElement).value = currentUser_.nick;
                allUsers_ = [{ userId: currentUser_.id, nickname: currentUser_.nick, publicKey: pk }, ...data.payload.users];
                postSignal_("UPDATE_NICKNAME", { nickname: currentUser_.nick, publicKey: pk });

                removeEmptyState_(); // Transition immediately

                if (data.payload.history) await renderHistoryMessages_(data.payload.history);
                refreshTopology_();
                break;
            case "USER_JOINED":
                allUsers_.push(data.payload); refreshTopology_(); break;
            case "USER_UPDATED":
                const user = allUsers_.find(u => u.userId === data.payload.userId);
                if (user) {
                    user.nickname = data.payload.nickname;
                    if (data.payload.publicKey) {
                        user.publicKey = data.payload.publicKey;
                        shareKeyWithPeer_(user.userId);
                    }
                }
                refreshTopology_(); break;
            case "USER_LEFT":
                allUsers_ = allUsers_.filter(u => u.userId !== data.payload.userId); refreshTopology_(); break;
            case "CHAT_MESSAGE":
                if (seenMessages_.has(data.payload.id)) return;
                seenMessages_.add(data.payload.id);
                const dec = await decryptPayload_(data.payload.text);
                if (dec) renderMessage_(data.payload.nickname, dec, false);
                else renderPlaceholder_(data.payload.nickname);
                break;
            case "SIGNAL":
                const { from, signal } = data.payload;
                if (signal.sdp) {
                    const peer = peers_.get(from) || await (async () => { await startPeerConnection_(from, false); return peers_.get(from); })();
                    await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    if (signal.sdp.type === 'offer') {
                        const ans = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(ans);
                        postSignal_("SIGNAL", { to: from, signal: { sdp: peer.pc.localDescription } });
                    }
                } else if (signal.candidate) {
                    peers_.get(from)?.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(()=>{});
                } else if (signal.groupKey) {
                    try {
                        const dec = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keyPair_.privateKey, b642ab_(signal.groupKey));
                        groupKey_ = await crypto.subtle.importKey("raw", dec, "AES-GCM", true, ["encrypt", "decrypt"]);
                        localStorage.setItem("chat_group_key", ab2b64_(dec));
                        await refreshHistory_();
                    } catch(e) {}
                }
                break;
            case "SYSTEM_ONLINE_COUNT":
                document.getElementById("onlineCount")!.textContent = `${data.count} Nodes Active`; break;
            case "CHAT_CLEARED":
                document.getElementById("chatWindow")!.innerHTML = ""; break;
        }
    };

    // Config Second
    try {
        const res = await fetch("/config");
        config_ = await res.json();
    } catch(e) {}
}

startApp_();

(document.getElementById("chatForm") as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById("messageInput") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !groupKey_) return;
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const encrypted = await encryptPayload_(text);
    renderMessage_("You", text, true);
    seenMessages_.add(id);
    const gossipMsg = { type: "TEXT", id, nick: currentUser_.nick, payload: encrypted, timestamp: new Date().toISOString(), ttl: GOSSIP_TTL_ };
    pickFanoutPeers_(null, gossipFanout_).forEach(pid => {
        const target = peers_.get(pid);
        if (target?.dc?.readyState === "open") target.dc.send(JSON.stringify(gossipMsg));
    });
    postSignal_("CHAT_MESSAGE", { id, text: encrypted, isEncrypted: true });
    input.value = "";
};

document.getElementById("nicknameInput")!.onchange = async () => {
    const val = (document.getElementById("nicknameInput") as HTMLInputElement).value.trim();
    if (val && val.length <= 20) {
        currentUser_.nick = val;
        postSignal_("UPDATE_NICKNAME", { nickname: val, publicKey: ab2b64_(await crypto.subtle.exportKey("spki", keyPair_.publicKey)) });
    }
};
