/**
 * OmniSync - Prueba en vivo de CADUCIDAD del buzón de un Worker real (herramienta manual).
 *
 * Publica eventos con `expiration` cortas (10 s y 60 s, más una de control a 7 días) y consulta el
 * buzón en varios instantes para comprobar que el Worker los elimina cuando caducan. También sube un
 * blob de Blossom y comprueba si sigue disponible al final (los blobs de R2 no llevan caducidad).
 * Usar solo contra un Worker DESECHABLE.
 *
 *   MODE=pubkey [SECRET=…] node …
 *   SECRET=… WORKER=wss://host/ node …
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { CryptoManager } from '../src/crypto/crypto-manager';
import { buildAuthenticatedSignalingUrl, deriveWorkerAuthKey, workerAuthPublicKey } from '../src/security/worker-auth';
import { BlossomClient } from '../src/network/blossom-client';

let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(ok: boolean, msg: string) { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function main() {
  const cm = new CryptoManager();
  const secret = process.env.SECRET || cm.generatePairingSecret();
  const authKey = await deriveWorkerAuthKey(cm, secret);
  if (process.env.MODE === 'pubkey') { console.log(`SECRET=${secret}`); console.log(`PUBKEY=${workerAuthPublicKey(authKey)}`); return; }

  const worker = process.env.WORKER!;
  const host = new URL(worker).host;
  const origin = `https://${host}`;
  const room = await cm.deriveMailboxRoomId(secret);

  const ws = new WebSocket(buildAuthenticatedSignalingUrl(worker, room, authKey, Date.now(), 'mailbox'));
  const inbox: any[] = [];
  ws.onmessage = (e) => { try { inbox.push(JSON.parse(String(e.data))); } catch { /* ignorar */ } };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('no se pudo abrir el buzón')); });
  const wait = async (pred: (m: any) => boolean, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() > end) return null; await sleep(100); }
  };

  const now = () => Math.floor(Date.now() / 1000);
  const mk = (label: string, ttl: number) => finalizeEvent({
    kind: 30078, created_at: now(),
    tags: [['d', hex(crypto.getRandomValues(new Uint8Array(32)))], ['t', room], ['expiration', String(now() + ttl)]],
    content: JSON.stringify({ v: 1, iv: 'x', ct: label }),
  }, generateSecretKey());

  const A = mk('ttl-10s', 10), B = mk('ttl-60s', 60), C = mk('ttl-7d', 7 * 86400);
  console.log('Publicando eventos con caducidad de 10 s, 60 s y 7 días…');
  for (const ev of [A, B, C]) {
    ws.send(JSON.stringify(['EVENT', ev]));
    const ok = await wait((m) => m[0] === 'OK' && m[1] === ev.id);
    check(!!ok && ok[2] === true, `evento ${JSON.parse(ev.content).ct} aceptado`);
  }
  // Una caducidad ya vencida debe rechazarse de entrada.
  const past = finalizeEvent({ kind: 30078, created_at: now(), tags: [['d', 'e'.repeat(64)], ['t', room], ['expiration', String(now() - 5)]], content: '{}' }, generateSecretKey());
  ws.send(JSON.stringify(['EVENT', past]));
  const rej = await wait((m) => m[0] === 'OK' && m[1] === past.id);
  check(!!rej && rej[2] === false, `caducidad ya vencida → rechazada (${rej?.[3]})`);

  // Blob de Blossom (R2) para comprobar si caduca.
  const blob = new Uint8Array(2048).map((_, i) => (i * 7) % 251);
  const bsha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', blob)));
  await BlossomClient.uploadBlob(blob, bsha, [origin], generateSecretKey(), 30000, { privateKey: authKey, privateHosts: [host] });
  const t0 = Date.now();

  let n = 0;
  const present = async (): Promise<string[]> => {
    const sub = `q${n++}`;
    ws.send(JSON.stringify(['REQ', sub, { kinds: [30078], '#t': [room] }]));
    const seen: string[] = [];
    for (;;) {
      const m = await wait((x) => (x[0] === 'EVENT' || x[0] === 'EOSE') && x[1] === sub, 6000);
      if (!m || m[0] === 'EOSE') break;
      seen.push(JSON.parse(m[2].content).ct);
    }
    ws.send(JSON.stringify(['CLOSE', sub]));
    return seen.sort();
  };
  const at = async (seconds: number) => { const left = seconds * 1000 - (Date.now() - t0); if (left > 0) await sleep(left); return present(); };

  const s3 = await at(3);
  check(s3.includes('ttl-10s') && s3.includes('ttl-60s') && s3.includes('ttl-7d'), `a los ~3 s siguen los tres: ${s3.join(', ')}`);
  const s14 = await at(14);
  check(!s14.includes('ttl-10s') && s14.includes('ttl-60s') && s14.includes('ttl-7d'), `a los ~14 s desaparece el de 10 s: quedan ${s14.join(', ')}`);
  const s40 = await at(40);
  check(s40.includes('ttl-60s'), `a los ~40 s el de 60 s sigue: ${s40.join(', ')}`);
  const s65 = await at(65);
  check(!s65.includes('ttl-60s') && s65.includes('ttl-7d'), `a los ~65 s desaparece el de 60 s: queda ${s65.join(', ')}`);

  const blobNow = await fetch(`${origin}/${bsha}`);
  check(blobNow.status === 200, `el blob de Blossom (R2) a los ~65 s sigue disponible: HTTP ${blobNow.status} (los blobs no llevan caducidad)`);
  ws.close();
  console.log(failures === 0 ? '\nCADUCIDAD OK' : `\nCADUCIDAD CON ${failures} FALLO(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
