/**
 * OmniSync - Fuzzer dirigido contra un Worker todo-en-uno REAL (herramienta manual, estilo DAST).
 *
 * Complementa a los escáneres genéricos (nuclei, ZAP, testssl): prueba lo que ellos no entienden,
 * es decir, la autorización NIP-98 y el protocolo del buzón por WebSocket, con entradas hostiles.
 * Cada caso declara qué respuesta es CORRECTA; además, ninguna entrada puede provocar un error 5xx.
 *
 * Debe ejecutarse contra un Worker DESECHABLE (envía ráfagas y eventos inválidos). Se recomienda
 * correrlo dentro de un contenedor (podman) con límites de recursos.
 *
 *   MODE=pubkey [SECRET=…] node …      # imprime SECRET y PUBKEY para el ALLOWED_PUBKEYS del Worker
 *   SECRET=… WORKER=wss://host/ node … # ejecuta los casos
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { CryptoManager } from '../src/crypto/crypto-manager';
import { buildAuthenticatedSignalingUrl, deriveWorkerAuthKey, workerAuthPublicKey } from '../src/security/worker-auth';

let failures = 0;
let serverErrors = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!ok) failures++;
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function sha256(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource)));
}

interface Nip98Opts {
  url: string; method: string; key: Uint8Array; payload?: string; kind?: number; content?: string;
  createdAtOffset?: number; extraTags?: string[][]; dropTags?: string[]; expiration?: number | null;
}
function nip98(o: Nip98Opts): string {
  const now = Math.floor(Date.now() / 1000);
  let tags: string[][] = [['u', o.url], ['method', o.method]];
  if (o.expiration !== null) tags.push(['expiration', String(o.expiration ?? now + 60)]);
  if (o.payload) tags.push(['payload', o.payload]);
  tags.push(['nonce', hex(crypto.getRandomValues(new Uint8Array(8)))]);
  tags = tags.filter((t) => !(o.dropTags ?? []).includes(t[0])).concat(o.extraTags ?? []);
  const ev = finalizeEvent({ kind: o.kind ?? 27235, created_at: now + (o.createdAtOffset ?? 0), tags, content: o.content ?? '' }, o.key);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

interface Sess { send: (f: unknown) => void; raw: (s: string) => void; next: (pred: (m: any) => boolean, ms?: number) => Promise<any | null>; closed: () => number | null; close: () => void; }
function openWs(url: string): Promise<Sess | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox: any[] = []; let closeCode: number | null = null; const waiters: Array<() => void> = [];
    ws.onmessage = (e) => { try { inbox.push(JSON.parse(String(e.data))); } catch { /* ignorar */ } waiters.splice(0).forEach((w) => w()); };
    ws.onclose = (e) => { closeCode = e.code; waiters.splice(0).forEach((w) => w()); };
    const timer = setTimeout(() => resolve(null), 8000);
    ws.onerror = () => { clearTimeout(timer); resolve(null); };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send: (f) => ws.send(JSON.stringify(f)),
        raw: (s) => ws.send(s),
        next: async (pred, ms = 4000) => {
          const end = Date.now() + ms;
          for (;;) {
            const i = inbox.findIndex(pred);
            if (i >= 0) return inbox.splice(i, 1)[0];
            if (closeCode !== null || Date.now() > end) return null;
            await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200); });
          }
        },
        closed: () => closeCode,
        close: () => { try { ws.close(); } catch { /* ya cerrado */ } },
      });
    };
  });
}

