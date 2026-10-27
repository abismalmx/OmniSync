/**
 * OmniSync - Pruebas del buzón asíncrono del Worker todo-en-uno (MailboxRoom)
 *
 * Valida de extremo a extremo, con el NostrMailbox real del plugin:
 * 1. Autenticación NIP-98 de la ruta `?mailbox=` (sala válida, un solo uso, clave autorizada).
 * 2. Un dispositivo deposita una nota con el otro desconectado y éste la recupera después.
 * 3. Difusión en vivo a un suscriptor conectado.
 * 4. Rechazo de eventos de otra sala, con firma falsa, sin caducidad o ajenos al kind.
 * 5. Reemplazo por (pubkey, d), duplicados, caducidad y cuota de la sala.
 */

import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import worker, { MailboxRoom } from '../scripts/cloudflare-allinone/worker.js';
import { CryptoManager } from '../src/crypto/crypto-manager';
import { MAILBOX_KIND, NostrMailbox } from '../src/network/nostr-mailbox';
import { buildAuthenticatedSignalingUrl, deriveWorkerAuthKey, workerAuthPublicKey } from '../src/security/worker-auth';

const HOST = 'allinone.test';
const WSS = `wss://${HOST}/`;

/** `ctx.storage.sql` de un Durable Object sobre SQLite en memoria. */
function createSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: any[]) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...bindings) as any[];
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
}

/** Par de WebSocket simulado: el "servidor" es el objeto que ve el Durable Object. */
class ServerSocket {
  public attachment: any = {};
  public closed: { code?: number } | null = null;
  constructor(public readonly client: ClientSocket) {}
  serializeAttachment(meta: any) { this.attachment = JSON.parse(JSON.stringify(meta)); }
  deserializeAttachment() { return JSON.parse(JSON.stringify(this.attachment)); }
  send(text: string) { queueMicrotask(() => this.client.deliver(text)); }
  close(code?: number) { this.closed = { code }; queueMicrotask(() => this.client.onclose?.({} as any)); }
}

class ClientSocket {
  static OPEN = 1; static CONNECTING = 0;
  public readyState = 0;
  public onopen: any; public onmessage: any; public onclose: any; public onerror: any;
  public server!: ServerSocket;
  public readonly url: string;
  constructor(url: string) { this.url = url; }
  deliver(data: string) { if (this.readyState === 1) this.onmessage?.({ data }); }
  send(data: string) {
    queueMicrotask(() => { void room.webSocketMessage(this.server, data); });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({} as any);
  }
}

const allSockets: ServerSocket[] = [];
const ctx = {
  storage: { sql: createSql() },
  getWebSockets: () => allSockets.filter((s) => !s.closed),
  acceptWebSocket: () => {},
};
const room = new MailboxRoom(ctx as any, {} as any);

