/**
 * OmniSync - Regresiones de auditor_security (alias 8.3, TTL del ReplayGuard)
 */
import { validateVaultPath, DEFAULT_VAULT_PATH_POLICY } from '../src/security/vault-security';
import {
  ReplayGuard,
  MAX_PROTOCOL_MESSAGE_AGE_MS,
  MAX_PROTOCOL_CLOCK_SKEW_MS,
} from '../src/security/protocol-security';

import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { DiffMergeEngine } from '../src/sync/diff-merge';
import { DeltaPatchEngine } from '../src/sync/delta-patch';
import { NostrMailbox, MAILBOX_KIND, MAILBOX_EXPIRATION_SECONDS } from '../src/network/nostr-mailbox';
import { CryptoManager, MAILBOX_KEY_CONTEXT } from '../src/crypto/crypto-manager';
import { SignalingClient } from '../src/network/signaling-client';
import { readFileSync } from 'node:fs';
import { es } from '../src/i18n/locales/es';
import { en } from '../src/i18n/locales/en';
import { zh } from '../src/i18n/locales/zh';
import { ru } from '../src/i18n/locales/ru';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function rejects(path: string, policy = { ...DEFAULT_VAULT_PATH_POLICY, syncAttachments: true, syncObsidianConfig: true }): boolean {
  try {
    validateVaultPath(path, policy);
    return false;
  } catch {
    return true;
  }
}

// SEC-01: alias 8.3 de directorios protegidos en la raíz
for (const p of ['OBSIDI~1/plugins/x/main.js', 'GIT~1/config', 'TRASH~1/x.md', 'obsidi~1/plugins/x/main.js']) {
  assert(rejects(p), `alias 8.3 debe rechazarse: ${p}`);
}
assert(!rejects('Notas/diario.md'), 'ruta normal sigue permitida');
assert(!rejects('Notas/archivo~1.md'), 'un ~ en un subdirectorio/archivo normal sigue permitido');

// SEC-03: un mensaje con timestamp +5 min sigue siendo válido hasta +15 min; el guard debe recordarlo
const guard = new ReplayGuard();
const t0 = 1_000_000_000_000;
assert(guard.accept('m1', t0), 'primer uso aceptado');
const justBeforeValidityEnd = t0 + MAX_PROTOCOL_MESSAGE_AGE_MS + MAX_PROTOCOL_CLOCK_SKEW_MS - 1_000;
assert(!guard.accept('m1', justBeforeValidityEnd), 'replay dentro de la ventana de validez efectiva debe rechazarse');

// SEC-04 / SEC-11: señalización Nostr
type Internals = {
  isNostr: boolean;
  replayGuard: ReplayGuard;
  handleNostrEvent(e: unknown): Promise<void>;
};
const cm = new CryptoManager();
const roomId = 'a'.repeat(64);
const nostrHost = (url: string) => (new SignalingClient(url, roomId, 'dev-local', cm) as unknown as Internals).isNostr;
assert(nostrHost('wss://relay.damus.io'), 'damus.io es Nostr');
assert(nostrHost('wss://nos.lol'), 'nos.lol es Nostr');
assert(!nostrHost('wss://damus.io.evil.com'), 'damus.io.evil.com no es Nostr');
assert(!nostrHost('wss://evil-nos.lol.example.com'), 'subcadena en otro dominio no es Nostr');

const client = new SignalingClient('wss://relay.damus.io', roomId, 'dev-local', cm) as unknown as Internals;
const garbage = finalizeEvent(
  { kind: 25000, created_at: Math.floor(Date.now() / 1000), tags: [['t', roomId]], content: '{"basura":1}' },
  generateSecretKey()
);
await client.handleNostrEvent(garbage);
assert(!client.replayGuard.isAccepted(garbage.id), 'un evento que no descifra no debe ocupar el ReplayGuard');

// SEC-08: la fusión de 3 vías agota su presupuesto y devuelve fallo (→ copia de conflicto)
const blocks = 400;
const mk = (tag: string) =>
  Array.from({ length: blocks }, (_b, i) => [...Array.from({ length: 47 }, (_c, j) => `${tag}${i}_${j}`), `C${i}`]).flat().join('\n');
