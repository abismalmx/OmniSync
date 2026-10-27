/**
 * OmniSync - Servidor Todo-en-Uno para Cloudflare Workers
 * Unifica en un solo Worker privado:
 * 1. Almacenamiento Blossom (Cubo R2) para archivos pesados de hasta 100 MB.
 * 2. Servidor de Señalización WebSocket (Durable Objects) con Hibernation API para WebRTC P2P en vivo.
 * 3. Buzón asíncrono (Durable Object con SQLite): relay Nostr mínimo (NIP-01/NIP-40) que guarda
 *    los eventos cifrados hasta que el otro dispositivo se conecta, sin depender de relays públicos.
 *
 * Seguridad (fail-closed):
 * - Todo acceso (subida y WebSocket) exige un evento NIP-98 firmado por una clave
 *   incluida en la variable ALLOWED_PUBKEYS (lista separada por comas/espacios).
 *   Si la variable no está configurada, el Worker rechaza todo.
 * - La firma queda ligada a la URL completa, al método, a la caducidad y, en las
 *   subidas, al SHA-256 del cuerpo (etiqueta `payload`).
 *
 * Despliegue:
 *   npm install && npx wrangler deploy
 */

import { DurableObject } from 'cloudflare:workers';
import { schnorr } from '@noble/curves/secp256k1.js';

// ======================================================================================
// 0. UTILIDADES Y LÍMITES
// ======================================================================================

const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_NIP98_AUTH_HEADER_LENGTH = 32 * 1024;
const MAX_NIP98_EVENT_BYTES = 16 * 1024;
const MAX_NIP98_TAGS = 16;
const MAX_NIP98_TAG_PARAMETERS = 8;
const MAX_NIP98_TAG_VALUE_LENGTH = 2048;
const NIP98_EVENT_WINDOW_SECONDS = 120;
const MAX_ALLOWED_PUBKEYS = 32;

/** Memoria anti-replay (por isolate, best effort): ids de eventos ya usados. */
const REPLAY_TTL_MS = 5 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 10_000;
const seenEventIds = new Map();

/** La sala de señalización es el HMAC hexadecimal de 256 bits que deriva el plugin. */
const ROOM_ID = /^[a-f0-9]{64}$/;
const MAX_SOCKETS_PER_ROOM = 32;
/** Salas de vinculación efímera: solo dos dispositivos y mensajes diminutos. */
const MAX_SOCKETS_PER_PAIR_ROOM = 4;
const MAX_PAIR_MESSAGE_BYTES = 16 * 1024;
const MAX_SIGNALING_MESSAGE_BYTES = 512 * 1024;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 120;

/** Buzón asíncrono: mismos límites que el cliente (src/network/nostr-mailbox.ts). */
const MAILBOX_KIND = 30078;
const MAX_MAILBOX_EVENT_BYTES = 256 * 1024;
const MAX_MAILBOX_FRAME_BYTES = MAX_MAILBOX_EVENT_BYTES + 4096;
const MAILBOX_MAX_TTL_SECONDS = 7 * 24 * 60 * 60 + 60;
const MAILBOX_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;
const MAILBOX_MAX_FUTURE_SECONDS = 60;
const MAX_MAILBOX_TAGS = 16;
const MAX_MAILBOX_TAG_PARAMETERS = 8;
const MAX_MAILBOX_TAG_VALUE_LENGTH = 1024;
const MAX_MAILBOX_EVENTS_PER_ROOM = 2_000;
const MAX_MAILBOX_BYTES_PER_ROOM = 96 * 1024 * 1024;
const MAX_MAILBOX_SOCKETS = 16;
const MAX_MAILBOX_SUBSCRIPTIONS_PER_SOCKET = 4;
const MAX_MAILBOX_RESULTS = 500;
const MAILBOX_RATE_LIMIT_MAX_MESSAGES = 240;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Length, X-Sha-256',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag, X-Sha-256',
};