/** WebSocket global: enruta por el Worker real y entrega el socket al Durable Object. */
let env: any;
let connectionUrls: string[] = [];
class RoutedWebSocket extends ClientSocket {
  constructor(url: string) {
    super(url);
    connectionUrls.push(url);
    const upgrade = new Request(url.replace('wss://', 'https://'), { headers: { Upgrade: 'websocket' } });
    void (async () => {
      const response = await worker.fetch(upgrade, env);
      if (response.status !== 200) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({} as any);
        return;
      }
      const server = new ServerSocket(this);
      const meta = await (response as any).__meta;
      server.serializeAttachment({ room: meta, subs: {} });
      this.server = server;
      allSockets.push(server);
      this.readyState = 1;
      this.onopen?.({});
    })();
  }
}
(globalThis as any).WebSocket = RoutedWebSocket;
(RoutedWebSocket as any).OPEN = 1;
(RoutedWebSocket as any).CONNECTING = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTests() {
  console.log('=== Iniciando Suite de Pruebas: Buzón asíncrono del Worker ===\n');

  const crypto1 = new CryptoManager();
  const secret = crypto1.generatePairingSecret();
  const authKey = await deriveWorkerAuthKey(crypto1, secret);
  const mailboxRoomId = await crypto1.deriveMailboxRoomId(secret);
  const mailboxKey = await crypto1.deriveAesKey(secret, 'OmniSync-Mailbox-v1');

  // El Worker real enruta al Durable Object; aquí el "stub" crea el socket que usa el DO.
  const namespaceNames: string[] = [];
  env = {
    ALLOWED_PUBKEYS: workerAuthPublicKey(authKey),
    SIGNALING_ROOM: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('x') }) },
    MAILBOX_ROOM: {
      idFromName(name: string) { namespaceNames.push(name); return name; },
      get() {
        return {
          fetch: async (req: Request) => {
            const roomParam = new URL(req.url).searchParams.get('room');
            const res = new Response('ok', { status: 200 });
            (res as any).__meta = Promise.resolve(roomParam);
            return res;
          },
        };
      },
    },
  };

  // ── 1. Autenticación de la ruta ?mailbox= ────────────────────────────────
  console.log('[Test 1] Ruta ?mailbox= exige NIP-98 válido, sala válida y token de un solo uso');
  const req = (u: string) => new Request(u.replace('wss://', 'https://'), { headers: { Upgrade: 'websocket' } });
  const good = buildAuthenticatedSignalingUrl(WSS, mailboxRoomId, authKey, Date.now(), 'mailbox');
  assert.strictEqual((await worker.fetch(req(good), env)).status, 200);
  assert.deepStrictEqual(namespaceNames, [`mailbox:${mailboxRoomId}`], 'El DO se nombra con el buzón autenticado');
  assert.strictEqual((await worker.fetch(req(good), env)).status, 401, 'Token reutilizado');
  assert.strictEqual((await worker.fetch(req(`${WSS}?mailbox=${mailboxRoomId}`), env)).status, 401, 'Sin token');
  assert.strictEqual((await worker.fetch(req(`${WSS}?mailbox=zz`), env)).status, 400, 'Buzón inválido');
  const asRoomToken = buildAuthenticatedSignalingUrl(WSS, mailboxRoomId, authKey, Date.now(), 'room');
  const swapped = asRoomToken.replace('room=', 'mailbox=');
  assert.strictEqual((await worker.fetch(req(swapped), env)).status, 401, 'Un token de señalización no sirve para el buzón');
  const stranger = buildAuthenticatedSignalingUrl(WSS, mailboxRoomId, generateSecretKey(), Date.now(), 'mailbox');
  assert.strictEqual((await worker.fetch(req(stranger), env)).status, 403, 'Clave no autorizada');
  const noBinding = { ...env, MAILBOX_ROOM: undefined };
  const g2 = buildAuthenticatedSignalingUrl(WSS, mailboxRoomId, authKey, Date.now(), 'mailbox');
  assert.strictEqual((await worker.fetch(req(g2), noBinding)).status, 500, 'Sin binding MAILBOX_ROOM: error claro');
  console.log('  ✓ Autenticación fail-closed y ligada a la ruta del buzón.');

  // ── 2. Entrega asíncrona con el receptor desconectado ───────────────────
  console.log('[Test 2] Nota depositada con el receptor apagado y recuperada después');
  const mkMailbox = (deviceId: string) => {
    const cm = new CryptoManager();
    const m = new NostrMailbox(WSS, mailboxRoomId, deviceId, secret, cm);
    m.setCryptoKey(mailboxKey);
    m.setPrivateWorkerAuth(authKey, [HOST]);
    return m;
  };
  const laptop = mkMailbox('dev-laptop-0001');
  const published = await laptop.publishNote('Diario/hoy.md', '# Hola desde el portátil', Date.now(), false);
  assert.ok(published.success, `publicación en el buzón del Worker: ${published.reason}`);
  assert.ok(connectionUrls.at(-1)!.includes('mailbox=') && connectionUrls.at(-1)!.includes('auth='), 'El cliente usa la ruta autenticada');

  const phone = mkMailbox('dev-phone-0002');
  const pending = await phone.fetchPendingNotes();
  assert.strictEqual(pending.length, 1, 'El móvil recupera la nota pendiente');
  assert.strictEqual(pending[0].note.path, 'Diario/hoy.md');
  assert.strictEqual(pending[0].note.content, '# Hola desde el portátil');
  assert.strictEqual(pending[0].note.deviceId, 'dev-laptop-0001');
  const ownView = await laptop.fetchPendingNotes();
  assert.strictEqual(ownView.length, 0, 'El emisor ignora sus propias notas');
  const stored = ctx.storage.sql.exec('SELECT raw FROM events').toArray();
  assert.ok(!stored[0].raw.includes('Hola desde el portátil') && !stored[0].raw.includes('Diario/hoy'), 'El Worker solo guarda texto cifrado y ruta ofuscada');
  console.log('  ✓ Store-and-forward funcionando; el contenido y la ruta no se guardan en claro.');

  // ── 3. Difusión en vivo ─────────────────────────────────────────────────
  console.log('[Test 3] Suscripción en vivo: el móvil conectado recibe la nota al instante');
  const received: string[] = [];
  phone.onNoteReceived = (note) => { received.push(note.path); };
  phone.startLiveSubscription();
  await sleep(150);
  const second = await laptop.publishNote('Diario/mañana.md', 'segunda', Date.now(), false);
  assert.ok(second.success);
  await sleep(200);
  assert.ok(received.includes('Diario/mañana.md'), 'La nota llega por la suscripción persistente');
  phone.destroy();
  console.log('  ✓ Difusión en vivo recibida.');

  // ── 4. Validación de eventos ────────────────────────────────────────────
  console.log('[Test 4] El buzón rechaza eventos de otra sala, sin firma válida o mal formados');
  const sock = new ServerSocket({ send() {}, deliver() {} } as any);
  const replies: any[] = [];
  (sock as any).send = (t: string) => replies.push(JSON.parse(t));
  sock.serializeAttachment({ room: mailboxRoomId, subs: {} });
  allSockets.push(sock);
  const now = Math.floor(Date.now() / 1000);
  const sk = generateSecretKey();
  const mk = (over: Record<string, any> = {}, tags?: string[][]) =>
    finalizeEvent(
      {
        kind: MAILBOX_KIND,
        created_at: now,
        tags: tags ?? [['d', 'a'.repeat(64)], ['t', mailboxRoomId], ['expiration', String(now + 3600)]],
        content: '{}',
        ...over,
      },
      sk
    );
  const send = async (evt: any) => {
    replies.length = 0;
    await room.webSocketMessage(sock as any, JSON.stringify(['EVENT', evt]));
    return replies.at(-1);
  };
  const ok = await send(mk());
  assert.strictEqual(ok[2], true, 'Evento válido aceptado');
  const dup = await send(mk());
  assert.match(String(dup[3]), /duplicate/, 'Duplicado idempotente');
  assert.strictEqual((await send(mk({}, [['d', 'b'], ['t', 'f'.repeat(64)], ['expiration', String(now + 3600)]])))[2], false, 'Sala ajena');
  assert.strictEqual((await send(mk({}, [['d', 'b'], ['t', mailboxRoomId]])))[2], false, 'Sin expiration');
  assert.strictEqual((await send(mk({}, [['d', 'b'], ['t', mailboxRoomId], ['expiration', String(now + 30 * 86400)]])))[2], false, 'TTL excesivo');
  assert.strictEqual((await send(mk({ kind: 1 })))[2], false, 'Kind no admitido');
  assert.strictEqual((await send(mk({ content: 'x'.repeat(256 * 1024 + 1) })))[2], false, 'Contenido excesivo');
  const forged = { ...mk(), content: '{"tampered":true}' };
  assert.strictEqual((await send(forged))[2], false, 'Id/firma no coinciden');
  assert.strictEqual((await send({ nope: 1 }))[2], false, 'Evento malformado');
  console.log('  ✓ Validación estricta en el servidor.');

  // ── 5. Reemplazo, caducidad y cuota ─────────────────────────────────────
  console.log('[Test 5] Reemplazo (pubkey,d), caducidad y cuota de la sala');
  const sk2 = generateSecretKey();
  const mk2 = (d: string, created: number, exp: number) =>
    finalizeEvent({ kind: MAILBOX_KIND, created_at: created, tags: [['d', d], ['t', mailboxRoomId], ['expiration', String(exp)]], content: '{}' }, sk2);
  await send(mk2('rep', now - 10, now + 3600));
  await send(mk2('rep', now, now + 3600));
  const reps = ctx.storage.sql.exec('SELECT created_at FROM events WHERE pubkey = ? AND d = ?', getPublicKey(sk2), 'rep').toArray();
  assert.deepStrictEqual(reps.map((r: any) => r.created_at), [now], 'Solo queda la versión más reciente');
  const older = await send(mk2('rep', now - 50, now + 3600));
  assert.match(String(older[3]), /duplicate/, 'Una versión más antigua no sustituye a la nueva');

  ctx.storage.sql.exec('UPDATE events SET expires_at = ? WHERE d = ?', now - 1, 'rep');
  replies.length = 0;
  await room.webSocketMessage(sock as any, JSON.stringify(['REQ', 'q1', { kinds: [MAILBOX_KIND], '#t': [mailboxRoomId] }]));
  assert.ok(!replies.some((r) => r[0] === 'EVENT' && r[2].tags.some((t: string[]) => t[1] === 'rep')), 'Los eventos caducados no se sirven');
  assert.strictEqual(replies.at(-1)[0], 'EOSE');
  assert.strictEqual(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM events WHERE d = ?', 'rep').one().n, 0, 'Se purgan al consultar');

  replies.length = 0;
  await room.webSocketMessage(sock as any, JSON.stringify(['REQ', 'bad', { since: -5 }]));
  assert.strictEqual(replies[0][0], 'CLOSED', 'Filtro inválido rechazado');
  for (const id of ['s1', 's2', 's3']) await room.webSocketMessage(sock as any, JSON.stringify(['REQ', id, {}]));
  replies.length = 0;
  await room.webSocketMessage(sock as any, JSON.stringify(['REQ', 's5', {}]));
  assert.strictEqual(replies[0][0], 'CLOSED', 'Máximo de suscripciones por socket');

  const total = ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM events').one().n;
  for (let i = 0; i < 2000 - total; i++) {
    ctx.storage.sql.exec(
      'INSERT INTO events (id, pubkey, d, created_at, expires_at, size, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
      `fill${i}`, 'p', `d${i}`, now, now + 3600, 10, '{}'
    );
  }
  const full = await send(mk2('overflow', now, now + 3600));
  assert.strictEqual(full[2], false, 'Buzón lleno: rechazo explícito');
  assert.match(String(full[3]), /rate-limited/);

  const flood = new ServerSocket({ send() {}, deliver() {} } as any);
  flood.serializeAttachment({ room: mailboxRoomId, subs: {} });
  for (let i = 0; i < 241; i++) await room.webSocketMessage(flood as any, JSON.stringify(['CLOSE', 'x']));
  assert.strictEqual(flood.closed?.code, 1008, 'Límite de ritmo');
  console.log('  ✓ Reemplazo, caducidad, límites y cuota correctos.');

  console.log('[Test 6] MAILBOX_DEBUG: apagado por defecto, y sin texto en claro al activarlo');
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: any[]) => { logged.push(args.join(' ')); };
  try {
    ctx.storage.sql.exec('DELETE FROM events');
    await send(mk2('dbg-off', now, now + 3600));
    assert.strictEqual(logged.length, 0, 'Sin MAILBOX_DEBUG no se registra nada');
    (room as any).env = { MAILBOX_DEBUG: '1' };
    await send(mk2('dbg-on', now, now + 3600));
  } finally {
    console.log = realLog;
  }
  assert.strictEqual(logged.length, 1);
  assert.ok(JSON.parse(logged[0]).mailbox === 'stored' && logged[0].includes('dbg-on'));
  console.log('  ✓ Registro de verificación opt-in.');

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DEL BUZÓN DEL WORKER PASARON');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Error en las pruebas del buzón del Worker:', err);
  process.exit(1);
});