const merged = DiffMergeEngine.threeWayMerge(mk('a'), mk('l'), mk('r'));
assert(!merged.success, 'una fusión adversarial debe agotar el presupuesto y fallar de forma segura');
const small = DiffMergeEngine.threeWayMerge('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne', 'a\nb\nc\nd\nE');
assert(small.success && !small.hasConflicts && small.mergedText === 'a\nB\nc\nd\nE', 'una fusión normal sigue funcionando');

// SEC-08: Myers con entradas enormes y distintas sigue produciendo un parche aplicable
const big = (tag: string) => Array.from({ length: 8_000 }, (_, i) => `${tag}${i}`).join('\n');
const baseBig = big('x');
const targetBig = big('y');
const patch = DeltaPatchEngine.computePatch(baseBig, targetBig);
const applied = DeltaPatchEngine.applyPatch(baseBig, patch);
assert(applied.success && applied.result === targetBig, 'el parche trivial de respaldo se aplica correctamente');

// SEC-10: un evento re-firmado con fecha nueva y contenido antiguo se rechaza
{
  const secret = cm.generatePairingSecret();
  const mbRoom = await cm.deriveMailboxRoomId(secret);
  const mbKey = await cm.deriveAesKey(secret, MAILBOX_KEY_CONTEXT);
  const mailbox = new NostrMailbox('wss://nos.lol', mbRoom, 'dev-local', secret, cm);
  mailbox.setCryptoKey(mbKey);
  const validate = (mailbox as unknown as { decryptAndValidateEventWithId(e: unknown): Promise<unknown> })
    .decryptAndValidateEventWithId.bind(mailbox);
  const path = 'vieja.md';
  const dTag = await cm.computeHmacHex(`${mbRoom}:${path}`, secret, 'mailbox-dtag-v2');
  const nowSec = Math.floor(Date.now() / 1000);
  const mkEvent = async (sentAt: number | undefined) =>
    finalizeEvent(
      {
        kind: MAILBOX_KIND,
        created_at: nowSec,
        tags: [['d', dTag], ['t', mbRoom], ['expiration', String(nowSec + MAILBOX_EXPIRATION_SECONDS)]],
        content: JSON.stringify(
          await cm.encrypt({ path, content: 'x', mtime: Date.now(), deviceId: 'dev-remoto', sentAt }, mbKey)
        ),
      },
      generateSecretKey()
    );
  assert((await validate(await mkEvent(nowSec))) !== null, 'evento con sentAt coherente se acepta');
  assert((await validate(await mkEvent(nowSec - 6 * 24 * 3600))) === null, 'evento re-firmado con sentAt antiguo se rechaza');
  assert((await validate(await mkEvent(undefined))) !== null, 'remitente anterior sin sentAt se acepta (compatibilidad)');
}

// SEC-13 / SEC-14: contratos del enlace obsidian:// y de la vinculación en main.ts
{
  const main = readFileSync('src/main.ts', 'utf8');
  const start = main.indexOf('public async pairNewDevice(');
  const body = main.slice(start, main.indexOf('public async unpairDevice('));
  assert(/if \(this\.pairingInFlight\)[\s\S]*return false;/.test(body), 'SEC-13: pairNewDevice rechaza una segunda vinculación simultánea');
  assert(/this\.pairingInFlight = true;/.test(body), 'SEC-13: la guarda se activa al empezar');
  assert(/finally \{\s*this\.pairingInFlight = false;/.test(body), 'SEC-13: la guarda se libera siempre (finally)');
  const link = main.slice(main.indexOf('private async handlePairingLink('), start);
  assert(/deepLinkConfirm', \{ server \}/.test(link), 'SEC-14: la confirmación del enlace muestra el servidor destino');
  for (const [name, dict] of Object.entries({ es, en, zh, ru })) {
    assert(dict.pairingModal.deepLinkConfirm.includes('{server}'), `SEC-14: deepLinkConfirm de ${name} incluye {server}`);
    assert(dict.pairingModal.pairingInProgress.length > 0, `SEC-13: pairingInProgress existe en ${name}`);
  }
}

console.log('PASS: regresiones auditor_security');
