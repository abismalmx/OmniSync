# User Guide – OmniSync (English)

OmniSync keeps your Obsidian notes identical on all your devices, in real time, free and privately. This guide is written for people, not engineers: whenever a technical term appears, we explain it with a comparison.

## 1. Overview

Imagine every note is a letter. With a traditional cloud service you leave it at someone else's post office and hope nobody opens it. With OmniSync, **your own devices hand the letter to each other**, always carried inside a safe whose key only you hold.

| You want… | OmniSync gives you… |
|---|---|
| No subscription | Free syncing |
| Nobody reading your notes | End-to-end encryption |
| No accounts | Pair with a QR; no email, no password |
| Changes to arrive instantly | Real time between devices |

## 2. How it works (with analogies)

| Concept | What it means | Comparison |
|---|---|---|
| **P2P** (peer-to-peer) | Your devices connect directly to each other | A call between two phones, no switchboard |
| **End-to-end encryption (AES-256)** | Content is scrambled before leaving your device and only unscrambled on yours | A safe: the courier carries it but can't open it |
| **Master key** | The secret key shared by your devices | The key to your house: whoever has it gets in |
| **Signaling server** | A place where your devices find each other the first time | A café where you agree to meet; the venue doesn't join the conversation |
| **Nostr** | An open public network OmniSync uses as meeting point (and mailbox) | A bulletin board nobody controls; what you leave there is in code |
| **Cloudflare Worker** (optional) | Your own free meeting point | Your own private café |
| **Blossom** | Network where large files (images, PDFs, audio) are stored | A cloakroom where each coat is identified by its fingerprint; if swapped, it shows |
| **Mailbox** | Small changes waiting, encrypted, until the other device connects | A letter waiting in the mailbox until you get home |

**What matters:** once your devices have found each other, notes travel directly between them. The meeting point only helps them locate each other.

## 3. Installation

> OmniSync is being validated for the official community plugin directory. Once approved, you'll just search for it in Obsidian. Until then:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/abismalmx/OmniSync/releases).
2. In your vault, create `.obsidian/plugins/omnisync/` and copy the three files there. (On mobile, use your file manager or whatever tool you use to move files into the vault.)
3. Restart Obsidian and enable **OmniSync** in *Settings → Community plugins*.

**Do this on every device** you want to sync.

## 4. First steps: pairing your devices

Pairing introduces your devices to each other so they share the key. You do it once per device.

### 4.1 Pair with a QR

