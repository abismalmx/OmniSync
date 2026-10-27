/**
 * OmniSync - Sesión de vinculación efímera
 *
 * La clave maestra NO viaja en el QR. El QR lleva un token aleatorio de 128 bits
 * (de un solo uso y con caducidad) que solo autentica un intercambio ECDH P-256:
 *
 *   invitado → anfitrión : hello  { pub, mac(token) }
 *   anfitrión → invitado : offer  { pub, mac(token), ciphertext(payload) }
 *   invitado → anfitrión : done   { ciphertext(identidad) }
 *
 * El relay solo ve la sala (HMAC del token), claves públicas efímeras y ciphertext.
 * Sin el token nadie puede producir un `hello` válido ni forjar un `offer`.
 */

import { SecurityValidationError, decodeCanonicalBase64, isPlainObject } from './vault-security';
import { validateSecureWebSocketUrl } from './network-security';

export const PAIRING_SESSION_URI_PREFIX = 'omnisync://pair2?data=';
/** Enlace profundo del QR: la cámara del móvil abre Obsidian y el plugin pide confirmación. */
export const PAIRING_LINK_ACTION = 'omnisync-pair';
export const PAIRING_LINK_PREFIX = `obsidian://${PAIRING_LINK_ACTION}?data=`;
export const PAIRING_TOKEN_BYTES = 16;
/** Vigencia del código mostrado en el QR (cuenta desde que el QR queda visible). */
export const PAIRING_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_SESSION_URI_LENGTH = 2048;
const MAX_PAIRING_MESSAGE_LENGTH = 8 * 1024;
const PUBLIC_KEY_BYTES = 65; // P-256 sin comprimir
const IV_BYTES = 12;
const ROOM_HEX = /^[a-f0-9]{64}$/;

export type PairingTransportKind = 'nostr' | 'worker';

export interface PairingInvite {
  v: 2;
  token: string;
  transport: PairingTransportKind;
  /** wss:// del relay Nostr o del Worker donde se encuentran ambos dispositivos. */
  server: string;
}

export interface PairingWireMessage {
  v: 1;
  /** Sala de encuentro; permite al Worker aplicar su control `roomId === room`. */
  roomId: string;
  type: 'hello' | 'offer' | 'done';
  pub?: string;
  mac?: string;
  iv?: string;
  ct?: string;
}

const encoder = new TextEncoder();
const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto API no disponible en este entorno.');
  return globalThis.crypto.subtle;
};

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: unknown, expectedLength?: number): Uint8Array {
  const bytes = decodeCanonicalBase64(value);
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new SecurityValidationError('Longitud de campo de vinculación inválida.');
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generatePairingToken(): string {
  return toB64(randomBytes(PAIRING_TOKEN_BYTES)).replace(/=+$/, '');
}

function tokenToBytes(token: string): Uint8Array {
  if (typeof token !== 'string' || !/^[A-Za-z0-9+/]{22}$/.test(token)) {
    throw new SecurityValidationError('El código de vinculación es inválido.');
  }
  return fromB64(`${token}==`, PAIRING_TOKEN_BYTES);
}

async function hmac(keyBytes: Uint8Array, label: string, ...parts: string[]): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = encoder.encode([`OmniSync-Pair-v2:${label}`, ...parts].join('\0'));
  return new Uint8Array(await subtle().sign('HMAC', key, data as BufferSource));
}

/** Sala de encuentro: derivada del token, no revela el token al relay. */
export async function derivePairingRoom(token: string): Promise<string> {
  return toHex(await hmac(tokenToBytes(token), 'room'));
}

