/**
 * OmniSync - FileTransfer
 *
 * Protocolo de transferencia de archivos binarios pesados (imágenes, PDFs,
 * adjuntos) sobre un `RTCDataChannel` de WebRTC.
 *
 *  - Fragmentación en chunks de 16 KB a 64 KB (configurable).
 *  - Control de flujo mediante el evento `bufferedamountlow` del
 *    `RTCDataChannel`, evitando el desbordamiento del búfer de salida.
 *  - Ensamblador con verificación de checksum SHA-256 (por chunk y del
 *    archivo completo) ANTES de escribir en el Vault.
 *
 * 100% nativo, sin dependencias externas. Compatible con Desktop y Mobile.
 */

import { App, TFile, Vault } from 'obsidian';
import { CryptoManager } from '../crypto/crypto-manager';
import {
  MAX_ACTIVE_INCOMING_TRANSFERS,
  validateFileChunk,
  validateFileHeader,
} from '../security/transfer-security';
import {
  DEFAULT_VAULT_PATH_POLICY,
  VaultPathPolicy,
  isPlainObject,
  validateVaultPath,
} from '../security/vault-security';
import { isValidTransferId } from '../security/protocol-security';
import { MySecretCompat } from '../security/mysecret-compat';
import { FileChunkMessage, FileHeaderMessage } from '../types';

/* ────────────────────────────────────────────────────────────────
 * Constantes del protocolo
 * ──────────────────────────────────────────────────────────────── */

/** Tamaño mínimo permitido para un chunk (16 KB). */
export const MIN_CHUNK_SIZE = 16 * 1024;

/** Tamaño máximo permitido para un chunk (64 KB). */
export const MAX_CHUNK_SIZE = 64 * 1024;

/**
 * Tamaño de chunk por defecto (32 KB). El fragmento viaja codificado en
 * Base64 dentro de un envelope JSON (+33 % de tamaño), por lo que 32 KB
 * mantienen el mensaje real muy por debajo del límite SCTP de 64 KB.
 */
export const CHUNK_SIZE = 32 * 1024;

/**
 * Marca de agua superior del búfer de salida del `RTCDataChannel`.
 * Cuando `bufferedAmount` la supera, el emisor espera al evento
 * `bufferedamountlow` antes de encolar el siguiente chunk.
 */
export const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;

/** Tiempo máximo de espera para que el búfer se drene antes de abortar. */
export const DRAIN_TIMEOUT_MS = 30000;

/** Tiempo máximo que puede permanecer inactiva una transferencia entrante. */
export const INCOMING_TRANSFER_TTL_MS = 5 * 60 * 1000;

/* ────────────────────────────────────────────────────────────────
 * Tipos públicos
 * ──────────────────────────────────────────────────────────────── */

/**
 * Subconjunto de la API de `RTCDataChannel` utilizado por este módulo.
 * Se declara una interfaz propia para mantener el módulo testeable y
 * desacoplo de la capa de red (`src/network/`), que es la que posee el canal.
 */
export interface DataChannelLike {
  /** Bytes pendientes de envío en el búfer del canal. */
  readonly bufferedAmount: number;
  /** Estado del canal (`connecting`, `open`, `closing`, `closed`). */
  readonly readyState: string;
  /** Umbral que dispara el evento `bufferedamountlow`. */
  bufferedAmountLowThreshold: number;
  /** Encola un mensaje de texto en el canal. */
  send(data: string): void;
  /** Suscripción al evento `bufferedamountlow`. */
  addEventListener(type: 'bufferedamountlow', listener: (ev: Event) => void): void;
  /** Baja del evento `bufferedamountlow`. */
  removeEventListener(type: 'bufferedamountlow', listener: (ev: Event) => void): void;
}

