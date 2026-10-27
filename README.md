<div align="center">
  <img src="assets/omnisync-banner-opt.png" alt="OmniSync Logo" width="460" />
  
  <h1>Real-time Sync Obsidian</h1>

  <p>
    <strong>English</strong> | <a href="README.es.md">Español</a> &bull; <strong>Documentation:</strong> 
    <a href="docs/User_Guide_EN.md">User Guide (EN)</a> / <a href="docs/Guía%20de%20Usuario.md">ES</a> | 
    <a href="docs/Developer_Guide_EN.md">Developer Guide (EN)</a> / <a href="docs/Guía%20de%20Desarrolladores.md">ES</a> | 
    <a href="docs/COMPARISON_EN.md">Technical Comparison (EN)</a> / <a href="docs/COMPARATIVA_es.md">ES</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Sync-Real--Time%20(Live)-blueviolet?style=flat-square&logo=visualstudiocode" alt="Real-Time Sync" />
    <img src="https://img.shields.io/badge/Encryption-AES--256--GCM%20E2EE-emerald?style=flat-square&logo=securityscorecard" alt="E2EE Encryption" />
    <img src="https://img.shields.io/badge/Architecture-Hybrid%20P2P%20WebRTC-blue?style=flat-square" alt="Hybrid P2P WebRTC" />
    <img src="https://img.shields.io/badge/Privacy-Zero%20Logs%20%2F%20No%20Accounts-black?style=flat-square" alt="Zero Logs" />
    <img src="https://img.shields.io/badge/Platforms-Desktop%20%26%20Mobile-7c3aed?style=flat-square&logo=obsidian" alt="Obsidian" />
    <a href="docs/TESTS_AND_AUDITS_EN.md"><img src="https://img.shields.io/badge/Tests-Passing-brightgreen?style=flat-square&logo=vitest&logoColor=white" alt="Tests" /></a>
    <img src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-orange?style=flat-square" alt="License" />
  </p>
</div>

---

### ⚡ Why OmniSync Changes Everything

Every common Obsidian sync alternative today forces you into an unwanted compromise:
1. Paying a recurring monthly subscription ($4 to $10/month per vault).
2. Entrusting your sensitive notes and thoughts to third-party tech giants (Dropbox, Google Drive, OneDrive).
3. Self-hosting and maintaining complex server stacks (CouchDB / Docker containers on a paid VPS).

**OmniSync completely discards that premise.** It turns your devices into direct peers. Notes travel directly peer-to-peer at lightning speed, encrypted before leaving your machine, with zero central authority tracking your activity.

---

## 🌟 Key Highlights & Architectural Advantages

### ⚡ 1. Free Real-Time Sync (Google Docs Experience)
* **Real-time sync, free:** Your notes sync across your devices the instant you type, with no subscription and nothing to pay.
* **Live Remote Cursors & Selections:** Deeply integrated into Obsidian's **CodeMirror 6** editor engine. Watch remote cursors glide across the screen with distinct colors in real time.
* **Simultaneous Live Typing:** Type on your phone and watch words appear instantly on your desktop monitor without lag.
* **Smart 3-Way Merge Engine:** Divergent edits made while offline reconcile automatically at the character level using stored base snapshots. **Zero overwritten paragraphs, zero messy conflict file duplicates (`.sync-conflict`)**.

### 🥷 2. Zero Accounts, Zero Central Servers, Zero Logs
* **Complete Privacy:** No email registration, no sign-ups, no passwords to create or leak.
* **True Zero-Knowledge (E2EE):** Everything is encrypted locally with **AES-256-GCM** before touching any network socket.
* **Cryptographic Path Obfuscation (HMAC):** File paths and directory trees are hashed deterministically (`hmac("Secret/Note.md") → 8f2a...`). Network observers only see encrypted payloads and never know your note titles or vault structure.
* **No Server Footprint:** Direct WebRTC channels and ephemeral signaling relays (Nostr or your own Serverless Worker) maintain zero activity logs or user identities.

### 📲 3. Instant Ephemeral QR Pairing (5 Seconds, Zero Typing)
* Forget manually typing long S3 keys, WebDAV endpoints, or GitHub Personal Access Tokens on mobile touchscreens.
* Open the pairing wizard on desktop, **scan the QR code with your mobile camera**, and confirm.
* An **ECDH P-256** key exchange takes place using a single-use token with a 2-minute expiration (TTL). Once completed, keys are stored in-memory/keychain and the token is burnt forever.