/** Cabeceras para contenido de usuario: nunca se interpreta como documento. */
const BLOB_SECURITY_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'attachment',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLowerHex(value, expectedLength) {
  return typeof value === 'string' && value.length === expectedLength && /^[0-9a-f]+$/.test(value);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Extrae el hash de `/<sha256>` o `/<sha256>.<ext>` sin expresiones con backtracking. */
function parseBlobPath(pathname) {
  if (pathname.length < 65 || pathname.charCodeAt(0) !== 47) return null;
  const hash = pathname.slice(1, 65);
  if (!isLowerHex(hash, 64)) return null;
  const rest = pathname.slice(65);
  if (rest.length === 0) return hash;
  if (rest.charCodeAt(0) !== 46 || rest.length < 2 || rest.length > 17) return null;
  for (let i = 1; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
    if (!alnum) return null;
  }
  return hash;
}

/** Devuelve el conjunto de claves autorizadas, o null si no hay ninguna válida. */
function getAllowedPubkeys(env) {
  const raw = typeof env?.ALLOWED_PUBKEYS === 'string' ? env.ALLOWED_PUBKEYS : '';
  const keys = raw
    .split(/[\s,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => isLowerHex(k, 64))
    .slice(0, MAX_ALLOWED_PUBKEYS);
  return keys.length > 0 ? new Set(keys) : null;
}

function pruneReplayCache(now) {
  for (const [id, expiresAt] of seenEventIds) {
    if (expiresAt <= now) seenEventIds.delete(id);
  }
  while (seenEventIds.size > MAX_REPLAY_ENTRIES) {
    const oldest = seenEventIds.keys().next().value;
    if (oldest === undefined) break;
    seenEventIds.delete(oldest);
  }
}

// ======================================================================================
// 1. AUTENTICACIÓN NIP-98
// ======================================================================================

function singleTag(tags, name) {
  const matches = tags.filter((t) => t[0] === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') return null;
  return matches[0][1];
}

/**
 * Valida un evento NIP-98 (kind 27235) recibido como `Nostr <base64>`.
 *
 * Orden deliberado: primero las comprobaciones baratas (formato, ventana, clave
 * autorizada, URL, método, payload); la verificación Schnorr es lo último, de modo
 * que una clave no autorizada nunca provoca trabajo criptográfico.
 *
 * @param {string|null} authHeader   Valor `Nostr <base64>`.
 * @param {{ env: object, expectedUrl: string, method: string }} ctx
 * @returns {Promise<{ok: true, pubkey: string, payload: string|null} | {ok: false, status: number, error: string}>}
 */
async function verifyNip98(authHeader, ctx) {
  const allowed = getAllowedPubkeys(ctx.env);
  if (!allowed) {
    return { ok: false, status: 503, error: 'Servidor sin configurar: define la variable ALLOWED_PUBKEYS' };
  }
  const fail = (error, status = 401) => ({ ok: false, status, error });

  if (!authHeader) return fail('Falta autorización NIP-98');
  if (authHeader.length > MAX_NIP98_AUTH_HEADER_LENGTH) return fail('Autorización excesiva');
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Nostr') return fail('Esquema inválido. Debe ser: Nostr <token_base64>');

  let event;
  try {
    const raw = atob(parts[1]);
    if (raw.length === 0 || raw.length > MAX_NIP98_EVENT_BYTES) return fail('Tamaño de evento NIP-98 inválido');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('Evento NIP-98 ilegible');
  }

  if (!isPlainObject(event) || event.kind !== 27235) return fail('El evento no es NIP-98 (kind 27235)');
  if (typeof event.content !== 'string' || event.content.length !== 0) return fail('El contenido NIP-98 debe estar vacío');
  if (!isLowerHex(event.id, 64) || !isLowerHex(event.pubkey, 64) || !isLowerHex(event.sig, 128)) {
    return fail('Campos criptográficos mal formados');
  }
  if (!Number.isSafeInteger(event.created_at)) return fail('created_at inválido');

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - event.created_at) > NIP98_EVENT_WINDOW_SECONDS) {
    return fail('Evento fuera de la ventana temporal (±120 s)');
  }

  if (!Array.isArray(event.tags) || event.tags.length > MAX_NIP98_TAGS) return fail('Etiquetas inválidas');
  for (const tag of event.tags) {
    if (
      !Array.isArray(tag) || tag.length === 0 || tag.length > MAX_NIP98_TAG_PARAMETERS ||
      tag.some((v) => typeof v !== 'string' || v.length > MAX_NIP98_TAG_VALUE_LENGTH)
    ) {
      return fail('Etiqueta inválida');
    }
  }

  // Control de acceso ANTES de cualquier operación costosa.
  if (!allowed.has(event.pubkey)) return fail('Clave no autorizada', 403);

  const expirationTags = event.tags.filter((t) => t[0] === 'expiration');
  if (expirationTags.length > 1) return fail('Etiqueta expiration duplicada');
  if (expirationTags.length === 1) {
    const expiration = Number(expirationTags[0][1]);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSec) return fail('Autorización caducada');
  }

  const eventUrl = singleTag(event.tags, 'u');
  if (eventUrl === null) return fail('Debe contener exactamente una etiqueta u');
  try {
    // Se compara la URL completa (host, ruta y query): un token no sirve en otro servidor.
    if (new URL(eventUrl).href !== new URL(ctx.expectedUrl).href) return fail('La URL firmada no coincide');
  } catch {
    return fail('URL firmada inválida');
  }

  const method = singleTag(event.tags, 'method');
  if (method === null || method.toUpperCase() !== ctx.method.toUpperCase()) return fail('El método firmado no coincide');

  const payloadTags = event.tags.filter((t) => t[0] === 'payload');
  if (payloadTags.length > 1) return fail('Etiqueta payload duplicada');
  let payload = null;
  if (payloadTags.length === 1) {
    if (!isLowerHex(payloadTags[0][1], 64)) return fail('Etiqueta payload inválida');
    payload = payloadTags[0][1];
  }

  pruneReplayCache(nowMs);
  if (seenEventIds.has(event.id)) return fail('Evento ya utilizado');
  // Se reserva el id antes de cualquier await: dos peticiones concurrentes con el
  // mismo evento no pueden pasar ambas la comprobación anterior.
  seenEventIds.set(event.id, nowMs + REPLAY_TTL_MS);

  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)));
  if (bytesToHex(digest) !== event.id) return fail('El id del evento no coincide con su contenido');

  let validSig = false;
  try {
    validSig = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    validSig = false;
  }
  if (!validSig) return fail('Firma Schnorr inválida');

  return { ok: true, pubkey: event.pubkey, payload };
}