/** Progreso de una transferencia. */
export interface TransferProgress {
  transferId: string;
  path: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

/** Resultado de una transferencia completada correctamente. */
export interface CompletedTransfer {
  transferId: string;
  path: string;
  size: number;
  hash: string;
}

/** Opciones de configuración del gestor de transferencias. */
export interface FileTransferOptions {
  /** Tamaño de chunk (16 KB - 64 KB). Por defecto `CHUNK_SIZE`. */
  chunkSize?: number;
  /** Marca de agua superior del búfer de salida. */
  highWaterMark?: number;
  /** Vault usado por `writeFileToVault` para materializar archivos entrantes. */
  vault?: Vault;
  /**
   * Instancia de Obsidian. Necesaria para interoperar con MySecret: el
   * adaptador crudo (sin hook de cifrado) solo es accesible a través del
   * plugin instalado.
   */
  app?: App;
  /** Política de rutas aplicada a archivos locales y remotos. */
  vaultPathPolicy?: VaultPathPolicy;
}

/** Opciones por transferencia (sobrescriben las globales). */
export interface SendFileOptions {
  /** Tamaño de chunk específico para esta transferencia. */
  chunkSize?: number;
  /** Identificador de transferencia (generado si se omite). */
  transferId?: string;
  /** Callback de progreso. */
  onProgress?: (progress: TransferProgress) => void;
  /** Política de rutas para esta transferencia. */
  vaultPathPolicy?: VaultPathPolicy;
}

/** Resultado del procesamiento de un chunk entrante. */
export interface IncomingChunkResult {
  complete: boolean;
  path: string;
  data?: Uint8Array;
  mtime?: number;
  isBinary?: boolean;
  hash?: string;
}

/** Error propio del protocolo de transferencia. */
export class FileTransferError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'FileTransferError';
    Object.setPrototypeOf(this, FileTransferError.prototype);
  }
}

/* ────────────────────────────────────────────────────────────────
 * Utilidades internas
 * ──────────────────────────────────────────────────────────────── */

/** Convierte bytes a su representación hexadecimal en minúsculas. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** Limita el tamaño de chunk al rango permitido por el protocolo (16 KB - 64 KB). */
export function clampChunkSize(size: number): number {
  if (!Number.isFinite(size)) return CHUNK_SIZE;
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(size)));
}

/** Genera un identificador único de transferencia. */
export function createTransferId(): string {
  const globalCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalCrypto) {
    globalCrypto.getRandomValues(bytes);
  }
  return bytesToHex(bytes);
}

/**
 * Estado interno de una transferencia entrante en curso.
 */
interface IncomingTransfer {
  header: FileHeaderMessage;
  chunks: Array<Uint8Array | undefined>;
  /** Checksums SHA-256 por chunk, indexados por `chunkIndex`. */
  checksums: Array<string | undefined>;
  receivedBytes: number;
  chunksReceived: number;
  lastActivity: number;
}

/* ────────────────────────────────────────────────────────────────
 * Gestor de transferencias
 * ──────────────────────────────────────────────────────────────── */

/**
 * Gestiona el envío y la recepción de archivos mediante fragmentación
 * binaria sobre un `RTCDataChannel`.
 */
export class FileTransferManager {
  private cryptoManager: CryptoManager;
  private defaultChunkSize: number;
  private highWaterMark: number;
  private vault: Vault | null;
  /** Instancia de Obsidian para interoperar con MySecret. */
  private app: App | null;
  private vaultPathPolicy: VaultPathPolicy;

  /** Transferencias entrantes en curso, indexadas por `transferId`. */
  private activeIncomingTransfers = new Map<string, IncomingTransfer>();

  constructor(cryptoManager: CryptoManager, options: FileTransferOptions = {}) {
    this.cryptoManager = cryptoManager;
    this.defaultChunkSize = clampChunkSize(options.chunkSize ?? CHUNK_SIZE);
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.vault = options.vault ?? null;
    this.app = options.app ?? null;
    this.vaultPathPolicy = options.vaultPathPolicy ?? DEFAULT_VAULT_PATH_POLICY;
  }

