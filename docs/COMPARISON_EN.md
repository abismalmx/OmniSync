# Technical & Architectural Comparison: OmniSync vs Obsidian Sync Alternatives

This document provides an objective, architectural, and technical comparison between **OmniSync** and the most widely used solutions across the Obsidian ecosystem: **Official Obsidian Sync**, **Remotely Save** (S3/WebDAV/Dropbox/OneDrive), **Self-hosted LiveSync** (CouchDB), and **Git / Obsidian Git**.

---

## 1. General Comparison Matrix

| Criterion / Feature | 🔮 **OmniSync** | 💎 **Official Obsidian Sync** | ☁️ **Remotely Save** | 🗄️ **Self-hosted LiveSync** | 🐙 **Git / Obsidian Git** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| 🌐 **Network Architecture** | ⚡ **Hybrid P2P**<br>*(Direct WebRTC + Encrypted Relay/Mailbox)* | 🏢 Centralized Server<br>*(Obsidian cloud infrastructure)* | ☁️ Client-Server<br>*(Dropbox / S3 / OneDrive)* | 🖥️ Client-Server<br>*(CouchDB / Docker)* | 🐙 Central Git Server<br>*(GitHub / GitLab)* |
| 🔐 **E2EE Encryption** | 🛡️ **Native AES-256-GCM**<br>+ Path HMAC Obfuscation | 🔒 AES-256<br>*(Optional E2EE with custom key)* | 🔑 Optional<br>*(OpenSSL/Restic depending on storage)* | 🛡️ Native E2EE | ❌ **No Encryption**<br>*(Plaintext files in remote repo)* |
| 👥 **Real-Time Collaboration** | ✨ **Yes (Live)**<br>*(Remote cursors & live selections)* | ❌ No<br>*(Sync triggers on save / delayed debounce)* | ❌ No<br>*(Periodic polling)* | ⚡ **Yes**<br>*(Reactive CouchDB events)* | ❌ No<br>*(Manual or periodic commit/push)* |
| 🔀 **Conflict Resolution** | 🧠 **Smart 3-Way Merge**<br>*(Character-level without duplicates)* | ⚠️ Conflict Duplicates<br>*(`.sync-conflict` files)* | ⚠️ Conflict Duplicates<br>*(Or Last-Write-Wins)* | 🧩 Chunk Merge<br>*(Record-level merge)* | 🛑 Git Conflicts<br>*(Manual `<<<<` markers)* |
| ⚙️ **Server Maintenance** | 🟢 **0% Required**<br>*(Free Serverless Worker or Nostr)* | 🟢 0% Required<br>*(Managed by Obsidian team)* | 🟡 0% with S3/Dropbox<br>*(High if self-hosted WebDAV)* | 🔴 **Very High**<br>*(VPS + Docker + SSL maintenance)* | 🟡 Medium<br>*(Git account or custom server)* |
| 📱 **Mobile UX (iOS/Android)** | 📲 **Instant (2-sec QR)**<br>*(Zero logins or tedious typing)* | ✅ Native & Integrated | 🟡 Good<br>*(Limited by mobile background APIs)* | ⚠️ Complex Configuration<br>*(Difficult to configure on mobile)* | 🔴 **Challenging**<br>*(Requires Working Copy app on iOS)* |
| 💰 **Financial Cost** | 🎁 **100% Free & Open**<br>*(No subscriptions)* | 💳 $4 to $10 / mo<br>*(Subscription per vault)* | 🟡 Free plugin<br>*(+ Cloud storage bill)* | 🟡 Free plugin<br>*(+ $3–$6/mo VPS costs)* | 🟢 Free on GitHub<br>*(Or custom hosting costs)* |
| 🕵️‍♂️ **Metadata Privacy** | 🥷 **Maximum Zero-Knowledge**<br>*(Obfuscated paths, zero accounts)* | 🔒 High with E2EE<br>*(Vault tied to billing email)* | ⚠️ Exposed Metadata<br>*(Provider sees file paths)* | 🛡️ High if self-hosted<br>*(Zero on public cloud providers)* | ⚠️ Public/Private History<br>*(Commits tied to user profile)* |
| 📦 **Large Binaries & Files** | 🚀 **Optimized (Blossom)**<br>*(BUD-01/02 addressed by SHA-256)* | ⚠️ Plan Limits<br>*(100 MB–200 MB per file)* | ⏱️ Slow<br>*(Storage rate limits)* | ⚠️ Database Bloat<br>*(CouchDB degrades with large blobs)* | ❌ **Not Recommended**<br>*(Requires Git LFS setup)* |