1. On the device that's **already set up**, open *Settings → OmniSync → Open Pairing Assistant*. A **QR code** appears.
2. On the **new device**, open the system camera and point it at the QR. Obsidian opens and OmniSync asks you to **confirm** the pairing.
3. Accept. The new device shows up under *Devices Linked to this Vault* within seconds (there's a ⟳ button to refresh).

Both devices must be online during this step.

**Why it's safe (the hotel key card):**
- The QR works **once** and **expires after 2 minutes**. When it expires a new one is generated automatically while the assistant stays open.
- The master key is **not inside the QR**. It is sent encrypted, and only after the new device presents the code. A photo of the QR, expired or already used, is useless.
- You are always asked to confirm. Any web page could try to open an OmniSync link, so **accept only if you just scanned your own QR**.

### 4.2 Fallback: copy the code

If the camera doesn't open Obsidian, use **Copy pairing code** in the assistant and paste it into *Link Device Now* on the new device. It's the last resort because the code passes through the clipboard (which other apps can read); it expires in the same 2 minutes.

### 4.3 Choosing the meeting channel

- **Nostr** (default): nothing to set up.
- **My Cloudflare Worker**: only if you already run your own server. It must be redeployed with the current version and the device's public key must be in `ALLOWED_PUBKEYS` (the Cloudflare assistant generates the command).

### 4.4 Things to keep in mind

- **Pairing replaces the new device's master key** with yours. If that device already had another one, you're warned first.
- If the QR carries a **server different from yours**, OmniSync shows the address and asks you to confirm. **Confirm only if you recognise it.**
- **Only scan QRs you generated yourself.** Whoever scans someone else's QR may end up handing over their key and server.
- After pairing, check the device list. If you see one you don't recognise, **unlink it and regenerate the master key** (see section 7).
- The old permanent-key mode remains under *Advanced*, with a warning. Use it only if you know why.

## 5. What gets synced

Configured in *Settings → OmniSync → Content and Scope*:

- **Notes** (always).
- **Attachments**: images, PDFs, audio, etc. (optional).
- **Obsidian appearance**: themes and CSS snippets (optional). Executable plugins and caches are **not** synced, for security and cross-OS compatibility.

**If the other device is off:** with *Online Sync (Nostr Network)* enabled, small changes wait encrypted in a mailbox and are picked up on reconnect. Large files use *Blossom*, with a per-file limit you choose (there are recommended profiles for public servers, or a free value in MB).

**If two devices edit the same note offline:** OmniSync merges the changes (three-way merge). If they can't be joined unambiguously, it flags it so you decide.

**If you delete a note on one device:** on the others it goes to the **Obsidian trash**, never destroyed. You can recover it.

**Live editing:** if you open the same note on two devices, you see the other's cursor on the text.

## 6. Privacy: what's visible and what isn't

**End-to-end encryption.** Your note contents and file names travel encrypted. Nobody along the way can read them without your key.

**What a public meeting point (relay) can still observe:** your IP address, that a pseudonymous "room" exists, the timing of activity and the approximate size of messages. It doesn't see the content. If that matters to you, run your own Cloudflare Worker (*Settings → OmniSync → Network & P2P Signaling Servers → Deploy Private All-in-One Server*): the assistant guides you step by step.

**End-to-end encryption (AES-GCM).** OmniSync encrypts your notes end to end with AES-256-GCM.

## 7. Managing your devices

- **Rename or change the type** of this device: *Settings → OmniSync → Device Identity*.
- **Lost a device, or see an unknown one:** use **Regenerate Master Key**. It is the definitive way to revoke access: all linked devices lose sync instantly, and you'll need to re-pair, with QR, the ones you want to keep.
- **Pause syncing:** disable *Real-Time Automatic Sync*; OmniSync stays disconnected until you re-enable it or trigger a sync.

## 8. FAQ

| Question | Answer |
|---|---|
| Is it free? | Yes, for personal, non-commercial use. See section 10. |
| Do I need an account? | No. |
| Do I need Dropbox, Drive or Git? | No. OmniSync doesn't use cloud folders: it connects your devices directly. |
| Does it work on mobile? | Yes, in Obsidian for Android and iOS. |
| Do both devices need to be on at once? | Only to pair. Afterwards, if one is off, small changes wait in the mailbox and large files in Blossom. |
| Can the servers read my notes? | Not the content. A public relay can see metadata (IP, timing, sizes). See section 6. |
| What if I lose a device? | Regenerate the master key (section 7). |
| Can I use it at my company? | Not without the author's permission: the license is non-commercial only. |

## 9. Common problems

- **The QR doesn't open Obsidian:** check OmniSync is installed and enabled on the new device. Otherwise use *Copy pairing code*.
- **"Code expired" or "already used":** that's normal; go back to the original device, where a fresh QR will be showing, and scan that one.
- **The new device doesn't appear in the list:** press the ⟳ button. Make sure both have internet.
- **It won't connect with my Worker:** redeploy the Worker with the current version and check the device's public key is in `ALLOWED_PUBKEYS`.
- **A large file isn't syncing:** it may exceed the per-file Blossom limit you picked; raise it or change the profile.

## 10. License

OmniSync is **public code, free for personal and non-commercial use**, under the [PolyForm Noncommercial License 1.0.0](../LICENSE). You may use, read, modify and share it for non-profit purposes, including in non-profit, educational and public organizations. Commercial use requires an agreement with the author ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

Questions or ideas? Open an issue in the [repository](https://github.com/abismalmx/OmniSync).