### 🔄 4. Robust Asynchronous Sync (Offline & Sleep Support)
* Your phone doesn't need to be awake or online when you work on your computer.
* Pending changes sit securely encrypted in a transient mailbox (on public Nostr relays or your own **free, 1-click deployable Cloudflare Worker**). The moment your phone wakes up, it catches up seamlessly.

### 📦 5. Native Large Binary & Media Handling (Blossom Protocol)
* Powered by the **Blossom (BUD-01/02)** protocol addressed directly by SHA-256 hash. Large images, PDFs, audio, and attachments sync smoothly without clogging memory or database records.

### 🛡️ 6. Safe Data Preservation (Obsidian Trash Integration)
* When a remote peer deletes a note, OmniSync **never performs an irreversible disk wipe**: files are safely routed to Obsidian's local `.trash` folder, ensuring human mistakes can always be undone.

---

## 📊 Quick Feature Comparison

| Feature | 🔮 **OmniSync** | 💎 **Obsidian Sync** | ☁️ **Remotely Save** | 🗄️ **Self-hosted LiveSync** |
| :--- | :---: | :---: | :---: | :---: |
| **Real-Time Collaboration (Live)** | ✨ **Yes (CodeMirror 6)** | ❌ No (Debounce/Save) | ❌ No (File Polling) | ⚡ Yes (CouchDB) |
| **Account / Sign-up Required** | 🥷 **Zero (No Accounts)** | 📧 Email & Account Required | 🔑 Cloud Provider Account | 👤 DB User & Credentials |
| **Network Architecture** | ⚡ **Direct P2P (WebRTC)** | 🏢 Centralized Cloud | ☁️ Commercial Storage (S3) | 🖥️ Dedicated VPS / Docker |
| **Financial Cost** | 🎁 **100% Free** | 💳 $4 – $10 / month | 🟡 Cloud Storage Fees | 🟡 $3 – $6 / month VPS |
| **Mobile Pairing Setup** | 📲 **Scan QR (2 seconds)** | 🔑 Username & Password | ⚙️ API Keys & Endpoints | ⚠️ Complex manual config |
| **Encrypted File Paths** | 🛡️ **Yes (HMAC Obfuscated)** | 🔒 Yes (with custom key) | ❌ Plaintext paths in cloud | 🛡️ Yes |

*(Read the comprehensive [Technical Comparison Document](docs/COMPARISON_EN.md) for in-depth architecture benchmarks).*

---

## 🚀 Quick Installation

> *OmniSync is currently under review for Obsidian's official community plugin directory. Until listed, install manually in under a minute:*

1. Visit the **[Releases](https://github.com/abismalmx/OmniSync/releases)** page and download:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Navigate to your Obsidian vault's `.obsidian/plugins/` directory and create a folder named `omnisync/`.
3. Copy the 3 downloaded files into `.obsidian/plugins/omnisync/`.
4. Open Obsidian, go to **Settings → Community plugins**, and toggle **OmniSync** on.
5. Go to **Settings → OmniSync → Pairing Assistant** to link your first phone or second computer.

For detailed walkthroughs and troubleshooting, see the **[User Guide](docs/User_Guide_EN.md)**.

---

## 🔒 Privacy & Transparency

- **What does a public relay see?** Only that an encrypted session is active and approximate packet sizes. Relays cannot decrypt your content, note names, or folder paths.
- **Want 100% sovereign isolation?** OmniSync features a built-in wizard to deploy your own **free Cloudflare Worker in 1 click**, bypassing public relays altogether.
- **Security Audits:** The codebase undergoes continuous security audits and strict cryptographic unit tests (`npm test`). View the audit reports in [docs/TESTS_AND_AUDITS_EN.md](docs/TESTS_AND_AUDITS_EN.md).

---

## 🛠️ Local Development

```bash
# Clone the repository
git clone https://github.com/abismalmx/OmniSync.git
cd OmniSync

# Install dependencies
npm install

# Start development compiler (watch mode)
npm run dev

# Production build
npm run build

# Run comprehensive test suite
npm test
```

Read the **[Developer Guide](docs/Developer_Guide_EN.md)** for full architecture breakdowns, security policies, and contribution guidelines.

---

## 📄 License

Distributed under the **[PolyForm Noncommercial 1.0.0](LICENSE)** — Free for personal use, learning, non-profit organizations, and academic research.

---

<div align="center">
  Crafted with care by <strong>abismalmx</strong>.<br>
  <em>If OmniSync saves you a monthly subscription, share it with the Obsidian community!</em>
</div>
