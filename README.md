<div align="center">
  <img src="assets/omnisync-banner-opt.png" alt="OmniSync" width="400" />
</div>

# OmniSync

> **Your Obsidian notes, always up to date on every device. Free, private, no accounts.**

**English** | [Español](README.es.md) | [User Guide](docs/User_Guide_EN.md) | [Developer Guide (ES)](docs/Guía%20de%20Desarrolladores.md)

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)
![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM%20end--to--end-green)
![Platforms](https://img.shields.io/badge/Obsidian-desktop%20and%20mobile-7c3aed)

Type on your PC and the note shows up on your phone. No subscription, no sign-up, and nobody, not even the server that helps your devices find each other, can read what you write.

---

## The problem

Syncing Obsidian across devices usually forces a trade-off:

| Common option | The catch |
|---|---|
| Obsidian's official service | Monthly subscription |
| A cloud folder (Dropbox, Drive…) | Your notes sit on someone else's servers, and duplicate or conflicting files are common |
| Running your own server | Time, technical skills and maintenance |

OmniSync takes a different route: **your devices talk directly to each other**.

## How it works (no jargon)

- **A direct call, not a switchboard.** Your devices connect person-to-person (technically, *P2P*), like a phone call between two phones instead of leaving messages at a post office.
- **A safe for every note.** Everything is encrypted *before* it leaves your device (*end-to-end encryption*, AES-256). Whoever carries the message only sees a locked box; the key exists only on your devices.
- **A meeting point, not a middleman.** Two devices need somewhere to find each other, like a café where you agree to meet. By default OmniSync uses **Nostr**, an open public network nobody controls and that costs nothing. If you prefer your own café, a guided wizard deploys a free **Cloudflare Worker**. Once connected, your notes don't go through it.
- **If the other device is off, no problem.** Small changes wait in an encrypted mailbox and are picked up when it comes back. Large files (images, PDFs, audio) travel over **Blossom**, a storage network where each file is named after its own fingerprint, so it can't be tampered with unnoticed.

## What you get

- **Real-time sync** across any number of devices, desktop and mobile.
- **End-to-end encryption** (AES-256-GCM). No accounts, no email, no passwords to remember.
- **Pair with a QR code**: scan with your phone's camera, confirm, done. The QR works **once** and **expires in 2 minutes**; the key is not inside the QR (it is negotiated in encrypted form when you scan).
- **Live editing**: see the cursors of your other devices on the open note.
- **Smart conflict merging**: if you edited the same note offline in two places, the changes are combined instead of overwriting each other.
- **No accidental loss**: anything deleted on another device goes to the **Obsidian trash**, never destroyed outright.
- **Attachments and appearance** (optional): images, PDFs, audio, themes and CSS snippets.
- **Full control**: revoke a device by regenerating the master key.
- **Four languages**: English, Spanish, Chinese and Russian.

## Installation

> OmniSync is going through validation for Obsidian's community plugin directory. Until then, install it manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/abismalmx/OmniSync/releases).
2. Create the folder `.obsidian/plugins/omnisync/` in your vault and copy the three files there.
3. In Obsidian: **Settings → Community plugins** → enable **OmniSync**.
4. Open **Settings → OmniSync → Pairing assistant** to connect your second device.

The full walkthrough is in the [User Guide](docs/User_Guide_EN.md).

## Privacy and transparency

We would rather be clear than sound perfect:

- **What the network sees:** your note contents and file names are encrypted. A Nostr relay can still see your IP address, that a pseudonymous room exists, timing and the approximate size of messages. If that matters to you, use your own Worker.
- **End-to-end encryption (AES-GCM):** your notes are encrypted end to end with AES-256-GCM.
- **A QR is like a hotel key card:** only scan codes you generated yourself, just now. A photographed or expired QR is useless; a fresh one works during its 2 minutes.

## License: public code, free for non-commercial use

OmniSync is released under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**, a standard, lawyer-reviewed license.

**You may, without asking:**
- Use it free for personal notes, study, hobbies or research.
- Read, study, modify and share the code for non-commercial purposes.
- Use it in non-profits, educational institutions and public or government bodies.

**You may not, without an agreement with the author:**
- Sell it, offer it as a paid service or build it into a commercial product.
- Use it inside a for-profit company.

For commercial use, licensing or inquiries, contact the author: [abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net) | [github.com/abismalmx](https://github.com/abismalmx).

> **Note:** because it restricts commercial use, this is a *source-available* license and does not meet the OSI's formal definition of "open source". The code is complete and public; what the author reserves is commercial use.

## Development and contributing

```bash
npm install
npm run build        # produces main.js
npm test             # full suite
npm run typecheck && npm run lint
```

Contributions are welcome: open an issue or a pull request. See the [Developer Guide](docs/Guía%20de%20Desarrolladores.md) (Spanish).

---

Created by **abismalmx**. If OmniSync saves you a subscription, tell someone else who uses Obsidian.
