# User Guide – OmniSync (English)

OmniSync keeps your Obsidian notes identical on all your devices, in real time, free and privately. This guide is written for people, not engineers: whenever a technical term appears, we explain it with a comparison.

> **This guide is for you, not for the source code.** You do not need to know anything about programming. If any part feels complicated, the [60-second summary](#60-second-summary) and the [common problems](#12-common-problems) sections solve 90 % of the cases. If you prefer Spanish, it is in [Guía de Usuario.md](Guía%20de%20Usuario.md).

## 60-second summary

If you only read one part, read this.

| I want… | What I do |
|---|---|
| **Get started** | Install the plugin ([section 4](#4-installation)) and pair the second device with the QR code ([section 5](#5-first-steps-pairing-your-devices)). That's it. |
| **Understand what this is** | My devices talk directly to each other, with the notes encrypted inside. No server reads my notes. ([section 2](#2-how-omnisync-works-step-by-step)) |
| **Know whether it is safe** | Yes: end-to-end encryption, no accounts, no passwords, no server storing my notes. ([section 8](#8-privacy-what-is-visible-and-what-is-not)) |
| **Make it work while my phone is off** | Turn on **Dual path** mode ([section 3.1](#31-the-two-settings-that-matter)). Without it, the other device must be switched on. |
| **Understand why a note did not arrive** | Look at the [message table](#10-what-the-messages-mean). It tells you exactly what to do. |
| **Recover something I deleted** | It is not deleted: it goes to the Obsidian trash. ([section 9](#9-managing-your-devices)) |
| **I lost a device** | Regenerate the master key. ([section 9](#9-managing-your-devices)) |

## Index

- [60-second summary](#60-second-summary)
- [1. The idea in one minute](#1-the-idea-in-one-minute)
- [2. How OmniSync works, step by step](#2-how-omnisync-works-step-by-step)
- [3. Choosing how your notes travel](#3-choosing-how-your-notes-travel)
- [4. Installation](#4-installation)
- [5. First steps: pairing your devices](#5-first-steps-pairing-your-devices)
- [6. The interface: where everything is](#6-the-interface-where-everything-is)
- [7. What gets synced](#7-what-gets-synced)
- [8. Privacy: what is visible and what is not](#8-privacy-what-is-visible-and-what-is-not)
- [9. Managing your devices](#9-managing-your-devices)
- [10. What the messages mean](#10-what-the-messages-mean)
- [11. FAQ](#11-faq)
- [12. Common problems](#12-common-problems)
- [13. License](#13-license)

> **About sections 3 and 4:** installation and configuration are the parts people look up the most. If something is not working, jump straight to [12. Common problems](#12-common-problems).

## 1. The idea in one minute

Imagine every note is a letter. With a traditional cloud service you leave it at someone else's post office and hope nobody opens it. With OmniSync, **your own devices hand the letter to each other**, always carried inside a locked box whose key only you hold.

| You want… | OmniSync gives you… |
|---|---|
| No subscription | Free syncing |
| Nobody reading your notes | End-to-end encryption |
| No accounts | Pair with a QR; no email, no password |
| Changes to arrive instantly | Real time between devices |
| Your phone to catch up after being off | A mailbox that holds your changes until the other device is back |

### 1.1 What OmniSync **is not**

These mix-ups are the most common ones, so it is worth clearing them up right away:

| It is not… | Why |
|---|---|
| **A backup** | A backup keeps your notes *for the future*. OmniSync moves them *from now to now*: its mailbox only holds changes for **7 days**. If you want both, use it together with iCloud, Dropbox or an external drive. ([section 2.3.1](#omnisync-is-not-a-backup)) |
| **A cloud folder** | There is no "OmniSync" folder in your Drive or iCloud. Your notes stay as normal files in your local vault; they are just copied between your devices while they are connected. |
| **An account service** | No sign-up, no email, no password, no "forgot my password". The key is yours and yours alone. |
| **Something that fools the server** | Even though it goes through a server, that server only receives scrambled blocks it cannot open. ([section 8](#8-privacy-what-is-visible-and-what-is-not)) |

### 1.2 A normal day with OmniSync

So you can see the real rhythm before the details:

1. **Morning.** You write on the laptop. After a fraction of a second without typing, the note is already encrypted and on its way.
2. **On the train.** The phone was in airplane mode. As the train moves, the phone checks the mailbox and picks up what was left behind.
3. **Midday.** You open the same note on the laptop and the tablet. You watch the other device's cursor move over the text.
4. **Afternoon.** You delete a note on the phone. On the laptop it **does not disappear**: it goes to the Obsidian trash, in case the deletion was a mistake.
5. **Night.** You close Obsidian. OmniSync sends whatever was pending first and then shuts down. Nothing is left half-done on your disk.

## 2. How OmniSync works, step by step

### 2.1 The key words

Every technical term that appears in this guide is here, translated into everyday language.

#### The basics: the network

| Concept | What it means | Comparison |
|---|---|---|
| **P2P** (peer-to-peer) | Your devices connect directly to each other | A phone call between two people, no switchboard |
| **Meeting point (signaling)** | A place where your devices find each other | A café where you agree to meet; the café does not join the conversation |
| **Relay / Nostr** | An open public network that OmniSync can use as meeting point **and mailbox** | A public bulletin board: what you leave there is in code |
| **Cloudflare Worker** (optional) | Your own private meeting point and mailbox, on your free Cloudflare account | Your own private café with a mailbox |
| **End-to-end encryption (AES-256)** | Content is scrambled before leaving your device and only unscrambled on yours | A locked box: the courier carries it but cannot open it |
| **Master key** | The secret shared by your devices | The key to your house: whoever has it gets in |
| **HMAC / path obfuscation** | Your file names are replaced with unreadable codes on the way | Putting your real name on an envelope with a pseudonym: the courier only sees the pseudonym |

#### What carries your stuff

| Concept | What it means | Comparison |
|---|---|---|
| **Mailbox** | Small changes that wait, encrypted, until the other device connects | A letter waiting in the mailbox until you get home |
| **Quick patch (delta)** | Instead of sending the whole note, only the part you changed is sent | Instead of resending the whole book, I send you only the page you corrected |
| **Three-way merge** | If both devices edited the same thing offline, OmniSync joins them by itself | Like when Google Docs reconciles two people typing at once |
| **Base snapshot** | An encrypted copy of how your note looked the last time everything lined up | The previous draft: with both versions and the base, you can work out what changed |
| **Blossom** | Storage for large files (images, PDFs, audio) | A cloakroom: each coat is identified by its fingerprint, so a swap would show |
| **Safe trash** | When you delete on one device, the others move it to the Obsidian trash | Instead of burning the letter, it is filed in case you change your mind |
| **Anonymous room** | A code that identifies your group of devices without revealing your key | A tunnel number at a station: only those who know it meet |

#### The limits worth knowing in advance

| Concept | What it means | Comparison |
|---|---|---|
| **64 KB** | The largest note that can travel through the mailbox | A letter that fits in the mailbox; anything bigger takes another route |
| **7 days** | How long a change waits in the mailbox | The window to collect a parcel from an office |
| **10 days** | How long a large file is kept on your own Cloudflare | A shop's trial period: then it cleans itself up |
| **No connection** | OmniSync keeps working: it holds the pending work and retries by itself | A traffic jam: it saves it and lets it out on its own |

### 2.2 What happens when you type a note

1. **You write.** After a fraction of a second without typing, OmniSync notices the change.
2. **It locks the note.** The text is encrypted on your device and the file name is turned into an unreadable code.
3. **It sends the change.** By one route or two, depending on the mode you picked in the settings:
   - **Directly** to your other device, if it is on, so it appears almost instantly. (This always happens.)
   - **To your mailbox**, so it is there even if the other device is off. (This only happens in **Dual path** mode.)
4. **The other device opens it.** It checks the note is genuine, unlocks it with the shared key and writes it into your vault.

If the mailbox cannot be reached at that moment (no signal, for example), OmniSync **keeps the change on a waiting list and tries again** by itself (after 2, 5, 15 and then every 60 seconds). That list survives closing Obsidian, so nothing is lost.

> **Why did the change not appear instantly on the other device?** Even if the other machine is on, there are two usual reasons: (1) you are in **Pure P2P** mode and no direct connection is open at that moment; (2) you are behind a network that blocks device-to-device connections (a corporate network or a wifi with "client isolation"). If the other machine is on the same wifi and it still does not arrive, see [section 12.1](#121-notes-do-not-arrive).

### 2.3 What happens if your other device was off

You write on your phone while your computer is off. The change goes to the mailbox. Later you open Obsidian on the computer: OmniSync **checks the mailbox right away** and brings the change in. On your phone it also checks every minute while the app is open, when you come back to the app and when the connection returns, because phones put background connections to sleep to save battery.

<a id="omnisync-is-not-a-backup"></a>

### 2.3.1 ⚠️ OmniSync is not a backup

OmniSync is a **transit mailbox**, not permanent storage. This means:

- The mailbox notice that announces a change **expires after 7 days**. After that, the other device can no longer receive it through the mailbox (though it can still get it over P2P if both devices meet online).
- Large files on your Cloudflare server (R2) **are deleted after 10 days** by design, so your free quota never fills up.
- Large files on public Blossom relays **are deleted around 7 days**, depending on each server's policy.
- If a device stays offline for more than 7 days and there was never a direct P2P session, **changes from that period will not arrive**.

**What OmniSync does guarantee:** the notes already on each device live in your local Obsidian vault. If you want a real backup — "my notes are safe a month from now no matter what" — use a separate backup solution: iCloud, Dropbox, a manual copy to an external drive, or the Obsidian Sync plugin. OmniSync and a backup complement each other well: one syncs in real time, the other keeps history.

### 2.4 What if you close the app just after typing

When you leave or close Obsidian, OmniSync **sends what was still pending first** (even the last second of typing) and then closes. At the next start it also looks for changes that never left the device and sends them.

### 2.5 If two devices edit the same note while offline

OmniSync merges both versions automatically, even within the same paragraph (a "three-way merge", like Google Docs reconciling two people). If it cannot join them without guessing, it keeps **both**: the other device's version is written, and yours is saved next to it as a copy named like `note.conflict-2026-10-27-1530.md`. Nothing is overwritten silently.

### 2.6 If you delete a note

On your other devices it goes to the **Obsidian trash**, never destroyed. You can recover it.

### 2.7 Live editing

If you open the same note on two devices at once, you see the other's cursor and selection on the text.

## 3. Choosing how your notes travel

All of this is changed in *Settings → Community plugins → OmniSync → Settings*.

### 3.1 The two settings that matter

If you only touch two things, make them these:

| Setting | What it does | Why it matters |
|---|---|---|
| **Sync mode** | Decides whether your changes are also stored in a mailbox | This is what decides whether notes reach a device that is **switched off**. |
| **Blossom storage** | Enables sending images, PDFs, audio and very long notes | Without it, media files only travel when both machines are on at the same time. |

#### Sync mode

| Mode | What it does | Choose it if… |
|---|---|---|
| **Dual path (P2P + relay)** | Sends every change directly **and** to your mailbox | You want it to work even when your other device is off (what most people want) |
| **Pure P2P (no relays)** | Only direct connection; no mailbox is used (the meeting point is still used so your devices can find each other) | You do not want any server involved and both devices are usually on at the same time |

> **Important:** OmniSync starts in **Pure P2P**, so on a fresh install notes **only** travel while the other device is switched on. If you want the "my notes always arrive" behaviour, switch to **Dual path** in the "Sync mode" dropdown. It is a one-click change and needs no other reconfiguration.

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
- **Pasted images stay tidy.** Obsidian saves a pasted image as a separate file. By default OmniSync points new attachments to an `Adjuntos` folder and hides it from the file explorer; the images still show in your notes and sync normally. You can turn this off in the settings (“Tidy attachments”). A dot-folder is not used because Obsidian ignores those and the images would stop displaying.
- A very large file on a slow mobile connection can time out (uploads get 45 seconds, downloads 30). Keep the biggest files for when you are on Wi-Fi.

> **Blossom privacy:** the server sees your IP address, the encrypted size, the file's hash and the upload date. It does **not** see the name, the path, the extension or the content in the clear.

### 3.4 Complete guide to every setting

Here is every option on the settings screen, in the order they appear. The "when to touch it" column tells you whether it is a one-time setup or something you will rarely change.

#### Automation and workflow

| Setting | What it does | When to touch it |
|---|---|---|
| **Real-Time Automatic Sync** | Starts the sync network in the background when you open Obsidian and watches your files for changes | Leave it **on**. If you turn it off, OmniSync stays disconnected until you sync manually. |
| **Pairing Assistant & QR Code** | Opens the window to connect new devices | Use it every time you add a device. |

#### Identity of this device

| Setting | What it does | When to touch it |
|---|---|---|
| **This device's name** | How this machine appears in the device list on your other devices ("Personal Laptop", "Phone"…) | Give it a recognisable name the first time, so you can tell the machines apart at a glance. |
| **Device type** | *Computer* or *Mobile*. Adjusts icons and the visual interface | OmniSync detects it on its own. Change it only if it got it wrong. |

#### Sync content & scope

| Setting | What it does | When to touch it |
|---|---|---|
| **Sync Attachments** | Transfers photos, screenshots, PDFs, audio and other media | Turn it on if you want your images on the phone too. If you turn it off, only text notes (`.md`, `.canvas`) travel. |
| **Sync Obsidian Visual Configuration** | Keeps your installed themes and CSS snippets in sync | Turn it on if you want the vault to look the same everywhere. Executable plugins (`.js`) and caches are **never** synced, for safety. |
| **Tidy attachments** | Sends newly pasted images to an `Adjuntos` folder and hides it from the file explorer | On by default. Change it only if you already use your own attachments folder. |
| **Sync mode** | *Dual path* or *Pure P2P* | The most important one. See [3.1](#31-the-two-settings-that-matter). |
| **Large Files & Multimedia Storage (Blossom Network)** | Enables sending large files through Blossom servers | Turn it on if you sync images or heavy files. See [3.3](#33-large-files-blossom). |
| **Blossom servers** | The list of servers where large files are stored | Only if you use the public defaults. You can add your own, one per line. If the first fails, OmniSync tries the next ones. |
| **Maximum file size** | The largest file you allow to upload (25 / 50 / 100 MB or a free value) | Leave it on the profile recommended for your server. The plugin detects the server type and suggests it for you. |

#### Network & P2P signaling servers

| Setting | What it does | When to touch it |
|---|---|---|
| **Signaling Server (P2P meeting point)** | The place where your devices meet to talk | Leave it on *Nostr Nos.lol* (the top of the dropdown) if everything works. Changing it is not something you do often. |
| **Server WebSocket URL** | The specific address (`wss://…`) | Only if you use your own server. It must start with `wss://` (with a lock): insecure `ws://` connections are not allowed. |
| **Deploy Private All-in-One Server** | The wizard to set up your own Cloudflare server | Optional. See [3.2](#32-where-your-mailbox-lives). |

#### Security, cryptography & recovery

| Setting | What it does | When to touch it |
|---|---|---|
| **Anonymous Connection Room ID** | The code your devices use to find each other without revealing your key | Informational only. Do not change it: it is derived from your master key. |
| **Deleted Note Loss Protection** | Notes deleted on another device go to the Obsidian trash | Always on. Nothing to do here. |
| **Reset & Regenerate Master Key** | Creates a new key and disconnects every device | Only if you lost a device or see one you do not recognise. See [section 9](#9-managing-your-devices). |

#### Language

| Setting | What it does | When to touch it |
|---|---|---|
| **Interface language** | The language of OmniSync's menus and messages | *Automatic* follows Obsidian's language. English, Español, Русский and 简体中文 are also available. |

> **One setting per device.** Everything on this screen is stored **separately on each machine**. If you switch the mode to Dual path on the laptop, the phone keeps its own until you change it there too. This is the most common mix-up: "but I had it turned on!"


## 4. Installation

> OmniSync is being validated for the official community plugin directory. Once approved, you will just search for it in Obsidian. Until then, you install it by hand.

### 4.1 What you need before you start

| Requirement | Detail |
|---|---|
| **Obsidian 1.11.4 or newer** | Mandatory: older versions do not have the secure store where OmniSync keeps your master key. If your Obsidian is older, update it first. |
| **The 3 plugin files** | `main.js`, `manifest.json` and `styles.css`. All three go together, in the same folder. |
| **Internet** | Only for the first connection between devices. After that, your content goes straight from one machine to the other. |
| **A vault** | The folder where you keep your notes. On mobile, your Obsidian account's synced vault works too, if you use one. |

### 4.2 Installing on a computer (Windows, macOS, Linux)

1. **Download the three files** from the [latest release](https://github.com/abismalmx/OmniSync/releases) page.
2. **Create the plugin folder.** In your vault, open the `.obsidian` folder (on Linux and macOS it may be hidden: press `Ctrl+Shift+.` or `Cmd+Shift+.` to show it). Inside, open `plugins` and create a folder called `omnisync`.
3. **Copy the three files** into `omnisync`. You should end up with:
   ```
   YourVault/
   └── .obsidian/
       └── plugins/
           └── omnisync/
               ├── main.js
               ├── manifest.json
               └── styles.css
   ```
4. **Restart Obsidian** and go to *Settings → Community plugins*. Find **OmniSync** and switch it on (the toggle on the left).
5. **Check that it is active.** At the bottom right of Obsidian you should see `OmniSync (Disconnected)`. If it does not appear, see 12.4.

### 4.3 Installing on mobile (Android, iOS)

The steps are the same, but moving the files around depends on the platform:

| Platform | Where to put the files |
|---|---|
| **Android** | Use your file manager or Samsung's *Files* app. The vault is usually at `/sdcard/Documents/Obsidian` or in whichever folder you chose for Obsidian. |
| **iOS** | Use Apple's *Files* app. You need to connect the vault from Obsidian once (so it shows up under *Files → On My iPhone*). |

Then the same steps 4 and 5: restart Obsidian and enable the plugin in *Settings → Community plugins*.

> **iOS shortcut:** if you prefer, you can use the official **Obsidian Sync** app (or iCloud) to distribute only the plugin *folder*, without syncing your notes. It is an easy way to install without cables. Your notes, though, remain OmniSync's job.

### 4.4 Checking that everything works

After enabling the plugin, check these three things:

| Check | What you should see | If it fails |
|---|---|---|
| **The plugin is active** | `OmniSync (Disconnected)` or `OmniSync (1)` at the bottom right | [12.4](#124-the-plugin-does-not-appear-in-the-bar) |
| **Your key was generated** | Under *Settings → OmniSync → Security* there is an "Anonymous Connection Room ID" with a code | [12.5](#125-i-cannot-see-the-room-code) |
| **You can open the assistant** | Clicking the OmniSync icon in the left sidebar opens the pairing window | [12.6](#126-i-cannot-open-the-pairing-assistant) |

### 4.5 Updating the plugin

1. Download the three files from the new version.
2. Replace the old ones in `.obsidian/plugins/omnisync/`.
3. Restart Obsidian.

> **Important:** keep **all your devices on the same version**. If one is ahead and another behind, they may fail to agree when they negotiate the connection. Update them all on the same afternoon.

### 4.6 Uninstalling

1. In *Settings → Community plugins*, switch OmniSync off.
2. Delete the `.obsidian/plugins/omnisync/` folder.
3. Your notes **are not touched**: they stay exactly where they were. OmniSync only added copies between devices; it never modified your files on your disk.

> **Note:** if you uninstall on one device and later reinstall it, that machine generates a new key and ends up unpaired from the others. You will have to pair it again with a QR code.

## 5. First steps: pairing your devices

Pairing introduces your devices to each other so they share the key. You do it once per device.

### 5.1 Pair with a QR

1. On the device that is **already set up**, open *Settings → OmniSync → Pairing Assistant & QR Code*. A **QR code** appears with a countdown ("Expires in …").
2. On the **new device**, open the system camera and point it at the QR. Obsidian opens and OmniSync asks you to **confirm** the pairing.
3. Read the prompt carefully. It tells you **which server** the new device will connect to. If it is not yours, **cancel**.
4. Accept. The new device shows up under *Devices Linked to this Vault* within seconds (there is a ⟳ button to refresh).

Both devices must be online during this step.

**Why it is safe (the hotel key card):**
- The QR works **once** and **expires after 2 minutes**. When it expires a new one is generated automatically while the assistant stays open.
- The master key is **not inside the QR**. It is sent encrypted, and only after the new device presents the code. A photo of the QR, expired or already used, is useless.
- You are always asked to confirm. Any web page could try to open an OmniSync link, so **accept only if you just scanned your own QR**.

### 5.2 Fallback: copy the code

If the camera does not open Obsidian, use **Copy Secret Pairing Key** in the assistant and paste it into *Link Device Now* on the new device. It is the last resort because the code passes through the clipboard (which other apps can read); it expires in the same 2 minutes.

### 5.3 The pairing assistant, block by block

The assistant window has three blocks. It is worth knowing what each one is:

| Block | What it is | What you do with it |
|---|---|---|
| **Step 1: QR Code and Key** | The QR the other device scans, and the button to copy the key | You show it on screen for the other machine to read |
| **Step 2: Connect to another Device** | The field where you paste a key you were given | Only if the other device already had OmniSync and sent you its key |
| **Step 3: Linked Devices** | The list of your machines, with their online state and last sync | To check that everything is fine, and to unlink devices |

### 5.4 Things to keep in mind

- **Pairing replaces the new device's master key** with yours. If that device already had another one, you are warned first.
- If the QR carries a **server different from yours**, OmniSync shows the address and asks you to confirm. **Confirm only if you recognise it.**
- **Only scan QRs you generated yourself.** Whoever scans someone else's QR may end up handing over their key and server.
- After pairing, check the device list. If you see one you do not recognise, **unlink it and regenerate the master key** (see [section 9](#9-managing-your-devices)).
- If you use your own Cloudflare server, pairing also needs it to be up to date. The wizard shows the command that registers your key.
- **A device can pair with another without a QR**, by copying the key by hand. It works exactly the same way.

### 5.5 Checking that the pairing worked

| Check | Where to look | What you see |
|---|---|---|
| **The other machine is in the list** | Step 3 of the assistant | Its name and the "Online" status |
| **The status bar updates** | Bottom right | It goes from `OmniSync (Disconnected)` to `OmniSync (1)` (the number is how many devices are connected) |
| **A real test** | Any note | Type a new line and watch it appear on the other machine in under a second |

> **If the number stays at 0 or the other machine does not show up**, go to [12.1](#121-notes-do-not-arrive). The most common cause is not OmniSync, but the two machines sitting on networks that block each other.

## 6. The interface: where everything is

OmniSync leans on the pieces of Obsidian you already know. There is no new screen to learn.

### 6.1 The status bar (bottom right)

This is the most important indicator. It tells you the state of the sync:

| What you see | What it means | Do you need to do anything? |
|---|---|---|
| `OmniSync (Disconnected)` | The plugin is active but no other device is connected yet. This is normal if you have not paired anything. | Only if you already paired and it should be connected. |
| `OmniSync (1)` | **1** device is connected and syncing in real time. The number is how many devices are connected right now. | No. All good. |
| `OmniSync (2)` | **2** devices are connected (you count as one). | No. All good. |
| `Connecting...` | It is looking for your other devices through the meeting point. | Wait a few seconds. |
| `Syncing...` | It is moving data right now. | No. |
| `Sync error` | Something went wrong. | Read the notice that popped up and check the [message table](#10-what-the-messages-mean). |
| `🔒 MySecret locked` | You use the MySecret plugin and your vault is locked. OmniSync cannot read your notes until you unlock it. | Unlock MySecret. Syncing resumes by itself. |

**Clicking the status bar** = the pairing assistant opens. It is the fastest way to get there.

### 6.2 The icon in the sidebar

In the left toolbar there is an icon with the OmniSync emblem. Clicking it opens **the same pairing assistant**.

### 6.3 The Obsidian commands

OmniSync adds three commands to the Obsidian palette. Open it with `Ctrl+P` (or `Cmd+P`) and type "OmniSync":

| Command | What it is for |
|---|---|
| **OmniSync: Open pairing assistant (QR code)** | Opens the QR window and the device list. |
| **OmniSync: Force full vault sync now** | Reviews all your content and syncs it, even if nothing changed recently. Useful if you suspect something was left behind. |
| **OmniSync: Repair notes with an encryption conflict (MySecret integration)** | Only if you use MySecret. Fixes notes left double-encrypted after a lock. |

### 6.4 The pairing assistant window

It is OmniSync's central screen. It is described in detail in [section 5.3](#53-the-pairing-assistant-block-by-block), but in short:

- **Top:** the QR and the button to copy the key.
- **Middle:** the field to paste a key you were given.
- **Bottom:** the list of linked devices, with their state, their last sync, and the buttons to unlink or force a sync.

### 6.5 The settings

They live in *Settings → Community plugins → OmniSync → Settings*. The complete list is in [section 3.4](#34-complete-guide-to-every-setting).

---

## 7. What gets synced

Configured in *Settings → OmniSync → Sync Content & Scope*:

- **Notes** (always): `.md`, `.markdown`, `.txt`, `.canvas`, `.json` and `.css` files.
- **Attachments**: images, PDFs, audio, etc. (*Sync Attachments*, optional).
- **Obsidian appearance**: themes and CSS snippets (*Sync Obsidian Visual Configuration*, optional). Executable plugins and caches are **not** synced, for security and cross-system compatibility.

And the switch **Real-Time Automatic Sync** turns the whole thing on or off.

### 7.1 What happens to each file type

| Type | Travels via | Notes |
|---|---|---|
| `.md`, `.markdown`, `.txt` | Direct P2P and mailbox | Up to 64 KB through the mailbox; above that it needs Blossom |
| `.canvas` (boards) | Direct P2P and mailbox | A board is a JSON file: it can get quite big |
| `.json`, `.css` | Direct P2P and mailbox | Usually from the `.obsidian` folder |
| Images, PDFs, audio, video | Blossom (if enabled) or direct P2P | The per-file limit depends on the server you use |
| The Obsidian **trash** (`.trash`) | ❌ Does not travel | It is local to each machine |

### 7.2 What does NOT get synced (and why)

| Does not travel | Why |
|---|---|
| **Obsidian plugins** (`.js`) | Running code from another machine is a security risk. Install them by hand on each device. |
| **Caches and session data** | They add nothing and create conflicts. |
| Obsidian's **version history** | Each machine manages its own. |
| **The trash** | It is a local safety net: if a note was deleted on one machine, the others can restore it, but the trash itself is not replicated. |

---

## 8. Privacy: what is visible and what is not

**Everything that matters is encrypted.** Your note text, your attachments and your **file and folder names** travel encrypted (AES-256-GCM). Nobody along the way can read them without your key. Names are turned into unreadable codes, so a server cannot even tell what your notes are called.

**What was checked.** OmniSync's team deployed real Cloudflare servers, synced notes and attachments through them, and **inspected what the server itself received**. It saw only random-looking codes and scrambled data: no file names, no paths, no text. Attachments up to 95 MB came back identical, byte for byte. The server also rejects anyone who does not hold your key. The details are in the [security findings](https://github.com/abismalmx/OmniSync/blob/main/Github/docs/SECURITY_FINDINGS_EN.md) and the [tests and audits](TESTS_AND_AUDITS_EN.md).

**What a mailbox server can still see.** Even with everything encrypted, a server can observe *that* something happened: when you sync, roughly how large the changes are and how many, and an anonymous room code. It does not see content or names. A public relay also sees your IP address.

| If you use… | The server can see… |
|---|---|
| Pure P2P (no relays) | Nothing is stored on any server. The meeting point may see that two devices connected. |
| Public Nostr network | Timing, rough size, an anonymous room code, your IP |
| Your own Cloudflare server | The same, but only **you** run it |

If that bothers you, use **Pure P2P**, or your own Cloudflare server.

### 8.1 The detail that usually matters: your IP address

With the mailbox on a public network, the server sees which IP you connect from. That does not tell it what notes you have, but it can reveal:
- that you have a vault with OmniSync,
- roughly when you write,
- that two devices are in the same home or the same office.

If you would rather avoid it, use your own Cloudflare Worker (you handle everything) or Pure P2P.

### 8.2 Your master key and where it lives

| Question | Answer |
|---|---|
| Where is my key? | In Obsidian's **secure store** (`SecretStorage`), not in a readable text file. |
| Is it stored in the cloud? | No. It lives on your device. |
| What if I lose it? | You cannot recover it. You would have to pair all your devices again from scratch. |
| Does it ever change? | Only if you press *Reset & Regenerate Master Key* yourself, or if you unlink a device. |

### 8.3 The summary in one sentence

> Your notes travel in a sealed envelope. The server carries it, knows how big it is and when it passed by, and leaves it in a mailbox. It cannot open it. Only you have the key.

---

## 9. Managing your devices

### 9.1 What you can do

| Action | Where | When to do it |
|---|---|---|
| **Rename or change the type** of this device | *Settings → OmniSync → Device Identity* | The first time, so you recognise it later in the list |
| **See the list of devices** | Pairing assistant → Step 3 | Whenever you are unsure whether everything is fine |
| **Unlink a device** | Pairing assistant → *Unlink* | When you no longer use that machine (you sold it, it was stolen, it broke) |
| **Pause syncing** | Turn off *Real-Time Automatic Sync* | If you want to stop syncing without uninstalling |

### 9.2 Unlinking a device

> **Careful: this rotates your master key.** Every linked device (including the one you are using) **gets disconnected** and you will have to pair the ones you want to keep again with a QR code. It is the only real way to revoke access, but it is a scary operation. Use it only when it is really needed.

### 9.3 You lost a device, or you see an unknown one

This is the exact procedure:

1. Open *Settings → OmniSync → Security, Cryptography & Recovery*.
2. Press **Reset & Regenerate Master Key**. Read the warning carefully: it tells you exactly what is about to happen.
3. Confirm. From that moment on, **no** linked device can read your notes. The device you lost is out of the picture, even if someone else has it in their hands.
4. Pair the devices you kept: on one of them open the assistant, and on each of the others scan the new QR code.

### 9.4 What NOT to do

| Do not do this | Why |
|---|---|
| Regenerate the key "often", "just in case" | Every time it disconnects all your machines and forces you to pair again. |
| Share your master key with someone | Whoever has it can read everything you sync. |
| Pair the same machine twice | You will get two entries in the list. Unlink the extra one. |

---

## 10. What the messages mean

OmniSync tells you about the important things with a notice in Obsidian. These are **all** of them:

### 10.1 Normal messages (no action needed)

| Message | What it means | What to do |
|---|---|---|
| "*'name' is pending and will be resent automatically*" | The mailbox was not reachable right then. The change is saved and will be retried. | Nothing. Check your connection if it persists. It shows at most once every 10 minutes. |
| "*Successfully synced N note(s) from secure mailbox*" | Changes made on another device have just arrived. | Nothing. |
| "*OmniSync connected with 'name'!*" | A device has connected to you. | Nothing. |
| "*'name' updated via quick patch*" | A partial change was applied (only the part that had changed). | Nothing. |
| "*Changes to 'name' on both devices were merged automatically*" | You both edited the same thing offline and OmniSync sorted it out by itself. | Nothing. Check the result if it matters to you. |
| "*File 'name' received from Blossom*" | A large file has arrived. | Nothing. |
| "*Attachment uploaded to Blossom: 'path' (X MB)*" | A large file was sent to storage. | Nothing. |
| "*Long note uploaded to Blossom: 'path' (X MB)*" | A very long note was sent to storage. | Nothing. |

### 10.2 Messages that need an action

| Message | What it means | What to do |
|---|---|---|
| "*'name' is over 64 KB. To sync it without P2P, enable Blossom storage…*" | A big note can only travel directly right now. | Turn on Blossom ([section 3.3](#33-large-files-blossom)) so it reaches your devices even if the other is off. |
| "*Your Cloudflare Worker has no mailbox enabled…*" | Your server is an older version without a mailbox. | Redeploy it with the wizard's current command ([section 3.2](#32-where-your-mailbox-lives)). |
| "*The change in 'path' exceeds the mailbox limit; it will be synced directly via P2P*" | That change does not fit in the mailbox and will only travel if both machines are connected. | Raise the Blossom limit or accept the limit. |
| "*The vault is locked by MySecret. Unlock it to sync*" | You use MySecret and the vault is closed. | Unlock MySecret. OmniSync resumes by itself. |
| "*The remote device has MySecret locked*" | The other machine has MySecret closed. | Unlock MySecret on that device. |
| "*No other devices are connected right now*" | You are on your own. | Pair another device ([section 5](#5-first-steps-pairing-your-devices)). |
| "*Edit conflict in 'name'. A backup copy was saved: 'copy'*" | Both devices edited the same thing and OmniSync could not merge them by itself. | Open both versions, keep the one you want and delete the other. See [12.7](#127-i-see-a-note-with-a-conflict). |

### 10.3 Informational messages

| Message | What it means |
|---|---|
| "*The base version of 'name' does not match. It will be synced via P2P*" | OmniSync found that the note changed in a way that prevents a partial patch. It will send the whole thing over the direct connection. |
| "*Could not apply the patch to 'name'. Direct P2P sync scheduled*" | The quick patch failed. A full send is scheduled instead. |
| "*Integrity check failed on 'name'*" | The content did not match on arrival. It is discarded and resent through another route. |
| "*New master key generated. Re-pair all your devices*" | Confirmation that the key rotation went through. |
| "*MySecret unlocked. Syncing notes…*" | MySecret was opened and OmniSync resumes the pending work. |

## 11. FAQ

### 11.1 About price and accounts

| Question | Answer |
|---|---|
| Is it free? | Yes, for personal, non-commercial use. See [section 13](#13-license). |
| Do I need an account? | No. Not for OmniSync, not for email, not for anything. |
| Do I need Dropbox, Drive or Git? | No. OmniSync does not use cloud folders: it connects your devices directly and uses a mailbox when needed. |
| Do I have to set up Cloudflare? | No. The public Nostr network works out of the box. Cloudflare is optional, for more privacy and control. |
| Can I use it at my company? | Not without the author's permission: the license is non-commercial only. |

### 11.2 About how it works

| Question | Answer |
|---|---|
| Does it work on mobile? | Yes, in Obsidian for Android and iOS. |
| Do both devices need to be on at once? | Only to pair. Afterwards, if one is off, changes wait in the mailbox (and big files in Blossom). In *Pure P2P* mode both must be on. |
| How long does a change take to arrive? | Less than a second if the other machine is on and connected. Up to a minute if it is in the mailbox. |
| What if I lose internet halfway through typing? | Nothing bad happens: the change goes to the waiting list and is retried by itself when the connection returns (after 2, 5, 15 seconds, then every minute). |
| Can the servers read my notes? | No. Content and names are encrypted. A server can see timing and rough sizes. See [section 8](#8-privacy-what-is-visible-and-what-is-not). |
| What if both devices have no signal? | The changes pile up in each mailbox. When either gets signal back, it picks up what is pending. |
| Can several devices sync at once? | Yes. The status bar shows the number connected: `OmniSync (3)` means three machines are talking. |

### 11.3 About mobile and battery

| Question | Answer |
|---|---|
| My phone does not update in the background. | Normal: phones pause background connections. It catches up when you open the app, when the connection returns, and every minute while the app is open. |
| Does it use a lot of battery? | With the app open, the connection stays alive. In the background, the system puts it to sleep (and that is the system, not OmniSync, deciding). |
| Can I leave it connected all the time? | On a computer, yes. On a phone it is not needed: it catches up as soon as you open the app. |

### 11.4 About recovery and security

| Question | Answer |
|---|---|
| What if I lose a device? | Regenerate the master key ([section 9.3](#93-you-lost-a-device-or-you-see-an-unknown-one)). |
| What if I delete a note by accident? | It is not really deleted: it goes to the Obsidian trash on the other devices ([section 9](#9-managing-your-devices)). |
| What if a file is deleted from the vault? | It goes to the trash. You can recover it from *Settings → Files & Links → Deleted files*. |
| Can I use it offline, with no internet? | Yes, but only within that one machine: without internet there is no connection to other devices and no mailbox. |
| Is OmniSync a backup? | No. See [section 2.3.1](#omnisync-is-not-a-backup). |

---

## 12. Common problems

Every problem has a number. Use `Ctrl+F` to find yours.

### 12.1 Notes do not arrive

This is the most frequent problem, and it is **almost never an OmniSync bug**. Check in this order:

| # | Check | How |
|---|---|---|
| 1 | **The other machine is on and connected** | On the other machine, the status bar must say `OmniSync (N)`, not `(Disconnected)`. |
| 2 | **The mode is "Dual path"** | In *Settings → OmniSync → Sync mode*. If it is on *Pure P2P*, the other machine **must** be switched on. |
| 3 | **Both machines have internet** | Open a browser on both. |
| 4 | **The mailbox is enabled** | Go to point 12.2. |
| 5 | **No network is blocking the connection** | Corporate networks, universities and some home wifis with "client isolation" stop two machines from talking to each other directly. The mailbox saves the day: that is why point 2 matters so much. |

If it still does not work, try forcing a sync: `Ctrl+P` → *OmniSync: Force full vault sync now*.

### 12.2 It worked with the public network, but not with my Cloudflare

Almost always it is because **your server is an older version without a mailbox**.

1. Open your Worker address in a browser (the `https://…workers.dev` one).
2. You should see the mailbox listed as `ready`.
3. If it says `missing_do_binding`, your server is old: **redeploy it** with the wizard's current command ([section 3.2](#32-where-your-mailbox-lives)).
4. Also check that the Worker has your **public key** in `ALLOWED_PUBKEYS`. The wizard gives you the exact command to update it.

### 12.3 Images or large files do not show up on my phone

| Cause | Solution |
|---|---|
| Blossom is off | Turn it on in *Settings → OmniSync → Large Files & Multimedia Storage*. |
| The other machine has no Blossom server | The settings are **per device**. Add it on the phone too. |
| The file is over the limit | Raise *Maximum file size* or use a higher profile. |
| The file is too big and the upload failed | Uploads have a 45-second limit. Leave the big ones for when you are on Wi-Fi. |

### 12.4 The plugin does not appear in the bar

| Check | Solution |
|---|---|
| Did you enable it in *Settings → Community plugins*? | Switch it on. |
| Are files missing from the folder? | All **three** must be there: `main.js`, `manifest.json` and `styles.css`. |
| Is your Obsidian too old? | You need **1.11.4 or newer**. |
| Is there an error? | Open the developer console (`Ctrl+Shift+I`) and look at what it says. |

### 12.5 I cannot see the room code

The "Anonymous Connection Room ID" is derived from your master key. If it does not show up:

- Check that the plugin is installed properly (point 12.4).
- Restart Obsidian: it is generated on load.

### 12.6 I cannot open the pairing assistant

- If the plugin is active, the assistant should open from the sidebar icon, from the status bar, or with `Ctrl+P`.
- If it does not open, look at the developer console (point 12.4) for the exact error.

### 12.7 I see a note with a conflict

A note whose name ends in `.conflict-YYYY-MM-DD-HHMM.md` (for example `note.conflict-2026-10-27-1530.md`).

**What happened:** both devices edited the same note without being able to talk to each other, and OmniSync could not merge them without guessing.

**What to do:**
1. Open **both** versions and compare them.
2. Copy what you want from each into a new note.
3. Delete the one you do not want to keep (and the other too, to leave the vault tidy).

> This is rare. If it happens often, it means two devices have been out of touch for a long time. Turn on **Dual path** mode so the mailbox reduces these situations.

### 12.8 Other cases

| Symptom | Likely cause |
|---|---|
| **"Code expired" or "already used"** | That is normal. Go back to the original device, where a fresh QR will be showing, and scan that one. |
| **The QR does not open Obsidian** | Check OmniSync is installed and enabled on the new device. Otherwise use *Copy Secret Pairing Key*. |
| **The new device does not appear in the list** | Press the ⟳ button. Make sure both have internet. |
| **"A pairing is already in progress"** | Wait for the previous one to finish, or restart Obsidian. |
| **The phone does not update in the background** | Normal: operating systems pause background connections. It catches up when you open the app. |
| **My router blocks the connection** | Try your own mobile data (4G/5G) instead of wifi. If it works, your wifi blocks device-to-device connections. |

---

## 13. License

OmniSync is **public code, free for personal and non-commercial use**, under the [PolyForm Noncommercial License 1.0.0](../LICENSE). You may use, read, modify and share it for non-profit purposes, including in non-profit, educational and public organizations. Commercial use requires an agreement with the author ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

## Related documents

| Document | What it is for |
|---|---|
| [User Guide in Spanish](Guía%20de%20Usuario.md) | The same guide, in Spanish. |
| [Developer Guide](Developer_Guide_EN.md) | How the plugin works inside. You do not need it to use it. |
| [Tests and audits](TESTS_AND_AUDITS_EN.md) | What was checked and how. For the sceptics. |
| [Sync protocol (whitepaper)](https://github.com/abismalmx/OmniSync/blob/main/PROTOCOL_WHITEPAPER.md) | The technical detail of the sync protocol. |
| [Changelog](https://github.com/abismalmx/OmniSync/blob/main/CHANGELOG.md) | What is new in each version. |

---

Questions or ideas? Open an issue in the [repository](https://github.com/abismalmx/OmniSync). To report a security problem, see the [security policy](https://github.com/abismalmx/OmniSync/blob/main/Github/SECURITY.md).
