/**
 * OmniSync - Comprobaciones de acceso contra un Worker real SIN conocer su secreto (herramienta manual).
 * Todo lo que no sea la clave autorizada debe rechazarse. Uso: WORKER=wss://host/ node …
 */
import { CryptoManager } from '../src/crypto/crypto-manager';
import { buildAuthenticatedSignalingUrl } from '../src/security/worker-auth';

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failures++; };

function wsStatus(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ya cerrado */ } resolve('timeout'); }, 8000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('ABIERTO'); };
    ws.onerror = () => { clearTimeout(timer); resolve('rechazado'); };
  });
}

async function main() {
  const worker = process.env.WORKER!;
  const origin = `https://${new URL(worker).host}`;
  const cm = new CryptoManager();
  const room = await cm.deriveMailboxRoomId(cm.generatePairingSecret());
  const intruder = crypto.getRandomValues(new Uint8Array(32));

  const health = (await (await fetch(origin + '/')).json()) as any;
  for (const k of ['blossom', 'signaling', 'mailbox', 'auth']) {
    check(health?.services?.[k]?.status === 'ready', `${k}: ${health?.services?.[k]?.status}`);
  }
  check((await wsStatus(`${worker}?mailbox=${room}`)) === 'rechazado', 'buzón sin autorización: rechazado');
  check((await wsStatus(buildAuthenticatedSignalingUrl(worker, room, intruder, Date.now(), 'mailbox'))) === 'rechazado', 'buzón con una clave NO autorizada: rechazado');
  check((await wsStatus(buildAuthenticatedSignalingUrl(worker, room, intruder, Date.now(), 'room'))) === 'rechazado', 'señalización con una clave NO autorizada: rechazada');
  const up = await fetch(`${origin}/upload`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
  check(up.status === 401 || up.status === 403, `subida sin autorización: HTTP ${up.status}`);
  const missing = await fetch(`${origin}/${'0'.repeat(64)}`);
  check(missing.status === 404, `blob inexistente: HTTP ${missing.status}`);
  console.log(failures === 0 ? '\nACCESO OK' : `\nACCESO CON ${failures} FALLO(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
