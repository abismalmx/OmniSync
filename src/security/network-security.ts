/**
 * OmniSync - Network Endpoint Security
 *
 * Política única para endpoints WebSocket. Todos los relays y servidores de
 * señalización deben usar TLS (`wss://`) y no pueden incluir credenciales.
 */

import { SecurityValidationError } from './vault-security';

/** Longitud máxima admitida para una URL de endpoint. */
export const MAX_SECURE_WEBSOCKET_URL_LENGTH = 2048;
/** Longitud máxima admitida para una URL HTTP segura. */
export const MAX_SECURE_HTTP_URL_LENGTH = 2048;

/**
 * Valida y normaliza una URL WebSocket segura.
 *
 * @throws {SecurityValidationError} si la URL no es absoluta, usa un esquema
 * distinto de `wss`, contiene credenciales o incluye caracteres de control.
 */
export function validateSecureWebSocketUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SECURE_WEBSOCKET_URL_LENGTH
  ) {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SecurityValidationError('La dirección del servidor contiene caracteres no permitidos.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }

  if (parsed.protocol !== 'wss:') {
    throw new SecurityValidationError('El servidor debe usar wss:// (TLS).');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }
  if (parsed.hash) {
    throw new SecurityValidationError('La dirección del servidor no puede contener un fragmento.');
  }

  return parsed.toString();
}

/**
 * Valida y normaliza una URL HTTP segura paraBlossom.
 *
 * Exige HTTPS y rechaza credenciales, query strings y fragmentos. La
 * comprobación de destinos internos se completa en la capa Blossom mediante
 * una allowlist explícita de servidores configurados por el usuario.
 */
export function validateSecureHttpUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SECURE_HTTP_URL_LENGTH
  ) {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SecurityValidationError('La dirección del servidor contiene caracteres no permitidos.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }

  if (parsed.protocol !== 'https:') {
    throw new SecurityValidationError('El servidor debe usar https:// (TLS).');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new SecurityValidationError('La dirección del servidor no es válida.');
  }
  if (parsed.hash || parsed.search) {
    throw new SecurityValidationError('La dirección base del servidor no puede contener query ni fragmento.');
  }

  return parsed.toString();
}
