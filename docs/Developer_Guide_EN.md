# Developer Guide – OmniSync

This guide is for people who want to **understand how OmniSync works**. It explains how the plugin is organized, how a change travels from one device to another, which security rules must never be broken, how to test, and how to ship a release.

- [1. Purpose and architecture](#1-purpose-and-architecture)
- [2. Getting started](#2-getting-started)
- [3. Codebase structure](#3-codebase-structure)
- [4. Keys, rooms and identity](#4-keys-rooms-and-identity)
- [5. How sync works](#5-how-sync-works)
- [6. Receiving changes and conflict policy](#6-receiving-changes-and-conflict-policy)
- [7. Transports in detail](#7-transports-in-detail)
- [8. Ephemeral pairing](#8-ephemeral-pairing)
- [9. Settings and persisted data](#9-settings-and-persisted-data)
- [10. Security rules (invariants)](#10-security-rules-invariants)
- [11. Testing](#11-testing)
- [12. Recipes: common changes](#12-recipes-common-changes)
- [13. Debugging](#13-debugging)
- [14. CI and dependencies](#14-ci-and-dependencies)
- [15. Releases and versioning](#15-releases-and-versioning)
- [16. Best practices and contributions](#16-best-practices-and-contributions)

**Appendix (extended reference):**

- [A. Architecture Overview Diagram](#a-architecture-overview-diagram)
- [B. SyncState Machine](#b-syncstate-machine)
- [C. WebRTC Message Sequence](#c-webrtc-message-sequence)
- [D. Key Derivation Tree](#d-key-derivation-tree)
- [E. Conflict Resolution Flowchart](#e-conflict-resolution-flowchart)
- [F. Writing a New Transport](#f-writing-a-new-transport)
- [G. Writing a Test](#g-writing-a-test)
- [H. Performance Considerations](#h-performance-considerations)
- [I. Cloudflare Worker Internals](#i-cloudflare-worker-internals)
- [J. Glossary](#j-glossary)
- [K. Security Invariants — Why Each Matters](#k-security-invariants--why-each-matters)
- [L. Delta Patch Deep-Dive](#l-delta-patch-deep-dive)
- [M. MySecret Interoperability](#m-mysecret-interoperability)
- [N. Extending i18n — Adding a New Language](#n-extending-i18n--adding-a-new-language)
- [O. Repository Map and Reference Files](#o-repository-map-and-reference-files)
- [P. Operational Recipes and Diagnostics](#p-operational-recipes-and-diagnostics)

---

## 1. Purpose and architecture

OmniSync is an **Obsidian** plugin (desktop and mobile) that synchronizes a vault across devices **without owning a central server**. All content is end-to-end encrypted with **AES-256-GCM** before it leaves the device.

Three transports carry the same encrypted messages:

| Transport | Used for | Needs both devices online? |
|---|---|---|
| **WebRTC DataChannel** (P2P) | Live typing, cursors, manifests, files of any size | Yes |
| **Nostr mailbox** (relay, kind 30078) | Notes written while the other device is off or asleep | No (relay stores for 7 days) |
| **Blossom** (HTTP blob servers) | Large files and attachments, announced through the mailbox | No |

Devices find each other through a **signaling server**: a public Nostr relay (default) or a self-hosted **Cloudflare Worker**. The Worker is optional.

License: [PolyForm Noncommercial 1.0.0](../LICENSE) (source-available, free for noncommercial use). See [Contributions](#16-best-practices-and-contributions).

### Key principles

| Principle | Description |
|---|---|
| **Real time first** | Every edit is sent immediately; nothing waits for a periodic job. |
| **End-to-end encryption** | One master secret per vault. Content and paths are encrypted (paths also hashed with HMAC) before touching any network. |
| **Decoupled transport** | Cryptographic identity does not depend on the channel. WebRTC, Nostr mailbox, Blossom and Worker are interchangeable layers. |
| **Default distrust** | Every inbound message is validated (size, type, path, signature, age, replay) before it touches disk. Relays and blob servers are untrusted. |
| **Data preservation** | A newer local file is never overwritten; remote deletions go to Obsidian's trash; divergent edits are 3-way merged or saved as a conflict copy. |

---

## 2. Getting started

**Requirements:** Node.js 22.x (what CI uses), npm, Obsidian 1.11.4 or newer (`minAppVersion` in `manifest.json`).

```bash
git clone https://github.com/abismalmx/OmniSync.git
cd OmniSync
npm install
npm run dev        # watch build, inline source maps
npm run build      # production build -> main.js (minified, no source maps)
```

- The bundle is built by `esbuild.config.mjs`: entry `src/main.ts`, output `main.js`, format **CommonJS**, target **ES2020**. `obsidian`, `electron`, `@codemirror/*` and Node built-ins are **external** (provided by Obsidian).
- TypeScript is **strict** (`tsconfig.json`: `strict`, `noImplicitAny`, `strictNullChecks`).
- **Install in a test vault:** copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/omnisync/`, then reload Obsidian (or use the Hot Reload plugin).
- **Console:** `Ctrl+Shift+I` opens Obsidian's developer tools. Mailbox logs are prefixed `[OmniSync Mailbox]`.

Before opening a pull request run:

```bash
npm run typecheck && npm run lint && npm test
```

---

## 3. Codebase structure

```
src/
├─ main.ts                    # Plugin lifecycle, network setup, send/receive orchestration,
│                             #   queues and retries, pairing entry points, settings load/save
├─ types.ts                   # Shared types: settings, manifests, mailbox payloads, message types
├─ crypto/crypto-manager.ts   # Key derivation (PBKDF2), AES-256-GCM, HMAC helpers, hashing
├─ network/
│   ├─ signaling-client.ts    # Signaling over Nostr (kind 25000) or the Worker WebSocket
│   ├─ webrtc-peer.ts         # RTCPeerConnection, DataChannel, mutual HMAC handshake
│   ├─ nostr-mailbox.ts       # Async encrypted mailbox: publish/fetch/live subscription,
│   │                         #   delta patches, Blossom attachments, reconnection
│   ├─ blossom-client.ts      # Blob upload/download (BUD-01/02, NIP-98)
│   ├─ blossom-providers.ts   # Default Blossom servers and blob-size limits
│   └─ pairing-channel.ts     # Transport for ephemeral pairing (Nostr / Worker)
├─ sync/
│   ├─ vault-watcher.ts       # Vault events -> debounced change callbacks (350 ms)
│   ├─ manifest-calc.ts       # Manifests and delta (what to upload/download/delete)
│   ├─ file-transfer.ts       # Chunked file transfer over the DataChannel
│   ├─ delta-patch.ts         # Unified diff patches (compute/apply, size limits)
│   ├─ base-snapshot-store.ts # Encrypted base versions used by 3-way merge
│   └─ diff-merge.ts          # 3-way text merge with a CPU budget
├─ collab/codemirror-collab.ts# Remote cursors and selections (CodeMirror 6)
├─ security/                  # Pure validators and policies (no I/O): see table below
├─ ui/                        # Settings tab, pairing modal, Cloudflare wizard, status bar
├─ i18n/                      # Translations: es, en, zh, ru (+ types.ts with the key list)
└─ templates/                 # Generated Cloudflare Worker templates (do not edit by hand)
scripts/
├─ cloudflare-allinone/       # All-in-one Worker: signaling + Blossom (R2) + pairing room
├─ package-stable.mjs         # Builds the reproducible distribution package
└─ generate-cloudflare-templates.mjs
tests/                        # Test suites; obsidian-stub.ts replaces the Obsidian API
zip/                          # Generated release package (see section 15)
```

### `src/security/` at a glance

| File | Responsibility |
|---|---|
| `vault-security.ts` | `validateVaultPath()`: the only gate for paths written to the vault (length, segments, traversal, reserved names). |
| `protocol-security.ts` | Validates WebRTC messages and signals; `ReplayGuard` against replays. |
| `transfer-security.ts` | Limits for file transfers (size, chunks, concurrent transfers, manifest entries). |
| `sync-policy.ts` | **Pure decisions**: apply / skip / conflict for writes, deletes, renames and mailbox notes. |
| `network-security.ts` | Only `wss://` and `https://` URLs, length and character checks. |
| `settings-security.ts` | Sanitizes `data.json` content before use. |
| `pairing.ts`, `pairing-session.ts` | Pairing payload and the ephemeral ECDH protocol. |
| `worker-auth.ts` | NIP-98 auth for the self-hosted Worker. |
| `mysecret-compat.ts` | Interoperability with vaults encrypted by the MySecret plugin. |
| `concurrency-limiter.ts`, `path-operation-queue.ts` | Concurrency limits and per-path serialization. |
| `external-text.ts` | Sanitizes text coming from relays/servers before showing it. |

---

## 4. Keys, rooms and identity

There is **one master secret** per vault (the pairing secret). Everything else is derived from it, with a different context for each purpose so a key for one use can never decrypt another:

| Derived value | Context (salt) | Used for |
|---|---|---|
| Vault key | `OmniSync-Salt-v1` (`VAULT_KEY_CONTEXT`) | WebRTC DataChannel messages |
| Signaling key | `OmniSync-Signaling-v1` (`SIGNALING_KEY_CONTEXT`) | Signaling messages |
| Mailbox key | `OmniSync-Mailbox-v1` (`MAILBOX_KEY_CONTEXT`) | Nostr mailbox payloads |
| Blossom key | `OmniSync-Blossom-v1` (`BLOSSOM_KEY_CONTEXT`) | Encrypting blobs |
| Snapshot key | `OmniSync-Snapshot-v1` (`SNAPSHOT_KEY_CONTEXT`) | Local base snapshots |
| Worker auth key | `deriveWorkerAuthKey` | NIP-98 identity for your Worker |

- Keys: **PBKDF2-SHA-256, 100 000 iterations**, 256-bit AES-GCM, non-extractable. A fresh random 12-byte IV is generated for every encryption.
- Room ids are HMAC-derived and **independent of each other**: `signalingRoomId` uses the domain `signaling-room-v1` and `mailboxRoomId` uses `mailbox-room-v1`, so a relay that learns one cannot correlate it with the other.
- The master key lives in Obsidian's `secretStorage` when available and is **never written to `data.json`** (`saveSettings()` deletes `pairingSecret` and `roomId` before calling `saveData()`).
- The mailbox `d` tag of each event is an opaque HMAC of the note path (`mailbox-dtag-v2`), so the relay cannot learn file names.
- All derivation happens in `main.ts` → `deriveDomainKeys()`; HMAC helpers are in `crypto-manager.ts` (`computeHmacHex`).

---

## 5. How sync works

### 5.1 Sync modes

The setting **Sync mode** has two values (stored as the boolean `enableNostrMailbox`):

| Mode | Behaviour |
|---|---|
| **Dual path** (default) | Every edit goes to the relay mailbox **and**, if a peer is connected, over P2P. |
| **Pure P2P** | No relay mailbox is created: no polling, no relay traffic. Both devices must be online at the same time. |

The relay used is `settings.signalingServer`, so it works the same with a public Nostr relay, your own Cloudflare Worker or any compatible relay.

### 5.2 Flow of a local edit

1. `vault-watcher` receives the Obsidian event, filters it with the policies in `security/` and waits **350 ms** (debounce) so a burst of keystrokes becomes one change.
2. `main.ts` → `broadcastFileChange` queues the send on `broadcastChain`, a promise chain that **serializes all sends** so an old version can never overtake a new one.
3. `doBroadcastFileChange` runs two independent steps:
   - **P2P:** for each authenticated, connected peer, `sendFileToPeer` (delta patch or file transfer). If all succeed, the base snapshot is updated.
   - **Relay:** if the mailbox exists, `publishToMailbox` publishes regardless of whether peers are connected (a "connected" peer on a suspended phone may not really be alive).
4. `publishToMailbox` picks the representation by size and type:
   - text ≤ **64 KB** → full note (`FULL_NOTE`);
   - larger text with a base snapshot → unified diff patch, split in chunks (`DELTA_PATCH`/`DELTA_CHUNK`);
   - larger text without a base, or binary files → upload to Blossom and publish a pointer (`BLOB_ATTACHMENT`). If Blossom is off, the user gets one short notice that the note is over 64 KB and Blossom must be enabled.
5. The result decides the queues (next section).

### 5.3 Delivery queues and retries

Two persisted queues exist and **must not be mixed**:

| Queue | Persisted in | Meaning |
|---|---|---|
| `pendingMailboxPaths` | `settings.pendingMailboxOut` | Local edits the **relay** has not confirmed. Retried until delivered. |
| `pendingP2PPaths` | `settings.pendingP2PSync` | Paths that must be reconciled **with a peer** (also set by the receiver on "base mismatch" or "patch failed"). |

Why they are separate: the receiver treats a path in `pendingP2PPaths` as "modified locally" (`applyMailboxNote` → `decideMailboxNote`). Marking more paths there causes false conflicts; publishing from it could push a stale local version to the relay.

Retry rules (`schedulePendingRetry`): backoff **2 s → 5 s → 15 s → 60 s**; an immediate trigger (reconnection, network back, app visible) cancels the wait and restarts the backoff. `flushPendingToMailbox` goes through `broadcastChain` and has a re-entrancy guard (`pendingFlushRunning`).

### 5.4 When pending work is flushed

- **App hidden** (`visibilitychange` → hidden): `vaultWatcher.flushPendingEdits()` sends edits still inside the 350 ms debounce, then the pending queue is flushed.
- **Plugin unload:** same sequence, waiting at most **3 s**, **before** the mailbox is destroyed and the snapshot store closed.
- **Startup** (`onLayoutReady`): `queueUnsyncedLocalEdits()` finds files modified since the last fetch (minus a 2-minute margin) whose hash differs from the base snapshot and queues them, so an edit that never reached the relay is not lost.

### 5.5 Pulling changes made while this device was off

Mobile OSes suspend WebSockets, so the mailbox is also **pulled**:

- on every WebSocket open (including the first),
- every **60 s** (`MAILBOX_POLL_INTERVAL_MS`),
- when the app becomes visible again and when the network comes back (`online`),
- on startup (`pollMailboxOnStartup`).

`NostrMailbox.reconnectNow()` forces a fresh connection. Reconnect backoff only resets after a connection lasted ≥ 10 s, so a relay that accepts and closes cannot create a query loop.

### 5.6 Fallback notices

User-visible notices about fallbacks go through `noticeFallbackOnce`: at most **one every 10 minutes**, whatever the number of edits. Never add a raw `new Notice(...)` inside a per-edit path.

---

## 6. Receiving changes and conflict policy

All decisions are **pure functions** in `src/security/sync-policy.ts`, which makes them easy to test:

| Function | Outcome |
|---|---|
| `decideRemoteWrite` | `apply` or `skip_newer_local` (a strictly newer local file is never overwritten). |
| `decideRemoteDelete` | `trash`, `skip_newer_local` or `skip_missing`. Deletes **always** use Obsidian's trash. |
| `decideRemoteRename` | `rename` or a `skip_*` reason; an existing destination is never overwritten. |
| `decideMailboxNote` | `apply`, `skip` or `conflict` for a note that arrived through the mailbox. |

`decideMailboxNote` rules: no local file → apply; remote not newer → skip; identical content → skip; local modified since the last sync → **conflict**; otherwise apply.

Handling a divergence:
1. `diff-merge.ts` runs a **3-way merge** at character level using the base snapshot from `base-snapshot-store`. It has a CPU budget (`MAX_MERGE_COMPARISONS`).
2. If it cannot merge cleanly, the local version is kept as `<name>.conflict-YYYY-MM-DD-HHMM.<ext>` and the remote is written.
3. Remote deletions become **tombstones** (`settings.deletedPaths`) so a deleted file is not resurrected by a stale manifest; tombstones are pruned over time.

Every incoming write goes through: `validateVaultPath` → size/type limits → checksum (SHA-256) → decision → write with the remote `mtime`. The watcher is told to ignore the echo of that write (`ignoreNextChange` with the expected hash), but a **real user edit inside that window is still synced**.

---

## 7. Transports in detail

> **OmniSync is not a backup.** All transports are transit mailboxes: mailbox notices expire after 7 days, R2 blobs after 10, and public Blossom blobs in ≈7 days depending on the server. If a device does not connect within that window and no direct P2P session ever happened, changes will not arrive. Each device is solely responsible for keeping its own vault. Document this in the UI and guides whenever user behaviour depends on something being "saved forever".

### 7.1 WebRTC (P2P)

- Signaling messages are encrypted and exchanged through the signaling server; ICE uses public STUN servers (Google by default).
- After the channel opens, both sides run a **mutual HMAC challenge** (`AUTH_CHALLENGE`, `AUTH_RESPONSE`, `AUTH_COMPLETE`). A peer counts as connected only when `isAuthenticated && isConnected`.
- Message types (`MessageType` in `types.ts`): `AUTH_*`, `MANIFEST_EXCHANGE`, `FILE_HEADER`, `FILE_CHUNK`, `FILE_COMPLETE`, `FILE_DELETE`, `FILE_RENAME`, `PRESENCE_CURSOR`, `LIVE_TEXT_DELTA`, `PING`, `PONG`.
- On connect, peers exchange **manifests** (`ManifestCalculator.computeDelta`) to compute `toUpload`, `toDownload`, `conflicts`, `toDelete`.
- Files are chunked (16–64 KB chunks, default 32 KB), with back-pressure (`DEFAULT_HIGH_WATER_MARK`), SHA-256 integrity checks, and limits (max file 128 MB, max 2 simultaneous incoming transfers, 5-minute transfer TTL).

### 7.2 Nostr mailbox

- Event **kind 30078** (NIP-78, parameterized replaceable), with **NIP-40 expiration of 7 days**. Replaceable means the relay keeps one event per `d` tag, so only the latest version of a note is stored.
- Content is the AES-GCM-encrypted JSON `NostrMailboxNotePayload` (`type`, `path`, `content`, `mtime`, `deviceId`, `sentAt`, hashes for deltas…). `sentAt` is bound to `created_at` so a relay cannot re-sign an old event as new.
- Validation of every event: kind, id, pubkey, signature (`verifyEvent`), age (≤ 8 days), tag count/size, AEAD decryption, `validateVaultPath`, and the `d` tag recomputed from the path.

| Limit | Value | Constant |
|---|---|---|
| Full note | 64 KB | `MAX_MAILBOX_NOTE_SIZE` |
| Event content | 256 KB | `MAX_MAILBOX_EVENT_CONTENT_LENGTH` |
| Event age | 8 days | `MAX_MAILBOX_EVENT_AGE_SECONDS` |
| Delta chunk / chunks per patch | 48 KB / 16 | `DELTA_CHUNK_SIZE` / `MAX_DELTA_CHUNKS` |
| Events per fetch | 500 | `MAX_MAILBOX_EVENTS_PER_FETCH` |
| Tags per event | 16 | `MAX_MAILBOX_EVENT_TAGS` |
| Eligible extensions | `md, markdown, txt, canvas, json, css` | `ELIGIBLE_MAILBOX_EXTENSIONS` |
| Blossom operations in flight | 1 running, 4 queued | `MAX_CONCURRENT_BLOSSOM_OPERATIONS` / `MAX_PENDING_BLOSSOM_OPERATIONS` |

### 7.3 Blossom

- Servers come from `settings.blossomServers` (defaults in `blossom-providers.ts`); you can add your own or a Cloudflare Worker with R2.
- Upload is `PUT /upload` with **NIP-98** authorization bound to URL, method and body hash. Downloads are verified by recomputing SHA-256.
- Requires `enableBlossomSync` and a size within the configured maximum (`maxBlobSizePreset` / `customMaxBlobSizeMb`, 1 MB–1 GB; public servers usually have lower caps).
- The blob is encrypted before upload, so servers only see opaque bytes.
- **Settings are per device.** The receiving device downloads only from servers in **its own** `blossomServers` list; a server named in the mailbox pointer that is not in that list is ignored. A second device therefore needs the same Blossom server configured (and `enableBlossomSync` on), or it will not find the file.
- **Stable identity only for the user's own Workers.** Uploads are signed with the stable Worker key only when the server's host is in `privateWorkerHosts`; any other server sees an ephemeral key. A Blossom-only Worker must therefore be registered as the user's own (the wizard does it), or its `ALLOWED_PUBKEYS` allowlist rejects the upload.
- Timeouts: uploads 45 s, downloads 30 s (`BlossomClient`). Verified live up to 95 MB on a fast connection; a slow mobile link can exceed them.
- **Retention.** Mailbox events expire after 7 days (the Worker deletes expired events whenever one is stored or queried; verified live with 10 s and 60 s lifetimes). Blobs in R2 do not expire by themselves, so the deployment command adds an R2 lifecycle rule, `expire-blobs`, that deletes objects after 10 days: the pointer that references a blob lasts 7 days, and a blob is never reused across re-encryptions because every encryption uses a random IV. For an existing bucket: `npx wrangler r2 bucket lifecycle add omnisync-blossom expire-blobs --expire-days 10 -y`, or R2 → bucket → Settings → Object lifecycle rules in the dashboard (this is also how to do it for the Blossom-only Worker). **Still to verify:** the rule is created and Cloudflare accepts it, but the actual deletion of R2 files after 10 days has not been observed live yet (Cloudflare runs it in the background, normally within 24 h after expiry, and its minimum is 1 day).
- The size cap of the all-in-one Worker is 100 MB per blob (`MAX_UPLOAD_SIZE_BYTES`); larger uploads get HTTP 413 and the plugin fails cleanly.

### 7.4 Cloudflare Worker (optional)

There are two Worker templates, both generated from `scripts/` into `src/templates/cloudflare-worker-template.ts` (do not edit that file by hand):

| Template | Contains | Needs a terminal? | Mailbox? |
|---|---|---|---|
| **All-in-one** (`scripts/cloudflare-allinone/worker.js`) | Signaling, Blossom (R2), pairing room, **async mailbox** | Yes (`wrangler`) | Yes |
| **Blossom-only** (`scripts/cloudflare-blossom-worker.js`) | Blossom (R2) only | No (pasted in the web dashboard) | **No**, by design; notes use the public Nostr relay |

The all-in-one Worker needs three bindings and two migrations, all declared in `scripts/cloudflare-allinone/wrangler.jsonc` and in the template the wizard writes:

| Binding | Kind | Used for |
|---|---|---|
| `SIGNALING_ROOM` | Durable Object `SignalingRoom` (migration `v1`) | Signaling and pairing rooms |
| `MAILBOX_ROOM` | Durable Object `MailboxRoom` (migration `v2`, SQLite) | The async mailbox: one Nostr-style relay per room |
| `MY_BUCKET` | R2 bucket | Blossom blobs |
| `ALLOWED_PUBKEYS` | Text variable | Allowlist of public keys; with none set the Worker rejects everything (fail closed) |

How it behaves:
- **Authorization:** every WebSocket (`?room=`, `?mailbox=`, `?pair=`) and every upload requires a NIP-98 event; the allowlist is checked before any signature work. Downloads (`GET /<sha256>`) are public but only ever serve ciphertext.
- **Status page** (`GET /`): public JSON with `services.{blossom,signaling,mailbox,auth}.status`. Values are `ready` or `missing_r2_binding`, `missing_do_binding`, `missing_allowed_pubkeys`. The plugin reads it to warn about a Worker without a mailbox, and the wizard shows it in its status card.
- **Mailbox rules:** kind 30078 only, one event per `(pubkey, d)`, mandatory `expiration` (≤ 7 days), `created_at` within range, exactly one `t` tag equal to the room, signature verified, frame and room size limits, per-socket rate limit.
- **Hardening headers:** JSON responses (status and errors) send `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`; blobs are served as `application/octet-stream` with `nosniff`, a sandbox CSP and `Content-Disposition: attachment`. CORS is intentionally `*`: authorization, not origin, protects writes.
- **Anti-replay** memory is per isolate (best effort); uploads are content-addressed and idempotent, so a replayed event has no effect.
- **`MAILBOX_DEBUG=1`** (text variable) makes the mailbox log what the server receives for every stored event (id, public key, kind, tags, size, first 96 characters of the ciphertext). Use it only on a disposable Worker to verify obfuscation, and never leave it on in a real one.

**Deploying and updating.** The wizard writes three files (`package.json`, `wrangler.jsonc`, `worker.js`), runs `npm install`, creates the R2 bucket and runs `npx wrangler deploy`. A Worker deployed with an older template **must be redeployed** to get the mailbox or later hardening. Deploying again keeps the same URL; variables set only in the dashboard are replaced by those in `wrangler.jsonc` unless you pass `--keep-vars`.

---

## 8. Ephemeral pairing

Files: `src/security/pairing-session.ts` (protocol), `src/network/pairing-channel.ts` (transport), `src/security/pairing.ts` (payload), and the `?pair=` branch in `scripts/cloudflare-allinone/worker.js`.

- QR = `obsidian://omnisync-pair?data=<b64>` link (`registerObsidianProtocolHandler` → `handlePairingLink`, **always asking for user confirmation**). The copyable code `omnisync://pair2?data=` carries the same payload `{v:2, token, transport, server}`. Token: 128 bits, **2-minute TTL**, single use; the modal generates a new one on expiry. The master key is never in the QR.
- Room = HMAC(token, "room"). Messages: `hello → offer → done`. Ephemeral ECDH P-256 authenticated by a token-keyed MAC; HKDF-SHA256 (salt = token, info binding both public keys) → AES-256-GCM with AAD (type, room, public keys). The sensitive payload (master key, room, server) travels only inside `offer`.
- Single use: `PairingHostSession` burns the token after the first valid `hello`; a `busy` flag prevents race conditions.
- `nostr` channel: kind 25000 events tagged `t`=room, signature/timestamp/size strictly validated. `worker` channel: the host opens `/?pair=<room>&auth=<NIP-98>`; the guest joins unauthenticated only if the host is present (404/409 otherwise); Durable Object scoped to `pair:<room>`, max 4 sockets, 16 KB frames.
- `pairNewDevice` asks for confirmation if the incoming signaling server differs from the active one and shows the destination host.

---

## 9. Settings and persisted data

Obsidian stores settings in `data.json`. Because that file can be edited by anything with disk access, it is **untrusted input**: `loadSettings()` sanitizes it (`sanitizeBooleanSettings`, `sanitizeBlossomSettings`, `sanitizeLanguageSettings`, `sanitizeTombstones`, and `settings-security.ts`).

Main fields (`PluginSettings` in `types.ts`):

| Field | Purpose |
|---|---|
| `deviceId`, `deviceName`, `devicePlatform` | Identity of this device. |
| `pairingSecret` / `masterKeySecretId` | Master key in memory; persisted in `secretStorage`, not in `data.json`. |
| `roomId`, `signalingServer` | Room and relay/Worker URL (`wss://` only). |
| `autoSync`, `syncAttachments`, `syncObsidianConfig` | What is watched and synced. |
| `tidyAttachments` | If `true` (default), the plugin sets "Adjuntos" as the attachments folder and hides it from the file explorer with its own `<style>` element (`applyAttachmentTidy`). Only acts when Obsidian exposes `getConfig/setConfig`. The CSS is constant — no external data — to prevent injection. |
| `enableNostrMailbox` | Sync mode: `true` = dual path, `false` = pure P2P. |
| `enableBlossomSync`, `blossomServers`, `maxBlobSizePreset`, `customMaxBlobSizeMb` | Large-file storage. |
| `privateWorkerHosts` | Hosts that receive NIP-98 auth for your own Worker. |
| `pairedDevices` | Paired device list. |
| `lastSyncTimestamp`, `lastMailboxFetchTimestamp` | Sync cursors. |
| `pendingP2PSync`, `pendingMailboxOut` | The two persisted queues (section 5.3). |
| `deletedPaths` | Tombstones. |

Rules for changing the schema:
- Add the field as **optional** with a default in `DEFAULT_SETTINGS`, and sanitize it on load. Never assume its type.
- Keep backward compatibility: users upgrade in place and keep their old `data.json`.
- Never persist keys or secrets there (invariant I6).
- Run `npm run test:security` afterwards.

---

## 10. Security rules (invariants)

These must hold for every change. Each has a test; breaking one is a release blocker.

| # | Rule |
|---|---|
| I1 | Nothing is written to the vault without passing `validateVaultPath()` and the attachment policy. |
| I2 | Nothing is written without verifying integrity (SHA-256 of the file and of each chunk). |
| I3 | A newer local version is never overwritten (`sync-policy.ts`). |
| I4 | A remote deletion goes to the trash (`vault.trash`), never destroys. |
| I5 | Every message is validated before it touches the browser or the disk. |
| I6 | The master key lives only in `secretStorage`, never in `data.json`. |
| I7 | A relay cannot deduce a file path: the `d` tag is an opaque HMAC (64 hex) and contains no room id or app prefix. |
| I8 | The published package (`zip/OmnySync_stable/`) is byte-identical to a fresh build of `src/main.ts` (`npm run test:distribution`). |

Threat model in one line: **relays, blob servers and the network are untrusted**; paired devices share the secret and are trusted. See [`SECURITY.md`](../SECURITY.md) and [`SECURITY_FINDINGS_EN.md`](SECURITY_FINDINGS_EN.md) for the policy and the audit history.

The design has been verified in layers, and the results are public: directed audits, an automated tool baseline, live end-to-end checks on real Cloudflare Workers (including inspecting what the server receives to confirm data is encrypted and obfuscated), and DAST in containers. See [`TESTS_AND_AUDITS_EN.md`](TESTS_AND_AUDITS_EN.md) sections 2.6 and 2.7 for the method and the limits of that verification.

---

## 11. Testing

Tests run in Node, not inside Obsidian. Each suite is a TypeScript file in `tests/` that `esbuild` bundles with the Obsidian API replaced by `tests/obsidian-stub.ts` (see any `test:*` script in `package.json`).

```bash
npm test                  # every suite
npm run test:nostr        # one suite
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint (errors fail CI; warnings do not)
```

| Suite | What it covers |
|---|---|
| `test:security`, `test:realtime-security` | Validators, crypto primitives, WebRTC channel rules. |
| `test:nostr`, `test:nostr-delta` | Mailbox encryption, event validation, delta patches. |
| `test:delta`, `test:base` | Patch engine, base snapshot store. |
| `test:blossom` | Upload/download, NIP-98, hash validation. |
| `test:mysecret` | MySecret interoperability. |
| `test:pairing`, `test:pairing-channel` | Pairing protocol and channels. |
| `test:cloudflare-*` | Worker: auth, rooms, mailbox. |
| `test:i18n` | Every key present in the four languages. |
| `test:core` | Core integration. |
| `test:bughunt`, `test:auditor` | Regressions of fixed bugs and audit findings. |
| `test:dual-path` | Relay + P2P: resend queue, serialization, reconnect backoff, close-time flush, startup reconciliation. |
| `test:distribution` | Published package equals the current build. |

**Tips**
- `test:i18n` may fail under a non-English locale: run it with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.
- `test:distribution` needs an up-to-date package: run `npm run package:stable` first.
- To test plugin logic without Obsidian, create the plugin with `Object.create(OmniSyncPlugin.prototype)` and set only the fields the method needs (vault, settings, mailbox mock). `tests/test-dual-path-regression.ts` shows the pattern, including a fake WebSocket for reconnection and a fake vault.
- Every bug fix and every new validation ships with a **regression test using hostile input**. Prefer proving a test fails against the old behaviour (revert the fix, see it go red).
- **Live check against a real Worker** (manual, not part of `npm test`): `tests/live-worker-e2e.ts` uses the plugin's own code with two simulated devices. `MODE=pubkey node …` prints a secret and the public key to put in `ALLOWED_PUBKEYS` of a throwaway Worker; `MODE=run SECRET=… WORKER=wss://host/ node …` publishes from device A, fetches from device B, and checks live delivery, version replacement, deletes and a Blossom attachment. `MODE=blob` tests attachments from 1 to 101 MB (download, decrypt and byte-for-byte comparison; the Worker limit is 100 MB) and `MODE=blossom-only` tests the Blossom-only Worker. To audit what the server sees, deploy the disposable Worker with `MAILBOX_DEBUG=1` and run `wrangler tail`: each stored event should show only a 64-hex `d` tag, a 64-hex `t` tag and ciphertext. `tests/live-worker-fuzz.ts` is a purpose-built DAST fuzzer for NIP-98 authorization and the mailbox WebSocket (hostile frames, forged/expired events, floods); run it against a disposable Worker, ideally inside a `podman` container with CPU/memory limits. `tests/live-worker-auth.ts` checks, without knowing the secret, that a real Worker rejects any key that is not authorized. Deploy a disposable Worker for these checks and delete it (and its R2 bucket) afterwards; never leave `MAILBOX_DEBUG` on in a real Worker.
- What tests do **not** cover: a real Obsidian, real relays, real phones. Check mobile suspend/resume and relay-down scenarios manually before a release.

---

## 12. Recipes: common changes

### Add a setting
1. Add the field (optional) to `PluginSettings` in `types.ts` and a default in `DEFAULT_SETTINGS`.
2. Sanitize it in `loadSettings()` (or `settings-security.ts`).
3. Add the control in `src/ui/settings-tab.ts`; call `saveSettings()` and, if networking depends on it, `reconnectNetwork()`.
4. Add the strings to `src/i18n/types.ts` and **all four** locales.
5. Add a test in `test:security` or a regression suite.

### Add a user-visible string
Add the key to `src/i18n/types.ts` and to `es.ts`, `en.ts`, `zh.ts`, `ru.ts`; use `t('group.key', { vars })`. `test:i18n` fails if one language is missing.

### Add a message type (WebRTC)
Add it to `MessageType`, extend the validators in `protocol-security.ts` (reject unknown shapes), handle it in `handleIncomingProtocolMessage`, and add hostile-input tests.

### Add a transport or backend
It must (1) live in `src/network/`, (2) validate every inbound message through `src/security/` (never trust the channel), (3) ship tests that reject malicious input, and (4) expose its settings in `settings-tab.ts` with all four translations.

### Change the Worker
1. Edit `scripts/cloudflare-allinone/worker.js` (or the Blossom-only script).
2. Run `npm run build:templates` (regenerates `src/templates/cloudflare-worker-template.ts`); `test:cloudflare-allinone` fails if the embedded copy is out of sync.
3. Run `test:cloudflare-worker`, `test:cloudflare-allinone` and `test:cloudflare-mailbox`.
4. Verify on a real Worker: deploy a **disposable** one and run the live checks (section 11): `live-worker-e2e.ts`, `live-worker-auth.ts` and `live-worker-fuzz.ts`. Delete the Worker and its R2 bucket afterwards.
5. Note in the CHANGELOG that existing Workers need a redeploy if the change affects them.

---

## 13. Debugging

- **A note does not arrive:** check, in order, the sync mode (pure P2P never uses the relay), `settings.signalingServer`, the status bar, and the console for `[OmniSync Mailbox]` messages. A path stuck in `pendingMailboxOut` means the relay did not confirm it.
- **Works with a public Nostr relay but not with your Cloudflare Worker:** open `https://<your-worker>/` and check `services.mailbox.status`. `missing_do_binding` means the Worker was deployed without the `MAILBOX_ROOM` Durable Object (old template); redeploy with the current one (`wrangler.jsonc` declares both bindings and migrations). The plugin warns about this at startup.
- **A Cloudflare Worker rejects your device:** the key in `ALLOWED_PUBKEYS` must equal `workerAuthPublicKeyHex` (the wizard shows it). The status page reports `auth: missing_allowed_pubkeys` when the variable is empty.
- **Attachments missing on one device:** that device has no Blossom server configured, or Blossom is off there (settings are per device), or the file is over its size limit.
- **Checking what a server sees:** deploy a disposable Worker with `MAILBOX_DEBUG=1` and run `wrangler tail`; stored events must show only 64-hex `d` and `t` tags and ciphertext.
- **Devices on different versions ignore each other's mailbox:** the `d` tag domain changed once (`mailbox-path-v1` → `mailbox-dtag-v2`). Update both devices.
- **False conflicts:** look at `pendingP2PPaths`; extra entries make a note look "modified locally".
- **Phone stops receiving in the background:** expected (OS suspends sockets). It pulls on resume, on `online`, and every 60 s while active.
- **Large note does not sync:** over 64 KB with no Blossom and no base snapshot only travels by P2P; enable Blossom.
- **MySecret vaults:** while the vault is locked nothing is read or published (fail closed).

---

## 14. CI and dependencies

`.github/workflows/ci.yml` runs on every push and pull request (Node 22.x): `npm ci` → typecheck → lint → build → `npm test` → `npm run package:stable`, plus a CodeQL job.

- Third-party actions are **pinned to a commit SHA**, with the version in a trailing comment (`# v4`). To update one, resolve the new tag to its commit (`git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<tag>`) and replace the SHA; Dependabot can open these updates.
- `.github/dependabot.yml` checks npm and GitHub Actions weekly, groups updates, and uses a **7-day cooldown** so a freshly published (possibly malicious) version is not proposed immediately.
- `npm run audit` runs typecheck, lint and the dependency/secret/static scans (`audit:deps` osv-scanner, `audit:secrets` gitleaks, `audit:static` semgrep) if those tools are installed.

---

## 15. Releases and versioning

Follow **Semantic Versioning** (`MAJOR.MINOR.PATCH`).

1. Bump the version in `manifest.json`, `package.json` and `package-lock.json` (they must match).
2. Add an entry to `CHANGELOG.md`.
3. `npm run typecheck && npm run lint && npm test`.
4. `npm run package:stable`: builds and writes `zip/OmnySync_stable/` (`main.js`, `manifest.json`, `styles.css`) and `zip/OmnySync_stable.zip`. Commit the result so `test:distribution` passes.
5. Create a GitHub Release whose **tag equals the version, without a `v`** (e.g. `1.0.1`), and attach `main.js`, `manifest.json` and `styles.css`. Obsidian and BRAT install from these assets.

---

## 16. Best practices and contributions

- Validate **all** untrusted input: paths, sizes, payload types, signatures, timestamps. Add a hostile-input regression test for each new check.
- No `Math.random` or home-made crypto for secrets: use `crypto-manager` and native `crypto.subtle`.
- Every UI string goes through i18n (`es`, `en`, `zh`, `ru`) and must pass `test:i18n`.
- Bound concurrency and CPU on anything fed by the network (`concurrency-limiter`, merge budget).
- Never mix the two queues, never publish from `pendingP2PPaths`, and never bypass `broadcastChain` for sends.
- Update the docs when you change the architecture: this guide and [`TESTS_AND_AUDITS_EN.md`](TESTS_AND_AUDITS_EN.md).
- The project is released under PolyForm Noncommercial 1.0.0. By contributing you agree your contribution is distributed under the same license; open an issue before large changes.
- To report a vulnerability, follow [`SECURITY.md`](../SECURITY.md) instead of opening a public issue.

---

# Appendix: Extended Reference

> The following sections expand on the guide above with diagrams, deep-dives, and reference material.

## A. Architecture Overview Diagram

```text
LOCAL WRITE PATH
+-------------------+
| Local file edit   |
+---------+---------+
          |
          v
+---------+------------------+
| VaultWatcher             |
| 350 ms debounce          |
+---------+------------------+
          |
          v
+---------+------------------+
| broadcastChain           |
| serialized promise queue |
+---------+--------+---------+
          |        |        |
          |        |        +----------------------+
          |        |                               |
          |        |                               v
          |        |                 +-------------+--------------+
          |        |                 | BlossomClient.upload       |
          |        |                 +-------------+--------------+
          |        |                               |
          |        |                               v
          |        |                 +-------------+--------------+
          |        |                 | PUT /upload (NIP-98)      |
          |        |                 +-------------+--------------+
          |        |                               |
          |        |                               v
          |        |                         +-----+--------+
          |        |                         | Blob server  |
          |        |                         +-----+--------+
          |        |
          |        +-------------------------------+
          |                                        |
          v                                        v
+---------+------------------+       +-------------+--------------+
| sendFileToPeer           |       | publishToMailbox          |
+-------------+--------------+       +-------------+--------------+
              |                                    |
              v                                    v
   +----------+-----------+          +-------------+--------------+
   | Delta or full file  |          | FULL_NOTE                 |
   +----------+-----------+          | DELTA_PATCH               |
              |                      | BLOB_ATTACHMENT           |
              |                      +-------------+--------------+
              |                                    |
              v                                    v
   +----------+-----------+          +-------------+--------------+
   | WebRTC DataChannel   |          | Nostr relay               |
   | authenticated peer   |          | kind 30078                |
   +----------+-----------+          +-------------+--------------+
              |                                    |
              +----------------+-------------------+
                               |
                               v
                         +-----+--------+
                         | Remote peer |
                         +-------------+


RECEIVING PATH

+---------------------------+       +---------------------------+
| Nostr relay              |       | Blossom blob server       |
| WebSocket / poll         |       | attachment download       |
+-------------+-------------+       +-------------+--------------+
              |                                   |
              |             +---------------------+
              |             |
              +------------>|
                           v
                  +--------+---------+
                  | decryptPayload   |
                  +--------+---------+
                           |
                           v
                  +--------+---------+
                  | validateVaultPath |
                  +--------+---------+
                           |
                           v
                  +--------+---------+
                  | sync-policy.ts   |
                  | decision         |
                  +--------+---------+
                           |
                           v
                  +--------+---------+
                  | Vault write      |
                  +------------------+
```

## B. SyncState Machine

```text
SyncState = disconnected | signaling | connecting | connected | syncing | error


[disconnected] -- signalingClient.connect() called ----------------------> [signaling]

[signaling]    -- AUTH_COMPLETE received; begin ICE negotiation ---------> [connecting]

[connecting]   -- ICE connected ----------------------------------------> [connected]

[connected]    -- sync starts; manifest exchange/file transfer ----------> [syncing]

[syncing]      -- sync completes; FILE_COMPLETE/snapshot commit -------> [connected]


[signaling]    -- network/signaling/auth error -------------------------> [error]

[connecting]   -- ICE/network/DataChannel error -------------------------> [error]

[connected]    -- network/WebRTC error ----------------------------------> [error]

[syncing]      -- network/file-transfer error ---------------------------> [error]


[error]        -- retry/reconnect calls signalingClient.connect() ------> [signaling]


[signaling]    -- disconnect() or clean signaling close ----------------> [disconnected]

[connecting]   -- disconnect() or clean connection close ---------------> [disconnected]

[connected]    -- disconnect() ------------------------------------------> [disconnected]

[syncing]      -- disconnect()/abort -----------------------------------> [disconnected]

[error]        -- disconnect()/shutdown --------------------------------> [disconnected]
```

## C. WebRTC Message Sequence

```text
Device A                    Signaling / Auth                    Device B
   |                              |                               |
   |---- connect() -------------->|                               |
   |<--- AUTH_CHALLENGE ----------|                               |
   |---- AUTH_RESPONSE ----------->|                               |
   |<--- AUTH_COMPLETE ------------|                               |
   |                              |<---------- connect() ----------|
   |                              |--------- AUTH_CHALLENGE ------>|
   |                              |<-------- AUTH_RESPONSE --------|
   |                              |--------- AUTH_COMPLETE ------>|
   |                              |                               |
   |---- SDP offer + ICE -------->|------------------------------>|
   |                              |<--------- SDP answer + ICE ----|
   |<--- SDP answer + ICE ---------|                               |
   |                              |                               |
   |<========== authenticated WebRTC DataChannel ===============>|
   |                              |                               |
   |                              |        KEEPALIVE TIMING      |
   |---- PING(seq, t0) ----------->|                               |
   |<--- PONG(seq, t0) ------------|                               |
   |    PONG deadline: t0 + pongTimeout                            |
   |    next PING: t1 = t0 + heartbeatInterval                     |
   |                              |                               |
   |<--------- PING(seq, t1) ------|                               |
   |---- PONG(seq, t1) ----------->|                               |
   |    PONG deadline: t1 + pongTimeout                            |
   |    Missing PONG -> error/reconnect                           |
   |                              |                               |
   |---- MANIFEST_EXCHANGE (A manifest) -------------------------->|
   |<--- MANIFEST_EXCHANGE (B manifest) ---------------------------|
   |                              |                               |
   | Compare B manifest with      |                               |
   | local base snapshot;         |                               |
   | choose delta or full file    |                               |
   |                              |                               |
   |---- FILE_HEADER --------------------------------------------->|
   |     path, mode, base hash,   |                               |
   |     delta/full metadata      |                               |
   |                              |                               |
   |---- FILE_CHUNK 1 --------------------------------------------->|
   |---- FILE_CHUNK 2 --------------------------------------------->|
   |                         ...                                   |
   |---- FILE_CHUNK N --------------------------------------------->|
   |                              | Decrypt and apply chunks      |
   |                              |                               |
   |---- FILE_COMPLETE (size/hash) ------------------------------->|
   |                              |                               |
   |                              | Commit vault file             |
   |                              | Update base snapshot          |
```

### C.1 Message types

Defined in `MessageType` (`src/types.ts`):

| Type | Direction | Content |
|---|---|---|
| `AUTH_CHALLENGE` | → | Random challenge used to authenticate the peer |
| `AUTH_RESPONSE` | → | HMAC of the challenge with the shared key |
| `AUTH_COMPLETE` | → | Confirms that mutual authentication finished |
| `MANIFEST_EXCHANGE` | ↔ | File manifest with `mtime`, `size` and `hash` |
| `FILE_HEADER` | → | Transfer header (path, size, chunks, hash) |
| `FILE_CHUNK` | → | File fragment in Base64 |
| `FILE_COMPLETE` | → | Transfer close and integrity verification |
| `FILE_DELETE` | → | Remote deletion (applied to the trash) |
| `FILE_RENAME` | → | Remote rename |
| `PRESENCE_CURSOR` | ↔ | Peer's cursor position and selection |
| `LIVE_TEXT_DELTA` | ↔ | Live editing fragment (CodeMirror) |
| `PING` / `PONG` | ↔ | Keepalive and latency check |

> Adding a new type requires extending **three** layers: the `MessageType` union, the validators in `src/security/protocol-security.ts` (which reject unknown shapes) and the `handleIncomingProtocolMessage` handler in `main.ts`. Forgetting the validator is a security bug, not just a missing feature.

### C.2 Signaling and WebRTC protocol limits

All of these constants live in `src/security/protocol-security.ts` and `src/network/signaling-client.ts`:

| Constant | Value | What it protects |
|---|---|---|
| `MAX_ENCRYPTED_MESSAGE_BYTES` | 512 KB | Ceiling on a received encrypted message |
| `MAX_SIGNAL_LENGTH` | 128 KB | Ceiling on a signal (SDP/ICE) |
| `MAX_ICE_CANDIDATE_LENGTH` | 16 KB | Ceiling on an ICE candidate |
| `MAX_PENDING_ICE_CANDIDATES` | 100 | Queued ICE candidates before dropping |
| `MAX_PROTOCOL_MESSAGE_AGE_MS` | 10 min | Maximum age of a protocol message |
| `MAX_PROTOCOL_CLOCK_SKEW_MS` | 5 min | Tolerated clock skew |
| `MAX_SIGNALING_FRAME_LENGTH` | 512 KB | Ceiling on a signaling WebSocket frame |
| `MAX_NOSTR_SIGNAL_AGE_SECONDS` | 600 s | Age of a Nostr signal |
| `MAX_SIGNALING_EVENT_TAGS` | 16 | Tags per signaling event |
| `MAX_SIGNALING_TAG_PARAMETERS` | 8 | Parameters per tag |
| `MAX_SIGNALING_TAG_VALUE_LENGTH` | 1024 | Length of a tag value |

The `ReplayGuard` class (same file) remembers the `messageId`s already seen so that a relay cannot redeliver an old message as if it were new.


## D. Key Derivation Tree

```text
                 Master pairing secret
                 (32 bytes, canonical Base64, 44 characters)
                          |
                          |
    +---------------------+---------------------+
    |                     |                     |
    |  PBKDF2-SHA-256     |  PBKDF2-SHA-256     |  PBKDF2-SHA-256
    |  100,000 iterations |  100,000 iterations |  100,000 iterations
    |  salt:              |  salt:              |  salt:
    |  OmniSync-Salt-v1   |  OmniSync-Signaling-v1| OmniSync-Mailbox-v1
    v                     v                     v
+---------+        +---------+           +---------+
| vaultKey|        | signalingKey|        | mailboxKey|
+---------+        +---------+           +---------+
    |                     |                     |
    |  Encryption of     |  Encryption of     |  Encryption of
    |  WebRTC messages   |  signaling         |  mailbox payloads
    |                     |                     |
    +---------------------+---------------------+
                          |
             +------------+------------+
             |                         |
   PBKDF2 (BLOSSOM_KEY_CONTEXT)  PBKDF2 (SNAPSHOT_KEY_CONTEXT)
             |                         |
             v                         v
      +-------------+           +----------------+
      | blossomKey  |           | snapshotKey    |
      +-------------+           +----------------+
             |                         |
             v                         v
    Blob encryption before      Encryption of local
    upload                      base snapshots

    +-------------------------------------------+
    | deriveWorkerAuthKey (worker-auth.ts)     |
    |   NIP-98 identity for your own Worker     |
    +-------------------------------------------+


DERIVED IDENTIFIERS

secret -- HMAC(secret, "room", "signaling-room-v1") --> signalingRoomId
secret -- HMAC(secret, "room", "mailbox-room-v1")   --> mailboxRoomId
path   -- HMAC(path, "mailbox-dtag-v2")              --> mailboxDTag
```

### D.1 Derivation constants

All of these live in `src/crypto/crypto-manager.ts`, except the snapshot one:

| Constant | Value | Used for |
|---|---|---|
| `PAIRING_SECRET_BYTES` | `32` | Exact length of the master secret (256 bits) |
| `PAIRING_SECRET_BASE64_LENGTH` | `44` | Length of the canonical Base64 encoding |
| `VAULT_KEY_CONTEXT` | `OmniSync-Salt-v1` | Vault key derivation |
| `SIGNALING_KEY_CONTEXT` | `OmniSync-Signaling-v1` | Signaling key derivation |
| `MAILBOX_KEY_CONTEXT` | `OmniSync-Mailbox-v1` | Mailbox key derivation |
| `BLOSSOM_KEY_CONTEXT` | `OmniSync-Blossom-v1` | Blob key derivation |
| `SNAPSHOT_KEY_CONTEXT` (`base-snapshot-store.ts`) | `OmniSync-Snapshot-v1` | Encryption of local base snapshots |
| `MAX_ENCRYPTED_PAYLOAD_BYTES` | 768 KB | Ceiling on the plaintext that can be encrypted |

> **Why the contexts matter:** each use has its own *salt*, so the same master secret produces different AES keys. A key is never reused across two domains, which means a leak in one channel does not compromise the others.

### D.2 Derived identifiers

| Identifier | How it is derived | Used for |
|---|---|---|
| `signalingRoomId` | `computeHmacHex('room', secret, 'signaling-room-v1')` | Name of the signaling WebSocket channel |
| `mailboxRoomId` | `computeHmacHex('room', secret, 'mailbox-room-v1')` | Selector for the mailbox events |
| `mailboxDTag` | `computeHmacHex(path, secret, 'mailbox-dtag-v2')` | The opaque `d` tag of each event |
| `roomId` (legacy) | `SHA-256(secret)[0..16]` in hex | Legacy identifier, only used to validate v1 pairing payloads |

> The three identifiers are **independent**: the same secret produces three different outputs, so a relay that sees the `d` tag cannot correlate it with the room.

### D.3 Derivation rules

1. `deriveAesKey()` uses **PBKDF2-SHA-256 with 100,000 iterations** and produces 256-bit AES-GCM keys that are **non-extractable** (`extractable: false`).
2. Every encryption generates a **fresh random 12-byte IV** (`crypto.getRandomValues`). Reusing an IV with the same key breaks GCM completely.
3. `requirePairingSecret()` validates that the secret is exactly 256 bits with **canonical** Base64 (no spaces, no line breaks).
4. The HMAC code uses domain prefixes (`OmniSync-HMAC-v1\0<domain>\0<data>` and `OmniSync-Auth-v1\0<challenge>`), so the same key never produces the same tag in two different contexts.
5. Signature verification uses `crypto.subtle.verify`, which compares the MAC **in a timing-resistant way**.

## E. Conflict Resolution Flowchart

```text
+-----------------------------------+
| Input                             |
| remote note: path, mtime,         |
| content, deviceId                 |
| local state                       |
+-----------------+-----------------+
                  |
                  v
         +--------+---------+
         | Local file      |
         | exists?         |
         +--------+---------+
              |       |
          no  |       | yes
              |       v
              |  +--------+------------------+
              |  | remote.mtime <=          |
              |  | local.mtime?             |
              |  +--------+------------------+
              |       |                |
              |   yes |                | no
              |       v                v
              |  +--------+      +--------+------------------+
              |  | SKIP   |      | content identical?     |
              |  +--------+      +--------+------------------+
              |                          |                |
              |                      yes |                | no
              |                          v                v
              |                     +--------+      +--------+------------------+
              |                     | SKIP   |      | path in                |
              |                     +--------+      | pendingP2PPaths?        |
              |                                        | (local modified?)      |
              |                                        +--------+------------------+
              |                                               |                |
              |                                          yes |                | no
              |                                               v                v
              |                                    +--------+---------+  +--------+-------+
              |                                    | Try 3-way merge |  | APPLY remote   |
              |                                    | diff-merge.ts  |  +----------------+
              |                                    | budget:        |
              |                                    | MAX_MERGE_     |
              |                                    | COMPARISONS    |
              |                                    +--------+---------+
              |                                               |
              |                                               v
              |                                    +--------+---------+
              |                                    | Merge clean?    |
              |                                    +--------+---------+
              |                                               |
              |                                          yes |                | no
              |                                               v                v
              |                                    +--------+---------+  +--------+---------+
              |                                    | APPLY merged     |  | Merge conflict?  |
              |                                    +------------------+  +--------+---------+
              |                                                                      |
              |                                                                      v
              |                                                            +---------+----------+
              |                                                            | Save local as      |
              |                                                            | <name>.conflict-    |
              |                                                            | YYYY-MM-DD-HHMM.   |
              |                                                            | <ext>              |
              |                                                            +---------+----------+
              |                                                                      |
              |                                                                      v
              |                                                            +---------+----------+
              |                                                            | APPLY remote       |
              |                                                            +--------------------+
              |
              v
       +------+------+
       | APPLY remote |
       +-------------+
```

## F. Writing a New Transport

A transport is any channel through which OmniSync messages travel: today WebRTC (P2P), the Nostr mailbox and Blossom. If you add one, these are the rules the project already applies and that you must follow.

### F.1 The five obligations

| # | Obligation | Where it lives |
|---|---|---|
| 1 | Live in `src/network/` | No transport outside that directory |
| 2 | **Validate every incoming message** with `src/security/` before touching anything | The channel is not trusted even over TLS |
| 3 | **Never degrade to plaintext** | A cipher failure is a failure, not a "send it unencrypted" |
| 4 | Include tests that **reject malicious input** | `tests/test-<transport>.ts` |
| 5 | Expose its configuration in `src/ui/settings-tab.ts` with **all four** translations | `es`, `en`, `zh`, `ru` |

### F.2 Shape of the class

The project deliberately has **no** generic `Transport` interface: each transport is a concrete class with its own shape, because their lifecycles and capabilities differ sharply (WebRTC is bidirectional and live; the mailbox is asynchronous and one-way; Blossom only moves blobs). If you add one, follow the pattern of `NostrMailbox` or `BlossomClient`:

```ts
export class MyTransport {
  // Own state
  private connected = false;

  constructor(/* explicit dependencies */) {}

  /** Starts the connection. Throws if it cannot. */
  public async connect(): Promise<void> {}

  /** Closes and releases every resource (listeners, timers, sockets). */
  public async disconnect(): Promise<void> {}

  /** Publishes a message. Throws if the message is invalid. */
  public async send(message: unknown): Promise<void> {}

  /** Observable state for the status bar and the settings tab. */
  public getStatus(): SyncState { /* ... */ }
}
```

### F.3 Injecting the cryptography

The transport **does not** derive keys itself. It receives the already-derived key from `main.ts` (`deriveDomainKeys()`), so each domain has its own context and key:

```ts
// In main.ts, not in the transport:
const mailboxKey = await this.cryptoManager.deriveAesKey(secret, MAILBOX_KEY_CONTEXT);
this.nostrMailbox = new NostrMailbox(this.cryptoManager, mailboxKey, ...);
```

The symmetric API of `CryptoManager` is:

```ts
encrypt(data: unknown, key: CryptoKey): Promise<EncryptedMessagePayload>
decrypt<T>(payload: unknown, key: CryptoKey, asText?: boolean): Promise<T>
encryptBinary(data: Uint8Array, key: CryptoKey): Promise<Uint8Array>
```

The encrypted payload always has the shape `{ v, iv, ct }` (canonical Base64). If you need *authenticated context* (extra data that travels encrypted but must not be revealed), use the `additionalData` field of AES-GCM in `crypto.subtle` — never concatenate fields by hand into the plaintext.

### F.4 Validate before processing

The mandatory pattern, as it appears in `src/security/protocol-security.ts` and `transfer-security.ts`:

```ts
export function validateMyPayload(value: unknown): asserts value is MyPayload {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Payload with invalid shape.');
  }
  if (typeof value.path !== 'string') {
    throw new SecurityValidationError('The payload path is invalid.');
  }
  // The path ALWAYS goes through the vault's single validator:
  const path = validateVaultPath(value.path, policy);
  if (path !== value.path) {
    throw new SecurityValidationError('The payload path is not normalized.');
  }
}
```

Invariants:

1. Validate the **envelope** (type, ids, age) **before** decrypting or deserializing.
2. Validate the **decrypted content** with a versioned schema. The project does not use Zod; the pattern is `asserts value is T` over functions in `src/security/`.
3. Reject unknown fields. A message with an unforeseen shape is rejected, not silently ignored.
4. An invalid message **does not terminate the transport**: log a concise diagnostic, increment an error counter, and continue.
5. **Never** log message contents or credentials. Use `sanitizeExternalError()` / `sanitizeExternalText()` from `src/security/external-text.ts`, which also truncate to 160 characters (`MAX_EXTERNAL_TEXT_LENGTH`) and strip ANSI sequences.

### F.5 Bound the consumption

Everything that comes from the network needs an explicit ceiling:

| Ceiling | Existing constant |
|---|---|
| Encrypted message size | `MAX_ENCRYPTED_MESSAGE_BYTES` (512 KB) |
| File size | `MAX_TRANSFER_FILE_SIZE` (128 MiB) |
| Chunks per transfer | `MAX_TRANSFER_CHUNKS` (8192) |
| Simultaneous incoming transfers | `MAX_ACTIVE_INCOMING_TRANSFERS` (2) |
| Manifest entries | `MAX_MANIFEST_ENTRIES` (100 000) |
| Simultaneous Blossom operations | `MAX_CONCURRENT_BLOSSOM_OPERATIONS` (1) + `MAX_PENDING_BLOSSOM_OPERATIONS` (4) |

Use `ConcurrencyLimiter` (`src/security/concurrency-limiter.ts`) to bound concurrent work and `PathOperationQueue` (`src/security/path-operation-queue.ts`) to serialize operations on the same path.

### F.6 Wire it into the settings

1. Add the field to `OmniSyncSettings` in `src/types.ts` as **optional**, with its default in `DEFAULT_SETTINGS` (`src/main.ts`).
2. Sanitize it on load: `sanitizeBooleanSettings()`, `sanitizeBlossomSettings()`, `sanitizeLanguageSettings()`, `sanitizeTombstones()`.
3. Add the UI control in `src/ui/settings-tab.ts` and call `saveSettings()`; if the network depends on it, call `reconnectNetwork()`.
4. Add the strings to `src/i18n/types.ts` and to **all four** languages (`es`, `en`, `zh`, `ru`). `npm run test:i18n` fails if any is missing.

### F.7 The tests

Put the tests in `tests/test-<transport>.ts` and follow the pattern of `test-nostr-mailbox.ts`:

```bash
npm run test:security && npm run test:<transport>
```

The test must cover at least:

- Successful connection, disconnection, sending and receiving.
- Rejection of the **wrong key** (AEAD integrity).
- Rejection of **tampered ciphertext** (one byte changed).
- Rejection of **malformed**, **oversized** and **unsupported-version** payloads.
- Rejection of **duplicate or replayed** messages (`ReplayGuard`).
- **Resource cleanup**: timers, listeners, sockets and abort controllers released on disconnect.
- Settings defaults, persistence and migration.

Use mocked network and encryption services. Add **one** loopback integration test that exercises the complete `frame → decrypt → validate → dispatch` path. Tests **must not** require external network access or contain real credentials.

## G. Writing a Test

OmniSync tests run in a plain Node.js environment rather than inside Obsidian. This keeps tests fast and deterministic and avoids depending on a running vault, editor, or network connection.

### G.1 The test environment

The `tests/obsidian-stub.ts` file provides a minimal stand-in for the Obsidian API. The project does **not** use Node's built-in test runner: each suite is a standalone script that is bundled with `esbuild` and then executed with `node`.

A suite is declared in `package.json` like this:

```json
"test:my-suite": "esbuild tests/test-my-suite.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/test-my-suite.mjs --alias:obsidian=./tests/obsidian-stub.ts --external:@codemirror/state --external:@codemirror/view --log-level=warning && node node_modules/.cache/test-my-suite.mjs"
```

| Part | What it does |
|---|---|
| `--bundle` | Packs your imports and the project's into a single `.mjs` |
| `--platform=node --format=esm` | Runnable in Node, no `require` |
| `--alias:obsidian=./tests/obsidian-stub.ts` | **Redirects** the `obsidian` import to the stub |
| `--external:@codemirror/state` / `--view` | Leaves them out of the bundle (Obsidian provides them at runtime) |
| `--outfile=node_modules/.cache/...` | Writes to the cache, not to the repository |

Add the suite to the `test` chain in `package.json` so `npm test` runs it.

### G.2 What the stub contains

`tests/obsidian-stub.ts` exports lightweight versions of what the plugin uses: `normalizePath`, `TFile`, `TFolder`, `TAbstractFile`, `Vault`, `App`, `Plugin`, `Modal`, `PluginSettingTab`, `Setting`, `Notice`, `MarkdownView`, `Component`, `ItemView`, `TextComponent`, `ButtonComponent`, `ToggleComponent`, `DropdownComponent`, `addIcon`, `setIcon` and `normalize`.

Keep the stub intentionally small. Add an API only when a test needs it, and make each stub behave predictably—for example, `loadData()` can return an empty object and `saveData()` can record its argument.

### G.3 Creating plugin instances

Do not construct the plugin normally with `new OmniSyncPlugin(app, manifest)`. The Obsidian base constructor expects a live application and may access platform-specific state. Instead, create an instance from the prototype and initialize only the fields required by the test:

```ts
const plugin = Object.create(OmniSyncPlugin.prototype) as OmniSyncPlugin;
```

This preserves the plugin’s methods while bypassing its constructor. Use `Object.assign` or direct assignments to configure settings, state, callbacks, and dependency factories. Avoid calling `onload()` unless the test is specifically an integration test and the stub supports everything that method requires.

### G.4 Security regression tests

Treat messages and identifiers received from the server as untrusted, even when they arrive over an authenticated WebSocket. Security regression tests should preserve the original exploit or failure as a narrow, repeatable test.

Useful edge cases include:

- Empty, missing, or incorrectly typed values
- `"."`, `".."`, absolute paths, and `../` path traversal
- NUL bytes, control characters, malformed Unicode, and normalization collisions
- Malformed JSON, duplicate keys, missing fields, and oversized payloads
- Missing, empty, malformed, or tampered authentication tokens
- Paths pointing at `.obsidian/plugins`, `.git` or `.trash`
- Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`, `LPT1`)

Assert that invalid input is rejected before any file, network, or persistence operation occurs. Also verify that error messages and logs do not expose credentials or sensitive vault content. A table-driven test is useful when several inputs must produce the same result.

### G.5 Fake WebSocket pattern

Reconnection tests must never contact a real server. Inject a WebSocket factory into the plugin and return a fake socket that records its URL, sent frames, ready state, and lifecycle events. The fake should let a test explicitly simulate `open`, `message`, `error`, graceful `close`, and abnormal closure such as code `1006`.

Use fake timers or a zero reconnect delay to test backoff without waiting in real time. Tests should confirm both that a new socket is created after an unexpected disconnect and that a normal close does not cause an unwanted reconnect.

### G.6 Minimal complete example

The project does not use `node:test`; suites are plain scripts with a local `assert` helper. `tests/test-dual-path-regression.ts` shows the real pattern:

```ts
import OmniSyncPlugin from '../src/main';
import { CryptoManager } from '../src/crypto/crypto-manager';
import { TFile } from 'obsidian';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `window` only exists inside Obsidian.
(globalThis as unknown as { window: unknown }).window = globalThis;

/** Plugin without going through `onload`: only the fields the queue uses. */
function makePlugin() {
  const plugin: any = Object.create((OmniSyncPlugin as any).prototype);
  plugin.app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getFiles: () => Array.from(files.values()),
      read: async (f: TFile) => contents.get(f.path) ?? '',
    },
    plugins: { plugins: {} },
  };
  plugin.cryptoManager = new CryptoManager();
  plugin.settings = { autoSync: true, enableBlossomSync: false, /* ... */ };
  plugin.pendingMailboxPaths = new Set<string>();
  plugin.pendingP2PPaths = new Set<string>();
  plugin.broadcastChain = Promise.resolve();
  plugin.pendingFlushRunning = false;
  plugin.saveSettings = async () => {};
  // ... mock the mailbox, the base snapshot store, the vault watcher
  return plugin;
}
```

Note the two important details:

1. `window` is aliased to `globalThis` because the plugin uses `window.setTimeout` and `window.clearTimeout`, which do not exist in bare Node.
2. The plugin is created with `Object.create((OmniSyncPlugin as any).prototype)` and then populated field by field — never with `new`.

### G.7 How a fix is proven

The project's preference: **show that the test fails against the old code**. Revert the fix, run the test and watch it go red; restore the fix and watch it go green. A test that has never been seen failing proves nothing.

```bash
npm run typecheck && npm run lint && npm test
```

### G.8 Common failures

| Symptom | Usual cause |
|---|---|
| `Cannot find module 'obsidian'` | Missing `--alias:obsidian=./tests/obsidian-stub.ts` in the suite script |
| `ERR_MODULE_NOT_FOUND` with `@codemirror/*` | Missing `--external:@codemirror/state --external:@codemirror/view` |
| `window is not defined` | The suite does not alias `globalThis` to `window` |
| `test:i18n` fails on a non-English machine | Run with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run test:i18n` |
| `test:distribution` fails | The published package is stale: run `npm run package:stable` |
| The test hangs | A timer or listener was not cleaned up: check `disconnect()` / `onunload()` |

This arrangement isolates the behavior under test, produces no external traffic, and makes failures easy to diagnose.

## H. Performance Considerations

OmniSync uses bounded delays and explicit limits to balance responsiveness, throughput, and UI responsiveness.

| Setting | Default | Primary implication |
|---|---:|---|
| Change debounce | **350 ms** | Coalesces bursts of vault events before syncing |
| DataChannel chunk size | **32 KiB** (`32 × 1024` bytes) | Balances per-message overhead against back-pressure |
| Blossom mobile upload timeout | **60 seconds** | Accommodates slower mobile uplinks |
| Blossom mobile download timeout | **30 seconds** | Fails over sooner when a remote object is unavailable |
| 3-way merge CPU budget | **100 ms** | Prevents an expensive conflict from blocking interaction |

### H.1 Debounce timing

The **350 ms** debounce waits for a short period of inactivity after the last vault change. This prevents a single logical edit—often reported by Obsidian as several create, modify, or metadata events—from triggering redundant hashing, serialization, and network traffic.

The tradeoff is added latency: synchronization begins only after the event stream has been quiet for 350 ms. This delay is separate from transfer time and is not a hard synchronization deadline during continuous editing, where new events may keep resetting the timer. A maximum-wait policy can prevent indefinite postponement, but it also increases redundant work.

### H.2 `broadcastChain` serialization

`broadcastChain` serializes broadcast operations through a promise chain. Operations admitted to the chain are processed in **FIFO order**, ensuring that a later broadcast observes the state produced by an earlier one. This avoids races caused by concurrent snapshot capture or channel writes.

The guarantee comes at a cost. Each queued operation retains its payload or closure until its turn arrives, while snapshot and message-serialization time is paid on the critical path. A slow operation therefore causes head-of-line blocking and can increase memory use during bursts. Errors must be caught per link; an unhandled rejection must not poison the chain and prevent subsequent broadcasts from running. This ordering applies to work processed by that chain, not to a global total order across separate devices.

### H.3 Chunk size and DataChannel back-pressure

The default DataChannel chunk size is **32 KiB**. Smaller chunks reduce the amount of memory held for one transfer and let the sender react more quickly when the channel is congested. Larger chunks can improve throughput by reducing message headers and scheduler overhead, but they also consume more of the channel buffer and make a failed or retransmitted chunk more expensive.

The sender must respect `bufferedAmount` or an equivalent acknowledgement/credit scheme. Enqueuing every chunk at once can exhaust the DataChannel buffer even though individual sends appear successful. A bounded window of outstanding chunks, with transmission paused when the buffer crosses a high-water mark and resumed below a low-water mark, prevents memory spikes and keeps one slow peer from stalling the pipeline.

### H.4 Blossom timeouts on mobile

Blossom operations use a **45-second upload timeout** and a **30-second download timeout** (`BlossomClient`). These limits are enforced with an abortable request and produce a distinct timeout result rather than being reported as ordinary HTTP failures. Retries use backoff; because Blossom objects are content-addressed, repeating an upload is safe. Uploads of up to 95 MB have been verified live on a fast connection. Mobile suspension and a weak signal make elapsed-time limits less predictable, which is why the limits are generous and errors are reported cleanly instead of blocking the queue.

### H.5 3-way merge CPU budget

The 3-way merge is limited by `MAX_MERGE_COMPARISONS = 20 000 000` comparisons (`src/sync/diff-merge.ts`). This is a **comparison budget**, not a wall-clock deadline: it is deterministic and does not depend on how loaded the machine is. When the budget is exceeded the merge is aborted and the conflict is preserved for manual resolution as `<name>.conflict-YYYY-MM-DD-HHMM.<ext>`. A budget is preferred over a timeout because it never blocks Obsidian's main thread for an unbounded period.

The diff engine that produces the patches has its own limits, so a pathological file is rejected before it ever reaches the merge: `MAX_MYERS_DIFFERENCE = 4 000`, `MAX_MYERS_TRACE_CELLS = 16 Mi`, `MAX_PATCH_LENGTH = 4 MiB`, `MAX_PATCH_HUNKS = 10 000`, `MAX_PATCH_HUNK_LINES = 20 000` and `MAX_CONTEXT_LINES = 100`.

## I. Cloudflare Worker Internals

OmniSync’s Cloudflare Worker is an all-in-one service for Blossom blob operations, WebSocket signaling and pairing, mailbox delivery, and NIP-98 authorization. It combines R2 storage with Durable Objects and exposes each subsystem through the same Worker deployment.

### I.1 Durable Objects

- **`SignalingRoom` — migration v1:** Handles WebSocket connections for signaling and device pairing. It uses the Durable Objects Hibernation API, so waiting connections do not incur CPU charges while idle and are resumed when a message arrives.
- **`MailboxRoom` — migration v2 with SQLite:** Maintains one Durable Object per vault room and stores kind-30078 mailbox events in SQLite. Each room operates independently, while its storage enforces event expiration whenever data is read or written.

### I.2 `MailboxRoom` storage

- Events are keyed by the composite **`(pubkey, d_tag)`** pair, allowing only one event per file per device within a room.
- The SQLite schema includes an **`expiration`** column. Every query checks this value, and expired rows are removed lazily.
- Before an event is stored, its **`t` tag** must exactly match the room name. This prevents an event intended for one room from being accepted by another.

### I.3 NIP-98 authorization flow

1. The client creates a Nostr authorization event of **kind 27235**, including `url` and `method` tags and, when applicable, a `payload` tag containing the SHA-256 hash of the request body.
2. The event is signed with the Worker authentication key. Operator-owned Workers use a stable identity, while public servers use an ephemeral key.
3. The client sends the base64-encoded event in the `Authorization: Nostr <base64(event)>` header.
4. The Worker base64-decodes and JSON-parses the event, verifies its Nostr signature, confirms that its pubkey appears in `ALLOWED_PUBKEYS`, checks that the URL and method match the request, and verifies that the event timestamp is fresh.

### I.4 Rate limiting

- **Per-socket limit:** Each WebSocket connection may send at most `RATE_LIMIT_MAX_MESSAGES` (120) messages per `RATE_LIMIT_WINDOW_MS` (10 s) window. The mailbox uses its own, higher limit: `MAILBOX_RATE_LIMIT_MAX_MESSAGES` (240).
- **Frame limit:** A signaling frame may not exceed `MAX_SIGNALING_MESSAGE_BYTES` (512 KB); a pairing frame may not exceed `MAX_PAIR_MESSAGE_BYTES` (16 KB).
- **Room connection limit:** Each signaling room allows up to `MAX_SOCKETS_PER_ROOM` (32) concurrent sockets; each pairing room allows up to `MAX_SOCKETS_PER_PAIR_ROOM` (4).
- **Mailbox limits:** at most `MAX_MAILBOX_SOCKETS` (16) sockets per room and `MAX_MAILBOX_SUBSCRIPTIONS_PER_SOCKET` (4) subscriptions per socket.

### I.5 Mailbox storage limits

| Limit | Value | Constant |
|---|---|---|
| Events per room | 2 000 | `MAX_MAILBOX_EVENTS_PER_ROOM` |
| Bytes per room | 96 MiB | `MAX_MAILBOX_BYTES_PER_ROOM` |
| Results per query | 500 | `MAX_MAILBOX_RESULTS` |
| Maximum TTL accepted | 7 days + 60 s | `MAILBOX_MAX_TTL_SECONDS` |
| Maximum event age | 8 days | `MAILBOX_MAX_AGE_SECONDS` |
| Allowed public keys | 32 | `MAX_ALLOWED_PUBKEYS` |
| Replay record TTL / size | 5 min / 10 000 | `REPLAY_TTL_MS` / `MAX_REPLAY_ENTRIES` |

### I.6 Status endpoint

`GET /` returns a JSON document describing the state of each Worker service:

```json
{
  "services": {
    "blossom": {
      "status": "ready"
    },
    "signaling": {
      "status": "ready"
    },
    "mailbox": {
      "status": "ready"
    },
    "auth": {
      "status": "ready"
    }
  }
}
```

Each service can report the following statuses:

- **`ready`** — The required binding or configuration exists and is functional.
- **`missing_r2_binding`** — The R2 bucket is not bound to the Worker.
- **`missing_do_binding`** — The required Durable Object binding is missing, and the Worker must be redeployed.
- **`missing_allowed_pubkeys`** — The `ALLOWED_PUBKEYS` variable is empty, causing the Worker to reject all authorization attempts.

### I.7 The deployment flow

The wizard in the interface (`src/ui/cloudflare-worker-modal.ts`) builds a one-line command from the templates embedded in `src/templates/cloudflare-worker-template.ts`. The command:

1. Creates the `omnisync-server` directory and enters it.
2. Writes `package.json`, `wrangler.jsonc` and `worker.js` using quoted heredocs (`<<'OMNISYNC_EOF'`), so bash does not interpret backticks, `${}` or `$`.
3. Runs `npm install`.
4. Creates the R2 bucket `omnisync-blossom` (the error is ignored if it already exists).
5. Adds the `expire-blobs` lifecycle rule with a 10-day expiry (the error is ignored if it already exists).
6. Runs `npx wrangler deploy`.

> The templates are **generated**: `npm run build:templates` regenerates `src/templates/cloudflare-worker-template.ts` from `scripts/`. `test:cloudflare-allinone` fails if the embedded copy is out of sync with the source files. **Do not edit `src/templates/cloudflare-worker-template.ts` by hand.**

### I.8 Blossom: stable vs ephemeral identity

The key that signs an upload is **stable** only if the server's host is listed in `settings.privateWorkerHosts`. Every other server sees an ephemeral key. This has an important operational consequence: a **Blossom-only** Worker must be registered as your own (the wizard does it), or its `ALLOWED_PUBKEYS` allowlist will reject the upload.

## J. Glossary

- **vault** — The Obsidian folder being synchronized by OmniSync. Its files and directory structure form the content synchronized between participating devices.

- **room** — A pseudonymous identifier derived with HMAC and used as both the WebSocket channel name and the mailbox selector. It never exposes the vault’s master secret.

- **mailbox** — A Nostr relay channel used for asynchronous delivery through kind-30078 events. It allows changes to reach peers that were offline when those changes were made.

- **relay** — A Nostr WebSocket server that stores and forwards events to subscribers. OmniSync treats relay infrastructure as untrusted and uses mechanisms such as message IDs and expiration checks to limit replay and stale delivery.

- **pairing** — An ephemeral ECDH protocol through which two devices establish a shared master secret. The pairing material is transferred through a QR code or copy-paste link and is not intended for long-term storage.

- **tombstone** — A record in `deletedPaths` that stores the modification time and deletion time of a locally deleted file. It prevents a stale manifest from recreating a file that the user has already deleted.

- **base snapshot** — The most recent version of a file known to be common to the devices involved in a synchronization operation. It serves as the ancestor in a three-way merge and as the basis for constructing or applying a delta patch.

- **delta patch** — A unified-diff representation of a file change, divided into chunks that can be transferred efficiently. Sending a patch through the mailbox avoids re-uploading the entire file when only a small portion has changed.

- **NIP-98** — A Nostr specification for authorizing HTTP requests with a signed Nostr event used as a bearer credential. OmniSync uses kind 27235 events with the `Authorization: Nostr <base64(event)>` header, optionally binding the request body with a SHA-256 payload hash.

- **NIP-40** — The Nostr specification that defines the `expiration` tag and its Unix timestamp semantics. Relays are instructed to delete expired events, and OmniSync’s mailbox storage also checks expiration during every read and write.

- **BUD-01/02** — The Blossom protocol specifications defining the blob upload and download interfaces. BUD-01 covers `PUT /upload`, while BUD-02 covers content-addressed retrieval through `GET /<sha256>`.

- **kind 30078** — The parameterized replaceable Nostr event kind, defined by NIP-78, used for OmniSync mailbox messages. Within a room, the `pubkey` and `d_tag` pair identifies the device and file represented by an event.

- **broadcastChain** — A single promise chain that serializes all outgoing sends in mutation order. This prevents an older file version from being broadcast after a newer version and overtaking it.

- **dual-path mode** — A synchronization mode in which each edit is sent through the relay mailbox and, when a peer is connected, directly through P2P. The mailbox provides an asynchronous fallback when no peer is available at the time of the edit.

- **pure P2P mode** — A synchronization mode that does not use the relay mailbox. Both devices must be online and connected at the same time because there is no relay-based delivery queue.

- **pendingMailboxOut** — A persisted queue of file paths whose relay delivery has not yet been confirmed. OmniSync retries these paths with exponential backoff until delivery succeeds or the entry is otherwise resolved.

- **pendingP2PSync** — A persisted queue of paths that require full reconciliation with a peer. An entry is added when the expected base snapshot does not match or when applying a delta patch fails.

- **ReplayGuard** — An in-memory set of recently observed message IDs used to recognize duplicate deliveries. It prevents a relay from replaying an already processed message as though it were a new update.

## K. Security Invariants — Why Each Matters

### I1 — Validate the vault path before every disk write

Every path derived from a relay event must pass `validateVaultPath` before it reaches the filesystem.

- **Path traversal:** Reject paths that escape the vault through `..`, absolute paths, or equivalent encodings. This prevents a crafted event from targeting files such as `../../.bashrc`.
- **Reserved-name attacks:** Reject Windows device names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`, and `LPT1`, including names that become reserved after adding an extension. This prevents writes to special devices rather than ordinary files.
- **Symlink injection:** Validate the canonical target and ensure it remains inside the vault, including when a component is a symbolic link. A relay must not be able to redirect an apparently vault-relative path to a location outside the vault.

Validation must occur immediately before each write because a path that was safe when received may become unsafe later.

### I2 — Apply SHA-256 integrity checks to every file and chunk

Every file and every multipart chunk must match its expected SHA-256 digest before OmniSync accepts or applies it.

This prevents a relay or blob server from substituting subtly corrupted data, including data that is still structurally valid or decrypts successfully but represents the wrong content. The digest binds the accepted bytes to the content that was originally published, so a mismatch causes rejection, reassembly, or resync instead of silent corruption.

### I3 — Never overwrite a newer local file

Before applying remote content, OmniSync must determine whether the local file has advanced beyond the version represented by the incoming update.

This prevents a stale copy cached by a relay from overwriting edits made while the device was offline. A newer local version is retained and, when necessary, merged with the remote version rather than being replaced by an older one.

### I4 — Send remote deletions to trash, never destroy them permanently

A deletion received from another paired device must move the affected file to the vault’s trash rather than unlink it permanently.

This limits the damage from a compromised paired device: an attacker can remove content from the active vault, but cannot make it unrecoverable. The file remains available for restoration and forensic recovery.

### I5 — Validate relay data before any browser or disk operation

Relay events are untrusted input. Their schemas, field types, sizes, paths, and other constrained values must be validated before the data is used by browser code or written to disk.

- **Prototype pollution:** Reject dangerous property names such as `__proto__`, `constructor`, and `prototype`, and avoid unsafe object-merging patterns.
- **ReDoS:** Apply bounded, safe validation to attacker-controlled patterns or similarly expensive expressions.
- **JSON injection:** Parse and validate structured data rather than interpolating raw event content into JSON, HTML, or executable expressions.

Fail-closed validation prevents malicious event content from reaching sensitive browser or filesystem APIs.

### I6 — Keep the master key in `secretStorage`, never in `data.json`

The vault master key must be stored through Obsidian’s `secretStorage`, backed by the operating system’s secure credential facilities where available.

Keeping it out of `data.json` prevents disclosure through:

- Vault synchronization to another device
- Git commits and repository history
- Cloud backups of `.obsidian/plugins/omnisync/data.json`
- Accidental sharing or packaging of the plugin’s data directory

`data.json` may contain ordinary configuration, but it must never contain the master key or another value sufficient to derive it.

### I7 — Use an opaque HMAC-based d-tag with no path information

The d-tag exposed to the relay must be an opaque keyed HMAC value, not an encoded filename, path, or reversible identifier.

This prevents the relay operator from learning:

- The names of synchronized files
- Their directory structure
- Which real vault paths correspond to observed d-tags

The same path can produce a stable opaque tag across events, allowing correlation without revealing its name. The relay can still observe traffic metadata such as tag frequency, timing, and payload sizes, so the d-tag protects path confidentiality rather than all metadata.

### I8 — Publish exactly the freshly built package

The published package must be generated from the current audited source tree in a clean build. Stale or separately supplied build artifacts must not be published in place of that build.

This prevents a supply-chain attack in which benign source code and tests appear correct while a pre-built JavaScript bundle contains malicious code. Building and publishing the exact artifact from the reviewed source ensures that the code users install corresponds to the code that was audited.

## L. Delta Patch Deep-Dive

### Selection in `publishToMailbox`

`publishToMailbox` chooses among three publication forms.

1. **`FULL_NOTE`**

   A text file whose size is no greater than `MAX_MAILBOX_NOTE_SIZE` (64KB) is published as a `FULL_NOTE`. Its content contains the complete text, so the receiver does not need a base snapshot or patch metadata.

2. **`DELTA_PATCH`**

   A text file larger than 64KB can be published as a delta when all of the following are true:

   - A base snapshot exists for the path.
   - A unified diff can be computed against that snapshot.
   - The serialized diff fits within the multipart limits: at most 16 chunks, with each chunk limited to 48KB.

   The publication consists of a `DELTA_PATCH` description and one or more `DELTA_CHUNK` events. The chunk metadata includes:

   - `patchId`
   - `chunkIndex`
   - `totalChunks`
   - `baseHash`
   - `targetHash`

   `baseHash` identifies the exact snapshot from which the patch was generated. `targetHash` identifies the content that must exist after the patch is applied.

3. **`BLOB_ATTACHMENT`**

   The blob path is used when:

   - The file is binary.
   - No base snapshot exists for a file that would otherwise require one.
   - The generated diff is too large for the chunk limits.
   - Blossom is enabled, in which case blob transport is selected instead of note or delta transport.

   OmniSync uploads the encrypted blob and publishes a `BLOB_ATTACHMENT` containing:

   - `blobSha256`
   - `blobSize`
   - `blobServer`

   The blob metadata tells the receiver

## M. MySecret Interoperability

OmniSync can operate in a vault that uses the MySecret Obsidian plugin, but it does not bypass, unlock, or manage MySecret’s encryption. MySecret remains the authority on the vault’s encryption state. OmniSync never requests or stores the MySecret password.

### Locked-state detection

Before preparing a publication—and again before committing it—OmniSync checks the lock state reported by MySecret. A vault is considered publishable only when MySecret explicitly reports that it is unlocked and ready. OmniSync does not infer readiness from whether an individual Markdown file happens to be readable, because that can produce an inconsistent view during startup, shutdown, or an unlock transition.

If MySecret is installed but its state cannot be determined—for example, while the plugin is still loading—OmniSync treats the vault as locked.

### Fail-closed behavior

When the vault is locked, or its state is uncertain, OmniSync publishes nothing. It sends no added, modified, or deleted files, does not flush queued changes, and leaves the existing remote state untouched. This all-or-nothing behavior also prevents a locked vault from appearing to the remote as if files had been deleted.

### Why partial decryption is dangerous

An unlock or lock operation may temporarily produce a mixed state: some files may be decrypted, others may remain encrypted, and cached content may differ from what is stored on disk. Publishing that state could expose plaintext intended to remain protected, overwrite valid remote content with ciphertext, or propagate an inconsistent vault snapshot. Encryption at the synchronization destination cannot undo content that has already been published incorrectly.

### Normal unlocked flow

Once MySecret reports the vault as unlocked, OmniSync resumes its normal pipeline: it observes vault changes, builds the publication set, uploads the current vault representation, and records the result. If MySecret locks the vault during a publication, OmniSync aborts before commit and publishes no partial payload. The vault can resume syncing after MySecret reports it unlocked again.

## N. Extending i18n — Adding a New Language

The following example adds French (`fr`) as a supported language, following the project's real conventions.

### N.1 The current structure

| Element | Location | Contents |
|---|---|---|
| Language option | `src/types.ts` | `LanguageOption = 'auto' \| 'en' \| 'es' \| 'ru' \| 'zh'` |
| Supported languages | `src/i18n/types.ts` | `SupportedLanguage = 'en' \| 'es' \| 'ru' \| 'zh'` |
| Schema | `src/i18n/types.ts` | `TranslationSchema` with every group of keys |
| Dictionaries | `src/i18n/locales/{en,es,ru,zh}.ts` | One exported object per language |
| Engine | `src/i18n/index.ts` | `LOCALES`, `t()`, `detectObsidianLocale()`, `resolveEffectiveLanguage()` |
| Selector | `src/ui/settings-tab.ts` | The language dropdown options |
| Test | `tests/test-i18n.ts` | Checks that the keys match across the four languages |

### N.2 Adding the language, step by step

**1. Extend both types** in `src/types.ts` and `src/i18n/types.ts`.

```ts
// src/types.ts
export type LanguageOption = 'auto' | 'en' | 'es' | 'fr' | 'ru' | 'zh';

// src/i18n/types.ts
export type SupportedLanguage = 'en' | 'es' | 'fr' | 'ru' | 'zh';
```

**2. Create the dictionary `src/i18n/locales/fr.ts`.**

Copy `src/i18n/locales/en.ts` and translate it. Keep the **exact same** key structure, nested objects, interpolation variables (`{name}`, `{count}`) and placeholders. Translate the **values**; never rename or remove a key.

```ts
export const fr = {
  settings: {
    language: 'Langue',
    // ...
  },
};
```

**3. Add the language name to every dictionary.**

The key must be **identical** everywhere; only the value changes:

```ts
// src/i18n/locales/en.ts
language: { french: 'French' },
// src/i18n/locales/fr.ts
language: { french: 'Français' },
```

Keeping the key identical while localizing its value lets the language selector work in every supported interface language.

**4. Register the locale in `src/i18n/index.ts`.**

```ts
import { fr } from './locales/fr';

const LOCALES: Record<SupportedLanguage, TranslationSchema> = {
  en, es, fr, ru, zh,
};
```

And update `resolveEffectiveLanguage()` to recognize the prefix:

```ts
if (option === 'es' || option === 'en' || option === 'fr' || option === 'ru' || option === 'zh') {
  return option;
}
```

**5. Add the option to the dropdown** in `src/ui/settings-tab.ts`.

```ts
{ value: 'fr', label: t('language.french') },
```

**6. Validate.**

```bash
npm run test:i18n
```

The test fails when a locale is missing a key or contains an unexpected key. Correct all reported differences before committing.

**7. Troubleshoot locale errors.**

If Node reports an unsupported or malformed locale, retry with:

```bash
LANG=en_US.UTF-8 npm run test:i18n
```

This fixes the test process’s locale environment; it does not change the translation files.

### N.3 How the translation engine works

| Aspect | Behaviour |
|---|---|
| Auto-detection | `detectObsidianLocale()` checks Obsidian's `localStorage.language`, then `moment.locale()`, then `navigator.language`. If everything fails it returns `en`. |
| Fallback chain | current language → `en` → `es` → the key path itself |
| Interpolation | `t('group.key', { name: 'X' })` substitutes `{name}` |
| Prototype safety | `getNestedValue()` uses `Object.getOwnPropertyDescriptor` and rejects `__proto__`, `constructor` and `prototype` at every segment of the path. Inherited properties are never read and prototype getters are never executed. |
| Blossom providers | `getLocalizedBlossomProviderInfo()` only accepts known providers and uses `hasOwnProperty` |

> The last row is not a detail: without `getOwnPropertyDescriptor`, a translation key coming from the interface could reach the prototype chain. `test:i18n` does not cover it, but `test:security` does check the engine's behaviour.

## O. Repository Map and Reference Files

### O.1 The complete tree

```text
OmniSync/
├─ main.js                     # Generated bundle (published; DO NOT edit)
├─ manifest.json               # Plugin metadata; the version lives here
├─ styles.css                  # Plugin styles
├─ package.json                # Dependencies and scripts (incl. every suite)
├─ package-lock.json
├─ tsconfig.json               # Strict TypeScript, target ES2020
├─ esbuild.config.mjs          # Bundle config (CommonJS, ES2020)
├─ eslint.config.mjs           # Flat ESLint + eslint-plugin-security
├─ .semgrepignore              # Excludes src/i18n/locales (known false positive)
├─ .gitignore
├─ CHANGELOG.md
├─ LICENSE                     # PolyForm Noncommercial 1.0.0
├─ README.md / README.es.md
├─ PROTOCOL_WHITEPAPER.md
├─ OmniSync_for_Obsidian.pdf
├─ assets/                     # Icons and banner (several sizes and formats)
├─ docs/
│  ├─ Developer_Guide_EN.md     # This guide, English
│  ├─ Guía de Desarrolladores.md # This guide, Spanish
│  ├─ User_Guide_EN.md / Guía de Usuario.md
│  ├─ COMPARISON_EN.md / COMPARATIVA_es.md
│  ├─ PROTOCOL_WHITEPAPER.md
│  ├─ TESTS_AND_AUDITS.md / TESTS_AND_AUDITS_EN.md
│  ├─ audits/                  # Security audit reports
│  └─ plans/                   # Design plans
├─ src/
│  ├─ main.ts                  # Orchestrator (2593 lines): the heart of the plugin
│  ├─ types.ts                 # Shared types
│  ├─ crypto/crypto-manager.ts
│  ├─ network/                 # webrtc-peer, nostr-mailbox, blossom-client,
│  │                           # blossom-providers, signaling-client, pairing-channel
│  ├─ sync/                    # vault-watcher, manifest-calc, file-transfer,
│  │                           # delta-patch, base-snapshot-store, diff-merge
│  ├─ security/                # 14 validation and policy modules (pure)
│  ├─ collab/codemirror-collab.ts
│  ├─ ui/                      # settings-tab, pairing-modal, cloudflare-worker-modal,
│  │                           # status-bar, icons
│  ├─ i18n/                    # index.ts, types.ts, locales/{en,es,ru,zh}.ts
│  └─ templates/cloudflare-worker-template.ts  # GENERATED, do not edit
├─ scripts/
│  ├─ cloudflare-allinone/     # worker.js, wrangler.jsonc, package.json
│  ├─ cloudflare-blossom-worker.js
│  ├─ generate-cloudflare-templates.mjs
│  ├─ package-stable.mjs       # Builds zip/OmnySync_stable/
│  └─ sync-to-github.sh        # Copies the source tree to Github/
├─ tests/                      # Suites + stubs + live tests
└─ zip/                        # Generated release package
```

### O.2 The `src/security/` modules in detail

| File | Lines | Responsibility | Key exports |
|---|---|---|---|
| `vault-security.ts` | 207 | The single gate for paths | `validateVaultPath`, `isAllowedVaultPath`, `isPlainObject`, `decodeCanonicalBase64`, `SecurityValidationError` |
| `protocol-security.ts` | 287 | Message and signal validation | `validateBaseProtocolMessage`, `validateAuthChallengePayload`, `validateAuthResponsePayload`, `validatePresencePayload`, `validateWebRtcSignal`, `ReplayGuard` |
| `transfer-security.ts` | 220 | Transfer and manifest limits | `validateFileHeader`, `validateFileChunk`, `validateFileDeletePayload`, `validateFileRenamePayload`, `validateRemoteManifest` |
| `sync-policy.ts` | 99 | Pure conflict decisions | `decideRemoteWrite`, `decideRemoteDelete`, `decideRemoteRename`, `decideMailboxNote` |
| `network-security.ts` | 90 | Secure URLs | `validateSecureWebSocketUrl`, `validateSecureHttpUrl` |
| `worker-auth.ts` | 157 | NIP-98 identity for the Worker | `deriveWorkerAuthKey`, `workerAuthPublicKey`, `normalizeWorkerHosts`, `isPrivateWorkerUrl`, `buildAuthenticatedSignalingUrl` |
| `settings-security.ts` | 46 | Boolean sanitization | `sanitizeBooleanSettings`, `coerceBoolean` |
| `external-text.ts` | 97 | External text sanitization | `sanitizeExternalText`, `sanitizeExternalError`, `warnExternal` |
| `pairing-session.ts` | 407 | Ephemeral pairing protocol | `generatePairingToken`, `derivePairingRoom`, `PAIRING_LINK_PREFIX` |
| `pairing.ts` | 123 | Pairing payload v1 | `encodePairingPayload`, `decodePairingPayload` |
| `mysecret-compat.ts` | 438 | MySecret interoperability | `MySecretCompat` |
| `concurrency-limiter.ts` | 64 | Concurrency limit | `ConcurrencyLimiter` |
| `path-operation-queue.ts` | 40 | Per-path serialization | `PathOperationQueue` |
| `attachment-tidy.ts` | 24 | Hidden attachments folder | `planAttachmentTidy`, `TIDY_ATTACHMENT_CSS` |

### O.3 The largest files in `src/`

| File | Lines | Note |
|---|---|---|
| `src/main.ts` | 2 593 | The orchestrator. If you are looking for a behaviour, start here. |
| `src/network/nostr-mailbox.ts` | 1 608 | The mailbox: publish, fetch, delta, Blossom, reconnection. |
| `src/ui/cloudflare-worker-modal.ts` | 737 | The Worker deployment wizard. |
| `src/sync/file-transfer.ts` | 709 | Chunked file transfer. |
| `src/sync/delta-patch.ts` | 593 | Diff engine (Myers) and unified patches. |
| `src/ui/settings-tab.ts` | 522 | The settings tab. |
| `src/collab/codemirror-collab.ts` | 521 | Remote cursors and selections. |
| `src/network/blossom-client.ts` | 484 | Blob upload/download. |
| `src/ui/pairing-modal.ts` | 467 | The pairing modal. |
| `src/network/webrtc-peer.ts` | 447 | The WebRTC peer. |
| `src/network/signaling-client.ts` | 441 | Nostr or WebSocket signaling. |
| `src/crypto/crypto-manager.ts` | 431 | Everything cryptographic. |
| `src/sync/base-snapshot-store.ts` | 354 | Encrypted base snapshots in IndexedDB. |

### O.4 Documents to read and update per change

| If you change… | Read and update |
|---|---|
| The architecture or the transports | This guide, section 3 and appendix A |
| The cryptographic limits | Section 4 and appendix D |
| The conflict policy | Section 6 and appendix E |
| The input validators | Section 10 and appendix K |
| The wire protocol | `docs/PROTOCOL_WHITEPAPER.md` |
| The tests or the coverage | `docs/TESTS_AND_AUDITS.md` |
| The Cloudflare Worker | Section 7.4 and appendix I |
| The UI strings | `src/i18n/types.ts` and the four dictionaries |

### O.5 The `Github/` mirror

`Github/` is a **mirror** of the public repository: it holds `src/`, `tests/`, `scripts/`, `package.json`, `manifest.json`, `styles.css`, the CI (`.github/workflows/ci.yml` and `dependabot.yml`), `README.md`/`README.es.md` and `docs/`.

`npm run sync:github` syncs the source tree with `rsync --delete`. It does **not** touch `README*`, `SECURITY*`, `CHANGELOG*`, `docs/`, `LICENSE` or `assets/`, because those are curated by hand.

> **When you finish a documentation change:** if you modify `docs/Developer_Guide_EN.md` or `docs/Guía de Desarrolladores.md`, copy the matching version to `Github/docs/` as well. The `sync:github` script does **not** do it for you.

## P. Operational Recipes and Diagnostics

### P.1 Quick command reference

| I want to… | Command |
|---|---|
| Build in development mode (watch) | `npm run dev` |
| Build for production | `npm run build` |
| Type-check | `npm run typecheck` |
| Lint | `npm run lint` (or `npm run lint:fix`) |
| Run every test | `npm test` |
| Run one suite | `npm run test:<name>` |
| Package for release | `npm run package:stable` |
| Regenerate the Worker templates | `npm run build:templates` |
| Audit dependencies, secrets and static analysis | `npm run audit` |
| Sync the `Github/` mirror | `npm run sync:github` |

### P.2 Test suite catalogue

| Script | Test file | What it covers |
|---|---|---|
| `test:security` | `tests/test-security.ts` | Validators, cryptographic primitives, WebRTC channel rules (1 341 lines) |
| `test:realtime-security` | `tests/test-realtime-security.ts` | Real-time path security (633 lines) |
| `test:nostr` | `tests/test-nostr-mailbox.ts` | Mailbox encryption, event validation |
| `test:nostr-delta` | `tests/test-nostr-delta-mailbox.ts` | Delta patches over the mailbox |
| `test:delta` | `tests/test-delta-patch.ts` | Patch engine (compute and apply) |
| `test:base` | `tests/test-base-snapshot-store.ts` | Base snapshot store |
| `test:blossom` | `tests/test-blossom.ts` | Upload/download, NIP-98, hash validation |
| `test:mysecret` | `tests/test-mysecret-compat.ts` | MySecret interoperability |
| `test:pairing` | `tests/test-pairing-session.ts` | Pairing protocol |
| `test:pairing-channel` | `tests/test-pairing-channel.ts` | Pairing channels |
| `test:cloudflare-worker` | `tests/test-cloudflare-worker.ts` | Worker auth, rooms and mailbox |
| `test:cloudflare-allinone` | `tests/test-cloudflare-allinone-worker.ts` | The all-in-one Worker and its templates |
| `test:cloudflare-mailbox` | `tests/test-cloudflare-mailbox.ts` | The mailbox over Durable Objects |
| `test:i18n` | `tests/test-i18n.ts` | Every key present in the four languages |
| `test:core` | `tests/test-omnisync.mjs` | Core integration |
| `test:dual-path` | `tests/test-dual-path-regression.ts` | Resend queue, serialization, backoff, close-time flush, startup reconciliation |
| `test:bughunt` | `tests/test-bughunt-regression.ts` | Regressions of already-fixed bugs |
| `test:auditor` | `tests/test-auditor-regression.ts` | Regressions of audit findings |
| `test:attachment-tidy` | `tests/test-attachment-tidy.ts` | Attachments folder plan |
| `test:attachment-tidy-runtime` | `tests/test-attachment-tidy-runtime.ts` | The same plan at runtime |
| `test:distribution` | `tests/test-distribution-artifact.ts` | The published package equals the current build |
| `test:minimax` | `tests/verify-minimax.ts` | Global invariant verification |

There are also **live tests** against a real deployed Worker. They are not part of `npm test` because they need network access and a disposable Worker:

| File | What it does |
|---|---|
| `tests/live-worker-e2e.ts` | End-to-end against a real Worker |
| `tests/live-worker-auth.ts` | NIP-98 authorization against a real Worker |
| `tests/live-worker-expiry.ts` | Event expiry in the Worker |
| `tests/live-worker-fuzz.ts` | Hostile inputs against a real Worker |

### P.3 Troubleshooting by symptom

| Symptom | Where to look first |
|---|---|
| A note does not arrive | Sync mode (pure P2P never uses the relay) → `settings.signalingServer` → status bar → console with `[OmniSync Mailbox]` |
| A path stuck in `pendingMailboxOut` | The relay did not confirm the publication |
| Works with a public relay but not with your Worker | `https://<your-worker>/` → `services.mailbox.status`; `missing_do_binding` means an old template |
| The Worker rejects your device | `ALLOWED_PUBKEYS` must equal `workerAuthPublicKeyHex`; `missing_allowed_pubkeys` means the variable is empty |
| Attachments missing on one device | That device has no Blossom server, has Blossom off there, or the file is over its size limit |
| False conflicts | Extra entries in `pendingP2PSync` make a note look "modified locally" |
| The phone stops receiving in the background | Expected (the OS suspends sockets). It pulls on resume, on `online`, and every 60 s while active |
| A large note does not sync | Over 64 KB with no Blossom and no base snapshot only travels by P2P; enable Blossom |
| Phone and desktop ignore each other | The `d` tag domain changed once (`mailbox-path-v1` → `mailbox-dtag-v2`); update both |
| MySecret vault | While the vault is locked nothing is read or published (fail closed) |

### P.4 Log prefixes in the console

The plugin's messages in the Obsidian console (`Ctrl+Shift+I`) carry these prefixes:

| Prefix | Origin |
|---|---|
| `[OmniSync Mailbox]` | Nostr mailbox: publishing, fetching, resend and download errors |
| `[OmniSync WebRTC]` | P2P channel: dropped messages, ICE errors |
| `[OmniSync Signaling]` | Signaling: WebSocket and signal-send errors |
| `[OmniSync Nostr]` | Ephemeral Nostr events |
| `[OmniSync VaultWatcher]` | Reading modified files |
| `[OmniSync MySecretCompat]` | Decrypting armored text |

> **Logging rule:** never log message contents, file paths or credentials. Use `sanitizeExternalError()` / `warnExternal()` from `src/security/external-text.ts`.

### P.5 Checks before releasing a version

```bash
# 1. Everything must be green
npm run typecheck && npm run lint && npm test

# 2. The package must be regenerated and committed
npm run package:stable

# 3. The Worker templates must be in sync
npm run build:templates && npm run test:cloudflare-allinone

# 4. The version must match in all three places
node -e "const p=require('./package.json'),m=require('./manifest.json');console.log(p.version,m.version)"

# 5. CHANGELOG.md must have an entry for this version
```

### P.6 Reading the status bar

`src/ui/status-bar.ts` renders an icon and a label that depend on `SyncState` and the peer count:

| State | Meaning |
|---|---|
| `disconnected` | Not connected |
| `signaling` | Connecting to the signaling server |
| `connecting` | Negotiating ICE |
| `connected` | Connected and ready to sync |
| `syncing` | Syncing right now |
| `error` | Error; a retry is needed |

The icon carries a translatable `aria-label` (`statusBar.tooltipDefault`) and is **interactive**: clicking it runs the primary action for the current state.