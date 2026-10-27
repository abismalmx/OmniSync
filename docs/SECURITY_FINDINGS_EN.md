# Public security findings summary — OmniSync

This document summarises all findings identified in OmniSync security audits, with severity, applied patch and regression test. It does not contain proof-of-concept code (PoC) or original file backups; those artifacts are private.

For more context on each audit, see [`TESTS_AND_AUDITS_EN.md`](TESTS_AND_AUDITS_EN.md).

---

## Current status (v1.0.3, 2026-10-27)

| Layer | What was done | Result |
|---|---|---|
| Directed audits and bug hunts | Initial audit, anonymity/Blossom, all-in-one Worker, pairing, and the dual-path (relay + P2P) sync | All findings fixed except the design decisions listed at the end |
| Automated tool baseline | Semgrep, CodeQL, gitleaks (tree and history), osv-scanner, npm audit, ESLint, tsc, Syft + Grype, and the full test suite, in a sandbox | No secrets, no vulnerable dependencies, no real code findings; one low CI finding, fixed |
| **Live verification on real Cloudflare Workers** | Disposable all-in-one Workers deployed from scratch from the current template and exercised end to end with the plugin's own code | Everything works as designed: sync with the other device offline, live delivery, version replacement, deletes, attachments up to 95 MB verified byte for byte |
| **Encryption and obfuscation check** | Server-side logs captured while syncing | The server only saw opaque identifiers and AES-256-GCM ciphertext: no paths, names or text (details in [`TESTS_AND_AUDITS_EN.md`](TESTS_AND_AUDITS_EN.md#26-live-verification-against-real-workers--what-the-server-actually-sees-2026-10-27)) |
| **Dynamic testing (DAST)** | Purpose-built fuzzer, nuclei, OWASP ZAP and testssl.sh, run in containers against a disposable Worker, plus a light pass on a real one | 0 failures and 0 server errors; one hardening fix applied |

**Not covered:** authenticated scans with a real user's key, real phones, Obsidian itself, and an independent human review of the cryptographic protocol.

---

## Earlier audits (before the automated auditor, 2026-10-24)

These three audits were performed before the automated runs, using directed review, PoCs executed against the real code, and static tools. Full reports are in the linked `.md` files.

### Initial audit — [`AUDIT_REPORT.md`](AUDIT_REPORT.md) — 45 findings, all fixed

**Tools:** ESLint (config created from scratch), Semgrep 455+322 rules, Gitleaks, osv-scanner, npm audit, tsc.

Selected critical-severity findings:

| ID | Sev. | Description | Status |
|---|---|---|---|
| C-01 | Critical | Master key length not enforced | Fixed |
| C-04 | Critical | Different HMAC prefix at creation vs. verification (auth bypass) | Fixed |
| P-01 | Critical | Message validators disconnected from handlers (decorative) | Fixed |
| P-02 | Critical | No `messageId` or replay guard (unlimited replay) | Fixed |
| P-06 | Critical | One-way handshake (no mutual challenge) | Fixed |
| S-01 | Critical | `ws://` (no TLS) accepted as relay endpoint | Fixed |
| T-01 | Critical | Invalid hash/checksum did not block writes | Fixed |
| T-02 | Critical | Transfer size and chunk count unvalidated (OOM) | Fixed |
| R-01 | Critical | Path validator disconnected from handler (path traversal) | Fixed |
| R-02 | Critical | `.obsidian/plugins` (executable) syncable | Fixed |
| S-05 | Critical | Master key stored in plaintext in `data.json` | Fixed |
| T-04 | Critical | Stale remote order overwrote recent local work | Fixed |

Full list (C-01…C-08, P-01…P-07, S-01…S-06, N-01…N-03, T-01…T-06, R-01…R-03, D-01…D-02) in [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md).

---

### Anonymity and Blossom audit — [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md) — 10 findings, all fixed

| ID | Sev. | Description | Status |
|---|---|---|---|
| AN-01 | Critical | NIP-98 not bound to URL/method/body (valid sig did not authorize the specific request) | Fixed |
| AN-02 | High | Uploader identity persisted in R2 | Fixed |
| AN-03 | High | Upload body read without real size limit | Fixed |
| AN-04 | High | Same pubkey for relay and Blossom (identity correlation) | Fixed |
| AN-05 | Medium | Ambiguous `d`/`t`/`expiration` tags | Fixed |
| AN-06 | Medium | `subId` with app prefix and room ID (fingerprinting) | Fixed |
| AN-07 | Medium | Upload descriptor not verified | Fixed |
| AN-08 | Medium | Limits and allowlist manipulable from `data.json` | Fixed |
| AN-09 | Medium | String `"false"` in `data.json` enabled boolean features | Fixed |
| AN-10 | Medium | Transfer queue unbounded (DoS) | Fixed |

---

### All-in-one Worker audit — [`SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md) — 12 findings, all fixed

**Tools:** directed review + PoCs against real code + manual mutation testing (8/8). Semgrep 167 rules: 0. Gitleaks: 0.

| ID | Sev. | Description | Status |
|---|---|---|---|
| AIO-01 | Critical | No Worker access control (any valid Nostr key could use it) | Fixed |
| AIO-02 | Critical | NIP-98 body/host binding broken (regression from previous worker) | Fixed |
| AIO-03 | High | Schnorr verification ~140–170 ms CPU (BigInt affine, DoS) | Fixed |
| AIO-04 | High | Signaling room isolation decorative (filter bypassable) | Fixed |
| AIO-05 | High | One-click deployment command broken (shell interpretation, invalid JSON) | Fixed |
| AIO-06 | Medium | Served blob headers: attacker-controlled `Content-Type`, no `nosniff` | Fixed |
| AIO-07 | Medium | WebRTC signal replay possible after plugin restart | Fixed |
| AIO-08 | Medium | `wrangler ^3.114.0` in deployable template (8 vulnerabilities, 7 high) | Fixed |
| AIO-09 | Medium | Windows path-policy bypass (8.3 aliases, ADS, reserved names) | Fixed |
| AIO-10…12 | Low | Minor findings (see report) | Fixed |

**Final verification:** `tsc --noEmit` 0 · `npm run lint` 0 errors · Semgrep 0 · Gitleaks 0 · `npm test` EXIT 0 (402 assertions in dedicated suites).

---

## Fixed findings (automated auditor, 2026-10-26)

### SEC-01 — Stale distribution artifact (Medium)

- **Audit:** run `20261026-012049-5656`
- **Description:** `zip/OmnySync_stable/` contained a 2026-10-24 build while the source code was dated 2026-10-25. The published artifact was missing the Nostr mailbox privacy fix (`mailbox-dtag-v2`), Blossom, delta patches and encrypted snapshots.
- **Concrete impact:** metadata leak to the relay (the `d` tag exposed the `omnisync:` prefix and the `roomId` in plain text); silent mailbox incompatibility between versions.
- **Patch:** bundle rebuilt from current sources; `zip/OmnySync_stable/` and `.zip` regenerated.
- **Regression:** `npm run test:distribution` (8 byte-for-byte checks). `npm run package:stable` prevents recurrence.

---

### SEC-02 — No artifact-sync check (Low)

- **Audit:** run `20261026-012049-5656`
- **Description:** no test or script compared `zip/OmnySync_stable/` with the current build, so the desync from SEC-01 could recur silently on every release cycle.
- **Patch:** `tests/test-distribution-artifact.ts` (new) + `scripts/package-stable.mjs` + `npm run package:stable`.
- **Regression:** `npm run test:distribution` (fails with stale artifact, passes with current).

---

### SEC-03 — ReplayGuard TTL shorter than effective message validity (Low)

- **Audit:** run `20261026-032150-10258`
- **Description:** the default `ReplayGuard` TTL was 10 min, shorter than the effective message validity (up to 15 min with allowed clock skew), leaving a 5-min replay window.
- **Patch:** `protocol-security.ts`: ReplayGuard TTL = `MAX_PROTOCOL_MESSAGE_AGE_MS + MAX_PROTOCOL_CLOCK_SKEW_MS` (15 min).
- **Regression:** `npm run test:auditor`.

---

### H1 — Single-use bypassable via race condition (Low–Medium)

- **Audit:** run `20261026-145714-16806` (ephemeral pairing)
- **Description:** two simultaneous valid `hello` messages could pass the `consumed` check before it was set, because there was an `await` between the check and the assignment. Both would receive the master key.
- **Condition:** required knowing the token (128 bits) and sending two `hello` messages at exactly the same time.
- **Patch:** `busy` flag in `PairingHostSession.handleHello` (`src/security/pairing-session.ts`).
- **Regression:** `npm run test:pairing` (13 cases, including the race case).

---

### H2 — `?pair=` Worker room with no host authentication (Medium)

- **Audit:** run `20261026-145714-16806`
- **Description:** any client on the internet could open WebSockets to arbitrary 64-hex rooms and create Durable Objects, generating usage on the user's Cloudflare account without exposing data.
- **Patch:** host must authenticate with NIP-98 (role `host`, assigned by the Worker, not forgeable via query); guest can only join if a host is already present (404 otherwise; 409 if one is already there).
- **Regression:** `npm run test:cloudflare-allinone` Test 7b.

---

### H3 — Foreign QR could replace key without showing destination server (Medium, social engineering)

- **Audit:** run `20261026-145714-16806`
- **Description:** a QR code generated by an attacker caused the victim to adopt a master key, `server` and `privateWorker` chosen by the attacker. The confirmation dialog did not show the destination host (see also SEC-14, which extends this fix to the deep link flow).
- **Patch:** `pairNewDevice` shows the server before adopting a new key when it differs from the current one.
- **Regression:** `npm run test:auditor` (i18n contracts in 4 languages).

---

### N1 — Worker forwarded client-supplied `kind`/`role` (Low)

- **Audit:** run `20261026-151238-24575`
- **Description:** the normal Worker route forwarded the `kind` and `role` fields as supplied by the authenticated client to the Durable Object, allowing the client to manipulate its own room limits.
- **Patch:** `kind` and `role` removed from the data the Worker forwards to the DO.
- **Regression:** `npm run test:cloudflare-allinone`.

---

### N2 — Duplicate `deviceId` could rename an already-paired device (Low)

- **Audit:** run `20261026-151238-24575`
- **Description:** a token holder could send an already-paired `deviceId` during pairing, renaming or relabeling that device on the host side.
- **Patch:** if the `deviceId` already exists, the session only refreshes its state; renaming is not allowed.
- **Regression:** `npm run test:pairing`.

---

### B1 — Orphaned channel after overlapping `startInvite` (Medium)

- **Audit:** run `20261026-150816-20845` (bug_hunter)
- **Description:** calling `startInvite` twice (switching channel or regenerating QR while the first was still opening, or closing the modal) left the previous channel open for up to 5 min, and its callbacks could mark the new invitation as expired.
- **Patch:** `inviteGen` counter in `pairing-modal.ts`; stale handles are cancelled when `inviteGen` has changed.
- **Regression:** `npm run test:bughunt`.

---

### B2 — Guest socket not closed on error; `complete()` not tolerant of failure (Medium)

- **Audit:** run `20261026-150816-20845`
- **Description:** on error, the guest socket was not closed. Additionally, if `complete()` failed after adopting the key, `pairNewDevice` returned `false` even though the key had already been replaced.
- **Patch:** `abort()` in the `catch` block of `pairNewDevice`; `complete()` failure only shows a warning (key is not reverted).
- **Regression:** `npm run test:bughunt`.

---

### B3 — Modal kept stale QR after pairing as guest (Low)

- **Audit:** run `20261026-150816-20845`
- **Description:** after completing pairing as a guest, the modal still showed the previous invitation QR.
- **Patch:** modal resets the invitation after completing the guest flow.
- **Regression:** `npm run test:bughunt`.

---

### B4 — Guest waited 30 s if channel closed; `buildHello` error uncaught (Low)

- **Audit:** run `20261026-150816-20845`
- **Description:** if the channel closed while the guest was waiting, it would stay waiting for up to 30 s. Errors from `buildHello` were not caught.
- **Patch:** guest closes quickly when the channel closes; `buildHello` errors caught.
- **Regression:** `npm run test:pairing-channel` (new test, 5/5).

---

### B5 — Guest platform set after notifying UI (Low)

- **Audit:** run `20261026-150816-20845`
- **Description:** on the host side, the guest's platform was assigned after notifying the UI, causing the wrong icon to appear momentarily.
- **Patch:** platform set before the notification.
- **Regression:** `npm run test:pairing`.

---

### SEC-12 — `wrangler` (Worker devDep) with EventSource DoS via `undici` (Low)

- **Audit:** run `20261026-155140-28734`
- **Description:** `wrangler 4.152.0` (a Worker development dependency) pulled in `undici` with unbounded memory DoS in the EventSource parser and an SRI bypass. Only affects the developer's machine (not the production bundle or plugin users).
- **Patch:** `wrangler` bumped to `4.153.0`; lockfile regenerated in sandbox; embedded template regenerated with `npm run build:templates`.
- **Regression:** `npm run test:cloudflare-allinone` Test 8 (template in sync).

---

### SEC-13 — `pairNewDevice` was not re-entrant (Low)

- **Audit:** run `20261026-155140-28734`
- **Description:** the `obsidian://omnisync-pair` deep link and the modal «Pair» button could run concurrently, interleaving writes to `pairingSecret`, `roomId` and derived keys.
- **Patch:** `pairingInFlight` guard in `pairNewDevice` (released in `finally`); `pairingInProgress` warning in i18n in 4 languages.
- **Regression:** `npm run test:auditor` (`main.ts` contract; verified red→green by removing the guard).

---

### SEC-14 — `deepLinkConfirm` did not show destination host (Low)

- **Audit:** run `20261026-155140-28734`
- **Description:** the guest connected to `invite.server` before showing the host in the confirmation dialog. A foreign QR could expose the user's IP to an arbitrary server without the user seeing the destination.
- **Patch:** `deepLinkConfirm` shows `{server}` from the payload before connecting; i18n updated in 4 languages.
- **Regression:** `npm run test:auditor` (4 languages include `{server}`).

---

### R1 — UI collapsed «Advanced» section on QR renewal (Low)

- **Audit:** run `20261026-152037-17189`
- **Description:** when the QR regenerated every 2 min, the invitation card was repainted and collapsed the «Advanced» section, hiding the legacy permanent-key QR the user was looking at.
- **Patch:** open state (`legacyOpen`) preserved on card regeneration.
- **Regression:** visual test (not automatable in Node without Obsidian).

---

### BUG-L1 — 2 `no-shadow` errors that would break CI lint (Informational)

- **Audit:** run `20261026-155140-28734`
- **Description:** `pairing-modal.ts:391` (variable `parent` shadowing the constructor parameter) and `tests/test-cloudflare-allinone-worker.ts:456` (variable `room`).
- **Patch:** `parent` → `container` (with null check); `room` → `pairDoRoom`.
- **Regression:** `eslint src tests scripts --quiet`: 0 errors.

---

## Fixed findings (dual-path review, 2026-10-27, v1.0.1)

Scoped audit of the dual-path sync (relay + P2P) code. Regression: `npm run test:dual-path`.

| ID | Sev. | Description | Status |
|---|---|---|---|
| A-01 | Medium | The retry could publish stale local versions to the relay and override a newer one for devices syncing later. | Fixed |
| A-02 | Low–Medium | The resend queue was not serialized with normal sends (race that could publish stale content last). | Fixed |
| A-03 | Low | A relay that accepts and closes the connection caused a reconnect/query loop (load on the relay, battery). | Fixed |
| A-04 | Low | On unload the pending resend was not awaited before closing the mailbox. | Fixed |
| A-05 | Info | In dual mode every edit also goes to the relay (content stays AES-GCM encrypted, opaque `d` tag), so the relay sees edit frequency and size. Use "Pure P2P" mode to avoid relays. | Accepted |
| A-06 | Info | Indefinite retry (1 event/min/file) if a file can never be published. | Accepted |
| A-07 | Info | Startup reconciliation and close-time flush only queue/send vault paths already validated; skipped when the vault is locked. | Accepted |

---

## Fixed findings (full tool baseline and live verification, 2026-10-27, v1.0.3)

| ID | Sev. | Description | Status |
|---|---|---|---|
| L-01 | Low | CI used GitHub Actions by mutable tag and Dependabot had no cooldown (supply-chain hardening). | Fixed: actions pinned to commit SHAs; 7-day Dependabot cooldown |
| B-08 | High for all-in-one users | A Worker deployed with an older template had no mailbox: P2P signaling worked but notes were never stored, so nothing arrived while the other device was off. The failure was silent. | Fixed: the plugin detects it at startup and in the Cloudflare wizard and asks to redeploy; the current template deploys the mailbox. Verified on real Workers |
| W-02 | Low | Files stored in the Worker's R2 bucket (Blossom) never expired, so storage and old attachment versions accumulated until the free quota filled up. Mailbox events were already expiring after 7 days. | Fixed: the deployment command adds an R2 lifecycle rule that deletes files after 10 days (the 7-day mailbox notice plus a margin). Existing servers add it with one command. Mailbox expiry verified live with 10 s and 60 s lifetimes |
| W-01 | Low | The Worker's JSON responses (status page and errors) lacked `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. | Fixed in the Worker and its embedded template; verified live. A Worker deployed with an older template should be redeployed |

Regression: `npm run test:dual-path` (includes the Worker-without-mailbox detection), the `test:cloudflare-*` suites, and the manual live checks `tests/live-worker-e2e.ts`, `tests/live-worker-auth.ts` and `tests/live-worker-fuzz.ts`.

---

*Live check of what the server sees (encrypted and obfuscated data): see [`TESTS_AND_AUDITS_EN.md`](TESTS_AND_AUDITS_EN.md#26-live-verification-against-real-workers--what-the-server-actually-sees-2026-10-27).*

---

## Accepted residual risks

These risks were identified, evaluated and explicitly accepted by design:

| Risk | Existing mitigation |
|---|---|
| Photographed QR usable within its 2-min window | Short TTL, single use, paired device list (review and unpair if anything looks odd) |
| Hostile QR that the user scans and confirms | User sees key and destination server before confirming (H3/SEC-14) |
| Anonymous requests to `?pair=` instantiate an empty Durable Object (minimal cost before 404) | Add Cloudflare rate limiting on the self-hosted Worker |
| Pairing token passes through the clipboard when copying an invitation | Token expires in 2 min and is single-use |
| Permissive CORS (`Access-Control-Allow-Origin: *`) on the Worker | Intentional: the plugin runs from Obsidian's origin and Blossom expects it. Every write and WebSocket requires NIP-98 authorization, and everything that can be read is end-to-end encrypted |
| The server can observe metadata: when changes happen, their approximate size and count, and the pseudonymous mailbox room | Content, paths and names are encrypted or hashed. No padding or decoy traffic was added, to keep real-time sync fast. "Pure P2P" mode avoids relays entirely |
| Worker anti-replay memory is per isolate (best effort) | Uploads are content-addressed and idempotent, so a repeated NIP-98 event has no effect |
| Cloudflare's edge still offers TLS 1.0/1.1 on `workers.dev` | It is Cloudflare's setting, not the plugin's; all payloads are also end-to-end encrypted |

## Unresolved findings (design decisions required)

| ID | Sev. | Description |
|---|---|---|
| SEC-04 | Low | ReplayGuard fills before authentication (eviction with 50k signed events) |
| SEC-05 | Medium | Overwrite without conflict copy for non-.md files with no local base |
| SEC-06 | Low | Worker: `u` in `/upload` ignores query (NIP-98); anti-replay with TOCTOU and per-isolate |
| SEC-07 | Low–Medium | Worker without its own lockfile (`@noble/curves ^2`, `wrangler ^4`) |
| SEC-08 | Low | CPU/memory DoS: `threeWayMerge`, Myers diff, unbounded WS rate |
| SEC-09 | Low–Medium | Shared identity, no per-device revocation |
| SEC-10 | Low | Re-signed Nostr events (rollback/resurrection) without AAD |

These findings require a design decision before patching. They have not been fixed without consulting the author.

---

*To report a new vulnerability, see [`SECURITY.md`](../SECURITY.md).*

*Last updated: 2026-10-27.*
