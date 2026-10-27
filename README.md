<div align="center">
  <img src="assets/omnisync-banner-opt.png" alt="OmniSync" width="400" />
</div>

**English** | [Español](README.es.md) | [User Guide](docs/User_Guide_EN.md) | [Developer Guide](docs/Developer_Guide_EN.md)

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)
![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM%20end--to--end-green)
![Platforms](https://img.shields.io/badge/Obsidian-desktop%20and%20mobile-7c3aed)

---

Every Obsidian sync solution today asks you to pick a poison: pay for the official service, trust Dropbox with your notes, or run your own server. OmniSync doesn't accept that premise.

**Your devices sync directly with each other. No cloud stores your notes. No account exists to be hacked.**

This is the shift: instead of routing your vault through a server, OmniSync turns your devices into peers. The note leaves your laptop already encrypted, travels peer-to-peer, and lands on your phone. The relay that helps them find each other never sees anything readable — just a locked box passing through.

## What makes it different

**True P2P, not "self-hosted cloud".** Other plugins replace Dropbox with your own server. OmniSync replaces the server with a direct connection. The difference matters: nothing is stored in transit, nothing accumulates anywhere, there's no database to back up or lose.

**Pairing by QR.** Open the pairing wizard on your laptop, scan the code with your phone's camera, confirm on both sides. Done — cryptographic keys exchanged, never written down anywhere, expired two minutes after you scanned. No usernames, no passwords, no email.

**Async by design.** Your phone doesn't need to be online when you edit on the desktop. Changes wait in an encrypted mailbox (a Cloudflare Worker you deploy in one click, or a public Nostr relay) and sync the moment the device wakes up. Blossom handles large files — images, PDFs, audio — where each file is addressed by its own hash, so tampering is structurally impossible.

**Real-time on top.** When both devices are online and the same note is open, you see the other device's cursor moving. Edits merge at the character level; two people typing on the same paragraph offline get both versions reconciled, not one overwritten.

**Nothing leaves as plaintext.** AES-256-GCM, end to end. The server sees ciphertext and approximate message sizes. If even that concerns you, a wizard deploys your own Worker in a few minutes and the public relay is never used.

## Installation

> OmniSync is going through validation for Obsidian's community plugin directory. Until then, install it manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/abismalmx/OmniSync/releases).
2. Create `.obsidian/plugins/omnisync/` inside your vault and copy the three files there.
3. In Obsidian: **Settings → Community plugins** → enable **OmniSync**.
4. Open **Settings → OmniSync → Pairing assistant** to connect your first device pair.

Full walkthrough in the [User Guide](docs/User_Guide_EN.md).

## Honest limitations

- A Nostr relay sees your IP, that an encrypted session exists, and message sizes. Use your own Worker if that's a concern.
- Revoking a device requires regenerating the master key and re-pairing every other device. It's a deliberate tradeoff for having no central authority to ask.
- Currently going through Obsidian's community review process — not yet one-click installable from the plugin directory.

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for personal use, study, non-profits and research. Commercial use requires a separate agreement: [abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)

## Build

```bash
npm install
npm run build
npm test
```

---

Built by **abismalmx**. If it saves you a subscription, tell someone.
