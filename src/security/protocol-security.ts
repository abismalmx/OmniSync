/**
 * OmniSync - Protocol Message Security
 *
 * Validación de mensajes base, presencia y señales. Separa formato, identidad,
 * antigüedad y replay para que ninguna capa del protocolo confíe en campos sin
 * comprobar.
 */

import type { BaseProtocolMessage, MessageType } from '../types';
import {
  SecurityValidationError,
  VaultPathPolicy,
  isPlainObject,
  validateVaultPath,
} from './vault-security';

/** Límite de un mensaje WebRTC ya serializado. */
export const MAX_ENCRYPTED_MESSAGE_BYTES = 512 * 1024;
/** Límite de un SDP/ICE que puede procesarse como señal. */
export const MAX_SIGNAL_LENGTH = 128 * 1024;
/** Límite de un candidato ICE individual. */
export const MAX_ICE_CANDIDATE_LENGTH = 16 * 1024;
/** Número máximo de candidatos ICE pendientes. */
export const MAX_PENDING_ICE_CANDIDATES = 100;
/** Antigüedad máxima aceptada para un mensaje sellado. */
export const MAX_PROTOCOL_MESSAGE_AGE_MS = 10 * 60 * 1000;
/** Tolerancia de reloj hacia el futuro. */
export const MAX_PROTOCOL_CLOCK_SKEW_MS = 5 * 60 * 1000;

const MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  'AUTH_CHALLENGE',
  'AUTH_RESPONSE',
  'AUTH_COMPLETE',
  'MANIFEST_EXCHANGE',
  'FILE_HEADER',
  'FILE_CHUNK',
  'FILE_COMPLETE',
  'FILE_DELETE',
  'FILE_RENAME',
  'PRESENCE_CURSOR',
  'LIVE_TEXT_DELTA',
  'PING',
  'PONG',
]);

const DEVICE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPES.has(value as MessageType);
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

export function isValidTransferId(value: unknown): value is string {
  return typeof value === 'string' && TRANSFER_ID.test(value);
}

export function isValidMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID.test(value);
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Valida un mensaje base sellado y comprueba emisor y antigüedad. */
export function validateBaseProtocolMessage(
  value: unknown,
  expectedSenderId: string,
  now: number = Date.now()
): asserts value is BaseProtocolMessage {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Mensaje de protocolo con formato inválido.');
  }
  if (!isMessageType(value.type)) {
    throw new SecurityValidationError('Tipo de mensaje de protocolo desconocido.');
  }
  if (!isValidDeviceId(value.senderId) || value.senderId !== expectedSenderId) {
    throw new SecurityValidationError('El mensaje no procede del peer autenticado esperado.');
  }
  if (!isValidMessageId(value.messageId)) {
    throw new SecurityValidationError('Identificador de mensaje inválido.');
  }
  if (!Number.isSafeInteger(value.timestamp)) {
    throw new SecurityValidationError('Timestamp de mensaje inválido.');
  }
  const timestamp = value.timestamp as number;
  if (
    timestamp < now - MAX_PROTOCOL_MESSAGE_AGE_MS ||
    timestamp > now + MAX_PROTOCOL_CLOCK_SKEW_MS
  ) {
    throw new SecurityValidationError('El mensaje está fuera de la ventana temporal permitida.');
  }
  if (!('payload' in value)) {
    throw new SecurityValidationError('El mensaje no contiene payload.');
  }
}

/** Valida el desafío de autenticación inicial. */
export function validateAuthChallengePayload(value: unknown): asserts value is {
  nonce: string;
  deviceName?: string;
} {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Desafío de autenticación inválido.');
  }
  if (typeof value.nonce !== 'string' || value.nonce.length < 32 || value.nonce.length > 1024) {
    throw new SecurityValidationError('Nonce de autenticación inválido.');
  }
  if (
    value.deviceName !== undefined &&
    (typeof value.deviceName !== 'string' ||
      value.deviceName.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(value.deviceName))
  ) {
    throw new SecurityValidationError('Nombre de dispositivo inválido.');
  }
}

