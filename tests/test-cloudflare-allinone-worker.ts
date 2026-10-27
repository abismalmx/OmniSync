/**
 * OmniSync - Tests de Regresión para Cloudflare Worker Todo-en-Uno (worker.js)
 *
 * Valida:
 * 1. Salud (GET /) y estado del control de acceso.
 * 2. Control de acceso fail-closed: ALLOWED_PUBKEYS obligatoria, claves ajenas rechazadas.
 * 3. NIP-98 ligado a URL completa, método, caducidad y SHA-256 del cuerpo; replay rechazado.
 * 4. Subida/descarga Blossom (extremo a extremo con el BlossomClient real) y cabeceras seguras.
 * 5. WebSocket autenticado, sala validada y token no reenviado al Durable Object.
 * 6. SignalingRoom: sala vinculada al socket, límites de tamaño, ritmo y aforo.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import worker, { SignalingRoom } from '../scripts/cloudflare-allinone/worker.js';
import { BlossomClient } from '../src/network/blossom-client';
import { CryptoManager } from '../src/crypto/crypto-manager';
import {
  CLOUDFLARE_ALLINONE_WORKER_TEMPLATE,
  CLOUDFLARE_BLOSSOM_WORKER_TEMPLATE,
  CLOUDFLARE_ONELINER_DEPLOY_COMMAND,
  CLOUDFLARE_PACKAGE_JSON_TEMPLATE,
  CLOUDFLARE_PUBKEY_PLACEHOLDER,
  CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE,
} from '../src/templates/cloudflare-worker-template';
import {
  buildAuthenticatedSignalingUrl,
  deriveWorkerAuthKey,
  workerAuthPublicKey,
} from '../src/security/worker-auth';

const HOST = 'https://allinone.test';
const OTHER_HOST = 'https://otro-servidor.test';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** R2 simulado: lee el flujo completo y verifica `sha256` como lo hace R2. */
class MemoryBucket {
  public readonly objects = new Map<string, { bytes: Uint8Array; options: Record<string, any> }>();
  public putCalls = 0;

  public async put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer, options: Record<string, any> = {}) {
    this.putCalls++;
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    if (options.sha256 && (await sha256Hex(bytes)) !== options.sha256) {
      throw new Error('The SHA-256 checksum you specified did not match what we received.');
    }
    this.objects.set(key, { bytes, options });
    return { size: bytes.byteLength };
  }

  public async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.byteLength, httpMetadata: { contentType: 'text/html' }, httpEtag: `"${key}"` };
  }

  public async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes).body as ReadableStream<Uint8Array>,
      size: object.bytes.byteLength,
      // Aunque un objeto antiguo declare text/html, el Worker nunca lo reenvía.
      httpMetadata: { contentType: 'text/html' },
      httpEtag: `"${key}"`,
    };
  }
}

class MockWebSocket {
  public sent: string[] = [];
  public closed: { code?: number; reason?: string } | null = null;
  constructor(public attachment: any = {}) {}
  serializeAttachment(meta: any) { this.attachment = { ...meta }; }
  deserializeAttachment() { return { ...this.attachment }; }
  send(message: string) { this.sent.push(message); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
}

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createAuth(options: {
  url: string;
  method: string;
  secretKey: Uint8Array;
  payloadHash?: string;
  createdAt?: number;
  expiration?: number | null;
  nonce?: boolean;
}): string {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [['u', options.url], ['method', options.method]];
  if (options.payloadHash) tags.push(['payload', options.payloadHash]);
  if (options.expiration !== null) tags.push(['expiration', String(options.expiration ?? createdAt + 60)]);
  if (options.nonce !== false) tags.push(['nonce', crypto.randomUUID()]);
  const event = finalizeEvent({ kind: 27235, created_at: createdAt, tags, content: '' }, options.secretKey);
  return `Nostr ${toBase64(JSON.stringify(event))}`;
}

async function runTests() {
  console.log('=== Iniciando Suite de Pruebas: Cloudflare All-in-One Worker ===\n');

  const ownerKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerKey);
  const bucket = new MemoryBucket();
  const forwarded: Request[] = [];
  const requestedRooms: string[] = [];
  const namespace = {
    idFromName(name: string) { requestedRooms.push(name); return { name }; },
    get() {
      return { fetch: async (req: Request) => { forwarded.push(req); return new Response('DO WebSocket OK', { status: 200 }); } };
    },
  };
  const env = { MY_BUCKET: bucket, SIGNALING_ROOM: namespace, ALLOWED_PUBKEYS: ownerPubkey } as any;

