/**
 * OmniSync - Blossom Client (BUD-01 / BUD-02 & NIP-98)
 *
 * Cliente HTTP descentralizado para almacenamiento de blobs binarios pesados (imágenes,
 * PDFs, audios, vídeos, canvas) sobre la red Blossom de Nostr con autenticación NIP-98
 * y redundancia mediante fallback automático entre servidores públicos gratuitos.
 */

import { finalizeEvent } from 'nostr-tools';
import { validateSecureHttpUrl } from '../security/network-security';
import { isPrivateWorkerUrl, randomNonceHex } from '../security/worker-auth';

export const NIP98_AUTH_KIND = 27235;
export const MAX_BLOSSOM_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1024 MB (1 GB)
/** IV (12 bytes) + etiqueta AES-GCM (16 bytes). */
export const BLOSSOM_ENCRYPTION_OVERHEAD_BYTES = 28;
export const MAX_BLOSSOM_ENCRYPTED_SIZE_BYTES =
  MAX_BLOSSOM_FILE_SIZE_BYTES + BLOSSOM_ENCRYPTION_OVERHEAD_BYTES;
/** Ventana de validez del evento NIP-98 emitido por el cliente. */
export const NIP98_AUTH_EXPIRATION_SECONDS = 5 * 60;
/** Número máximo de destinos Blossom guardados o contactados en una operación. */
export const MAX_BLOSSOM_SERVERS = 16;
/** Tope del descriptor JSON devuelto por un servidor Blossom. */
export const MAX_BLOSSOM_DESCRIPTOR_BYTES = 16 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']);

/** Sanitiza texto externo antes de incluirlo en errores mostrados o registrados. */
function safeErrorText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 160);
}

export interface BlossomUploadResult {
  sha256: string;
  serverUrl: string;
  size: number;
}