/** Valida id (SHA-256 del evento serializado) y firma Schnorr de un evento Nostr (NIP-01). */
async function verifyNostrEvent(event) {
  if (!isPlainObject(event)) return false;
  if (!isLowerHex(event.id, 64) || !isLowerHex(event.pubkey, 64) || !isLowerHex(event.sig, 128)) return false;
  if (!Number.isSafeInteger(event.kind) || !Number.isSafeInteger(event.created_at)) return false;
  if (!Array.isArray(event.tags) || typeof event.content !== 'string') return false;
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)));
  if (bytesToHex(digest) !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

// ======================================================================================
// 2. DURABLE OBJECT: Servidor de Señalización WebSocket (una instancia por sala)
// ======================================================================================

/** Contadores de ritmo por socket. Se pierden al hibernar, lo cual es aceptable. */
const socketRates = new WeakMap();

export class SignalingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Se esperaba una conexión WebSocket (Upgrade: websocket)', { status: 426 });
    }

    const room = new URL(request.url).searchParams.get('room');
    if (!room || !ROOM_ID.test(room)) {
      return new Response('Sala inválida', { status: 400 });
    }
    const params = new URL(request.url).searchParams;
    const isPair = params.get('kind') === 'pair';
    const role = isPair && params.get('role') === 'host' ? 'host' : 'guest';
    const existing = this.ctx.getWebSockets();
    const maxSockets = isPair ? MAX_SOCKETS_PER_PAIR_ROOM : MAX_SOCKETS_PER_ROOM;
    if (existing.length >= maxSockets) {
      return new Response('Sala llena', { status: 503 });
    }
    if (isPair) {
      // Solo el anfitrión autenticado (NIP-98) abre la sala; el invitado únicamente se une a una abierta.
      const hasHost = existing.some((ws) => ws.deserializeAttachment?.()?.role === 'host');
      if (role === 'host' && hasHost) return new Response('Sala ya abierta', { status: 409 });
      if (role === 'guest' && !hasHost) return new Response('Sala de vinculación inexistente', { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: Cloudflare hiberna la memoria cuando no hay tráfico.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ room, pair: isPair, role });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const size = typeof message === 'string' ? message.length : message.byteLength;
      const attachment = ws.deserializeAttachment?.();
      const limit = attachment && attachment.pair ? MAX_PAIR_MESSAGE_BYTES : MAX_SIGNALING_MESSAGE_BYTES;
      if (size > limit) {
        ws.close(1009, 'Mensaje demasiado grande');
        return;
      }

      const now = Date.now();
      let rate = socketRates.get(ws);
      if (!rate || now - rate.start > RATE_LIMIT_WINDOW_MS) {
        rate = { start: now, count: 0 };
        socketRates.set(ws, rate);
      }
      if (++rate.count > RATE_LIMIT_MAX_MESSAGES) {
        ws.close(1008, 'Demasiados mensajes');
        return;
      }

      const text = typeof message === 'string' ? message : new TextDecoder('utf-8', { fatal: true }).decode(message);
      const data = JSON.parse(text);
      const meta = ws.deserializeAttachment?.();
      const room = meta && typeof meta.room === 'string' ? meta.room : null;
      // El sobre debe declarar exactamente la sala autenticada del socket.
      if (!room || !isPlainObject(data) || data.roomId !== room) return;

      // Esta instancia pertenece a una sola sala: se reenvía a los demás sockets.
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === ws) continue;
        try {
          socket.send(message);
        } catch {
          // Socket cerrado o en proceso de desconexión.
        }
      }
    } catch {
      // Frames corruptos o no JSON: se ignoran.
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, 'WebSocket error in Durable Object');
    } catch {}
  }
}

