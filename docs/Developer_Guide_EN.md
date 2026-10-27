# Developer Guide – OmniSync

## Purpose and General Architecture
OmniSync is an **Obsidian** plugin (desktop and mobile) that synchronizes a vault across devices **without a central server**: devices connect via **WebRTC** (P2P) and all content is end-to-end encrypted with **AES-256-GCM**. To discover each other, they use a signaling server which can be a public **Nostr** relay (default) or a self-hosted **Cloudflare Worker**; offline peers are handled via an encrypted Nostr mailbox (small notes) and **Blossom** (large files).

License: [PolyForm Noncommercial 1.0.0](../LICENSE) (source-available, free for noncommercial use). See "Contributions".

### Key Principles
| Principle | Description |
|---|---|
| **P2P First** | Data travels directly between peers (WebRTC DataChannel); the signaling server only coordinates device discovery. |
| **End-to-End Encryption** | Master key per vault; content and paths (obfuscated with HMAC) are encrypted before leaving the device. |
| **Decoupled Transport** | Cryptographic identity is independent of the transport channel: WebRTC, Nostr mailbox, Blossom, and Worker are interchangeable layers. |
| **Default Distrust** | All network messages are validated (size, type, paths, replay attacks) before touching disk. Modules in `src/security/` enforce these rules. |
| **Data Preservation** | Remote deletions are moved to Obsidian's trash; conflicts are 3-way merged instead of overwritten. |

## Codebase Structure
```
src/
├─ main.ts                    # Plugin lifecycle, settings, orchestration, pairing
├─ types.ts                   # Types and constants (default Blossom servers, etc.)
├─ crypto/crypto-manager.ts   # Key derivation, AES-256-GCM, path HMAC
├─ network/
│   ├─ signaling-client.ts    # Signaling client (Nostr / Worker)
│   ├─ webrtc-peer.ts         # P2P connection and data channels
│   ├─ nostr-mailbox.ts       # Asynchronous encrypted mailbox (notes < 64 KB)
│   ├─ blossom-client.ts      # Blob storage client (BUD-01/02, NIP-98)
│   ├─ blossom-providers.ts   # Default servers and limits
│   └─ pairing-channel.ts     # Ephemeral pairing transport
├─ sync/
│   ├─ vault-watcher.ts       # Detects vault changes
│   ├─ manifest-calc.ts       # Manifests / hashes to compute missing files
│   ├─ file-transfer.ts       # File sending and receiving
│   ├─ delta-patch.ts         # Differential patches
│   ├─ base-snapshot-store.ts # Base snapshot storage for 3-way merge
│   └─ diff-merge.ts          # 3-way text merge
├─ collab/codemirror-collab.ts# Remote cursors and selections (CodeMirror 6)
├─ security/                  # Validators and protocol rules (paths, network, transfers,
│                             #   anti-replay, pairing, NIP-98, etc.)
├─ ui/                        # Settings tab, pairing modal, Cloudflare wizard
├─ i18n/                      # es, en, zh, ru translations
└─ templates/                 # Embedded Cloudflare Worker template
scripts/cloudflare-allinone/  # All-in-one Worker (Durable Objects + R2/Blossom)
tests/                        # Test suites (see "Local Development")
```

### Flow of an Edit
1. `vault-watcher` detects a change and filters it through policies in `security/` (valid path, allowed size, supported type).
2. If the peer is connected: sent via WebRTC as a delta patch (`delta-patch`) or full file (`file-transfer`), always encrypted.
3. If peer is offline: small notes are sent to the **Nostr mailbox**; large files are uploaded to **Blossom** and announced via SHA-256 hash.
4. The receiver validates, decrypts, and applies the update. If both sides edited offline, `diff-merge` reconciles changes using the base version from `base-snapshot-store`; remote deletions are safely moved to the Obsidian trash.

