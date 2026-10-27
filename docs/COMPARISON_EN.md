# Technical & Architectural Comparison: OmniSync vs Obsidian Sync Alternatives

This document provides an objective, architectural, and technical comparison between **OmniSync** and the most widely used solutions across the Obsidian ecosystem: **Official Obsidian Sync**, **Remotely Save** (S3/WebDAV/Dropbox/OneDrive), **Self-hosted LiveSync** (CouchDB), and **Git / Obsidian Git**.

---

## 1. General Comparison Matrix

| Feature / Criterion | **OmniSync** | **Official Obsidian Sync** | **Remotely Save** | **Self-hosted LiveSync** | **Git / Obsidian Git** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Network Architecture** | **Hybrid P2P** (Direct WebRTC + Encrypted Relay/Mailbox) | Centralized Server (Obsidian cloud infrastructure) | Client-Server (Third-party storage / cloud) | Client-Server (CouchDB / Cloudant) | Centralized Server (GitHub / GitLab / Gitea) |
| **End-to-End Encryption (E2EE)** | **Native AES-256-GCM** + Path HMAC obfuscation | AES-256 (Optional E2EE with custom vault key) | Optional OpenSSL / Restic-like encryption depending on backend | Native E2EE | **No** (Plaintext files stored in remote git repo) |
| **Real-time Collaboration** | **Yes** (CodeMirror 6, live remote cursors & selections) | No (Sync triggers on save / delayed debounce) | No (Periodic full-file polling) | **Yes** (Event-driven reactive CouchDB sync) | No (Manual or periodic commit/push/pull flow) |
| **Conflict Resolution** | **3-Way Text Merge** at character level + base snapshot | Conflict duplication (`.sync-conflict` files) | Conflict duplication or Last-Write-Wins (LWW) | Chunk / record level merge | Standard Git merge conflicts (requires manual text markers resolution) |
| **Self-Hosted Infrastructure Requirement** | **Zero mandatory** (Public Nostr relays or free Cloudflare Serverless Worker) | Zero (Managed by Obsidian team) | Zero if using commercial S3/Dropbox, High if using custom WebDAV | **High** (Requires maintaining Docker CouchDB / VPS) | Medium (GitHub account or self-hosted Git server) |
| **Mobile Experience (iOS / Android)** | **Seamless & Instant** (Ephemeral QR pairing) | Integrated & Native | Good (limited by mobile background API) | Complex mobile setup & CouchDB configuration | **Challenging** (iOS requires third-party tools like Working Copy; memory bounds) |
| **Cost** | **100% Free & Open** (Free tier Cloudflare / Nostr) | Monthly subscription ($4–$10/month per vault) | Free plugin + cloud storage costs | Free plugin + VPS hosting costs ($3–$6/month) | Free (GitHub) or self-hosted server costs |
| **Privacy & Metadata** | **Maximum**: Cryptographic HMAC path obfuscation, zero accounts, no logs | High (with E2EE), but vault identity tied to billing account | Dependent on cloud provider (Dropbox/Google index metadata) | Maximum if self-hosted; Zero on public Cloudant | Minimal (Commit history and files linked to Git account) |
| **Large Files & Binary Handling** | **Optimized** (Blossom BUD-01/02 addressed by SHA-256 hash) | Plan limits (100 MB–200 MB per file) | Bound by storage provider upload speeds | Limited by CouchDB DB size (degrades with large blobs) | **Poor** (Git is unsuited for large binary files; requires Git LFS) |

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