async function macKey(token: string): Promise<CryptoKey> {
  const bytes = await hmac(tokenToBytes(token), 'mac');
  return subtle().importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function computeMac(token: string, label: string, ...parts: string[]): Promise<string> {
  const key = await macKey(token);
  const data = encoder.encode([`OmniSync-Pair-v2:${label}`, ...parts].join('\0'));
  return toB64(new Uint8Array(await subtle().sign('HMAC', key, data as BufferSource)));
}

async function verifyMac(token: string, mac: unknown, label: string, ...parts: string[]): Promise<boolean> {
  try {
    const sig = fromB64(mac, 32);
    const key = await macKey(token);
    const data = encoder.encode([`OmniSync-Pair-v2:${label}`, ...parts].join('\0'));
    return await subtle().verify('HMAC', key, sig as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

export interface EphemeralKeyPair {
  privateKey: CryptoKey;
  publicB64: string;
}

export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicB64: toB64(raw) };
}

async function deriveSessionKey(
  privateKey: CryptoKey,
  remotePubB64: string,
  token: string,
  hostPub: string,
  guestPub: string
): Promise<CryptoKey> {
  const remote = await subtle().importKey(
    'raw',
    fromB64(remotePubB64, PUBLIC_KEY_BYTES) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = await subtle().deriveBits({ name: 'ECDH', public: remote }, privateKey, 256);
  const hkdfKey = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: tokenToBytes(token) as BufferSource,
      info: encoder.encode(`OmniSync-Pair-v2:session\0${hostPub}\0${guestPub}`) as BufferSource,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(key: CryptoKey, aad: string, value: unknown): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(aad) as BufferSource },
    key,
    encoder.encode(JSON.stringify(value)) as BufferSource
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function open<T>(key: CryptoKey, aad: string, msg: PairingWireMessage): Promise<T> {
  const plain = await subtle().decrypt(
    {
      name: 'AES-GCM',
      iv: fromB64(msg.iv, IV_BYTES) as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
    },
    key,
    fromB64(msg.ct) as BufferSource
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as T;
}

export function validateWireMessage(value: unknown, room: string): PairingWireMessage | null {
  if (!isPlainObject(value) || value.v !== 1 || value.roomId !== room) return null;
  if (value.type !== 'hello' && value.type !== 'offer' && value.type !== 'done') return null;
  for (const field of ['pub', 'mac', 'iv', 'ct'] as const) {
    const v = value[field];
    if (v !== undefined && (typeof v !== 'string' || v.length > MAX_PAIRING_MESSAGE_LENGTH)) return null;
  }
  return value as unknown as PairingWireMessage;
}

// ---------------------------------------------------------------------------
// Invitación (contenido del QR)
// ---------------------------------------------------------------------------

export function encodePairingInvite(invite: PairingInvite): string {
  validateInvite(invite);
  const json = JSON.stringify({ v: 2, token: invite.token, transport: invite.transport, server: invite.server });
  return `${PAIRING_SESSION_URI_PREFIX}${encodeURIComponent(toB64(encoder.encode(json)))}`;
}

function validateInvite(value: unknown): PairingInvite {
  if (!isPlainObject(value) || value.v !== 2) {
    throw new SecurityValidationError('Versión de invitación no soportada.');
  }
  tokenToBytes(value.token as string);
  if (value.transport !== 'nostr' && value.transport !== 'worker') {
    throw new SecurityValidationError('Canal de vinculación inválido.');
  }
  validateSecureWebSocketUrl(value.server);
  return value as unknown as PairingInvite;
}

/** Mismo contenido que el código copiable, pero como enlace `obsidian://` para abrir la app al escanear. */
export function encodePairingLink(invite: PairingInvite): string {
  return `${PAIRING_LINK_PREFIX}${encodePairingInvite(invite).slice(PAIRING_SESSION_URI_PREFIX.length)}`;
}

/** Reconstruye el código a partir del parámetro `data` que entrega el manejador de protocolo de Obsidian. */
export function inviteUriFromLinkData(data: unknown): string {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_SESSION_URI_LENGTH) {
    throw new SecurityValidationError('La invitación de vinculación es inválida.');
  }
  return `${PAIRING_SESSION_URI_PREFIX}${encodeURIComponent(data)}`;
}

export function isPairingInviteUri(input: string): boolean {
  return (
    typeof input === 'string' &&
    (input.startsWith(PAIRING_SESSION_URI_PREFIX) || input.startsWith(PAIRING_LINK_PREFIX))
  );
}

export function decodePairingInvite(input: string): PairingInvite {
  if (!isPairingInviteUri(input) || input.length > MAX_SESSION_URI_LENGTH) {
    throw new SecurityValidationError('La invitación de vinculación es inválida.');
  }
  let json: string;
  try {
    const prefix = input.startsWith(PAIRING_LINK_PREFIX) ? PAIRING_LINK_PREFIX : PAIRING_SESSION_URI_PREFIX;
    const bytes = decodeCanonicalBase64(decodeURIComponent(input.slice(prefix.length)));
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SecurityValidationError('La invitación de vinculación es ilegible.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SecurityValidationError('La invitación de vinculación no es JSON válido.');
  }
  return validateInvite(parsed);
}

// ---------------------------------------------------------------------------
// Anfitrión (dispositivo que ya tiene la clave y muestra el QR)
// ---------------------------------------------------------------------------

export class PairingHostSession {
  private consumed = false;
  /** Un solo hello en proceso a la vez: evita que dos válidos simultáneos pasen el control de uso único. */
  private busy = false;
  private hostKeys: EphemeralKeyPair | null = null;
  private guestPub = '';
  private sessionKey: CryptoKey | null = null;
  private room = '';

  constructor(
    public readonly token: string,
    private readonly now: () => number = Date.now,
    public readonly expiresAt: number = Date.now() + PAIRING_TOKEN_TTL_MS
  ) {}

  public async getRoom(): Promise<string> {
    if (!this.room) this.room = await derivePairingRoom(this.token);
    return this.room;
  }

  /** Un `hello` válido ya recibió la clave: el intercambio está en curso. */
  public get isConsumed(): boolean {
    return this.consumed;
  }

  public get isExpired(): boolean {
    return this.now() > this.expiresAt;
  }

  /**
   * Procesa un `hello`. Devuelve el `offer` cifrado, o null si el mensaje no es
   * válido, el código caducó o ya se consumió (un solo uso).
   */
  public async handleHello(msg: PairingWireMessage, payload: unknown): Promise<PairingWireMessage | null> {
    if (this.consumed || this.busy || this.isExpired || msg.type !== 'hello') return null;
    this.busy = true;
    try {
      return await this.processHello(msg, payload);
    } finally {
      this.busy = false;
    }
  }

  private async processHello(msg: PairingWireMessage, payload: unknown): Promise<PairingWireMessage | null> {
    const room = await this.getRoom();
    if (msg.roomId !== room || typeof msg.pub !== 'string') return null;
    try {
      fromB64(msg.pub, PUBLIC_KEY_BYTES);
    } catch {
      return null;
    }
    if (!(await verifyMac(this.token, msg.mac, 'hello', room, msg.pub))) return null;

    // Se consume antes de responder: ni un fallo posterior permite reutilizar el código.
    this.consumed = true;
    this.hostKeys = await generateEphemeralKeyPair();
    this.guestPub = msg.pub;
    this.sessionKey = await deriveSessionKey(
      this.hostKeys.privateKey,
      msg.pub,
      this.token,
      this.hostKeys.publicB64,
      msg.pub
    );
    const aad = `offer\0${room}\0${this.hostKeys.publicB64}\0${msg.pub}`;
    const sealed = await seal(this.sessionKey, aad, payload);
    return {
      v: 1,
      roomId: room,
      type: 'offer',
      pub: this.hostKeys.publicB64,
      mac: await computeMac(this.token, 'offer', room, this.hostKeys.publicB64, msg.pub),
      ...sealed,
    };
  }

  /** Descifra el `done` del invitado y devuelve su identidad. */
  public async handleDone<T>(msg: PairingWireMessage): Promise<T | null> {
    if (!this.consumed || !this.sessionKey || !this.hostKeys || msg.type !== 'done') return null;
    const room = await this.getRoom();
    if (msg.roomId !== room) return null;
    try {
      return await open<T>(this.sessionKey, `done\0${room}\0${this.hostKeys.publicB64}\0${this.guestPub}`, msg);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Invitado (dispositivo nuevo que escanea el QR)
// ---------------------------------------------------------------------------

export class PairingGuestSession {
  private keys: EphemeralKeyPair | null = null;
  private sessionKey: CryptoKey | null = null;
  private hostPub = '';
  private room = '';

  constructor(public readonly token: string) {}

  public async buildHello(): Promise<PairingWireMessage> {
    this.room = await derivePairingRoom(this.token);
    this.keys = await generateEphemeralKeyPair();
    return {
      v: 1,
      roomId: this.room,
      type: 'hello',
      pub: this.keys.publicB64,
      mac: await computeMac(this.token, 'hello', this.room, this.keys.publicB64),
    };
  }

  /** Verifica el `offer` (MAC del token) y devuelve el payload descifrado. */
  public async handleOffer<T>(msg: PairingWireMessage): Promise<T | null> {
    if (!this.keys || msg.type !== 'offer' || msg.roomId !== this.room || typeof msg.pub !== 'string') return null;
    try {
      fromB64(msg.pub, PUBLIC_KEY_BYTES);
      if (!(await verifyMac(this.token, msg.mac, 'offer', this.room, msg.pub, this.keys.publicB64))) return null;
      this.hostPub = msg.pub;
      this.sessionKey = await deriveSessionKey(
        this.keys.privateKey,
        msg.pub,
        this.token,
        msg.pub,
        this.keys.publicB64
      );
      return await open<T>(this.sessionKey, `offer\0${this.room}\0${msg.pub}\0${this.keys.publicB64}`, msg);
    } catch {
      return null;
    }
  }

  public async buildDone(identity: unknown): Promise<PairingWireMessage> {
    if (!this.sessionKey || !this.keys) throw new Error('Sesión de vinculación incompleta.');
    const sealed = await seal(this.sessionKey, `done\0${this.room}\0${this.hostPub}\0${this.keys.publicB64}`, identity);
    return { v: 1, roomId: this.room, type: 'done', ...sealed };
  }
}

export { ROOM_HEX as PAIRING_ROOM_PATTERN };