## Ephemeral Pairing
Files: `src/security/pairing-session.ts` (protocol), `src/network/pairing-channel.ts` (transport), `src/security/pairing.ts` (payload), `?pair=` branch in `scripts/cloudflare-allinone/worker.js`.
- QR = `obsidian://omnisync-pair?data=<b64>` link (`registerObsidianProtocolHandler` → `handlePairingLink`, always prompting user confirmation); copyable code `omnisync://pair2?data=` contains identical payload: `{v:2, token, transport, server}`; 128-bit token, 2-minute TTL while QR is visible (modal generates a fresh one on expiry), single-use. No master key exposed.
- Room = HMAC(token, "room"). Messages: `hello → offer → done`. Ephemeral ECDH P-256 authenticated with token-keyed MAC; HKDF-SHA256 (salt=token, info binding both public keys) → AES-256-GCM with AAD (type, room, public keys). Sensitive payload (master key, room, server) travels only in `offer`.
- Single-use: `PairingHostSession` burns the token after the first valid `hello`; `busy` flag prevents concurrent `hello` race conditions.
- `nostr` channel: kind 25000 events tagged `t`=room, signature/timestamp/size strictly validated. `worker` channel: host opens `/?pair=<room>&auth=<NIP-98>` (host role assigned by Worker); guest joins unauthenticated only if host is present (404/409 otherwise); Durable Object scoped to `pair:<room>`, max 4 sockets, 16 KB frames.
- `pairNewDevice` prompts confirmation if the incoming signaling server differs from the current active one.
- After editing Worker code: run `npm run build:templates` and redeploy.

## Configuration
Settings are managed by Obsidian (`data.json`) and validated in `src/security/settings-security.ts` prior to use. The master encryption key is stored in Obsidian's `secretStorage` when supported. Any schema changes must preserve backward migration and pass `npm run test:security`.

Worker modifications: edit `scripts/cloudflare-allinone/worker.js`, run `npm run build:templates` (regenerates `src/templates/cloudflare-worker-template.ts`), and redeploy.

## Local Development
1. **Clone** repository and install dependencies:
   ```bash
   git clone https://github.com/abismalmx/OmniSync.git
   cd OmniSync
   npm install
   ```
2. **Build**:
   ```bash
   npm run dev      # continuous development build
   npm run build    # production build: generates main.js
   ```
3. **Install in test vault**: copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/omnisync/`.
4. **Testing and Quality**:
   ```bash
   npm test                 # run all test suites
   npm run test:pairing     # run a specific suite (see package.json)
   npm run typecheck && npm run lint
   ```
   If `test:i18n` fails on non-UTF8 locales, run with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. `test:distribution` requires up-to-date distribution bundle (`npm run package:stable`).
5. **Debugging**: Obsidian Developer Console (`Ctrl+Shift+I`).

## Adding a Transport or Backend
Network logic is decoupled: any new transport must (1) reside in `src/network/`, (2) validate all inbound messages via `src/security/` (never trust transport layers), (3) provide security tests rejecting malicious inputs, and (4) expose settings in `src/ui/settings-tab.ts` with translations across all four languages (`src/i18n/`).

## Best Practices
- Always validate **all** untrusted external input: file paths, sizes, payload types, signatures, and timestamps. Add regression tests for hostile inputs on every new validation.
- Do not use `Math.random` or homegrown crypto for secrets: use `crypto-manager` and native `crypto.subtle` primitives.
- User-facing UI strings must always use i18n (`es`/`en`/`zh`/`ru`) and pass `npm run test:i18n`.
- Enforce concurrency limits and CPU budgets on network ingestion pipelines (`concurrency-limiter`, merge budget).
- Update protocol documentation when making architectural changes: see `PROTOCOL_WHITEPAPER.md` and `TESTS_AND_AUDITS.md`.

## Releases & Versioning
- Follow **Semantic Versioning** (`MAJOR.MINOR.PATCH`); ensure `manifest.json` and `package.json` are aligned.
- Run `npm run package:stable` to generate release zip.
