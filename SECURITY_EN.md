# Security policy — OmniSync

## Supported versions

OmniSync is under active development. Security fixes are applied to the most recent published version only.

## How to report a vulnerability

**Do not open a public issue if you have found a security vulnerability.** Public disclosure before a patch is available may put current users at risk.

Send an email with the subject `[OmniSync Security]` to:

**abismalmx.splurge748@8shield.net**

Include in your message:

1. A description of the problem and its potential impact.
2. Steps to reproduce it (with the minimal input that triggers it).
3. Plugin version affected (visible in `manifest.json`).
4. A proposed patch is welcome if you have one.

## What to expect

- Acknowledgement within **72 hours**.
- Assessment and confirmation of whether it is considered a valid vulnerability within **7 days**.
- Coordinated fix and disclosure. You will be credited in the changelog unless you prefer to remain anonymous.

## Scope

In scope:

- The plugin TypeScript code (`src/`).
- The Cloudflare Worker (`scripts/cloudflare-allinone/worker.js`).
- The ephemeral pairing protocol and pairing flow.

Out of scope:

- Vulnerabilities in Obsidian, Cloudflare, Nostr or Blossom (report those to their respective maintainers).
- Attacks that require physical access to an unlocked device.
- Social engineering of the user (e.g. convincing them to scan a malicious QR code).

## Known and accepted residual risks

See the "Accepted residual risks" section in [`docs/SECURITY_FINDINGS_EN.md`](docs/SECURITY_FINDINGS_EN.md).

---

*This document is also available in Spanish: [`SECURITY.md`](SECURITY.md).*