export class BlossomClient {
  /**
   * Normaliza una URL base de servidor Blossom. La comparación posterior de
   * allowlists se hace sobre esta forma canónica.
   */
  public static normalizeServerUrl(value: unknown): string {
    const validated = validateSecureHttpUrl(value);
    const parsed = new URL(validated);
    const cleanPathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${cleanPathname}`;
  }

  /** Calcula SHA-256 en hexadecimal usando Web Crypto. */
  public static async computeSha256Hex(data: Uint8Array): Promise<string> {
    if (!(data instanceof Uint8Array)) {
      throw new Error('Los datos a resumir deben ser un Uint8Array.');
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error('Web Crypto API no disponible en este entorno.');
    }
    const digest = await subtle.digest('SHA-256', data as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Genera la cabecera de autorización HTTP NIP-98 requerida por Blossom.
   * NIP-98 vigente usa kind 27235 y el tag `payload` para el hash del cuerpo.
   */
  public static createNip98AuthHeader(
    url: string,
    method: string,
    sha256Hex: string,
    nostrSecretKey: Uint8Array
  ): string {
    const normalizedUrl = this.normalizeServerUrl(url);
    const normalizedMethod = method.toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(normalizedMethod)) {
      throw new Error('Método HTTP no permitido para NIP-98.');
    }
    if (!SHA256_HEX.test(sha256Hex)) {
      throw new Error('El hash SHA-256 de NIP-98 no es válido.');
    }
    if (!(nostrSecretKey instanceof Uint8Array) || nostrSecretKey.byteLength !== 32) {
      throw new Error('La clave secreta Nostr no es válida.');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tags: string[][] = [
      ['u', normalizedUrl],
      ['method', normalizedMethod],
      ['expiration', String(nowSec + NIP98_AUTH_EXPIRATION_SECONDS)],
      // Evento único: el servidor puede rechazar repeticiones sin falsos positivos.
      ['nonce', randomNonceHex()],
    ];
    if (['POST', 'PUT', 'PATCH'].includes(normalizedMethod)) {
      tags.push(['payload', sha256Hex]);
    }

    const event = finalizeEvent(
      {
        kind: NIP98_AUTH_KIND,
        created_at: nowSec,
        tags,
        content: '',
      },
      nostrSecretKey
    );

    const json = JSON.stringify(event);
    // Codificación segura Base64 para entornos navegador / Obsidian / Node
    let binary = '';
    const bytes = new TextEncoder().encode(json);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Event = btoa(binary);
    return `Nostr ${base64Event}`;
  }

  /**
   * Sube un blob cifrado a la red Blossom probando la lista de servidores con fallback automático.
   */
  public static async uploadBlob(
    encryptedBytes: Uint8Array,
    sha256Hex: string,
    servers: string[],
    nostrSecretKey: Uint8Array,
    timeoutMs = 45000,
    privateWorker?: { privateKey: Uint8Array; privateHosts: readonly string[] }
  ): Promise<BlossomUploadResult> {
    if (!(encryptedBytes instanceof Uint8Array) || encryptedBytes.byteLength === 0) {
      throw new Error('El blob cifrado está vacío o tiene un formato inválido.');
    }
    if (encryptedBytes.byteLength > MAX_BLOSSOM_ENCRYPTED_SIZE_BYTES) {
      throw new Error('El blob cifrado supera el límite máximo de Blossom.');
    }
    if (!SHA256_HEX.test(sha256Hex)) {
      throw new Error('El hash SHA-256 del blob no es válido.');
    }

    // El hash se recalcula localmente: nunca se confía en un valor remoto o en
    // una respuesta del servidor para autorizar los bytes enviados.
    const computedHash = await this.computeSha256Hex(encryptedBytes);
    if (computedHash !== sha256Hex) {
      throw new Error('El hash SHA-256 del blob no coincide con su contenido.');
    }

    const normalizedServers = this.normalizeServerList(servers);
    if (normalizedServers.length === 0) {
      throw new Error('No hay servidores Blossom configurados para la subida.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5 * 60 * 1000) {
      throw new Error('El timeout de subida Blossom no es válido.');
    }

    const errors: string[] = [];

    for (const serverUrl of normalizedServers) {
      const uploadUrl = `${serverUrl}/upload`;

      try {
        // La identidad estable solo se presenta a los Workers propios del usuario;
        // el resto de servidores ve una clave efímera no correlacionable.
        const signingKey =
          privateWorker && isPrivateWorkerUrl(serverUrl, privateWorker.privateHosts)
            ? privateWorker.privateKey
            : nostrSecretKey;
        const authHeader = this.createNip98AuthHeader(
          uploadUrl,
          'PUT',
          sha256Hex,
          signingKey
        );

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          // Las redirecciones se bloquean para impedir que un endpoint
          // configurado redirija la petición firmada a otro destino.
          const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/octet-stream',
              'X-SHA-256': sha256Hex,
            },
            body: encryptedBytes as unknown as BodyInit,
            signal: controller.signal,
            redirect: 'error',
          });

          // 200 OK, 201 Created o 409 Conflict (el blob idéntico ya existe).
          // En 200/201 se exige un descriptor BUD-01 coherente con los bytes
          // enviados: un código HTTP por sí solo no prueba la subida. Un 409
          // sin cuerpo es idempotente y se acepta; si trae descriptor, este
          // también debe ser coherente.
          if (response.status === 200 || response.status === 201 || response.status === 409) {
            const descriptor = await this.readUploadDescriptor(
              response,
              computedHash,
              encryptedBytes.byteLength
            );
            if (
              descriptor === 'valid' ||
              (response.status === 409 && descriptor === 'absent')
            ) {
              return {
                sha256: computedHash,
                serverUrl,
                size: encryptedBytes.byteLength,
              };
            }
            errors.push(`${serverUrl}: descriptor Blossom ausente o inválido`);
            continue;
          }

          // El cuerpo de error no se conserva: puede ser ilimitado y no es
          // necesario para decidir el fallback entre servidores.
          errors.push(`${serverUrl}: HTTP ${response.status}`);
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        errors.push(`${serverUrl}: ${safeErrorText(err instanceof Error ? err.message : err)}`);
      }
    }

    throw new Error(`Falló la subida Blossom en todos los servidores disponibles: ${errors.join('; ')}`);
  }

  /**
   * Lee y valida el descriptor BUD-01 devuelto tras una subida. El cuerpo se
   * acota antes de llamar a `JSON.parse` para evitar que un servidor malicioso
   * consuma memoria indefinidamente.
   */
  private static async readUploadDescriptor(
    response: Response,
    expectedHash: string,
    expectedSize: number
  ): Promise<'valid' | 'absent' | 'invalid'> {
    if (!response.body) return 'absent';

    // Lectura dedicada: distingue "sin cuerpo" de "demasiado grande", porque
    // un 409 sin cuerpo es una respuesta idempotente válida.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BLOSSOM_DESCRIPTOR_BYTES) {
        try { await reader.cancel(); } catch { }
        return 'invalid';
      }
      chunks.push(value);
    }
    if (totalBytes === 0) return 'absent';

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let descriptor: unknown;
    try {
      descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return 'invalid';
    }
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
      return 'invalid';
    }

    const value = descriptor as Record<string, unknown>;
    if (
      typeof value.sha256 !== 'string' ||
      value.sha256.toLowerCase() !== expectedHash ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size !== expectedSize ||
      typeof value.url !== 'string'
    ) {
      return 'invalid';
    }

    try {
      const descriptorUrl = new URL(value.url);
      if (
        descriptorUrl.protocol !== 'https:' ||
        !descriptorUrl.hostname ||
        descriptorUrl.username ||
        descriptorUrl.password
      ) {
        return 'invalid';
      }
    } catch {
      return 'invalid';
    }
    return 'valid';
  }

  /**
   * Descarga un blob cifrado verificando su integridad mediante SHA-256 con fallback automático.
   */
  public static async downloadBlob(
    sha256Hex: string,
    preferredServer: string,
    fallbackServers: string[],
    computeHashFn: (bytes: Uint8Array) => Promise<string>,
    timeoutMs = 30000,
    maxBytes = MAX_BLOSSOM_ENCRYPTED_SIZE_BYTES,
    expectedSize?: number
  ): Promise<Uint8Array> {
    if (!SHA256_HEX.test(sha256Hex)) {
      throw new Error('El hash SHA-256 del blob no es válido.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BLOSSOM_ENCRYPTED_SIZE_BYTES) {
      throw new Error('El límite de descarga Blossom no es válido.');
    }
    if (
      expectedSize !== undefined &&
      (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maxBytes)
    ) {
      throw new Error('El tamaño declarado del blob Blossom no es válido.');
    }

    const normalizedFallbacks = this.normalizeServerList(fallbackServers);
    if (normalizedFallbacks.length === 0) {
      throw new Error('No hay servidores Blossom configurados para la descarga.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5 * 60 * 1000) {
      throw new Error('El timeout de descarga Blossom no es válido.');
    }

    let normalizedPreferred = '';
    try {
      normalizedPreferred = this.normalizeServerUrl(preferredServer);
    } catch {
      // Un puntero remoto inválido no se usa; se prueban los servidores locales.
    }

    // El servidor preferido forma parte del evento remoto: solo se acepta si
    // coincide con la allowlist configurada localmente.
    if (!normalizedPreferred || !normalizedFallbacks.includes(normalizedPreferred)) {
      normalizedPreferred = normalizedFallbacks[0];
    }

    const candidateServers = [
      normalizedPreferred,
      ...normalizedFallbacks.filter((server) => server !== normalizedPreferred),
    ];
    const errors: string[] = [];

    for (const serverUrl of candidateServers) {
      const downloadUrl = `${serverUrl}/${sha256Hex}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(downloadUrl, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'error',
          });