---

## 2. Key Architectural Advantages of OmniSync

### 1. True Decentralization without Dedicated Servers (Zero Maintenance)
* **The challenge with alternatives:** *Self-hosted LiveSync* requires provisioning, securing, and maintaining a Linux VPS running CouchDB, configuring SSL certificates, and managing storage growth. If your VPS goes down, sync breaks.
* **The OmniSync approach:** Leverages a serverless and direct peer-to-peer model:
  - When devices are online concurrently, data streams **directly via WebRTC DataChannels** without touching intermediate storage.
  - For asynchronous sync (when a target device is asleep), it utilizes Nostr relays or a **1-click deployable Cloudflare Worker** (which runs comfortably within Cloudflare's free quota of 100,000 requests/day at zero cost).

### 2. Instant QR Pairing (No Passwords or Long-Lived Tokens)
* **The challenge with alternatives:** Setting up WebDAV credentials, S3 secret keys, or GitHub personal access tokens on mobile keyboards is tedious and leaves long-lived credentials stored in plugin settings.
* **The OmniSync approach:**
  - The host displays an ephemeral QR code on desktop.
  - The phone scans the QR.
  - An **ECDH P-256** key exchange occurs authenticated via a single-use token with a 2-minute time-to-live (TTL).
  - Keys are transferred securely in-memory and the token is burnt immediately. Zero usernames, zero passwords, and zero accounts.

### 3. Real-Time Collaborative Editing (Google Docs / Figma Experience)
* **The challenge with alternatives:** Most sync plugins operate at file-level granularity: concurrent edits on two devices inevitably produce conflict copies or overwrite paragraphs.
* **The OmniSync approach:** Integrates directly into Obsidian's **CodeMirror 6** editor engine:
  - Live colored remote cursors and active selections.
  - Incremental changes propagate character-by-character.
  - When changes occur offline, an automatic **3-way text merge** reconciles divergences using the last common base snapshot stored in memory.

### 4. Cryptographic Path Obfuscation (HMAC)
* **The challenge with alternatives:** Even when file contents are encrypted, storage providers and relay nodes usually see plaintext directory trees and file names (`/Medical/Health_Records.md`), revealing sensitive behavioral patterns.
* **The OmniSync approach:**
  - File paths are deterministically hashed via HMAC using the vault's master secret (`hmac("Medical/Health_Records.md") → 8f2d...`).
  - To any relay or worker, the vault traffic consists strictly of fixed-size encrypted blobs and opaque identifiers.

### 5. Safe Data Preservation
* When a remote peer deletes a file, OmniSync **never performs destructive physical file deletion on disk**: files are safely moved to Obsidian's local `.trash` folder, ensuring human error on one device never causes irreversible data loss on another.

---

## 3. Decision Matrix

| If your priority is... | Recommended Solution | Why |
| :--- | :--- | :--- |
| **Total privacy, P2P speed, zero monthly fees, and real-time live typing** | **OmniSync** | No dedicated servers required, full E2EE with HMAC path privacy, live cursors, and instant QR pairing. |
| Zero technical configuration and available monthly budget | **Official Obsidian Sync** | Native integration maintained by the Obsidian core team. |
| Complete homelab infrastructure control with existing CouchDB setup | **Self-hosted LiveSync** | Ideal if you already maintain Docker/Kubernetes clusters. |
| Formal version control with branching and commit audit trails | **Obsidian Git** | Best suited for developers tracking code changes via Git commit logs. |
