/**
 * OmniSync - Transfer and Manifest Security Policy
 *
 * Valida tamaños, número de fragmentos, checksums y estructura de manifests
 * antes de que puedan provocar asignaciones de memoria o escrituras indebidas.
 */

import type { FileChunkMessage, FileHeaderMessage, VaultManifest } from '../types';
import {
  DEFAULT_VAULT_PATH_POLICY,
  SecurityValidationError,
  VaultPathPolicy,
  decodeCanonicalBase64,
  isPlainObject,
  validateVaultPath,
} from './vault-security';
import {
  isValidDeviceId,
  isValidSha256,
  isValidTransferId,
} from './protocol-security';

/** Tope defensivo para un archivo recibido (128 MiB). */
export const MAX_TRANSFER_FILE_SIZE = 128 * 1024 * 1024;
/** Tope defensivo para fragmentos dentro de una transferencia. */
export const MAX_TRANSFER_CHUNKS = 8192;
/** Tamaño mínimo declarado por fragmento. */
export const MIN_TRANSFER_CHUNK_SIZE = 16 * 1024;
/** Tamaño máximo declarado por fragmento. */
export const MAX_TRANSFER_CHUNK_SIZE = 64 * 1024;
/** Número máximo de transferencias entrantes simultáneas. */
export const MAX_ACTIVE_INCOMING_TRANSFERS = 2;
/** Longitud máxima de un Base64 que representa un fragmento de 64 KiB. */
export const MAX_ENCODED_CHUNK_LENGTH = Math.ceil(MAX_TRANSFER_CHUNK_SIZE / 3) * 4 + 4;
/** Entradas máximas en un manifiesto remoto. */
export const MAX_MANIFEST_ENTRIES = 100_000;
/** Tolerancia para timestamps de archivo en el futuro. */
export const MAX_FUTURE_FILE_MTIME_MS = 5 * 60 * 1000;

/** Valida la cabecera antes de reservar memoria. */
export function validateFileHeader(
  value: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY,
  now: number = Date.now()
): asserts value is FileHeaderMessage {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Cabecera de archivo con formato inválido.');
  }
  if (!isValidTransferId(value.transferId)) {
    throw new SecurityValidationError('Identificador de transferencia inválido.');
  }
  const path = validateVaultPath(value.path, policy);
  if (path !== value.path) {
    throw new SecurityValidationError('La ruta de la cabecera no está normalizada.');
  }
  if (!Number.isInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_TRANSFER_FILE_SIZE) {
    throw new SecurityValidationError('El tamaño declarado del archivo excede el límite permitido.');
  }
  if (!Number.isInteger(value.totalChunks)) {
    throw new SecurityValidationError('Número de fragmentos inválido.');
  }
  const totalChunks = value.totalChunks as number;
  const size = value.size as number;
  const minimumChunksForSize = Math.max(1, Math.ceil(size / MAX_TRANSFER_CHUNK_SIZE));
  const maximumChunksForSize = Math.max(1, Math.ceil(size / MIN_TRANSFER_CHUNK_SIZE));
  if (
    totalChunks < minimumChunksForSize ||
    totalChunks > maximumChunksForSize ||
    totalChunks > MAX_TRANSFER_CHUNKS
  ) {
    throw new SecurityValidationError('El número de fragmentos es inconsistente con el tamaño declarado.');
  }
  if (!isValidSha256(value.hash)) {
    throw new SecurityValidationError('Hash SHA-256 de archivo inválido.');
  }
  if (
    !Number.isSafeInteger(value.mtime) ||
    (value.mtime as number) < 0 ||
    (value.mtime as number) > now + MAX_FUTURE_FILE_MTIME_MS ||
    typeof value.isBinary !== 'boolean'
  ) {
    throw new SecurityValidationError('Metadatos de archivo inválidos.');
  }
}