          if (!response.ok) {
            errors.push(`${serverUrl}: HTTP ${response.status}`);
            continue;
          }

          const contentLength = response.headers.get('content-length');
          if (contentLength !== null) {
            const declaredSize = Number(contentLength);
            if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
              errors.push(`${serverUrl}: Content-Length inválido`);
              continue;
            }
            if (declaredSize > maxBytes) {
              errors.push(`${serverUrl}: respuesta de ${declaredSize} bytes supera el límite`);
              continue;
            }
            if (expectedSize !== undefined && declaredSize !== expectedSize) {
              errors.push(`${serverUrl}: tamaño HTTP distinto al tamaño autenticado`);
              continue;
            }
          }

          if (!response.body) {
            errors.push(`${serverUrl}: respuesta sin cuerpo legible`);
            continue;
          }

          const downloadedBytes = await this.readBodyWithLimit(response.body, maxBytes);
          if (!downloadedBytes) {
            errors.push(`${serverUrl}: respuesta vacía o superior al límite`);
            continue;
          }
          if (expectedSize !== undefined && downloadedBytes.byteLength !== expectedSize) {
            errors.push(`${serverUrl}: tamaño descargado distinto al tamaño autenticado`);
            continue;
          }

          const actualHash = await computeHashFn(downloadedBytes);
          if (actualHash.toLowerCase() !== sha256Hex.toLowerCase()) {
            errors.push(`${serverUrl}: Hash SHA-256 no coincide`);
            continue;
          }

          return downloadedBytes;
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        errors.push(`${serverUrl}: ${safeErrorText(err instanceof Error ? err.message : err)}`);
      }
    }

    throw new Error(`No se pudo descargar el archivo Blossom '${sha256Hex}': ${errors.join('; ')}`);
  }

  /** Lee un cuerpo HTTP sin permitir que exceda el límite indicado. */
  private static async readBodyWithLimit(
    body: ReadableStream<Uint8Array>,
    maxBytes: number
  ): Promise<Uint8Array | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { }
        return null;
      }
      chunks.push(value);
    }

    if (totalBytes === 0) return null;
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  /**
   * Normaliza, valida y deduplica una allowlist local de servidores Blossom.
   * La misma función se usa al guardar, al cargar ajustes y al transferir, de
   * modo que la lista persistida y la lista realmente contactada no divergen.
   */
  public static normalizeServerList(servers: unknown): string[] {
    if (!Array.isArray(servers)) return [];
    const normalized: string[] = [];
    for (const server of servers) {
      if (typeof server !== 'string') continue;
      try {
        const canonical = this.normalizeServerUrl(server);
        if (!normalized.includes(canonical)) normalized.push(canonical);
        if (normalized.length >= MAX_BLOSSOM_SERVERS) break;
      } catch {
        // Una URL local inválida se ignora; no se intenta contactar.
      }
    }
    return normalized;
  }
}
