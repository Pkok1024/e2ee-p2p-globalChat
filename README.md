# P2P E2EE Mesh Chat

A real-time, privacy-focused chat application leveraging a WebRTC P2P mesh network with End-to-End Encryption (E2EE). This project demonstrates a robust, decentralized communication system with dual signaling backend support.

## 🚀 Features

- **P2P Mesh Network**: Direct client-to-client communication using WebRTC, reducing server load and enhancing privacy.
- **End-to-End Encryption**:
  - **Key Exchange**: RSA-OAEP (2048-bit) for secure sharing of the group key.
  - **Payload Encryption**: AES-GCM (256-bit) for encrypting all text, images, and metadata.
- **Multi-modal Communication**:
  - **Encrypted Text**: Real-time messaging with message history.
  - **P2P Image Sharing**: Secure, chunked file transfer directly between peers.
  - **Voice Chat**: Real-time audio communication via WebRTC MediaStreams.
- **Dual Signaling Support**:
  - **Node.js**: A classic Express-based server using Server-Sent Events (SSE) for signaling.
  - **Cloudflare Workers**: A serverless implementation using Durable Objects for high-availability signaling.
- **Privacy First**: No messages are stored on the server in plain text. Signalling servers only facilitate peer discovery and encrypted key exchange.
- **Admin Controls**: Securely clear chat history via a protected administrative reset.

## 🛠 Tech Stack

- **Frontend**: HTML5, Tailwind CSS, WebRTC API, Web Crypto API.
- **Signaling (Node.js)**: Node.js, Express, Server-Sent Events (SSE).
- **Signaling (Serverless)**: Cloudflare Workers, Durable Objects.
- **Styling**: Tailwind CSS (CDN).

## 📥 Getting Started

### Local Development (Node.js)

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Start the Signaling Server**:
    ```bash
    node server.js
    ```
    The server will run on [http://localhost:3000](http://localhost:3000).

### Cloudflare Workers Deployment

1.  **Local Testing**:
    ```bash
    npx wrangler dev
    ```

2.  **Deploy**:
    ```bash
    npx wrangler deploy
    ```

## ⚙️ Configuration

- **PORT**: Set the `PORT` environment variable to change the Node.js server port (default: 3000).
- **ADMIN_TOKEN**: Set this environment variable to enable the administrative reset feature.

## 🛡 Security

Communication is secured using a "Group Key" model. The first participant (Root) generates a random 256-bit AES-GCM key. As new peers join and establish WebRTC connections, the Root (or other authorized peers) securely shares the Group Key using the recipient's RSA public key. All subsequent data sent over RTCDataChannels is encrypted with this shared Group Key.

## 📜 License

ISC
