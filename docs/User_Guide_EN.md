# User Guide – OmniSync (English)

OmniSync keeps your Obsidian notes identical on all your devices, in real time, free and privately. This guide is written for people, not engineers: whenever a technical term appears, we explain it with a comparison.

- [1. The idea in one minute](#1-the-idea-in-one-minute)
- [2. How OmniSync works, step by step](#2-how-omnisync-works-step-by-step)
- [3. Choosing how your notes travel](#3-choosing-how-your-notes-travel)
- [4. Installation](#4-installation)
- [5. First steps: pairing your devices](#5-first-steps-pairing-your-devices)
- [6. What gets synced](#6-what-gets-synced)
- [7. Privacy: what is visible and what is not](#7-privacy-what-is-visible-and-what-is-not)
- [8. Managing your devices](#8-managing-your-devices)
- [9. What the messages mean](#9-what-the-messages-mean)
- [10. FAQ](#10-faq)
- [11. Common problems](#11-common-problems)
- [12. License](#12-license)

## 1. The idea in one minute

Imagine every note is a letter. With a traditional cloud service you leave it at someone else's post office and hope nobody opens it. With OmniSync, **your own devices hand the letter to each other**, always carried inside a locked box whose key only you hold.

| You want… | OmniSync gives you… |
|---|---|
| No subscription | Free syncing |
| Nobody reading your notes | End-to-end encryption |
| No accounts | Pair with a QR; no email, no password |
| Changes to arrive instantly | Real time between devices |
| Your phone to catch up after being off | A mailbox that holds your changes until the other device is back |

## 2. How OmniSync works, step by step

### 2.1 The key words

| Concept | What it means | Comparison |
|---|---|---|
| **P2P** (peer-to-peer) | Your devices connect directly to each other | A phone call between two people, no switchboard |
| **End-to-end encryption (AES-256)** | Content is scrambled before leaving your device and only unscrambled on yours | A locked box: the courier carries it but cannot open it |
| **Master key** | The secret shared by your devices | The key to your house: whoever has it gets in |
| **Meeting point (signaling)** | A place where your devices find each other | A café where you agree to meet; the café does not join the conversation |
| **Relay / Nostr** | An open public network that OmniSync can use as meeting point **and mailbox** | A public bulletin board: what you leave there is in code |
| **Cloudflare Worker** (optional) | Your own private meeting point and mailbox, on your free Cloudflare account | Your own private café with a mailbox |
| **Mailbox** | Small changes that wait, encrypted, until the other device connects | A letter waiting in the mailbox until you get home |
| **Blossom** | Storage for large files (images, PDFs, audio) | A cloakroom: each coat is identified by its fingerprint, so a swap would show |

### 2.2 What happens when you type a note

1. **You write.** After a fraction of a second without typing, OmniSync notices the change.
2. **It locks the note.** The text is encrypted on your device and the file name is turned into an unreadable code.
3. **It sends the change two ways at once** (this is the default "Dual path" mode):
   - **Directly** to your other device, if it is on, so it appears almost instantly.
   - **To your mailbox**, so it is there even if the other device is off.
4. **The other device opens it.** It checks the note is genuine, unlocks it with the shared key and writes it into your vault.

If the mailbox cannot be reached at that moment (no signal, for example), OmniSync **keeps the change on a waiting list and tries again** by itself (after 2, 5, 15 and then every 60 seconds). That list survives closing Obsidian, so nothing is lost.

### 2.3 What happens if your other device was off

You write on your phone while your computer is off. The change goes to the mailbox. Later you open Obsidian on the computer: OmniSync **checks the mailbox right away** and brings the change in. On your phone it also checks every minute while the app is open, when you come back to the app and when the connection returns, because phones put background connections to sleep to save battery.

### 2.4 What if you close the app just after typing

When you leave or close Obsidian, OmniSync **sends what was still pending first** (even the last second of typing) and then closes. At the next start it also looks for changes that never left the device and sends them.

### 2.5 If two devices edit the same note while offline

OmniSync merges both versions automatically, even within the same paragraph (a "three-way merge", like Google Docs reconciling two people). If it cannot join them without guessing, it keeps **both**: the other device's version is written, and yours is saved next to it as a copy named like `note.conflict-2026-10-27-1530.md`. Nothing is overwritten silently.

### 2.6 If you delete a note

On your other devices it goes to the **Obsidian trash**, never destroyed. You can recover it.

### 2.7 Live editing

If you open the same note on two devices at once, you see the other's cursor and selection on the text.

## 3. Choosing how your notes travel

In *Settings → OmniSync* you pick two things.

### 3.1 Sync mode

| Mode | What it does | Choose it if… |
|---|---|---|
| **Dual path (P2P + relay)** (default) | Sends every change directly **and** to your mailbox | You want it to work even when your other device is off (what most people want) |
| **Pure P2P (no relays)** | Only direct connection; no mailbox is used (the meeting point is still used so your devices can find each other) | You do not want any server involved and both devices are usually on at the same time |

### 3.2 Where your mailbox lives

The mailbox is the "letter box" used in Dual path mode. You have three options:

| Option | Cost | Setup | Notes |
|---|---|---|---|
| **Public Nostr network** (default) | Free | None | Works right away. Content is encrypted, but a public relay can see when you sync and roughly how big the changes are. |
| **Your own Cloudflare Worker, All-in-One** (recommended if you want more privacy) | Free for personal use | One command, guided by a wizard | Your private server for the meeting point, the mailbox **and** large files. Only your key can use it. |
| **Cloudflare, Blossom only** | Free | Web-only, no terminal | Stores **only large files**. Your notes still go through the public Nostr network. It has **no mailbox**. |

To set up your own server: *Settings → OmniSync → Network & P2P Signaling Servers → Deploy Private All-in-One Server → Configure Cloudflare Server*. The wizard gives you a command to copy and shows a status card that confirms everything is ready, including the mailbox.

> **Important:** if you made your Cloudflare server some time ago, **redeploy it with the wizard's current command**. Older servers lack the mailbox, so notes would not arrive while the other device is off. OmniSync warns you when it detects this.

### 3.3 Large files: Blossom

Images, PDFs, audio and notes bigger than 64 KB (when they cannot travel directly) use **Blossom**.
- Turn on the Blossom option and choose a **per-file limit** (profiles for public servers, 100 MB for your own Cloudflare server, or any value you set).
- **Do this on each device.** These settings are per device: your phone also needs your Blossom server in its list, otherwise it will not find the files.
- Files are encrypted before upload, so the storage only holds unreadable bytes.
- **Storage cleans itself.** On your own Cloudflare server, uploaded files are deleted automatically after 10 days, so the free space never fills up (the mailbox notice that points to a file lasts 7 days). If you set your server up before this rule existed, add it once: Cloudflare dashboard → R2 → your bucket → Settings → Object lifecycle rules → delete objects after 10 days.
- A very large file on a slow mobile connection can time out (uploads get 45 seconds, downloads 30). Keep the biggest files for when you are on Wi-Fi.

## 4. Installation

> OmniSync is being validated for the official community plugin directory. Once approved, you will just search for it in Obsidian. Until then:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/abismalmx/OmniSync/releases).
2. In your vault, create `.obsidian/plugins/omnisync/` and copy the three files there. (On mobile, use your file manager or whatever tool you use to move files into the vault.)
3. Restart Obsidian and enable **OmniSync** in *Settings → Community plugins*.

**Do this on every device** you want to sync. To update, repeat the same steps with the new files. Keep all your devices on the same version.

## 5. First steps: pairing your devices

Pairing introduces your devices to each other so they share the key. You do it once per device.

### 5.1 Pair with a QR

1. On the device that is **already set up**, open *Settings → OmniSync → Pairing Assistant & QR Code*. A **QR code** appears.
2. On the **new device**, open the system camera and point it at the QR. Obsidian opens and OmniSync asks you to **confirm** the pairing.
3. Accept. The new device shows up under *Devices Linked to this Vault* within seconds (there is a ⟳ button to refresh).

Both devices must be online during this step.

**Why it is safe (the hotel key card):**
- The QR works **once** and **expires after 2 minutes**. When it expires a new one is generated automatically while the assistant stays open.
- The master key is **not inside the QR**. It is sent encrypted, and only after the new device presents the code. A photo of the QR, expired or already used, is useless.
- You are always asked to confirm. Any web page could try to open an OmniSync link, so **accept only if you just scanned your own QR**.

### 5.2 Fallback: copy the code

If the camera does not open Obsidian, use **Copy pairing code** in the assistant and paste it into *Link Device Now* on the new device. It is the last resort because the code passes through the clipboard (which other apps can read); it expires in the same 2 minutes.

### 5.3 Things to keep in mind

- **Pairing replaces the new device's master key** with yours. If that device already had another one, you are warned first.
- If the QR carries a **server different from yours**, OmniSync shows the address and asks you to confirm. **Confirm only if you recognise it.**
- **Only scan QRs you generated yourself.** Whoever scans someone else's QR may end up handing over their key and server.
- After pairing, check the device list. If you see one you do not recognise, **unlink it and regenerate the master key** (see section 8).
- If you use your own Cloudflare server, pairing also needs it to be up to date. The wizard shows the command that registers your key.

## 6. What gets synced

Configured in *Settings → OmniSync → Sync Content & Scope*:

- **Notes** (always).
- **Attachments**: images, PDFs, audio, etc. (*Sync Attachments*, optional).
- **Obsidian appearance**: themes and CSS snippets (*Sync Obsidian Visual Configuration*, optional). Executable plugins and caches are **not** synced, for security and cross-system compatibility.

And the switch **Real-Time Automatic Sync** turns the whole thing on or off.

## 7. Privacy: what is visible and what is not

**Everything that matters is encrypted.** Your note text, your attachments and your **file and folder names** travel encrypted (AES-256-GCM). Nobody along the way can read them without your key. Names are turned into unreadable codes, so a server cannot even tell what your notes are called.

**What was checked.** OmniSync's team deployed real Cloudflare servers, synced notes and attachments through them, and **inspected what the server itself received**. It saw only random-looking codes and scrambled data: no file names, no paths, no text. Attachments up to 95 MB came back identical, byte for byte. The server also rejects anyone who does not hold your key. The details are in the [security findings](SECURITY_FINDINGS_EN.md) and the [tests and audits](TESTS_AND_AUDITS_EN.md).

**What a mailbox server can still see.** Even with everything encrypted, a server can observe *that* something happened: when you sync, roughly how large the changes are and how many, and an anonymous room code. It does not see content or names. A public relay also sees your IP address.

| If you use… | The server can see… |
|---|---|
| Pure P2P (no relays) | Nothing is stored on any server. The meeting point may see that two devices connected. |
| Public Nostr network | Timing, rough size, an anonymous room code, your IP |
| Your own Cloudflare server | The same, but only **you** run it |

If that bothers you, use **Pure P2P**, or your own Cloudflare server.

## 8. Managing your devices

- **Rename or change the type** of this device: *Settings → OmniSync → Device Identity*.
- **Lost a device, or see an unknown one:** use **Regenerate Master Key** (in *Security, Cryptography & Recovery*). It is the definitive way to revoke access: all linked devices lose sync instantly, and you will need to re-pair, with QR, the ones you want to keep.
- **Pause syncing:** turn off *Real-Time Automatic Sync*; OmniSync stays disconnected until you turn it on again or trigger a sync.

## 9. What the messages mean

| Message | What it means | What to do |
|---|---|---|
| "*'name' is pending and will be resent automatically*" | The mailbox was not reachable right then. The change is saved and will be retried. | Nothing. Check your connection if it persists. It shows at most once every 10 minutes. |
| "*Successfully synced N note(s) from secure mailbox*" | Changes made on another device have just arrived. | Nothing. |
| "*'name' is over 64 KB. To sync it without P2P, enable Blossom storage…*" | A big note can only travel directly right now. | Turn on Blossom (section 3.3) so it reaches your devices even if the other is off. |
| "*Your Cloudflare Worker has no mailbox enabled…*" | Your server is an older version without a mailbox. | Redeploy it with the wizard's current command. |

## 10. FAQ

| Question | Answer |
|---|---|
| Is it free? | Yes, for personal, non-commercial use. See section 12. |
| Do I need an account? | No. |
| Do I need Dropbox, Drive or Git? | No. OmniSync does not use cloud folders: it connects your devices directly and uses a mailbox when needed. |
| Does it work on mobile? | Yes, in Obsidian for Android and iOS. |
| Do both devices need to be on at once? | Only to pair. Afterwards, if one is off, changes wait in the mailbox (and big files in Blossom). In *Pure P2P* mode both must be on. |
| Can the servers read my notes? | No. Content and names are encrypted. A server can see timing and rough sizes. See section 7. |
| Do I have to set up Cloudflare? | No. The public Nostr network works out of the box. Cloudflare is optional, for more privacy and control. |
| My phone does not update in the background. | Normal: phones pause background connections. It catches up when you open the app, when the connection returns, and every minute while the app is open. |
| What if I lose a device? | Regenerate the master key (section 8). |
| Can I use it at my company? | Not without the author's permission: the license is non-commercial only. |

## 11. Common problems

- **My notes do not arrive when the other device was off.** Check, in order: (1) you are in *Dual path* mode, not *Pure P2P*; (2) the mailbox option is enabled; (3) if you use your own Cloudflare server, open its address in a browser: it should list the mailbox as `ready`. If it says `missing_do_binding`, redeploy it with the wizard's current command.
- **It worked with the public network but not with my Cloudflare server.** Almost always the server is an older version without the mailbox. Redeploy it (section 3.2).
- **Images or big files do not show up on my phone.** Blossom must be on, with your server in the list, **on that device too**, and the file must be under the size limit.
- **The QR does not open Obsidian:** check OmniSync is installed and enabled on the new device. Otherwise use *Copy pairing code*.
- **"Code expired" or "already used":** that is normal; go back to the original device, where a fresh QR will be showing, and scan that one.
- **The new device does not appear in the list:** press the ⟳ button. Make sure both have internet.
- **I see a note ending in `.conflict-…`:** two devices changed the same note while offline and could not be merged cleanly. Open both, keep what you want and delete the copy.

## 12. License

OmniSync is **public code, free for personal and non-commercial use**, under the [PolyForm Noncommercial License 1.0.0](../LICENSE). You may use, read, modify and share it for non-profit purposes, including in non-profit, educational and public organizations. Commercial use requires an agreement with the author ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

Questions or ideas? Open an issue in the [repository](https://github.com/abismalmx/OmniSync). To report a security problem, see the [security policy](../SECURITY.md).