/** Valida la prueba HMAC y el desafío recíproco. */
export function validateAuthResponsePayload(value: unknown): asserts value is {
  proof: string;
  counterNonce?: string;
  deviceName?: string;
} {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Respuesta de autenticación inválida.');
  }
  if (typeof value.proof !== 'string' || value.proof.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value.proof)) {
    throw new SecurityValidationError('Prueba de autenticación inválida.');
  }
  if (
    value.counterNonce !== undefined &&
    (typeof value.counterNonce !== 'string' ||
      value.counterNonce.length < 32 ||
      value.counterNonce.length > 1024)
  ) {
    throw new SecurityValidationError('Contradesafío inválido.');
  }
  if (
    value.deviceName !== undefined &&
    (typeof value.deviceName !== 'string' ||
      value.deviceName.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(value.deviceName))
  ) {
    throw new SecurityValidationError('Nombre de dispositivo inválido.');
  }
}

/** Valida la presencia remota antes de modificar el estado del editor. */
export function validatePresencePayload(
  value: unknown,
  policy?: VaultPathPolicy
): asserts value is {
  filePath: string | null;
  pos?: number;
  selection?: { from: number; to: number };
} {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Payload de presencia inválido.');
  }
  if (value.filePath !== null) {
    if (typeof value.filePath !== 'string') {
      throw new SecurityValidationError('Ruta de presencia inválida.');
    }
    validateVaultPath(value.filePath, policy);
  }
  if (
    value.pos !== undefined &&
    (!Number.isSafeInteger(value.pos) || (value.pos as number) < 0)
  ) {
    throw new SecurityValidationError('Posición de cursor inválida.');
  }
  if (value.selection !== undefined) {
    if (!isPlainObject(value.selection)) {
      throw new SecurityValidationError('Selección remota inválida.');
    }
    for (const position of [value.selection.from, value.selection.to]) {
      if (!Number.isSafeInteger(position) || (position as number) < 0) {
        throw new SecurityValidationError('Selección remota inválida.');
      }
    }
  }
}

/** Valida una señal WebRTC antes de tocar el navegador. */
export function validateWebRtcSignal(
  value: unknown
): asserts value is
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit } {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Señal WebRTC inválida.');
  }
  if (value.type === 'offer' || value.type === 'answer') {
    if (typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > MAX_SIGNAL_LENGTH) {
      throw new SecurityValidationError('Descripción de sesión fuera de límites.');
    }
    return;
  }
  if (value.type === 'candidate') {
    if (!isPlainObject(value.candidate)) {
      throw new SecurityValidationError('Candidato ICE inválido.');
    }
    const candidate = value.candidate.candidate;
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_ICE_CANDIDATE_LENGTH) {
      throw new SecurityValidationError('Candidato ICE fuera de límites.');
    }
    if (
      value.candidate.sdpMid !== undefined &&
      typeof value.candidate.sdpMid !== 'string'
    ) {
      throw new SecurityValidationError('Candidato ICE inválido.');
    }
    if (
      value.candidate.sdpMLineIndex !== undefined &&
      (!Number.isSafeInteger(value.candidate.sdpMLineIndex) ||
        (value.candidate.sdpMLineIndex as number) < 0)
    ) {
      throw new SecurityValidationError('Candidato ICE inválido.');
    }
    return;
  }
  throw new SecurityValidationError('Tipo de señal WebRTC desconocido.');
}

/**
 * Guarda acotada de IDs aceptados para impedir replay de ciphertext AEAD.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  // Un mensaje con reloj adelantado sigue siendo válido hasta edad máxima + desfase.
  constructor(
    ttlMs: number = MAX_PROTOCOL_MESSAGE_AGE_MS + MAX_PROTOCOL_CLOCK_SKEW_MS,
    maxEntries: number = 50_000
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  public accept(messageId: string, now: number = Date.now()): boolean {
    this.prune(now);
    const expiresAt = this.seen.get(messageId);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    // Reinsertar mueve el ID al final para conservar el orden de expiración.
    this.seen.delete(messageId);
    this.seen.set(messageId, now + this.ttlMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Indica si el ID ya fue procesado y sigue dentro de la ventana de replay. */
  public isAccepted(messageId: string, now: number = Date.now()): boolean {
    this.prune(now);
    const expiresAt = this.seen.get(messageId);
    return expiresAt !== undefined && expiresAt > now;
  }

  /** Libera una reserva para permitir reintentar una operación que falló. */
  public release(messageId: string): void {
    this.seen.delete(messageId);
  }

  public prune(now: number = Date.now()): void {
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }

  /** Descarta todos los identificadores aceptados; usado al rotar la clave. */
  public clear(): void {
    this.seen.clear();
  }
}