/** Valida un fragmento contra la cabecera y los límites del protocolo. */
export function validateFileChunk(
  value: unknown,
  header: FileHeaderMessage,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY
): asserts value is FileChunkMessage {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Fragmento de archivo con formato inválido.');
  }
  if (value.transferId !== header.transferId || value.totalChunks !== header.totalChunks) {
    throw new SecurityValidationError('El fragmento no corresponde a la cabecera de la transferencia.');
  }
  const path = validateVaultPath(value.path, policy);
  if (path !== header.path || path !== value.path) {
    throw new SecurityValidationError('La ruta del fragmento no coincide con la cabecera.');
  }
  const index = value.chunkIndex;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= header.totalChunks) {
    throw new SecurityValidationError('Índice de fragmento fuera de rango.');
  }
  if (
    typeof value.data !== 'string' ||
    value.data.length > MAX_ENCODED_CHUNK_LENGTH
  ) {
    throw new SecurityValidationError('Datos del fragmento fuera de los límites permitidos.');
  }

  const decoded = value.data === '' ? new Uint8Array(0) : decodeCanonicalBase64(value.data);
  if (decoded.byteLength > MAX_TRANSFER_CHUNK_SIZE) {
    throw new SecurityValidationError('El fragmento supera el tamaño máximo permitido.');
  }
  if (decoded.byteLength === 0 && !(header.size === 0 && value.chunkIndex === 0)) {
    throw new SecurityValidationError('El fragmento no puede estar vacío.');
  }
  if (!isValidSha256(value.checksum)) {
    throw new SecurityValidationError('Checksum SHA-256 del fragmento ausente o inválido.');
  }
}

/** Valida una orden de borrado received from a peer. */
export function validateFileDeletePayload(
  value: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY,
  now: number = Date.now()
): asserts value is { path: string; mtime: number } {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Payload de borrado inválido.');
  }
  const path = validateVaultPath(value.path, policy);
  if (path !== value.path) {
    throw new SecurityValidationError('La ruta de borrado no está normalizada.');
  }
  if (
    !Number.isSafeInteger(value.mtime) ||
    (value.mtime as number) < 0 ||
    (value.mtime as number) > now + MAX_FUTURE_FILE_MTIME_MS
  ) {
    throw new SecurityValidationError('Timestamp de borrado inválido.');
  }
}

/** Valida una orden de renombrado received from a peer. */
export function validateFileRenamePayload(
  value: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY,
  now: number = Date.now()
): asserts value is { oldPath: string; newPath: string; mtime: number } {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Payload de renombrado inválido.');
  }
  const oldPath = validateVaultPath(value.oldPath, policy);
  const newPath = validateVaultPath(value.newPath, policy);
  if (oldPath !== value.oldPath || newPath !== value.newPath) {
    throw new SecurityValidationError('Las rutas de renombrado no están normalizadas.');
  }
  if (oldPath === newPath) {
    throw new SecurityValidationError('El renombrado no puede usar la misma ruta.');
  }
  if (
    !Number.isSafeInteger(value.mtime) ||
    (value.mtime as number) < 0 ||
    (value.mtime as number) > now + MAX_FUTURE_FILE_MTIME_MS
  ) {
    throw new SecurityValidationError('Timestamp de renombrado inválido.');
  }
}

/** Valida la estructura y los límites de un manifiesto remoto. */
export function validateRemoteManifest(
  value: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY,
  now: number = Date.now()
): asserts value is VaultManifest {
  if (!isPlainObject(value) || !isPlainObject(value.files)) {
    throw new SecurityValidationError('Manifiesto remoto con formato inválido.');
  }
  if (
    !isValidDeviceId(value.deviceId) ||
    !Number.isSafeInteger(value.timestamp) ||
    (value.timestamp as number) < 0 ||
    (value.timestamp as number) > now + MAX_FUTURE_FILE_MTIME_MS
  ) {
    throw new SecurityValidationError('Metadatos del manifiesto remoto inválidos.');
  }
  if (value.isLocked !== undefined && typeof value.isLocked !== 'boolean') {
    throw new SecurityValidationError('Estado de bloqueo de manifiesto inválido.');
  }
  const entries = Object.entries(value.files);
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    throw new SecurityValidationError('El manifiesto remoto contiene demasiadas entradas.');
  }
  for (const [path, entry] of entries) {
    const normalized = validateVaultPath(path, policy);
    if (normalized !== path || !isPlainObject(entry)) {
      throw new SecurityValidationError('Entrada de manifiesto inválida.');
    }
    if (entry.path !== path || !isValidSha256(entry.hash)) {
      throw new SecurityValidationError('Ruta o hash de manifiesto inválido.');
    }
    if (!Number.isInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > MAX_TRANSFER_FILE_SIZE) {
      throw new SecurityValidationError('Tamaño de entrada de manifiesto fuera de límite.');
    }
    if (
      !Number.isSafeInteger(entry.mtime) ||
      (entry.mtime as number) < 0 ||
      (entry.mtime as number) > now + MAX_FUTURE_FILE_MTIME_MS ||
      typeof entry.isBinary !== 'boolean'
    ) {
      throw new SecurityValidationError('Metadatos de entrada de manifiesto inválidos.');
    }
    if (entry.deleted !== undefined && typeof entry.deleted !== 'boolean') {
      throw new SecurityValidationError('Marca de eliminación de manifiesto inválida.');
    }
  }
}