  const upload = (auth: string | null, body: Uint8Array, extra: Record<string, string> = {}, e: any = env) =>
    worker.fetch(
      new Request(`${HOST}/upload`, {
        method: 'PUT',
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          'Content-Length': String(body.byteLength),
          ...extra,
        },
        body,
      }),
      e
    );

  // ── 1. Salud ───────────────────────────────────────────────────────────────
  console.log('[Test 1] Health check y estado del control de acceso');
  const health = await (await worker.fetch(new Request(`${HOST}/`), env)).json() as any;
  assert.strictEqual(health.services.blossom.status, 'ready');
  assert.strictEqual(health.services.signaling.status, 'ready');
  assert.strictEqual(health.services.auth.status, 'ready');
  const healthOpen = await (await worker.fetch(new Request(`${HOST}/`), { ...env, ALLOWED_PUBKEYS: '' })).json() as any;
  assert.strictEqual(healthOpen.services.auth.status, 'missing_allowed_pubkeys');
  console.log('  ✓ La salud informa si falta ALLOWED_PUBKEYS.');

  // ── 2. Subida válida ───────────────────────────────────────────────────────
  console.log('[Test 2] Subida válida y descarga con cabeceras seguras');
  const payload = new TextEncoder().encode('Prueba de sincronización All-in-One Cloudflare');
  const payloadHash = await sha256Hex(payload);
  const ok = await upload(createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash }), payload, {
    'Content-Type': 'text/html',
  });
  assert.strictEqual(ok.status, 200, 'Subida firmada por clave autorizada');
  const descriptor = (await ok.json()) as any;
  assert.strictEqual(descriptor.sha256, payloadHash);
  assert.strictEqual(descriptor.size, payload.byteLength);
  assert.strictEqual(bucket.objects.get(payloadHash)!.options.httpMetadata.contentType, 'application/octet-stream',
    'El Content-Type del cliente no se persiste');
  assert.strictEqual(bucket.objects.get(payloadHash)!.options.sha256, payloadHash, 'R2 debe verificar el hash firmado');

  const get = await worker.fetch(new Request(`${HOST}/${payloadHash}`), env);
  assert.strictEqual(get.status, 200);
  assert.deepStrictEqual(new Uint8Array(await get.arrayBuffer()), payload);
  assert.strictEqual(get.headers.get('content-type'), 'application/octet-stream');
  assert.strictEqual(get.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(get.headers.get('content-disposition'), 'attachment');
  assert.ok(get.headers.get('content-security-policy')?.includes('sandbox'));
  const head = await worker.fetch(new Request(`${HOST}/${payloadHash}`, { method: 'HEAD' }), env);
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(head.headers.get('content-type'), 'application/octet-stream');
  console.log('  ✓ Subida, descarga y HEAD; Content-Type forzado y cabeceras anti-sniffing.');

  // ── 3. Control de acceso ───────────────────────────────────────────────────
  console.log('[Test 3] Control de acceso (fail-closed)');
  const strangerBody = crypto.getRandomValues(new Uint8Array(512));
  const strangerHash = await sha256Hex(strangerBody);
  const before = bucket.putCalls;
  const stranger = await upload(
    createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: generateSecretKey(), payloadHash: strangerHash }),
    strangerBody
  );
  assert.strictEqual(stranger.status, 403, 'Una clave válida pero ajena debe rechazarse');
  assert.strictEqual(bucket.putCalls, before, 'No debe escribirse nada en R2');
  for (const bad of [undefined, '', 'zz', 'ABCD', ownerPubkey.toUpperCase().slice(0, 63)]) {
    const closed = await upload(
      createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash }),
      payload,
      {},
      { ...env, ALLOWED_PUBKEYS: bad }
    );
    assert.strictEqual(closed.status, 503, `ALLOWED_PUBKEYS=${JSON.stringify(bad)} debe cerrar el servidor`);
  }
  console.log('  ✓ Claves ajenas → 403 sin tocar R2; configuración ausente o inválida → 503.');

  // ── 4. NIP-98: ligaduras ───────────────────────────────────────────────────
  console.log('[Test 4] NIP-98 ligado a cuerpo, URL, método, caducidad y no repetible');
  const other = new TextEncoder().encode('<script>alert(1)</script> cuerpo del atacante');
  const otherHash = await sha256Hex(other);
  const bound = createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash });

  // Cuerpo distinto al firmado: R2 detecta la discrepancia de SHA-256.
  const replayBody = await upload(bound, new TextEncoder().encode('otro contenido distinto'));
  assert.strictEqual(replayBody.status, 400, 'El cuerpo debe coincidir con el hash firmado');
  assert.ok(!bucket.objects.has(otherHash), 'No se guarda un blob que no coincide con su firma');

  const cases: Array<[string, string, number]> = [
    ['otro host', createAuth({ url: `${OTHER_HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash }), 401],
    ['otra ruta', createAuth({ url: `${HOST}/otra`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash }), 401],
    ['con query', createAuth({ url: `${HOST}/upload?x=1`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash }), 401],
    ['otro método', createAuth({ url: `${HOST}/upload`, method: 'POST', secretKey: ownerKey, payloadHash: otherHash }), 401],
    ['sin payload', createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey }), 401],
    ['expirada (expiration)', createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash, expiration: Math.floor(Date.now() / 1000) - 5 }), 401],
    ['antigua (created_at)', createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash, createdAt: Math.floor(Date.now() / 1000) - 600 }), 401],
  ];
  for (const [name, header, status] of cases) {
    const res = await upload(header, other);
    assert.strictEqual(res.status, status, `Autorización con ${name} debe rechazarse`);
  }
  assert.strictEqual((await upload(null, other)).status, 401, 'Sin Authorization');
  assert.strictEqual((await upload('Nostr ***', other)).status, 401, 'Token ilegible');
  assert.strictEqual((await upload(`Bearer ${bound.slice(6)}`, other)).status, 401, 'Esquema incorrecto');

  // Un token firmado para /upload no sirve con una query añadida en la petición (NIP-98: URL exacta).
  const queryBody = new TextEncoder().encode('cuerpo para la prueba de query');
  const queryHash = await sha256Hex(queryBody);
  const queryAuth = createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: queryHash });
  const withQuery = await worker.fetch(
    new Request(`${HOST}/upload?x=1`, {
      method: 'PUT',
      headers: { Authorization: queryAuth, 'Content-Length': String(queryBody.byteLength) },
      body: queryBody,
    }),
    env
  );
  assert.strictEqual(withQuery.status, 401, 'La query añadida debe invalidar el token');

  // Dos peticiones simultáneas con el mismo evento: solo una puede superar el anti-replay.
  const raceBody = new TextEncoder().encode('cuerpo para la prueba de concurrencia');
  const raceAuth = createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: await sha256Hex(raceBody) });
  const race = await Promise.all([upload(raceAuth, raceBody), upload(raceAuth, raceBody)]);
  assert.strictEqual(race.filter((r) => r.status === 401).length, 1, 'El segundo uso simultáneo del evento debe rechazarse');

  // Evento nuevo (no usado) para que el rechazo sea por la firma y no por replay.
  const freshForTamper = createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash });
  const tampered = JSON.parse(Buffer.from(freshForTamper.slice(6), 'base64').toString('utf8'));
  tampered.sig = tampered.sig.slice(0, -1) + (tampered.sig.endsWith('0') ? '1' : '0');
  assert.strictEqual((await upload(`Nostr ${toBase64(JSON.stringify(tampered))}`, other)).status, 401, 'Firma alterada');
  const noContent = JSON.parse(Buffer.from(freshForTamper.slice(6), 'base64').toString('utf8'));
  noContent.content = 'x';
  assert.strictEqual((await upload(`Nostr ${toBase64(JSON.stringify(noContent))}`, other)).status, 401, 'content no vacío');

  // Replay: el mismo evento válido solo se acepta una vez.
  const oneShot = createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: otherHash });
  assert.strictEqual((await upload(oneShot, other)).status, 200, 'Primera presentación');
  const replayed = await upload(oneShot, other);
  assert.strictEqual(replayed.status, 401, 'El mismo evento no puede repetirse');
  console.log('  ✓ Cuerpo, host, ruta, query, método, payload, caducidad, firma y replay verificados.');

  // Content-Length obligatorio y acotado.
  const noLength = await worker.fetch(
    new Request(`${HOST}/upload`, {
      method: 'PUT',
      headers: { Authorization: createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: strangerHash }) },
      body: strangerBody,
    }),
    env
  );
  assert.strictEqual(noLength.status, 411, 'Sin Content-Length no se acepta (evita acumular memoria)');
  const tooBig = await upload(
    createAuth({ url: `${HOST}/upload`, method: 'PUT', secretKey: ownerKey, payloadHash: strangerHash }),
    strangerBody,
    { 'Content-Length': String(100 * 1024 * 1024 + 1) }
  );
  assert.strictEqual(tooBig.status, 413);

  // ── 5. Cliente real extremo a extremo ──────────────────────────────────────
  console.log('[Test 5] BlossomClient real contra el Worker');
  const crypto2 = new CryptoManager();
  const secret = crypto2.generatePairingSecret();
  const authKey = await deriveWorkerAuthKey(crypto2, secret);
  const authKeyAgain = await deriveWorkerAuthKey(crypto2, secret);
  assert.deepStrictEqual(authKey, authKeyAgain, 'La identidad se deriva de forma determinista');
  assert.notDeepStrictEqual(authKey, await deriveWorkerAuthKey(crypto2, crypto2.generatePairingSecret()));
  const e2eEnv = { ...env, ALLOWED_PUBKEYS: workerAuthPublicKey(authKey) };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const body = init.body as Uint8Array | undefined;
    const headers = new Headers(init.headers);
    if (body) headers.set('Content-Length', String(body.byteLength));
    return worker.fetch(new Request(String(input), { ...init, headers }), e2eEnv);
  }) as typeof fetch;
  try {
    const blob = crypto.getRandomValues(new Uint8Array(4096));
    const blobHash = await sha256Hex(blob);
    const uploaded = await BlossomClient.uploadBlob(blob, blobHash, [HOST], generateSecretKey(), 45000, {
      privateKey: authKey,
      privateHosts: ['allinone.test'],
    });
    assert.strictEqual(uploaded.sha256, blobHash);
    assert.ok(bucket.objects.has(blobHash));

    const blob2 = crypto.getRandomValues(new Uint8Array(2048));
    await assert.rejects(
      BlossomClient.uploadBlob(blob2, await sha256Hex(blob2), [HOST], generateSecretKey()),
      'Sin la identidad propia (clave efímera) la subida debe fallar'
    );
    await assert.rejects(
      BlossomClient.uploadBlob(blob2, await sha256Hex(blob2), [HOST], generateSecretKey(), 45000, {
        privateKey: authKey,
        privateHosts: ['otro-host.test'],
      }),
      'La identidad estable no se presenta a hosts no marcados como propios'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('  ✓ El cliente real sube con la identidad derivada; una clave efímera es rechazada.');

  // ── 6. WebSocket autenticado ───────────────────────────────────────────────
  console.log('[Test 6] Upgrade WebSocket autenticado y enrutado por sala');
  const room = await crypto2.deriveSignalingRoomId(secret);
  const wsEnv = { ...env, ALLOWED_PUBKEYS: workerAuthPublicKey(authKey) };
  const wsReq = (url: string) => new Request(url.replace('wss://', 'https://'), { headers: { Upgrade: 'websocket' } });

  const noAuth = await worker.fetch(wsReq(`wss://allinone.test/?room=${room}`), wsEnv);
  assert.strictEqual(noAuth.status, 401, 'WebSocket sin token');
  assert.strictEqual((await worker.fetch(wsReq(`wss://allinone.test/?room=corta&auth=x`), wsEnv)).status, 400, 'Sala inválida');
  assert.strictEqual((await worker.fetch(wsReq(`wss://allinone.test/`), wsEnv)).status, 400, 'Sin sala');
  const strangerUrl = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, generateSecretKey());
  assert.strictEqual((await worker.fetch(wsReq(strangerUrl), wsEnv)).status, 403, 'Clave ajena');
  const foreignRoom = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, authKey).replace(room, 'f'.repeat(64));
  assert.strictEqual((await worker.fetch(wsReq(foreignRoom), wsEnv)).status, 401, 'Token firmado para otra sala');
  const otherHostUrl = buildAuthenticatedSignalingUrl('wss://otro-servidor.test/', room, authKey)
    .replace('otro-servidor.test', 'allinone.test');
  assert.strictEqual((await worker.fetch(wsReq(otherHostUrl), wsEnv)).status, 401, 'Token firmado para otro host');
  assert.strictEqual(requestedRooms.length, 0, 'Ningún intento fallido debe crear un Durable Object');

  const goodUrl = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, authKey);
  const accepted = await worker.fetch(wsReq(goodUrl), wsEnv);
  assert.strictEqual(accepted.status, 200);
  assert.deepStrictEqual(requestedRooms, [room], 'El Durable Object se nombra con la sala autenticada');
  const forwardedUrl = new URL(forwarded[forwarded.length - 1].url);
  assert.strictEqual(forwardedUrl.searchParams.get('room'), room);
  assert.strictEqual(forwardedUrl.searchParams.get('auth'), null, 'El token no se reenvía al Durable Object');
  assert.strictEqual((await worker.fetch(wsReq(goodUrl), wsEnv)).status, 401, 'El token de WebSocket no es reutilizable');
  // Dos dispositivos del mismo vault firmando en el mismo segundo no colisionan.
  const now = Date.now();
  const tokenA = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, authKey, now);
  const tokenB = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, authKey, now);
  assert.notStrictEqual(tokenA, tokenB);
  assert.strictEqual((await worker.fetch(wsReq(tokenA), wsEnv)).status, 200);
  assert.strictEqual((await worker.fetch(wsReq(tokenB), wsEnv)).status, 200);
  console.log('  ✓ Solo clave autorizada + sala válida crean/abren un Durable Object; token de un solo uso.');

  // ── 7. SignalingRoom ───────────────────────────────────────────────────────
  console.log('[Test 7] SignalingRoom: sala vinculada, límites de tamaño, ritmo y aforo');
  const sockets: MockWebSocket[] = [];
  const ctx = { getWebSockets: () => sockets, acceptWebSocket: () => {} };
  const doRoom = new SignalingRoom(ctx as any, env);
  const sender = new MockWebSocket({ room });
  const peer = new MockWebSocket({ room });
  const lurker = new MockWebSocket({ room });
  sockets.push(sender, peer, lurker);

  await doRoom.webSocketMessage(sender, JSON.stringify({ roomId: room, type: 'signal', payload: { v: 1 } }));
  assert.strictEqual(peer.sent.length, 1);
  assert.strictEqual(lurker.sent.length, 1);
  assert.strictEqual(sender.sent.length, 0, 'El emisor no recibe su propio mensaje');

  peer.sent = []; lurker.sent = [];
  await doRoom.webSocketMessage(sender, JSON.stringify({ type: 'signal', payload: {} }));
  await doRoom.webSocketMessage(sender, JSON.stringify({ roomId: 'f'.repeat(64), type: 'signal', payload: {} }));
  await doRoom.webSocketMessage(sender, 'no es json');
  await doRoom.webSocketMessage(sender, JSON.stringify(['EVENT', {}]));
  assert.strictEqual(peer.sent.length + lurker.sent.length, 0, 'Sin roomId, con sala ajena, no JSON o no objeto: se descarta');

  const noRoomSocket = new MockWebSocket({});
  await doRoom.webSocketMessage(noRoomSocket, JSON.stringify({ roomId: room }));
  assert.strictEqual(peer.sent.length, 0, 'Un socket sin sala autenticada no retransmite');

  const bigSender = new MockWebSocket({ room });
  await doRoom.webSocketMessage(bigSender, 'x'.repeat(512 * 1024 + 1));
  assert.strictEqual(bigSender.closed?.code, 1009, 'Mensaje demasiado grande cierra el socket');

  const flooder = new MockWebSocket({ room });
  for (let i = 0; i < 121; i++) {
    await doRoom.webSocketMessage(flooder, JSON.stringify({ roomId: room, i }));
  }
  assert.strictEqual(flooder.closed?.code, 1008, 'Exceder el ritmo cierra el socket');

  const full = new SignalingRoom({ getWebSockets: () => new Array(32).fill(0).map(() => new MockWebSocket({ room })), acceptWebSocket: () => {} } as any, env);
  const fullRes = await full.fetch(new Request(`${HOST}/?room=${room}`, { headers: { Upgrade: 'websocket' } }));
  assert.strictEqual(fullRes.status, 503, 'Sala llena');
  assert.strictEqual((await doRoom.fetch(new Request(`${HOST}/?room=${room}`))).status, 426, 'Sin Upgrade');
  assert.strictEqual(
    (await doRoom.fetch(new Request(`${HOST}/?room=mala`, { headers: { Upgrade: 'websocket' } }))).status,
    400,
    'Sala inválida en el propio Durable Object'
  );
  console.log('  ✓ Solo se retransmite el sobre con la sala autenticada; límites aplicados.');

  // ── 7b. Sala de vinculación efímera (sin NIP-98, aislada del vault) ─────────
  console.log('[Test 7b] Sala de vinculación efímera');
  const pairRoom = 'a'.repeat(64);
  requestedRooms.length = 0;
  assert.strictEqual((await worker.fetch(wsReq(`wss://allinone.test/?pair=corta`), wsEnv)).status, 400, 'Sala de vinculación inválida');
  const hostUrl = buildAuthenticatedSignalingUrl('wss://allinone.test/', pairRoom, authKey, Date.now(), 'pair');
  assert.ok(hostUrl.includes(`pair=${pairRoom}`));
  assert.strictEqual((await worker.fetch(wsReq(`wss://allinone.test/?pair=${pairRoom}&auth=basura`), wsEnv)).status, 401, 'Token de anfitrión inválido');
  const strangerHost = buildAuthenticatedSignalingUrl('wss://allinone.test/', pairRoom, generateSecretKey(), Date.now(), 'pair');
  assert.strictEqual((await worker.fetch(wsReq(strangerHost), wsEnv)).status, 403, 'Anfitrión ajeno a ALLOWED_PUBKEYS');
  const roomTokenAsPair = buildAuthenticatedSignalingUrl('wss://allinone.test/', pairRoom, authKey).replace('room=', 'pair=');
  assert.strictEqual((await worker.fetch(wsReq(roomTokenAsPair), wsEnv)).status, 401, 'Un token de sala no abre salas de vinculación');
  const pairRes = await worker.fetch(wsReq(hostUrl), wsEnv);
  assert.strictEqual(pairRes.status, 200, 'El anfitrión autenticado abre la sala');
  assert.strictEqual(new URL(forwarded[forwarded.length - 1].url).searchParams.get('role'), 'host');
  const spoofed = buildAuthenticatedSignalingUrl('wss://allinone.test/', room, authKey) + '&kind=pair&role=host';
  assert.strictEqual((await worker.fetch(wsReq(spoofed), wsEnv)).status, 200);
  const spoofedFwd = new URL(forwarded[forwarded.length - 1].url);
  assert.strictEqual(spoofedFwd.searchParams.get('kind'), null, 'La ruta normal no admite kind/role del cliente');
  assert.strictEqual(spoofedFwd.searchParams.get('role'), null);
  requestedRooms.length = 0;
  await worker.fetch(wsReq(hostUrl.replace(/auth=[^&]+/, 'auth=' + new URL(buildAuthenticatedSignalingUrl('wss://allinone.test/', pairRoom, authKey, Date.now(), 'pair')).searchParams.get('auth'))), wsEnv);
  const guestRes = await worker.fetch(wsReq(`wss://allinone.test/?pair=${pairRoom}&role=host`), wsEnv);
  assert.strictEqual(guestRes.status, 200, 'El invitado se une sin NIP-98');
  assert.strictEqual(new URL(forwarded[forwarded.length - 1].url).searchParams.get('role'), 'guest', 'El rol no se puede forjar por query');
  assert.ok(requestedRooms.length > 0 && requestedRooms.every((r) => r === `pair:${pairRoom}`), 'Espacio de nombres propio: no colisiona con salas del vault');
  const pairForwarded = new URL(forwarded[forwarded.length - 1].url);
  assert.strictEqual(pairForwarded.searchParams.get('room'), pairRoom);
  assert.strictEqual(pairForwarded.searchParams.get('kind'), 'pair');
  // Las rutas normales siguen exigiendo autenticación aunque se añada `pair` ausente.
  assert.strictEqual((await worker.fetch(wsReq(`wss://allinone.test/?room=${room}`), wsEnv)).status, 401);

  const pairDo = new SignalingRoom({ getWebSockets: () => [], acceptWebSocket: () => {} } as any, env);
  const pairFull = new SignalingRoom(
    { getWebSockets: () => new Array(4).fill(0).map(() => new MockWebSocket({ room: pairRoom, pair: true })), acceptWebSocket: () => {} } as any,
    env
  );
  assert.strictEqual(
    (await pairFull.fetch(new Request(`${HOST}/?room=${pairRoom}&kind=pair`, { headers: { Upgrade: 'websocket' } }))).status,
    503,
    'La sala de vinculación admite pocos sockets'
  );
  const pairReq = (role: string) =>
    new Request(`${HOST}/?room=${pairRoom}&kind=pair&role=${role}`, { headers: { Upgrade: 'websocket' } });
  const hostWs = new MockWebSocket({ room: pairRoom, pair: true, role: 'host' });
  const noHostDo = new SignalingRoom({ getWebSockets: () => [], acceptWebSocket: () => {} } as any, env);
  assert.strictEqual((await noHostDo.fetch(pairReq('guest'))).status, 404, 'Sin anfitrión no se crea ni se une a una sala');
  const withHostDo = new SignalingRoom({ getWebSockets: () => [hostWs], acceptWebSocket: () => {} } as any, env);
  assert.strictEqual((await withHostDo.fetch(pairReq('host'))).status, 409, 'Solo un anfitrión por sala');
  // Node no admite respuestas 101: se comprueba que se llega a aceptar el socket.
  (globalThis as any).WebSocketPair = class { 0 = {}; 1 = new MockWebSocket(); };
  const accepted101 = async (pairDoRoom: SignalingRoom, role: string) => {
    try {
      return (await pairDoRoom.fetch(pairReq(role))).status === 101;
    } catch (err) {
      return err instanceof RangeError;
    }
  };
  assert.ok(await accepted101(withHostDo, 'guest'), 'El invitado entra a una sala abierta');
  assert.ok(await accepted101(noHostDo, 'host'), 'El anfitrión abre la sala');
  const pairSender = new MockWebSocket({ room: pairRoom, pair: true });
  await pairDo.webSocketMessage(pairSender, 'x'.repeat(16 * 1024 + 1));
  assert.strictEqual(pairSender.closed?.code, 1009, 'Mensajes de vinculación acotados a 16 KB');
  console.log('  ✓ Sala efímera abierta solo por anfitrión autenticado, aislada, con aforo y tamaño mínimos.');

  // ── 8. Plantillas embebidas == archivos fuente (lo copiado es lo desplegado) ─
  console.log('[Test 8] Plantillas embebidas sincronizadas con scripts/');
  // Rutas literales (relativas a la raíz del plugin, donde corre `npm test`).
  assert.strictEqual(CLOUDFLARE_ALLINONE_WORKER_TEMPLATE, readFileSync('scripts/cloudflare-allinone/worker.js', 'utf8'), 'worker.js desincronizado: ejecuta npm run build:templates');
  assert.strictEqual(CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE, readFileSync('scripts/cloudflare-allinone/wrangler.jsonc', 'utf8'), 'wrangler.jsonc desincronizado');
  assert.strictEqual(CLOUDFLARE_PACKAGE_JSON_TEMPLATE, readFileSync('scripts/cloudflare-allinone/package.json', 'utf8'), 'package.json desincronizado');
  assert.strictEqual(CLOUDFLARE_BLOSSOM_WORKER_TEMPLATE, readFileSync('scripts/cloudflare-blossom-worker.js', 'utf8'), 'worker Blossom desincronizado');
  assert.ok(CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE.includes(CLOUDFLARE_PUBKEY_PLACEHOLDER), 'wrangler debe llevar el marcador de clave');
  assert.ok(!/wrangler"\s*:\s*"\^3/.test(CLOUDFLARE_PACKAGE_JSON_TEMPLATE), 'No debe fijarse wrangler 3.x (vulnerable)');
  // El one-liner usa heredocs entrecomillados: bash no interpreta backticks ni ${}.
  assert.ok(CLOUDFLARE_ONELINER_DEPLOY_COMMAND.includes("<<'OMNISYNC_EOF'"));
  assert.ok(!/echo\s+"/.test(CLOUDFLARE_ONELINER_DEPLOY_COMMAND), 'No debe volcar código con echo "..."');
  console.log('  ✓ Las plantillas coinciden byte a byte y el one-liner usa heredocs seguros.');

  // ── 9. /list eliminado ─────────────────────────────────────────────────────
  assert.strictEqual((await worker.fetch(new Request(`${HOST}/list/${ownerPubkey}`), env)).status, 404, '/list ya no existe');

  // ── 10. El comando de despliegue limita la retención de archivos en R2 ───────
  assert.ok(
    /wrangler r2 bucket lifecycle add omnisync-blossom \S+ --expire-days 10\b/.test(CLOUDFLARE_ONELINER_DEPLOY_COMMAND),
    'el comando del asistente debe crear la regla que borra los archivos de R2 a los 10 días'
  );
  assert.ok(
    /lifecycle add [^)]*\|\| true\)/.test(CLOUDFLARE_ONELINER_DEPLOY_COMMAND),
    'si la regla ya existe (redespliegue) el comando no debe abortar'
  );
  console.log('  ✓ el comando de despliegue añade la caducidad de 10 días a los archivos de R2');

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DEL WORKER TODO-EN-UNO PASARON');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Error en las pruebas del Worker Todo-en-Uno:', err);
  process.exit(1);
});
