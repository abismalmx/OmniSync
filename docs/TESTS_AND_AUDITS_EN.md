# Tests and security audits — OmniSync

This document lists all **real test scripts** in the project and every **security audit** carried out with deterministic tools. It contains only verifiable information.

---

## 1. Test suite

### 1.1. Available scripts

All scripts run with `npm test` (full suite) or individually:

| Script | Test file | Description |
|---|---|---|
| `npm run test:minimax` | `tests/verify-minimax.ts` | Verifies bundle size stays within the Obsidian limit. |
| `npm run test:security` | `tests/test-security.ts` | Crypto primitives, path validators, protocol validators. |
| `npm run test:nostr` | `tests/test-nostr-mailbox.ts` | Nostr mailbox encrypt/decrypt, kind 30078 event validation. |
| `npm run test:mysecret` | `tests/test-mysecret-compat.ts` | Interoperability with the MySecret format. |
| `npm run test:delta` | `tests/test-delta-patch.ts` | Binary delta patches and conflict reconciliation. |
| `npm run test:base` | `tests/test-base-snapshot-store.ts` | Encrypted snapshot store. |
| `npm run test:nostr-delta` | `tests/test-nostr-delta-mailbox.ts` | Mailbox with compressed delta patches. |
| `npm run test:blossom` | `tests/test-blossom.ts` | Blossom upload/download, NIP-98, SHA-256 hash validation. |
| `npm run test:realtime-security` | `tests/test-realtime-security.ts` | WebRTC real-time channel security. |
| `npm run test:cloudflare-worker` | `tests/test-cloudflare-worker.ts` | Blossom-only Worker (cloudflare-blossom-worker.js). |
| `npm run test:cloudflare-allinone` | `tests/test-cloudflare-allinone-worker.ts` | All-in-one Worker: NIP-98, `?pair=` room, embedded template in sync (Test 8). |
| `npm run test:i18n` | `tests/test-i18n.ts` | All i18n keys present across all 4 languages. Use `LANG=en_US.UTF-8`. |
| `npm run test:pairing` | `tests/test-pairing-session.ts` | Ephemeral pairing session: 13 cases (flow, single-use, expiry, races, replay). |
| `npm run test:pairing-channel` | `tests/test-pairing-channel.ts` | Pairing channel: 7 cases (Nostr and Worker stubs). |
| `npm run test:core` | `tests/test-omnisync.mjs` | Plugin core integration tests. |
| `npm run test:bughunt` | `tests/test-bughunt-regression.ts` | Regression tests for bugs found during bug-hunt sessions. |
| `npm run test:auditor` | `tests/test-auditor-regression.ts` | Regression tests for audit findings (SEC-01…SEC-14, `main.ts` contracts in 4 languages). |
| `npm run test:distribution` | `tests/test-distribution-artifact.ts` | Verifies `zip/OmnySync_stable/` is byte-for-byte identical to the current build (8 checks). |

### 1.2. Additional commands

```bash
npm run typecheck      # tsc --noEmit, 0 errors
npm run lint           # ESLint, 0 errors
npm run audit:deps     # osv-scanner over package-lock.json
npm run audit:secrets  # gitleaks over the tree
npm run audit:static   # semgrep scan
npm run package:stable # build + reproducible packaging of zip/OmnySync_stable/
```

### 1.3. Note on test:i18n

