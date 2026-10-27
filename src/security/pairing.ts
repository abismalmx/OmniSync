/**
 * OmniSync - Secure Pairing Payload
 *
 * Formato de emparejamiento versionado, limitado en tamaño y decodificado de
 * forma estricta. No se acepta una clave o sala arbitraria sin validarla.
 */

import {
  SecurityValidationError,
  decodeCanonicalBase64,
  isPlainObject,
} from './vault-security';
import { validateSecureWebSocketUrl } from './network-security';

export const PAIRING_URI_PREFIX = 'omnisync://pair?data=';
const MAX_PAIRING_PAYLOAD_LENGTH = 8192;
const ROOM_ID = /^[a-f0-9]{32}$/;
const PAIRING_SECRET_BASE64_LENGTH = 44;

export interface PairingPayload {
  v: 1;
  name?: string;
  platform?: 'desktop' | 'mobile';
  secret: string;
  roomId: string;
  /** Servidor de señalización del emisor: sin él, ambos equipos pueden quedar en redes distintas. */
  server?: string;
  /** El emisor lo tiene registrado como Worker propio (exige autenticación). */
  privateWorker?: boolean;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return decodeCanonicalBase64(value);
}

function validatePayload(value: unknown): PairingPayload {
  if (!isPlainObject(value) || value.v !== 1) {
    throw new SecurityValidationError('Versión de payload de vinculación no soportada.');
  }
  if (
    typeof value.secret !== 'string' ||
    value.secret.length !== PAIRING_SECRET_BASE64_LENGTH
  ) {
    throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
  }
  try {
    if (base64ToBytes(value.secret).byteLength !== 32) {
      throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
    }
  } catch {
    throw new SecurityValidationError('La clave de vinculación no contiene Base64 válido.');
  }
  if (typeof value.roomId !== 'string' || !ROOM_ID.test(value.roomId)) {
    throw new SecurityValidationError('El identificador de sala es inválido.');
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 100 || /[\u0000-\u001f\u007f]/.test(value.name))) {
    throw new SecurityValidationError('El nombre del dispositivo es inválido.');
  }
  if (value.platform !== undefined && value.platform !== 'desktop' && value.platform !== 'mobile') {
    throw new SecurityValidationError('La plataforma del dispositivo es inválida.');
  }
  if (value.server !== undefined) {
    try {
      validateSecureWebSocketUrl(value.server);
    } catch {
      throw new SecurityValidationError('El servidor de señalización del payload es inválido.');
    }
  }
  if (value.privateWorker !== undefined && typeof value.privateWorker !== 'boolean') {
    throw new SecurityValidationError('El indicador de Worker privado es inválido.');
  }
  return value as unknown as PairingPayload;
}

/** Codifica el payload como texto UTF-8 y Base64 estándar. */
export function encodePairingPayload(payload: PairingPayload): string {
  const validated = validatePayload(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  return `${PAIRING_URI_PREFIX}${encodeURIComponent(bytesToBase64(bytes))}`;
}

/** Decodifica tanto el URI de emparejamiento como JSON plano. */
export function decodePairingPayload(input: string): PairingPayload {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PAIRING_PAYLOAD_LENGTH) {
    throw new SecurityValidationError('El payload de vinculación tiene un tamaño inválido.');
  }

  let json: string;
  if (input.startsWith(PAIRING_URI_PREFIX)) {
    const encoded = input.slice(PAIRING_URI_PREFIX.length);
    if (!encoded || encoded.length > MAX_PAIRING_PAYLOAD_LENGTH) {
      throw new SecurityValidationError('El URI de vinculación está vacío o es demasiado grande.');
    }
    let decodedEncoded: string;
    try {
      decodedEncoded = decodeURIComponent(encoded);
    } catch {
      throw new SecurityValidationError('El URI de vinculación tiene un escape inválido.');
    }
    const bytes = base64ToBytes(decodedEncoded);
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SecurityValidationError('El payload de vinculación no contiene UTF-8 válido.');
    }
  } else {
    json = input;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SecurityValidationError('El payload de vinculación no contiene JSON válido.');
  }
  return validatePayload(parsed);
}