  /** Actualiza la política de rutas sin recrear transferencias en curso. */
  public setVaultPathPolicy(policy: VaultPathPolicy): void {
    this.vaultPathPolicy = policy;
  }

  /** Tamaño de chunk efectivo por defecto. */
  public get chunkSize(): number {
    return this.defaultChunkSize;
  }

  /** Transferencias entrantes actualmente en curso. */
  public get activeTransferCount(): number {
    return this.activeIncomingTransfers.size;
  }

  /**
   * Divide un buffer de archivo en fragmentos listos para transmitir por
   * WebRTC DataChannel.
   *
   * El checksum SHA-256 de cada chunk se calcula aquí y viaja en el mensaje,
   * de modo que el receptor pueda validar cada fragmento de forma aislada
   * antes de ensamblar el archivo completo.
   */
  public prepareOutgoingChunks(
    path: string,
    fileData: Uint8Array,
    mtime: number,
    hash: string,
    isBinary: boolean,
    options: SendFileOptions = {}
  ): { header: FileHeaderMessage; chunks: FileChunkMessage[] } {
    const transferId = options.transferId ?? createTransferId();
    const chunkSize = clampChunkSize(options.chunkSize ?? this.defaultChunkSize);
    const pathPolicy = options.vaultPathPolicy ?? this.vaultPathPolicy;
    validateVaultPath(path, pathPolicy);
    const totalBytes = fileData.byteLength;
    // Un archivo vacío produce un único chunk vacío para no romper el protocolo.
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));

    const header: FileHeaderMessage = {
      transferId,
      path,
      size: totalBytes,
      mtime,
      totalChunks,
      hash,
      isBinary,
    };

    validateFileHeader(header, pathPolicy);

    const chunks: FileChunkMessage[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const slice = fileData.subarray(start, end);

      chunks.push({
        transferId,
        path,
        chunkIndex: i,
        totalChunks,
        data: this.cryptoManager.uint8ArrayToBase64(slice),
        // El checksum SHA-256 del chunk se calcula durante el envío (ver
        // `sendFileOverChannel`), ya que el cálculo es asíncrono y este
        // método debe permanecer síncrono para el orquestador.
      });
    }

    return { header, chunks };
  }

  /**
   * Envía un archivo por un RTCDataChannel respetando el límite de búfer
   * mediante control de congestión reactivo (`bufferedamountlow`).
   *
   * El flujo es:
   *   1. Cabecera cifrada (metadatos + hash SHA-256 del archivo completo).
   *   2. Chunks cifrados, uno a uno, esperando a que el búfer de salida se
   *      drene cuando supera la marca de agua superior.
   *   3. Mensaje de cierre (`FILE_COMPLETE`) con el hash final, que el
   *      receptor contrasta antes de escribir en el Vault.
   */
  public async sendFileOverChannel(
    channel: DataChannelLike,
    key: CryptoKey,
    header: FileHeaderMessage,
    chunks: FileChunkMessage[],
    senderId: string,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    validateFileHeader(header, this.vaultPathPolicy);
    if (channel.readyState !== 'open') {
      throw new FileTransferError(
        `Canal de datos cerrado al intentar transferir: ${header.path}`
      );
    }

    // Umbral del evento `bufferedamountlow`: se dispara cuando el búfer
    // baja por debajo de este valor.
    channel.bufferedAmountLowThreshold = this.highWaterMark;

    // 1. Cabecera del archivo (cifrada con AES-256-GCM).
    const encryptedHeader = await this.cryptoManager.encrypt(
      {
        type: 'FILE_HEADER',
        senderId,
        messageId: this.cryptoManager.generateNonce(),
        timestamp: Date.now(),
        payload: header,
      },
      key
    );
    channel.send(JSON.stringify(encryptedHeader));

    // 2. Chunks con control de congestión.
    let sentBytes = 0;

    for (const chunk of chunks) {
      if (channel.readyState !== 'open') {
        throw new FileTransferError(
          `Canal desconectado a mitad de transferencia de '${header.path}'.`
        );
      }

      // Espera a que el búfer de salida se drene por debajo de la marca
      // de agua antes de encolar el siguiente fragmento.
      await this.waitForDrain(channel, header.path);

      const chunkBytes = this.cryptoManager.base64ToUint8Array(chunk.data);

      // Checksum SHA-256 del fragmento: permite al receptor descartar
      // fragmentos corruptos de forma aislada.
      const checksum = await this.cryptoManager.computeHash(chunkBytes);

      const encryptedChunk = await this.cryptoManager.encrypt(
        {
          type: 'FILE_CHUNK',
          senderId,
          messageId: this.cryptoManager.generateNonce(),
          timestamp: Date.now(),
          payload: { ...chunk, checksum } satisfies FileChunkMessage,
        },
        key
      );
      channel.send(JSON.stringify(encryptedChunk));

      sentBytes += chunkBytes.byteLength;

      if (onProgress) {
        onProgress({
          transferId: header.transferId,
          path: header.path,
          bytesTransferred: sentBytes,
          totalBytes: header.size,
          percentage: Math.min(
            100,
            Math.round((sentBytes / (header.size || 1)) * 100)
          ),
        });
      }
    }

    // 3. Cierre de la transferencia con el hash del archivo completo.
    const encryptedComplete = await this.cryptoManager.encrypt(
      {
        type: 'FILE_COMPLETE',
        senderId,
        messageId: this.cryptoManager.generateNonce(),
        timestamp: Date.now(),
        payload: {
          transferId: header.transferId,
          path: header.path,
          size: header.size,
          hash: header.hash,
        },
      },
      key
    );
    channel.send(JSON.stringify(encryptedComplete));
  }

  /**
   * Espera a que el búfer de salida del canal se drene por debajo de la
   * marca de agua superior.
   *
   * Se escucha el evento `bufferedamountlow` del `RTCDataChannel`. Si el
   * evento no llegara (por ejemplo, en implementaciones que no lo soporten),
   * se sondea periódicamente `bufferedAmount` como respaldo.
   */
  private waitForDrain(channel: DataChannelLike, path: string): Promise<void> {
    if (channel.bufferedAmount <= this.highWaterMark) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        channel.removeEventListener('bufferedamountlow', onLow);
        if (pollTimer !== null) clearInterval(pollTimer);
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onLow = (): void => {
        if (channel.bufferedAmount <= this.highWaterMark) {
          finish();
        }
      };

      // Respaldo por sondeo: cubre implementaciones que no emiten el evento.
      pollTimer = setInterval(() => {
        if (channel.bufferedAmount <= this.highWaterMark) {
          finish();
        }
      }, 50);

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new FileTransferError(
            `Tiempo de espera agotado esperando a que se drene el búfer para '${path}'.`
          )
        );
      }, DRAIN_TIMEOUT_MS);

      channel.addEventListener('bufferedamountlow', onLow);
    });
  }

  /**
   * Registra una nueva cabecera entrante para ensamblar fragmentos.
   *
   * Si ya existía una transferencia con el mismo identificador, se descarta
   * para reiniciarla limpiamente (por ejemplo, tras una reconexión).
   */
  public registerIncomingHeader(header: unknown): void {
    validateFileHeader(header, this.vaultPathPolicy);
    this.pruneStaleTransfers();

    if (this.activeIncomingTransfers.has(header.transferId)) {
      throw new FileTransferError('Identificador de transferencia ya utilizado.');
    }
    if (this.activeIncomingTransfers.size >= MAX_ACTIVE_INCOMING_TRANSFERS) {
      throw new FileTransferError('Demasiadas transferencias entrantes simultáneas.');
    }

    this.activeIncomingTransfers.set(header.transferId, {
      header,
      chunks: new Array(header.totalChunks),
      checksums: new Array(header.totalChunks),
      receivedBytes: 0,
      chunksReceived: 0,
      lastActivity: Date.now(),
    });
  }

  /**
   * Procesa un fragmento entrante. Devuelve el archivo completo si era el
   * último bloque pendiente.
   *
   * Cada fragmento se valida contra su checksum SHA-256 individual y, al
   * completarse la transferencia, el archivo ensamblado se contrasta contra
   * el hash SHA-256 de la cabecera. El archivo solo se devuelve (y por tanto
   * solo puede escribirse en el Vault) cuando ambas verificaciones pasan.
   */
  public async handleIncomingChunk(
    chunk: unknown
  ): Promise<IncomingChunkResult> {
    if (!isPlainObject(chunk) || !isValidTransferId(chunk.transferId)) {
      throw new FileTransferError('Fragmento de archivo con formato inválido.');
    }
    const transfer = this.activeIncomingTransfers.get(chunk.transferId);
    if (!transfer) {
      return { complete: false, path: String(chunk.path ?? '') };
    }

    validateFileChunk(chunk, transfer.header, this.vaultPathPolicy);
    transfer.lastActivity = Date.now();

    // Validación del índice de fragmento.
    if (
      !Number.isInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= transfer.header.totalChunks
    ) {
      this.activeIncomingTransfers.delete(chunk.transferId);
      throw new FileTransferError(
        `Índice de fragmento fuera de rango (${chunk.chunkIndex}) para '${chunk.path}'.`
      );
    }

    // Fragmento duplicado: se ignora sin volver a contarlo.
    if (transfer.chunks[chunk.chunkIndex] !== undefined) {
      return { complete: false, path: chunk.path };
    }

    const chunkBytes = this.cryptoManager.base64ToUint8Array(chunk.data);
    if (transfer.receivedBytes + chunkBytes.byteLength > transfer.header.size) {
      this.activeIncomingTransfers.delete(chunk.transferId);
      throw new FileTransferError('Los fragmentos exceden el tamaño declarado.');
    }

    // Verificación del checksum SHA-256 del fragmento.
    if (chunk.checksum) {
      const computed = await this.cryptoManager.computeHash(chunkBytes);
      if (computed !== chunk.checksum) {
        this.activeIncomingTransfers.delete(chunk.transferId);
        throw new FileTransferError(
          `Checksum inválido en el fragmento ${chunk.chunkIndex} de '${chunk.path}'. ` +
            `Esperado: ${chunk.checksum}, calculado: ${computed}`
        );
      }
    }

    transfer.chunks[chunk.chunkIndex] = chunkBytes;
    transfer.checksums[chunk.chunkIndex] = chunk.checksum;
    transfer.receivedBytes += chunkBytes.byteLength;
    transfer.chunksReceived++;

    if (transfer.chunksReceived < transfer.header.totalChunks) {
      return { complete: false, path: chunk.path };
    }

    // Ensamblado del archivo completo.
    const fullBuffer = new Uint8Array(transfer.receivedBytes);
    let offset = 0;
    for (const piece of transfer.chunks) {
      if (!piece) {
        this.activeIncomingTransfers.delete(chunk.transferId);
        throw new FileTransferError(
          `Faltan fragmentos al ensamblar '${chunk.path}'.`
        );
      }
      fullBuffer.set(piece, offset);
      offset += piece.byteLength;
    }

    if (transfer.receivedBytes !== transfer.header.size) {
      this.activeIncomingTransfers.delete(chunk.transferId);
      throw new FileTransferError('El tamaño ensamblado no coincide con la cabecera.');
    }

    // Verificación del hash SHA-256 del archivo completo.
    const computedHash = await this.cryptoManager.computeHash(fullBuffer);
    this.activeIncomingTransfers.delete(chunk.transferId);

    if (computedHash !== transfer.header.hash) {
      throw new FileTransferError(
        `Integridad de archivo corrupta para '${transfer.header.path}'. ` +
          `Hash esperado: ${transfer.header.hash}, calculado: ${computedHash}`
      );
    }

    return {
      complete: true,
      path: transfer.header.path,
      data: fullBuffer,
      mtime: transfer.header.mtime,
      isBinary: transfer.header.isBinary,
      hash: computedHash,
    };
  }

  /**
   * Cancela y libera las transferencias entrantes que llevan demasiado tiempo
   * inactivas, evitando fugas de memoria ante transferencias interrumpidas.
   *
   * @returns Los identificadores de las transferencias canceladas.
   */
  public pruneStaleTransfers(now: number = Date.now()): string[] {
    const cancelled: string[] = [];
    for (const [id, transfer] of this.activeIncomingTransfers) {
      if (now - transfer.lastActivity > INCOMING_TRANSFER_TTL_MS) {
        this.activeIncomingTransfers.delete(id);
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  /**
   * Cancela una transferencia entrante en curso.
   */
  public cancelIncomingTransfer(transferId: string): boolean {
    return this.activeIncomingTransfers.delete(transferId);
  }

  /**
   * Materializa un archivo recibido en el Vault.
   *
   * La escritura solo se realiza si el checksum del archivo completo coincide
   * con el esperado. Si el archivo ya existe, se sobrescribe mediante
   * `modifyBinary`; en caso contrario, se crea.
   *
   * @returns `true` si el archivo se escribió correctamente.
   */
  public async writeFileToVault(
    path: string,
    data: Uint8Array,
    expectedHash: string,
    options: { mtime?: number; isBinary?: boolean } = {}
  ): Promise<boolean> {
    if (!this.vault) {
      throw new FileTransferError(
        'No hay un Vault configurado para escribir el archivo recibido.'
      );
    }

    // Verificación de integridad previa a la escritura.
    const computedHash = await this.cryptoManager.computeHash(data);
    if (computedHash !== expectedHash) {
      throw new FileTransferError(
        `Se aborta la escritura de '${path}': checksum inválido. ` +
          `Esperado: ${expectedHash}, calculado: ${computedHash}`
      );
    }

    const normalizedPath = validateVaultPath(path, this.vaultPathPolicy);
    const existing = this.vault.getAbstractFileByPath(normalizedPath);
    const isText = options.isBinary === false || Boolean(normalizedPath.match(/\.(md|txt|canvas|json|css|js)$/i));

    if (isText) {
      const text = new TextDecoder().decode(data);
      if (existing instanceof TFile) {
        if (MySecretCompat.isArmored(text)) {
          // El texto ya viene cifrado en reposo: se escribe por el adaptador
          // crudo de MySecret para no cifrarlo una segunda vez. Si no hay
          // adaptador crudo, `writeTextSafely` aborta (fail-closed).
          if (!this.app) {
            throw new FileTransferError(
              'No se puede escribir un archivo blindado sin acceso a la instancia de Obsidian.'
            );
          }
          await MySecretCompat.writeTextSafely(this.app, existing, text);
        } else {
          await this.vault.modify(existing, text);
        }
      } else {
        if (MySecretCompat.isArmored(text)) {
          if (!this.app) {
            throw new FileTransferError(
              'No se puede escribir un archivo blindado sin acceso a la instancia de Obsidian.'
            );
          }
          await MySecretCompat.createTextSafely(this.app, normalizedPath, text);
        } else {
          await this.vault.create(normalizedPath, text);
        }
      }
      return true;
    }

    // Se copia el rango exacto de bytes: `ArrayBuffer` no puede contener
    // bytes sobrantes de una vista reutilizada.
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;

    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, buffer);
    } else {
      await this.vault.createBinary(normalizedPath, buffer);
    }

    return true;
  }
}