// ======================================================================================
// 2b. DURABLE OBJECT: Buzón asíncrono (relay Nostr mínimo, una instancia por buzón)
// ======================================================================================

/**
 * Almacén y reenvío de eventos kind 30078 cifrados. El Worker nunca ve contenido en claro:
 * solo guarda el evento firmado, lo sirve a quien lo pida (REQ) y lo difunde a los
 * suscriptores conectados. Los eventos caducan por su etiqueta NIP-40 `expiration`.
 */
export class MailboxRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        d TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        size INTEGER NOT NULL,
        raw TEXT NOT NULL
      )`
    );
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_created ON events (created_at)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_replaceable ON events (pubkey, d)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_expiry ON events (expires_at)');
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Se esperaba una conexión WebSocket (Upgrade: websocket)', { status: 426 });
    }
    const room = new URL(request.url).searchParams.get('room');
    if (!room || !ROOM_ID.test(room)) return new Response('Buzón inválido', { status: 400 });
    if (this.ctx.getWebSockets().length >= MAX_MAILBOX_SOCKETS) {
      return new Response('Buzón con demasiadas conexiones', { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ room, subs: {} });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const size = typeof message === 'string' ? message.length : message.byteLength;
      if (size > MAX_MAILBOX_FRAME_BYTES) {
        ws.close(1009, 'Mensaje demasiado grande');
        return;
      }
      const now = Date.now();
      let rate = socketRates.get(ws);
      if (!rate || now - rate.start > RATE_LIMIT_WINDOW_MS) {
        rate = { start: now, count: 0 };
        socketRates.set(ws, rate);
      }
      if (++rate.count > MAILBOX_RATE_LIMIT_MAX_MESSAGES) {
        ws.close(1008, 'Demasiados mensajes');
        return;
      }

      const text = typeof message === 'string' ? message : new TextDecoder('utf-8', { fatal: true }).decode(message);
      const data = JSON.parse(text);
      if (!Array.isArray(data) || typeof data[0] !== 'string') return;

      if (data[0] === 'EVENT') return await this.handleEvent(ws, data[1]);
      if (data[0] === 'REQ') return this.handleReq(ws, data[1], data[2]);
      if (data[0] === 'CLOSE') return this.handleClose(ws, data[1]);
    } catch {
      // Frames corruptos o no JSON: se ignoran.
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, 'WebSocket error in Durable Object');
    } catch {}
  }

  send(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Socket cerrado o en proceso de desconexión.
    }
  }

  /** Valida un evento entrante. Devuelve un motivo de rechazo o null si es aceptable. */
  async validateEvent(event, room) {
    if (!isPlainObject(event)) return 'invalid: evento malformado';
    if (event.kind !== MAILBOX_KIND) return 'invalid: kind no admitido';
    if (typeof event.content !== 'string' || new TextEncoder().encode(event.content).byteLength > MAX_MAILBOX_EVENT_BYTES) {
      return 'invalid: contenido excesivo';
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(event.created_at) || event.created_at < nowSec - MAILBOX_MAX_AGE_SECONDS || event.created_at > nowSec + MAILBOX_MAX_FUTURE_SECONDS) {
      return 'invalid: created_at fuera de rango';
    }
    if (!Array.isArray(event.tags) || event.tags.length > MAX_MAILBOX_TAGS) return 'invalid: etiquetas inválidas';
    for (const tag of event.tags) {
      if (
        !Array.isArray(tag) || tag.length === 0 || tag.length > MAX_MAILBOX_TAG_PARAMETERS ||
        tag.some((v) => typeof v !== 'string' || v.length > MAX_MAILBOX_TAG_VALUE_LENGTH)
      ) {
        return 'invalid: etiqueta inválida';
      }
    }
    // El buzón solo acepta eventos de su propia sala: así el aislamiento no depende del cliente.
    const roomTags = event.tags.filter((t) => t[0] === 't');
    if (roomTags.length !== 1 || roomTags[0][1] !== room) return 'invalid: sala incorrecta';
    const expirationTags = event.tags.filter((t) => t[0] === 'expiration');
    if (expirationTags.length !== 1) return 'invalid: expiration obligatoria';
    const expiration = Number(expirationTags[0][1]);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSec || expiration > nowSec + MAILBOX_MAX_TTL_SECONDS) {
      return 'invalid: expiration fuera de rango';
    }
    const dTags = event.tags.filter((t) => t[0] === 'd');
    if (dTags.length !== 1 || typeof dTags[0][1] !== 'string') return 'invalid: etiqueta d obligatoria';
    if (!(await verifyNostrEvent(event))) return 'invalid: firma o id incorrectos';
    return null;
  }

  async handleEvent(ws, event) {
    const meta = ws.deserializeAttachment?.();
    const room = meta && typeof meta.room === 'string' ? meta.room : null;
    const eventId = isPlainObject(event) && typeof event.id === 'string' ? event.id : '';
    if (!room) return;

    const reason = await this.validateEvent(event, room);
    if (reason) {
      this.send(ws, ['OK', eventId, false, reason]);
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    this.purgeExpired(nowSec);

    const raw = JSON.stringify(event);
    const size = new TextEncoder().encode(raw).byteLength;
    const expiresAt = Number(event.tags.find((t) => t[0] === 'expiration')[1]);
    const d = event.tags.find((t) => t[0] === 'd')[1];

    const duplicate = this.sql.exec('SELECT 1 FROM events WHERE id = ?', event.id).toArray();
    if (duplicate.length > 0) {
      this.send(ws, ['OK', event.id, true, 'duplicate: ya existe']);
      return;
    }

    // Evento reemplazable parametrizado (NIP-33): una versión por (pubkey, d).
    const previous = this.sql.exec('SELECT id, created_at FROM events WHERE pubkey = ? AND d = ?', event.pubkey, d).toArray();
    if (previous.some((row) => row.created_at > event.created_at)) {
      this.send(ws, ['OK', event.id, true, 'duplicate: existe una versión más reciente']);
      return;
    }
    for (const row of previous) this.sql.exec('DELETE FROM events WHERE id = ?', row.id);

    const totals = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM events').one();
    if (totals.n >= MAX_MAILBOX_EVENTS_PER_ROOM || totals.bytes + size > MAX_MAILBOX_BYTES_PER_ROOM) {
      this.send(ws, ['OK', event.id, false, 'rate-limited: buzón lleno']);
      return;
    }

    this.sql.exec(
      'INSERT INTO events (id, pubkey, d, created_at, expires_at, size, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
      event.id, event.pubkey, d, event.created_at, expiresAt, size, raw
    );
    this.send(ws, ['OK', event.id, true, '']);
    this.debugLog('stored', event, size);

    // Difusión en vivo a los suscriptores conectados (incluido el emisor, como un relay estándar).
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment?.();
      const subs = attachment && isPlainObject(attachment.subs) ? attachment.subs : {};
      for (const [subId, filter] of Object.entries(subs)) {
        if (this.matches(event, filter)) this.send(socket, ['EVENT', subId, event]);
      }
    }
  }

  /** Reduce un filtro NIP-01 a los campos que este buzón entiende (todos acotados). */
  normalizeFilter(filter) {
    if (!isPlainObject(filter)) return null;
    const out = {};
    if (filter.since !== undefined) {
      if (!Number.isSafeInteger(filter.since) || filter.since < 0) return null;
      out.since = filter.since;
    }
    if (filter.until !== undefined) {
      if (!Number.isSafeInteger(filter.until) || filter.until < 0) return null;
      out.until = filter.until;
    }
    if (filter.kinds !== undefined) {
      if (!Array.isArray(filter.kinds) || filter.kinds.length > 4 || filter.kinds.some((k) => !Number.isSafeInteger(k))) return null;
      out.kinds = filter.kinds;
    }
    if (filter.limit !== undefined) {
      if (!Number.isSafeInteger(filter.limit) || filter.limit < 0) return null;
      out.limit = Math.min(filter.limit, MAX_MAILBOX_RESULTS);
    }
    for (const key of ['#t', '#d']) {
      if (filter[key] !== undefined) {
        if (!Array.isArray(filter[key]) || filter[key].length > 8 || filter[key].some((v) => typeof v !== 'string' || v.length > 128)) return null;
        out[key] = filter[key];
      }
    }
    return out;
  }

  matches(event, filter) {
    if (filter.since !== undefined && event.created_at < filter.since) return false;
    if (filter.until !== undefined && event.created_at > filter.until) return false;
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    for (const key of ['#t', '#d']) {
      if (filter[key]) {
        const name = key.slice(1);
        if (!event.tags.some((tag) => tag[0] === name && filter[key].includes(tag[1]))) return false;
      }
    }
    return true;
  }

  handleReq(ws, subId, rawFilter) {
    if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) return;
    const filter = this.normalizeFilter(rawFilter);
    if (!filter) {
      this.send(ws, ['CLOSED', subId, 'invalid: filtro no admitido']);
      return;
    }
    const attachment = ws.deserializeAttachment?.() ?? {};
    const subs = isPlainObject(attachment.subs) ? { ...attachment.subs } : {};
    if (!(subId in subs) && Object.keys(subs).length >= MAX_MAILBOX_SUBSCRIPTIONS_PER_SOCKET) {
      this.send(ws, ['CLOSED', subId, 'rate-limited: demasiadas suscripciones']);
      return;
    }
    subs[subId] = filter;
    ws.serializeAttachment({ ...attachment, subs });

    const nowSec = Math.floor(Date.now() / 1000);
    this.purgeExpired(nowSec);
    const limit = filter.limit ?? MAX_MAILBOX_RESULTS;
    const rows = this.sql
      .exec(
        'SELECT raw FROM events WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC, id ASC LIMIT ?',
        filter.since ?? 0,
        filter.until ?? Number.MAX_SAFE_INTEGER,
        MAX_MAILBOX_RESULTS * 4
      )
      .toArray();
    let sent = 0;
    for (const row of rows) {
      if (sent >= limit) break;
      let event;
      try {
        event = JSON.parse(row.raw);
      } catch {
        continue;
      }
      if (!this.matches(event, filter)) continue;
      this.send(ws, ['EVENT', subId, event]);
      sent++;
    }
    this.send(ws, ['EOSE', subId]);
  }

  handleClose(ws, subId) {
    if (typeof subId !== 'string') return;
    const attachment = ws.deserializeAttachment?.() ?? {};
    if (!isPlainObject(attachment.subs) || !(subId in attachment.subs)) return;
    const subs = { ...attachment.subs };
    delete subs[subId];
    ws.serializeAttachment({ ...attachment, subs });
  }

  /**
   * Verificación opt-in (variable MAILBOX_DEBUG=1): registra lo que el servidor ve de cada
   * evento, para comprobar que solo hay ciphertext y etiquetas ofuscadas. Nunca hay texto en claro.
   */
  debugLog(action, event, size) {
    if (this.env?.MAILBOX_DEBUG !== '1') return;
    console.log(JSON.stringify({
      mailbox: action,
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      tags: event.tags,
      bytes: size,
      contentPreview: event.content.slice(0, 96),
    }));
  }

  purgeExpired(nowSec) {
    this.sql.exec('DELETE FROM events WHERE expires_at <= ?', nowSec);
  }
}

// ======================================================================================
// 3. ENRUTADOR PRINCIPAL (HTTP REST + WEBSOCKET UPGRADE)
// ======================================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ----------------------------------------------------------------------------------
    // A. WEBSOCKET SIGNALLING: autenticado y enrutado a la sala indicada
    // ----------------------------------------------------------------------------------
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (!env.SIGNALING_ROOM) return json({ error: 'Binding SIGNALING_ROOM no configurado' }, 500);

      // Vinculación efímera: el anfitrión (ya autorizado) abre la sala con NIP-98; el dispositivo
      // nuevo, que aún no está en ALLOWED_PUBKEYS, solo puede unirse a una sala ya abierta. Así
      // nadie anónimo crea salas. La sala solo retransmite mensajes autenticados por el token del
      // QR (sala = HMAC del token), con aforo y tamaño mínimos y un espacio de nombres propio.
      const pairRoom = url.searchParams.get('pair');
      if (pairRoom !== null) {
        if (!ROOM_ID.test(pairRoom)) return json({ message: 'Sala de vinculación inválida' }, 400);
        const pairToken = url.searchParams.get('auth');
        let pairRole = 'guest';
        if (pairToken) {
          const pairAuth = await verifyNip98(`Nostr ${pairToken}`, {
            env,
            expectedUrl: `https://${url.host}${url.pathname}?pair=${pairRoom}`,
            method: 'GET',
          });
          if (!pairAuth.ok) return json({ message: pairAuth.error }, pairAuth.status);
          pairRole = 'host';
        }
        const forwardedPair = new URL(request.url);
        forwardedPair.search = '';
        forwardedPair.searchParams.set('room', pairRoom);
        forwardedPair.searchParams.set('kind', 'pair');
        forwardedPair.searchParams.set('role', pairRole);
        const pairStub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(`pair:${pairRoom}`));
        return pairStub.fetch(new Request(forwardedPair.toString(), request));
      }

      // Buzón asíncrono: relay Nostr privado del usuario (mismo NIP-98, espacio de nombres propio).
      const mailboxRoom = url.searchParams.get('mailbox');
      if (mailboxRoom !== null) {
        if (!env.MAILBOX_ROOM) return json({ error: 'Binding MAILBOX_ROOM no configurado' }, 500);
        if (!ROOM_ID.test(mailboxRoom)) return json({ message: 'Buzón inválido' }, 400);
        const mailboxToken = url.searchParams.get('auth');
        const mailboxAuth = await verifyNip98(mailboxToken ? `Nostr ${mailboxToken}` : null, {
          env,
          expectedUrl: `https://${url.host}${url.pathname}?mailbox=${mailboxRoom}`,
          method: 'GET',
        });
        if (!mailboxAuth.ok) return json({ message: mailboxAuth.error }, mailboxAuth.status);
        const forwardedMailbox = new URL(request.url);
        forwardedMailbox.search = '';
        forwardedMailbox.searchParams.set('room', mailboxRoom);
        const mailboxStub = env.MAILBOX_ROOM.get(env.MAILBOX_ROOM.idFromName(`mailbox:${mailboxRoom}`));
        return mailboxStub.fetch(new Request(forwardedMailbox.toString(), request));
      }

      const room = url.searchParams.get('room');
      if (!room || !ROOM_ID.test(room)) return json({ message: 'Sala inválida' }, 400);

      const token = url.searchParams.get('auth');
      const auth = await verifyNip98(token ? `Nostr ${token}` : null, {
        env,
        // Se fuerza https: el esquema de una petición de upgrade varía según el entorno.
        expectedUrl: `https://${url.host}${url.pathname}?room=${room}`,
        method: 'GET',
      });
      if (!auth.ok) return json({ message: auth.error }, auth.status);

      // El token no se reenvía al Durable Object.
      const forwarded = new URL(request.url);
      forwarded.searchParams.delete('auth');
      // Parámetros internos de las salas de vinculación: nunca los decide el cliente en esta ruta.
      forwarded.searchParams.delete('kind');
      forwarded.searchParams.delete('role');
      const stub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(room));
      return stub.fetch(new Request(forwarded.toString(), request));
    }

    // ----------------------------------------------------------------------------------
    // B. RUTA RAÍZ: estado de salud (sin datos sensibles)
    // ----------------------------------------------------------------------------------
    if (path === '/' && request.method === 'GET') {
      return json({
        name: 'OmniSync All-in-One Server',
        version: '2.0.0',
        status: 'ok',
        services: {
          blossom: {
            status: env.MY_BUCKET ? 'ready' : 'missing_r2_binding',
            protocol: 'BUD-01/02',
            maxFileSizeMb: MAX_UPLOAD_SIZE_BYTES / 1024 / 1024,
            storage: 'Cloudflare R2',
          },
          signaling: {
            status: env.SIGNALING_ROOM ? 'ready' : 'missing_do_binding',
            protocol: 'WebSocket / Durable Objects',
            hibernation: true,
          },
          mailbox: {
            status: env.MAILBOX_ROOM ? 'ready' : 'missing_do_binding',
            protocol: 'Nostr NIP-01 / NIP-40 (relay privado)',
            storage: 'Durable Objects (SQLite)',
          },
          auth: {
            status: getAllowedPubkeys(env) ? 'ready' : 'missing_allowed_pubkeys',
          },
        },
      });
    }

    // ----------------------------------------------------------------------------------
    // C. BLOSSOM STORAGE
    // ----------------------------------------------------------------------------------
    if (!env.MY_BUCKET) {
      return json({ error: 'Binding R2 no configurado', message: 'Falta la fijación MY_BUCKET en Cloudflare R2.' }, 500);
    }

    // Subida: PUT /upload. El cuerpo se transmite directamente a R2, que verifica el
    // SHA-256 firmado en la autorización; no se acumula en memoria del isolate.
    if (path === '/upload' && request.method === 'PUT') {
      const auth = await verifyNip98(request.headers.get('Authorization'), {
        env,
        expectedUrl: `${url.origin}${url.pathname}${url.search}`,
        method: 'PUT',
      });
      if (!auth.ok) return json({ message: auth.error }, auth.status);
      if (!auth.payload) return json({ message: 'La autorización debe incluir la etiqueta payload (SHA-256 del cuerpo)' }, 401);

      const contentLengthHeader = request.headers.get('Content-Length');
      if (contentLengthHeader === null) return json({ message: 'Content-Length es obligatorio' }, 411);
      const declaredSize = Number(contentLengthHeader);
      if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) return json({ message: 'Content-Length inválido' }, 400);
      if (declaredSize > MAX_UPLOAD_SIZE_BYTES) {
        return json({ message: `El archivo excede el tamaño máximo permitido (${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024} MB)` }, 413);
      }

      const headerSha256 = request.headers.get('X-Sha-256');
      if (headerSha256 !== null && headerSha256.toLowerCase() !== auth.payload) {
        return json({ message: 'X-Sha-256 no coincide con la autorización' }, 400);
      }
      if (!request.body) return json({ message: 'Cuerpo vacío' }, 400);

      const sha256Hex = auth.payload;
      const descriptor = (size) => ({
        url: `${url.origin}/${sha256Hex}`,
        sha256: sha256Hex,
        size,
        type: 'application/octet-stream',
        uploaded: Math.floor(Date.now() / 1000),
      });

      // Un blob direccionado por contenido que ya existe no se reescribe.
      const existing = await env.MY_BUCKET.head(sha256Hex);
      if (existing) {
        try { await request.body.cancel(); } catch {}
        return json(descriptor(existing.size), 200, { 'X-Sha-256': sha256Hex });
      }

      let stored;
      try {
        stored = await env.MY_BUCKET.put(sha256Hex, request.body, {
          sha256: sha256Hex,
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { uploadedAt: String(Math.floor(Date.now() / 1000)) },
        });
      } catch {
        return json({ message: 'El cuerpo no coincide con el SHA-256 autorizado' }, 400);
      }

      return json(descriptor(stored?.size ?? declaredSize), 200, { 'X-Sha-256': sha256Hex });
    }

    // Descarga o verificación: GET/HEAD /:sha256 (públicas, direccionadas por contenido
    // y cifradas extremo a extremo por el plugin).
    const sha256Hex = parseBlobPath(path);
    if (sha256Hex) {
      if (request.method === 'HEAD') {
        const object = await env.MY_BUCKET.head(sha256Hex);
        if (!object) return new Response(null, { status: 404, headers: CORS_HEADERS });
        return new Response(null, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            ...BLOB_SECURITY_HEADERS,
            'Content-Length': String(object.size),
            'ETag': object.httpEtag,
            'X-Sha-256': sha256Hex,
          },
        });
      }

      if (request.method === 'GET') {
        const object = await env.MY_BUCKET.get(sha256Hex);
        if (!object) return json({ message: 'Blob no encontrado' }, 404);
        return new Response(object.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            ...BLOB_SECURITY_HEADERS,
            'Content-Length': String(object.size),
            'ETag': object.httpEtag,
            'X-Sha-256': sha256Hex,
          },
        });
      }
    }

    return json({ message: 'Ruta no encontrada en OmniSync Server' }, 404);
  },
};
