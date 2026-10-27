/**
 * OmniSync - Autenticación frente al Worker privado de Cloudflare
 *
 * El Worker solo acepta eventos NIP-98 firmados por una clave de su lista
 * `ALLOWED_PUBKEYS`. Esa identidad se deriva de forma determinista del secreto de
 * emparejamiento (HMAC con dominio propio), de modo que todos los dispositivos
 * emparejados comparten la misma clave pública sin guardar nada adicional y sin
 * que la clave revele el secreto.
 *
 * La identidad estable solo se usa con los hosts que el usuario marcó como
 * propios (`privateWorkerHosts`): nunca con relays o servidores Blossom públicos,
 * que podrían correlacionar la actividad.
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools';
import type { CryptoManager } from '../crypto/crypto-manager';
import { SecurityValidationError } from './vault-security';

export const WORKER_AUTH_KIND = 27235;
/** Ventana de validez declarada en la etiqueta `expiration` del token. */
export const WORKER_AUTH_EXPIRATION_SECONDS = 90;
/** Número máximo de hosts propios que se conservan en los ajustes. */
export const MAX_PRIVATE_WORKER_HOSTS = 8;
/** Formato de la sala de señalización que acepta el Worker (HMAC hexadecimal). */
export const WORKER_ROOM_ID = /^[a-f0-9]{64}$/;

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Deriva la clave secreta Nostr (32 bytes) con la que se autentica ante el Worker. */
export async function deriveWorkerAuthKey(
  cryptoManager: CryptoManager,
  pairingSecret: string
): Promise<Uint8Array> {
  // Un escalar fuera de rango tiene probabilidad ~2^-128; se reintenta por rigor.
  for (let counter = 0; counter < 8; counter++) {
    const hex = await cryptoManager.computeHmacHex(
      `identity:${counter}`,
      pairingSecret,
      'worker-auth-v1'
    );
    const candidate = hexToBytes(hex);
    try {
      getPublicKey(candidate);
      return candidate;
    } catch {
      // Escalar inválido: siguiente intento.
    }
  }
  throw new SecurityValidationError('No se pudo derivar la identidad de acceso al Worker.');
}

/** Clave pública hexadecimal (la que va en ALLOWED_PUBKEYS). */
export function workerAuthPublicKey(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

/** Normaliza el host (con puerto opcional) de una URL; null si no es válido. */
export function normalizeWorkerHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260) return null;
  try {
    const candidate = value.includes('://') ? value : `https://${value}`;
    const host = new URL(candidate).host.toLowerCase();
    return HOSTNAME.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Sanea la lista de hosts propios guardada en data.json. */
export function normalizeWorkerHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts: string[] = [];
  for (const item of value) {
    const host = normalizeWorkerHost(item);
    if (host && !hosts.includes(host)) hosts.push(host);
    if (hosts.length >= MAX_PRIVATE_WORKER_HOSTS) break;
  }
  return hosts;
}

/** Indica si la URL apunta a un Worker propio del usuario. */
export function isPrivateWorkerUrl(url: unknown, privateHosts: readonly string[]): boolean {
  const host = normalizeWorkerHost(url);
  return host !== null && privateHosts.includes(host);
}

/** Valor aleatorio que hace único cada evento aunque dos dispositivos firmen en el mismo segundo. */
export function randomNonceHex(byteLength = 8): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * URL canónica que el Worker reconstruye para validar la etiqueta `u` de la
 * conexión WebSocket: `https://host/ruta?room=<sala>` (o `pair`/`mailbox`).
 */
function canonicalSignalingUrl(parsed: URL, room: string, param: 'room' | 'pair' | 'mailbox' = 'room'): string {
  return `https://${parsed.host}${parsed.pathname}?${param}=${room}`;
}

/**
 * Construye la URL `wss://` autenticada para el WebSocket del Worker. El token es
 * un evento NIP-98 de un solo uso, ligado a host, ruta y sala.
 */
export function buildAuthenticatedSignalingUrl(
  serverUrl: string,
  room: string,
  secretKey: Uint8Array,
  now: number = Date.now(),
  param: 'room' | 'pair' | 'mailbox' = 'room'
): string {
  if (!WORKER_ROOM_ID.test(room)) {
    throw new SecurityValidationError('La sala de señalización no es válida para el Worker.');
  }
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== 'wss:') {
    throw new SecurityValidationError('El servidor debe usar wss:// (TLS).');
  }

  const createdAt = Math.floor(now / 1000);
  const event = finalizeEvent(
    {
      kind: WORKER_AUTH_KIND,
      created_at: createdAt,
      tags: [
        ['u', canonicalSignalingUrl(parsed, room, param)],
        ['method', 'GET'],
        ['expiration', String(createdAt + WORKER_AUTH_EXPIRATION_SECONDS)],
        ['nonce', randomNonceHex()],
      ],
      content: '',
    },
    secretKey
  );

  const result = new URL(serverUrl);
  result.search = '';
  result.searchParams.set(param, room);
  result.searchParams.set('auth', toBase64(JSON.stringify(event)));
  return result.toString();
}