async function main() {
  const cm = new CryptoManager();
  const secret = process.env.SECRET || cm.generatePairingSecret();
  const authKey = await deriveWorkerAuthKey(cm, secret);
  if (process.env.MODE === 'pubkey') {
    console.log(`SECRET=${secret}`);
    console.log(`PUBKEY=${workerAuthPublicKey(authKey)}`);
    return;
  }
  const worker = process.env.WORKER!;
  const host = new URL(worker).host;
  const origin = `https://${host}`;
  const intruder = generateSecretKey();
  const room = await cm.deriveMailboxRoomId(secret);
  console.log(`Fuzz contra ${origin}\n`);

  const status = (r: Response) => { if (r.status >= 500) serverErrors++; return r.status; };

  // ---------- HTTP: /upload ----------
  console.log('HTTP /upload (NIP-98):');
  const body = new Uint8Array(1024).map((_, i) => (i * 13) % 251);
  const hash = await sha256(body);
  const up = `${origin}/upload`;
  const put = async (auth: string | null, b: Uint8Array = body, extra: Record<string, string> = {}) =>
    status(await fetch(up, { method: 'PUT', body: b as unknown as BodyInit, headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/octet-stream', ...extra } }));
  const good = () => nip98({ url: up, method: 'PUT', key: authKey, payload: hash });

  check((await put(good())) === 200, 'subida válida (control) → 200');
  const replay = good();
  const r1 = await put(replay); const r2 = await put(replay);
  check(r1 === 200 && (r2 === 401 || r2 === 200), `repetir el mismo evento: 1.ª ${r1}, 2.ª ${r2} (401 = anti-repetición activo; 200 = otro aislado, aceptable porque el blob es idempotente)`);
  check((await put(null)) === 401, 'sin cabecera Authorization → 401');
  check((await put('Bearer abc')) === 401, 'esquema distinto de Nostr → 401');
  check((await put('Nostr !!!no-base64!!!')) === 401, 'token no base64 → 401');
  check((await put('Nostr ' + Buffer.from('{"kind":27235}').toString('base64'))) === 401, 'evento incompleto → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: intruder, payload: hash }))) === 403, 'clave NO autorizada → 403');
  check((await put(nip98({ url: `${origin}/otra-ruta`, method: 'PUT', key: authKey, payload: hash }))) === 401, 'URL firmada distinta → 401');
  check((await put(nip98({ url: up, method: 'POST', key: authKey, payload: hash }))) === 401, 'método firmado distinto → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, createdAtOffset: -400 }))) === 401, 'evento caducado (−400 s) → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, createdAtOffset: 400 }))) === 401, 'evento del futuro (+400 s) → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, expiration: Math.floor(Date.now() / 1000) - 10 }))) === 401, 'expiration ya vencida → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey }))) === 401, 'sin etiqueta payload → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: 'zz' }))) === 401, 'payload mal formado → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, kind: 1 }))) === 401, 'kind distinto de 27235 → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, content: 'x' }))) === 401, 'contenido no vacío → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, extraTags: [['u', up]] }))) === 401, 'etiqueta u duplicada → 401');
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash, extraTags: Array.from({ length: 20 }, (_, i) => ['x', String(i)]) }))) === 401, 'más de 16 etiquetas → 401');
  // Con un hash NUEVO (un blob que ya existe responde 200 sin leer el cuerpo: es idempotente y no guarda nada).
  const fresh = new Uint8Array(2048).map(() => Math.floor(Math.random() * 256));
  const freshHash = await sha256(fresh);
  const lie = new Uint8Array(2048).fill(9);
  const mism = await put(nip98({ url: up, method: 'PUT', key: authKey, payload: freshHash }), lie);
  check(mism === 400 || mism === 401, `cuerpo distinto del hash firmado (hash nuevo) → ${mism} (rechazado)`);
  const stored = status(await fetch(`${origin}/${freshHash}`));
  check(stored === 404, `el cuerpo falso no quedó guardado bajo el hash firmado → GET ${stored}`);
  const lieHash = await sha256(lie);
  check(status(await fetch(`${origin}/${lieHash}`)) === 404, 'tampoco quedó guardado bajo su propio hash');
  const existing = await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash }), lie);
  check(existing === 200 && status(await fetch(`${origin}/${lieHash}`)) === 404, `blob ya existente con cuerpo distinto → ${existing} idempotente, sin guardar el cuerpo nuevo`);
  check((await put(nip98({ url: up, method: 'PUT', key: authKey, payload: hash }), body, { 'X-Sha-256': 'a'.repeat(64) })) === 400, 'X-Sha-256 distinto del firmado → 400');

  // ---------- HTTP: rutas y métodos ----------
  console.log('\nHTTP rutas y métodos:');
  for (const p of ['/' + '0'.repeat(64), '/' + '0'.repeat(64) + '.png', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/' + 'g'.repeat(64), '/' + '0'.repeat(63), '/upload/../upload', '/' + 'a'.repeat(5000)]) {
    const s = status(await fetch(origin + p));
    check(s === 404 || s === 400, `GET ${p.slice(0, 40)}${p.length > 40 ? '…' : ''} → ${s}`);
  }
  for (const m of ['DELETE', 'PATCH', 'TRACE', 'POST']) {
    try { const s = status(await fetch(up, { method: m === 'TRACE' ? 'GET' : m, body: m === 'POST' || m === 'PATCH' ? 'x' : undefined })); check(s < 500, `${m} /upload → ${s} (sin error de servidor)`); }
    catch { check(true, `${m} /upload: rechazado por el cliente`); }
  }
  const opt = await fetch(up, { method: 'OPTIONS' });
  check(opt.status === 204, `OPTIONS → ${status(opt)}`);

  // ---------- WebSocket: buzón ----------
  console.log('\nWebSocket del buzón:');
  const wsUrl = () => buildAuthenticatedSignalingUrl(worker, room, authKey, Date.now(), 'mailbox');
  const bare = await openWs(`${worker}?mailbox=${room}`);
  check(bare === null, 'sin autorización: la conexión se rechaza');
  const bad = await openWs(buildAuthenticatedSignalingUrl(worker, room, intruder, Date.now(), 'mailbox'));
  check(bad === null, 'clave no autorizada: la conexión se rechaza');
  const badRoom = await openWs(`${worker}?mailbox=${'zz' + room.slice(2)}`);
  check(badRoom === null, 'id de sala inválido: la conexión se rechaza');

  const s = await openWs(wsUrl());
  if (!s) { check(false, 'no se pudo abrir la sesión autenticada'); return finish(); }
  const sub = 'f'.repeat(16);
  s.send(['REQ', sub, { kinds: [30078], '#t': [room] }]);
  check((await s.next((m) => m[0] === 'EOSE' && m[1] === sub)) !== null, 'control: REQ válido → EOSE');

  s.raw('esto no es json'); s.raw('[1,2,3]'); s.raw('{"a":1}'); s.raw('["EVENT"]'); s.raw('["EVENT",null]'); s.raw('["REQ"]'); s.raw('["REQ",5,{}]');
  s.send(['REQ', 'ok2', { kinds: [30078], '#t': [room] }]);
  check((await s.next((m) => m[0] === 'EOSE' && m[1] === 'ok2')) !== null && s.closed() === null, 'tramas basura se ignoran y la sesión sigue viva');

  const now = Math.floor(Date.now() / 1000);
  const mk = (over: { created_at?: number; tags?: string[][]; content?: string; kind?: number }, sk = generateSecretKey()) =>
    finalizeEvent({ kind: over.kind ?? 30078, created_at: over.created_at ?? now, tags: over.tags ?? [['d', 'a'.repeat(64)], ['t', room], ['expiration', String(now + 3600)]], content: over.content ?? '{"v":1,"iv":"x","ct":"y"}' }, sk);
  const expectInvalid = async (name: string, ev: any, frag: string) => {
    s.send(['EVENT', ev]);
    const ok = await s.next((m) => m[0] === 'OK' && m[1] === ev.id);
    check(!!ok && ok[2] === false && String(ok[3]).includes(frag), `${name} → rechazado (${ok ? ok[3] : 'sin respuesta'})`);
  };
  await expectInvalid('kind distinto de 30078', mk({ kind: 1 }), 'kind');
  await expectInvalid('sala incorrecta', mk({ tags: [['d', 'a'.repeat(64)], ['t', 'b'.repeat(64)], ['expiration', String(now + 3600)]] }), 'sala');
  await expectInvalid('sin etiqueta t', mk({ tags: [['d', 'a'.repeat(64)], ['expiration', String(now + 3600)]] }), 'sala');
  await expectInvalid('sin expiration', mk({ tags: [['d', 'a'.repeat(64)], ['t', room]] }), 'expiration');
  await expectInvalid('expiration > 7 días', mk({ tags: [['d', 'a'.repeat(64)], ['t', room], ['expiration', String(now + 30 * 86400)]] }), 'expiration');
  await expectInvalid('sin etiqueta d', mk({ tags: [['t', room], ['expiration', String(now + 3600)]] }), 'etiqueta d');
  await expectInvalid('creado hace 9 días', mk({ created_at: now - 9 * 86400 }), 'created_at');
  await expectInvalid('creado en el futuro', mk({ created_at: now + 600 }), 'created_at');
  await expectInvalid('más de 16 etiquetas', mk({ tags: [['d', 'a'.repeat(64)], ['t', room], ['expiration', String(now + 3600)], ...Array.from({ length: 20 }, (_, i) => ['x', String(i)])] }), 'etiquetas');
  await expectInvalid('etiqueta con valor gigante', mk({ tags: [['d', 'a'.repeat(5000)], ['t', room], ['expiration', String(now + 3600)]] }), 'etiqueta');
  const forged = mk({}); (forged as any).sig = '0'.repeat(128);
  await expectInvalid('firma falsificada', forged, 'firma');
  const tampered = mk({}); (tampered as any).content = '{"v":1,"iv":"x","ct":"CAMBIADO"}';
  await expectInvalid('contenido alterado tras firmar', tampered, 'firma');

  s.send(['REQ', 'neg', { since: -5 }]);
  check(!!(await s.next((m) => m[0] === 'CLOSED' && m[1] === 'neg')), 'REQ con since negativo → CLOSED');
  s.send(['REQ', 'big', { '#t': Array.from({ length: 9 }, (_, i) => String(i)) }]);
  check(!!(await s.next((m) => m[0] === 'CLOSED' && m[1] === 'big')), 'REQ con 9 valores en #t → CLOSED');
  s.send(['REQ', 'kk', { kinds: [1, 2, 3, 4, 5] }]);
  check(!!(await s.next((m) => m[0] === 'CLOSED' && m[1] === 'kk')), 'REQ con 5 kinds → CLOSED');
  for (let i = 0; i < 6; i++) s.send(['REQ', `s${i}`, { kinds: [30078], '#t': [room] }]);
  const limited = await s.next((m) => m[0] === 'CLOSED' && String(m[2]).startsWith('rate-limited'));
  check(!!limited, 'más de 4 suscripciones por socket → CLOSED (rate-limited)');

  // Tramas gigantes y ráfaga: la sesión debe cerrarse con el código correcto, sin error de servidor.
  const huge = await openWs(wsUrl());
  huge?.raw('x'.repeat(300 * 1024));
  for (let i = 0; i < 20 && huge && huge.closed() === null; i++) await sleep(250);
  check(!!huge && huge.closed() === 1009, `trama de 300 KB → cierre ${huge?.closed()} (esperado 1009)`);
  const flood = await openWs(wsUrl());
  if (flood) { for (let i = 0; i < 400; i++) flood.raw('["CLOSE","x"]'); for (let i = 0; i < 20 && flood.closed() === null; i++) await sleep(250); }
  check(!!flood && flood.closed() === 1008, `ráfaga de 400 tramas → cierre ${flood?.closed()} (esperado 1008)`);
  s.close();

  // Tras todo el abuso, el servicio legítimo sigue respondiendo.
  const after = await openWs(wsUrl());
  after?.send(['REQ', 'tras', { kinds: [30078], '#t': [room] }]);
  check(!!after && !!(await after.next((m) => m[0] === 'EOSE' && m[1] === 'tras')), 'tras el abuso, el buzón sigue atendiendo a la clave legítima');
  after?.close();
  const health = (await (await fetch(origin + '/')).json()) as any;
  check(health?.services?.mailbox?.status === 'ready', 'el estado público sigue en ready');
  finish();
}

function finish() {
  check(serverErrors === 0, `ninguna entrada hostil provocó un error 5xx (${serverErrors} detectados)`);
  console.log(failures === 0 ? '\nFUZZ OK' : `\nFUZZ CON ${failures} FALLO(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
