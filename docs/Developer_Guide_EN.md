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
| Vault key | `OmniSync-Salt-v1` | WebRTC DataChannel messages |
| Signaling key | `SIGNALING_KEY_CONTEXT` | Signaling messages |
| Mailbox key | `OmniSync-Mailbox-v1` | Nostr mailbox payloads |
| Blossom key | `BLOSSOM_KEY_CONTEXT` | Encrypting blobs |
| Snapshot key | `OmniSync-Snapshot-v1` | Local base snapshots |
| Worker auth key | `deriveWorkerAuthKey` | NIP-98 identity for your Worker |

- Keys: **PBKDF2-SHA-256, 100 000 iterations**, 256-bit AES-GCM, non-extractable. A fresh random 12-byte IV is generated for every encryption.
- Room ids (`signalingRoomId`, `mailboxRoomId`) are HMAC-derived, so the relay never sees the real secret or a guessable name.
- The master key lives in Obsidian's `secretStorage` when available and is **never written to `data.json`**.
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

| Limit | Value |
|---|---|
| Full note (`MAX_MAILBOX_NOTE_SIZE`) | 64 KB |
| Event content | 256 KB |
| Delta chunk / chunks per patch | 48 KB / 16 |
| Events per fetch | 500 |
| Eligible extensions | `md, markdown, txt, canvas, json, css` |
| Blossom operations in flight | 1 running, 4 queued |

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