`npm run test:i18n` may fail if the system locale is set to Spanish. Fix:

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run test:i18n
```

---

## 2. Security audits

Full reports with evidence and PoCs are in [`docs/AUDIT_REPORT.md`](AUDIT_REPORT.md), [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md), [`docs/SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md), [`docs/SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md) and the private auditor runs. The findings and patches summary is in [`SECURITY_FINDINGS_EN.md`](SECURITY_FINDINGS_EN.md).

---

### 2.0. Initial audit — `AUDIT_REPORT.md` (2026-10-24)

**Scope:** full repository (~15,700 lines of TypeScript). **Tools:** ESLint (config created from scratch), Semgrep (`--config auto` 455 rules + p/security-audit/owasp/secrets 322 rules), Gitleaks, osv-scanner, npm audit, tsc.

| Tool | Before | After |
|---|---|---|
| ESLint errors | 46 | 0 |
| Semgrep findings | 12 | 0 |
| Secrets (Gitleaks) | 0 | 0 |
| Vulnerable deps (OSV/npm audit) | 0 | 0 |
| ReDoS-candidate regexes | 2 | 0 |

**Fixed findings (45):** C-01…C-08 (crypto), P-01…P-07 (protocol/WebRTC), S-01…S-06 (signaling/persistence), N-01…N-03 (Nostr), T-01…T-06 (transfers/temporal), R-01…R-03 (paths), D-01…D-02 (docs), AN-01…AN-10 (anonymity/Blossom). Including critical failures: validators disconnected from handlers, inconsistent HMAC prefix, `Math.random()` for nonces, master key in `data.json`, destructive remote deletion, `ws://` accepted, one-way handshake. Detail in [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) and [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md).

---

### 2.0.b. Anonymity and Blossom audit — `SECURITY_AUDIT_ANONYMITY_BLOSSOM.md` (2026-10-24)

**Scope:** Blossom Worker, `blossom-client.ts`, `nostr-mailbox.ts`, `signaling-client.ts`, `settings-security.ts`. Directed review + tests (no additional SAST tools).

**Findings (AN-01…AN-10):** all fixed. Most severe: AN-01 (NIP-98 signature not bound to URL/method/body — valid signature did not authorize the specific request), AN-04 (same pubkey for relay and Blossom). Detail in [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md).

---

### 2.0.c. All-in-one Worker audit — `SECURITY_AUDIT_ALLINONE_WORKER.md` (2026-10-24)

**Scope:** `scripts/cloudflare-allinone/worker.js`, deployment modal, embedded templates. **Tools:** directed review + PoCs executed against real code + manual mutation testing (8/8 mutations detected). Semgrep 167 rules: 0 findings. Gitleaks: 0.

| Metric | Before | After |
|---|---|---|
| Worker access control | None (any valid Nostr key) | `ALLOWED_PUBKEYS` allowlist, fail-closed |
| NIP-98 body/host binding | Broken (regression) | Restored and hardened |
| CPU per Schnorr verification | ~140–170 ms | ~4–6 ms (`@noble/curves`) |
| `wrangler` in deployable template | `^3.114.0` (8 vulnerabilities) | `^4.0.0` |
| Full test suite | 13 suites green | 13 suites + ~140 new negative assertions |

**Findings (AIO-01…AIO-12):** all fixed. Most severe: AIO-01 (no access control — any valid Nostr key could use the Worker). Detail in [`SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md).

---

### 2.1. Full baseline — run `20261026-012049-5656`

**Date:** 2026-10-26 · **Tools:** Semgrep (own rules + p/security-audit/owasp/js/ts), CodeQL JS/TS `security-extended`, gitleaks, osv-scanner, npm audit, ESLint + plugin-security, tsc, SBOM (syft) + grype, full test suite in sandbox.

| Tool | Raw results | Triaged |
|---|---|---|
| Semgrep | 3 alerts (2 info, 1 warning) | 0 vulnerabilities (FP documented) |
| CodeQL | 2 findings | 0 in `src/`; 2 FP discarded (see report) |
| gitleaks | 0 | — |
| osv-scanner / npm audit | 0 | — |
| grype | several | Go stdlib inside esbuild binary: not reachable |
| Test suite | 13 suites | All pass in sandbox |

**Findings:** SEC-01 (Medium, stale distribution artifact) and SEC-02 (Low, missing artifact-sync check). Both fixed with regression tests. Detail in [`SECURITY_FINDINGS_EN.md`](SECURITY_FINDINGS_EN.md).

---

### 2.2. Full baseline — run `20261026-032150-10258`

**Date:** 2026-10-26 · **Tools:** same as 2.1, plus 3 specialists + 1 independent defender.

| ID | Severity | Status |
|---|---|---|
| SEC-01 | Medium | fixed (previous) |
| SEC-02 | Low–Medium (availability) | fixed |
| SEC-03 | Low | fixed |
| SEC-04–SEC-12 | Low–Medium | require decision or no local PoC |
| SEC-11 | Informational | CodeQL `js/incomplete-url-substring-sanitization`; FP (changes only framing, not a security boundary) |

Not executed: DAST, fuzzing, remote reconnaissance.

---

### 2.3. Guided-reading audits — ephemeral pairing

#### Run `20261026-145714-16806` — first pairing review

Scope: `pairing-session.ts`, `pairing-channel.ts`, `?pair=` Worker branch, `main.ts`, `pairing-modal.ts`. No Semgrep/CodeQL/DAST.

| ID | Sev. | Status |
|---|---|---|
| H1 | Low–Medium | Fixed (`busy` flag in `handleHello`, regression test red→green) |
| H2 | Medium | Fixed (`?pair=` room requires host NIP-98 auth; Worker Test 7b) |
| H3 | Medium (social engineering) | Fixed (server confirmation before adopting key) |
| H4 | Low | Accepted by design (2-min TTL, single use, device list) |
| H5 | Info | No action |

#### Run `20261026-151238-24575` — final review (bug_hunter patches verified)

H1/H2/H3 still in place. New findings N1 and N2 (Low) fixed (Worker: client-supplied `kind`/`role` removed; duplicate id only refreshes state). Accepted residuals documented in [`SECURITY_FINDINGS_EN.md`](SECURITY_FINDINGS_EN.md).

#### Run `20261026-152037-17189` — 2-min TTL and QR renewal

H1/H2/H3 still in place. Expiry/hello race conditions verified without key leakage. Finding R1 (Low, UI collapsed «Advanced» on QR renewal) fixed. Accepted residuals unchanged.

---

### 2.4. Bug-hunt sessions — ephemeral pairing

Five `bug_hunter` sessions on the new pairing flow. Most relevant:

#### Run `20261026-150816-20845`

Scope: `pairing-session.ts`, `pairing-channel.ts`, `main.ts`, `pairing-modal.ts`, Worker, `settings-tab.ts`. No Obsidian or real devices.

| ID | Sev. | Status |
|---|---|---|
| B1 | Medium | Fixed (`inviteGen` counter; orphaned channel cancelled) |
| B2 | Medium | Fixed (abort in catch; `complete()` failure only warns) |
| B3 | Low | Fixed (modal resets invite after pairing) |
| B4 | Low | Fixed + new test |
| B5 | Low | Fixed |

---

### 2.5. Final full baseline — run `20261026-155140-28734`

**Date:** 2026-10-26 · **Reason:** previous four pairing runs were read-only + tests; this run applies full deterministic tools to the final code (including the `obsidian://omnisync-pair` deep link).

**Tools:** Semgrep (p/security-audit + p/secrets + p/owasp-top-ten + p/javascript + p/nodejs + p/typescript + own rules), CodeQL JS/TS `security-extended`, gitleaks, osv-scanner, npm audit (root and Worker component), ESLint + plugin-security, tsc, SBOM (syft) + grype, full test suite.

| Tool | Raw results | Triaged |
|---|---|---|
| Semgrep | 6 (2 WARNING, 4 INFO) | 0 vulnerabilities (FP documented) |
| CodeQL | 1 | FP in `tests/`; 0 in `src/` |
| gitleaks | 0 | — |
| osv-scanner / npm audit root | 0 | — |
| npm audit Worker (`devDependencies`) | 3 (1 high, 2 moderate) | `devDependencies` only; production 0 → SEC-12 |
| grype | 120 | Go stdlib inside esbuild binary: not reachable |
| ESLint errors | 2 (`no-shadow`) | In pairing-modal + test → BUG-L1 |
| tsc | 0 errors | — |
| Test suite | All suites | All green (pairing 13/13, pairing-channel 7/7, Worker, auditor, bughunt, distribution) |

**Directed review of `obsidian://omnisync-pair` link:** length, base64, JSON and URL validated before any side-effect; always requests confirmation; no finding on the entry point.

| ID | Sev. | Description | Status |
|---|---|---|---|
| SEC-12 | Low | `wrangler` (Worker devDep) pulled in `undici` with EventSource DoS; affects developer machine only | Fixed (wrangler 4.153.0; Worker npm audit: 0) |
| SEC-13 | Low | `pairNewDevice` was not re-entrant: two concurrent calls could interleave key writes | Fixed (`pairingInFlight` guard; warning in i18n 4 languages) |
| SEC-14 | Low | `deepLinkConfirm` did not show destination host before connecting | Fixed (`{server}` shown in confirmation; i18n 4 languages) |
| BUG-L1 | Info | 2 `no-shadow` errors that would break `npm run lint` in CI | Fixed |

**Previous findings H1–H4, N1–N2, B1–B5, SEC-11, R1 and earlier audit corrections:** all regression tests pass in this run (pairing 13/13, pairing-channel 7/7, Worker, auditor, bughunt).

**Final verification (Podman sandbox, network none):** `tsc --noEmit`: 0 · `eslint src tests scripts --quiet`: 0 · `npm test`: exit 0. Bundle rebuilt, `zip/OmnySync_stable` regenerated, `Github/` synced.

---

## 3. Honest coverage

What these audits **do not** cover:

- No DAST or lab with the Worker deployed on real Cloudflare infrastructure.
- No fuzzing of production inputs.
- No tests on real devices or real relays (camera → `obsidian://`, real WebRTC, Nostr relay in production).
- No independent human review of the cryptographic protocol (ECDH P-256 + HKDF-SHA256 + AES-256-GCM).

---

*Last updated: 2026-10-26.*
