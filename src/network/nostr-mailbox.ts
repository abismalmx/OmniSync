/**
 * OmniSync - Nostr Mailbox
 * Buzón asíncrono descentralizado cifrado en Nostr (NIP-78 kind: 30078 + NIP-40 + AES-256-GCM).
 * Permite sincronización asíncrona a costo $0 para notas Markdown (< 64 KB) cuando los pares están desconectados.
 */

import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools';
import { CryptoManager } from '../crypto/crypto-manager';
import { isValidDeviceId, ReplayGuard } from '../security/protocol-security';
import { validateSecureWebSocketUrl } from '../security/network-security';
import { isPlainObject, validateVaultPath, VaultPathPolicy, DEFAULT_VAULT_PATH_POLICY } from '../security/vault-security';
import { ConcurrencyLimiter } from '../security/concurrency-limiter';
import { sanitizeExternalError } from '../security/external-text';
import { buildAuthenticatedSignalingUrl, isPrivateWorkerUrl } from '../security/worker-auth';
import { NostrMailboxNotePayload, DEFAULT_BLOSSOM_SERVERS } from '../types';
import {
  BlossomClient,
  BLOSSOM_ENCRYPTION_OVERHEAD_BYTES,
  MAX_BLOSSOM_FILE_SIZE_BYTES,
} from './blossom-client';

export const MAX_MAILBOX_NOTE_SIZE = 64 * 1024; // 64 KB
export const MAILBOX_KIND = 30078; // NIP-78 Parameterized Replaceable Event
export const MAILBOX_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 7 días (NIP-40)
/** Límite de contenido cifrado recibido desde un relay. */
export const MAX_MAILBOX_EVENT_CONTENT_LENGTH = 256 * 1024;
/** Antigüedad máxima de un evento de buzón aceptado. */
export const MAX_MAILBOX_EVENT_AGE_SECONDS = 8 * 24 * 60 * 60;
/** Número máximo de eventos procesados en una consulta al relay. */
export const MAX_MAILBOX_EVENTS_PER_FETCH = 500;
/** Número máximo de etiquetas aceptadas en un evento de buzón. */
export const MAX_MAILBOX_EVENT_TAGS = 16;
/** Número máximo de parámetros admitidos por etiqueta. */
export const MAX_MAILBOX_TAG_PARAMETERS = 8;
/** Longitud máxima del valor de un parámetro de etiqueta. */
export const MAX_MAILBOX_TAG_VALUE_LENGTH = 1024;

/** Extensiones de texto admitidas para el buzón asíncrono y parches delta. */
export const ELIGIBLE_MAILBOX_EXTENSIONS = /\.(md|markdown|txt|canvas|json|css)$/i;
/** Número máximo de fragmentos admitidos para un parche delta multipart. */
export const MAX_DELTA_CHUNKS = 16;
/** Tamaño máximo de contenido útil por fragmento delta (48 KB antes de cifrado). */
export const DELTA_CHUNK_SIZE = 48 * 1024;
/**
 * Límite máximo total de un parche delta. Un fragmento puede quedar hasta 3
 * bytes por debajo de DELTA_CHUNK_SIZE para no partir un punto de código UTF-8,
 * por eso el tope deja ese margen en cada fragmento.
 */
export const MAX_DELTA_TOTAL_SIZE = MAX_DELTA_CHUNKS * (DELTA_CHUNK_SIZE - 3);

/** Número máximo de grupos multipart realtime retenidos simultáneamente. */
export const MAX_LIVE_MULTIPART_GROUPS = 16;
/** Tamaño máximo de un grupo multipart retenido en memoria. */
export const MAX_LIVE_MULTIPART_BYTES = MAX_DELTA_TOTAL_SIZE;
/** Longitud máxima de un identificador de grupo multipart. */
export const MAX_PATCH_ID_LENGTH = 128;
/** Antigüedad máxima de un grupo multipart incompleto. */
export const MAX_LIVE_MULTIPART_AGE_MS = 5 * 60 * 1000;
/** Tolerancia máxima hacia el futuro para el mtime incluido en un payload. */
export const MAX_MAILBOX_MTIME_SKEW_MS = 5 * 60 * 1000;
/** Diferencia máxima entre `sentAt` (cifrado) y `created_at` (firmado). */
export const MAX_MAILBOX_SENT_AT_SKEW_SECONDS = 120;
/**
 * Transferencias Blossom simultáneas permitidas. Acota el pico de memoria:
 * cada blob ocupa hasta 50 MB en claro más su copia cifrada.
 */
export const MAX_CONCURRENT_BLOSSOM_OPERATIONS = 1;
/**
 * Operaciones Blossom pendientes máximo. Las copias cifradas en espera se
 * retienen en memoria, por lo que la cola debe ser mucho menor que el límite
 * global de eventos del buzón.
 */
export const MAX_PENDING_BLOSSOM_OPERATIONS = 4;
/** Longitud máxima del mensaje de error devuelto por un relay. */
export const MAX_RELAY_ERROR_LENGTH = 120;

export interface MailboxPublishResult {
  success: boolean;
  reason?: string;
  eventId?: string;
}

/**
 * Nota pendiente de aplicar junto con las claves reservadas en el guard de
 * replay que la respaldan. Si la aplicación local falla, esas claves deben
 * liberarse para que el evento pueda procesarse de nuevo.
 */
export interface MailboxPendingNote {
  note: NostrMailboxNotePayload;
  reservationKeys: string[];
  /**
   * `created_at` del evento de origen en segundos. Permite al llamador
   * mantener la marca de consulta por debajo de los eventos que no pudieron
   * aplicarse, de modo que vuelvan a descargarse en el siguiente barrido.
   */
  eventCreatedAt: number;
}

interface MultipartGroup {
  path: string;
  baseHash: string;
  targetHash: string;
  mtime: number;
  deviceId: string;
  totalChunks: number;
  chunks: Map<number, string>;
  bytes: number;
  createdAt: number;
  /** Eventos firmados que forman este grupo, para poder reintentarlo. */
  eventIds: Set<string>;
}

interface AssembledMultipart {
  note: NostrMailboxNotePayload;
  eventIds: string[];
}

export class NostrMailbox {
  private relayUrl: string;
  private roomId: string;
  private deviceId: string;
  private pairingSecret: string;
  private cryptoManager: CryptoManager;
  private cryptoKey: CryptoKey | null = null;
  private blossomKey: CryptoKey | null = null;
  private blossomServers: string[] = [...DEFAULT_BLOSSOM_SERVERS];
  private maxBlobSizeBytes: number = 25 * 1024 * 1024;
  private vaultPathPolicy: VaultPathPolicy = { ...DEFAULT_VAULT_PATH_POLICY };
  /**
   * Identidad Nostr exclusiva del buzón. No se reutiliza para Blossom: de lo
   * contrario, un servidor Blossom podría correlacionar una subida con la
   * actividad del mismo usuario en el relay.
   */
  private mailboxSecretKey = generateSecretKey();
  /** Identidad Nostr exclusiva para autenticaciones NIP-98 de Blossom. */
  private readonly blossomSecretKey = generateSecretKey();
  /** Identidad estable y hosts propios: solo se usa con Workers del propio usuario. */
  private privateWorkerKey: Uint8Array | null = null;
  private privateWorkerHosts: string[] = [];

  /** Se invoca al restablecerse la suscripción viva tras una caída, para ponerse al día. */
  public onReconnected?: () => void;
  /** Indica si la última consulta del buzón terminó con EOSE (o truncada por límite). */
  public lastFetchComplete = true;
  private hasConnectedBefore = false;

  public onNoteReceived?: (note: NostrMailboxNotePayload) => Promise<void> | void;
  private persistentWs: WebSocket | null = null;
  private persistentSubId = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private liveSubscriptionActive = false;
  private readonly replayGuard = new ReplayGuard(MAX_MAILBOX_EVENT_AGE_SECONDS * 1000, 5000);
  private pendingPublishes = new Map<
    string,
    {
      resolve: () => void;
      reject: (err: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Ensamblador compartido por barrido inicial y push realtime. */
  private multipartMap = new Map<string, MultipartGroup>();
  /**
   * Límite global de transferencias Blossom simultáneas. Sin él, varias notas
   * de 25/50 MB podrían descargarse a la vez y multiplicar el consumo de RAM.
   */
  private readonly blossomLimiter = new ConcurrencyLimiter(
    MAX_CONCURRENT_BLOSSOM_OPERATIONS,
    MAX_PENDING_BLOSSOM_OPERATIONS
  );

  constructor(
    relayUrl: string,
    roomId: string,
    deviceId: string,
    pairingSecret: string,
    cryptoManager: CryptoManager
  ) {
    validateSecureWebSocketUrl(relayUrl);
    this.relayUrl = relayUrl;
    this.roomId = roomId;
    this.deviceId = deviceId;
    this.pairingSecret = pairingSecret;
    this.cryptoManager = cryptoManager;
  }

  public setCryptoKey(key: CryptoKey): void {
    this.cryptoKey = key;
    if (this.liveSubscriptionActive && (!this.persistentWs || this.persistentWs.readyState !== WebSocket.OPEN)) {
      this.connectPersistent();
    }
  }

  public setBlossomKey(key: CryptoKey): void {
    this.blossomKey = key;
  }

  /**
   * Configura la identidad estable con la que se autentican las subidas a los
   * Workers privados del usuario (lista ALLOWED_PUBKEYS). Con cualquier otro
   * servidor se sigue usando la clave efímera de sesión.
   */
  public setPrivateWorkerAuth(secretKey: Uint8Array, hosts: string[]): void {
    this.privateWorkerKey = secretKey;
    this.privateWorkerHosts = [...hosts];
  }

  /**
   * URL con la que abrir un WebSocket contra el relay. Un Worker propio del usuario
   * exige un token NIP-98 de un solo uso por conexión; cualquier otro relay recibe
   * la URL tal cual, sin identidad estable.
   */
  private relaySocketUrl(relayUrl: string): string {
    if (this.privateWorkerKey && isPrivateWorkerUrl(relayUrl, this.privateWorkerHosts)) {
      return buildAuthenticatedSignalingUrl(relayUrl, this.roomId, this.privateWorkerKey, Date.now(), 'mailbox');
    }
    return relayUrl;
  }

  public setBlossomConfig(servers: string[], maxBlobSizeBytes: number): void {
    // La allowlist se canonicaliza con la misma función que usa el cliente
    // HTTP. Así, la configuración persistida y los destinos realmente
    // contactados son siempre el mismo conjunto.
    this.blossomServers = BlossomClient.normalizeServerList(servers);
    this.maxBlobSizeBytes = Number.isSafeInteger(maxBlobSizeBytes) &&
      maxBlobSizeBytes > 0 &&
      maxBlobSizeBytes <= MAX_BLOSSOM_FILE_SIZE_BYTES
      ? maxBlobSizeBytes
      : 25 * 1024 * 1024;
  }

  /** Define la política local que se aplica a toda ruta recibida. */
  public setVaultPathPolicy(policy: VaultPathPolicy): void {
    this.vaultPathPolicy = {
      syncAttachments: Boolean(policy.syncAttachments),
      syncObsidianConfig: Boolean(policy.syncObsidianConfig),
    };
  }

  public isEligibleForBlossom(path: string, byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
    if (byteLength > this.maxBlobSizeBytes) return false;
    try {
      const normalized = validateVaultPath(path, this.vaultPathPolicy);
      if (normalized !== path) return false;
    } catch {
      return false;
    }
    return true;
  }

  public updateConfig(relayUrl: string, roomId: string, pairingSecret: string): void {
    validateSecureWebSocketUrl(relayUrl);
    const changed = this.relayUrl !== relayUrl || this.roomId !== roomId || this.pairingSecret !== pairingSecret;
    this.relayUrl = relayUrl;
    this.roomId = roomId;
    this.pairingSecret = pairingSecret;
    if (changed && this.persistentWs) {
      try {
        if (this.persistentWs.readyState === WebSocket.OPEN && this.persistentSubId) {
          this.persistentWs.send(JSON.stringify(['CLOSE', this.persistentSubId]));
        }
        this.persistentWs.close();
      } catch {}
      this.persistentWs = null;
      if (this.liveSubscriptionActive) {
        this.connectPersistent();
      }
    }
  }

  /**
   * Inicia la suscripción WebSocket persistente en tiempo real (100% gratuita)
   * a eventos kind: 30078 del relay de Nostr.
   */
  public startLiveSubscription(): void {
    this.liveSubscriptionActive = true;
    if (this.cryptoKey) {
      this.connectPersistent();
    }
  }

  private connectPersistent(): void {
    if (this.isDestroyed || !this.liveSubscriptionActive) return;
    if (
      this.persistentWs &&
      (this.persistentWs.readyState === WebSocket.OPEN ||
        this.persistentWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      validateSecureWebSocketUrl(this.relayUrl);
      const ws = new WebSocket(this.relaySocketUrl(this.relayUrl));
      this.persistentWs = ws;
      this.activeSockets.add(ws);
      this.persistentSubId = this.cryptoManager.generateHexId(8);

      ws.onopen = () => {
        if (this.isDestroyed || this.persistentWs !== ws) return;
        this.reconnectAttempts = 0;
        const isReconnect = this.hasConnectedBefore;
        this.hasConnectedBefore = true;
        const nowSec = Math.floor(Date.now() / 1000);
        // Suscribirse a eventos kind: 30078 para la sala actual, con margen de 120s
        const req = [
          'REQ',
          this.persistentSubId,
          {
            kinds: [MAILBOX_KIND],
            '#t': [this.roomId],
            since: Math.max(0, nowSec - 120),
          },
        ];
        try {
          ws.send(JSON.stringify(req));
        } catch {}
        if (isReconnect) {
          try {
            this.onReconnected?.();
          } catch {}
        }
      };

      ws.onmessage = async (msgEvt) => {
        if (this.isDestroyed || this.persistentWs !== ws) return;
        if (typeof msgEvt.data !== 'string' || msgEvt.data.length > MAX_MAILBOX_EVENT_CONTENT_LENGTH) {
          return;
        }

        try {
          const data = JSON.parse(msgEvt.data);
          if (!Array.isArray(data)) return;

          const [type, subOrEventId, payload, reason] = data;

          if (type === 'OK' && typeof subOrEventId === 'string') {
            const pending = this.pendingPublishes.get(subOrEventId);
            if (pending) {
              this.pendingPublishes.delete(subOrEventId);
              clearTimeout(pending.timer);
              if (payload === false) {
                pending.reject(new Error(reason || 'Relay rechazó el evento'));
              } else {
                pending.resolve();
              }
            }
            return;
          }

          if (type === 'EVENT' && subOrEventId === this.persistentSubId && payload) {
            await this.handleLiveIncomingEvent(payload);
          }
        } catch {}
      };

      ws.onerror = () => {
        // En caso de error de red, onclose gestionará la reconexión
      };

      ws.onclose = () => {
        this.activeSockets.delete(ws);
        if (this.persistentWs === ws) {
          this.persistentWs = null;
        }
        if (!this.isDestroyed && this.liveSubscriptionActive) {
          this.scheduleReconnect();
        }
      };
    } catch {
      if (!this.isDestroyed && this.liveSubscriptionActive) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || !this.liveSubscriptionActive || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, Math.min(this.reconnectAttempts++, 8)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPersistent();
    }, delay);
  }

  /**
   * Determina si un archivo es candidato para enviarse completo en el buzón asíncrono (texto y <= 64 KB).
   */
  public isEligibleForMailbox(path: string, byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    try {
      const normalized = validateVaultPath(path, this.vaultPathPolicy);
      if (normalized !== path) return false;
    } catch {
      return false;
    }
    if (!path.match(ELIGIBLE_MAILBOX_EXTENSIONS)) {
      return false;
    }
    return byteLength <= MAX_MAILBOX_NOTE_SIZE;
  }

  /**
   * Determina si un archivo de texto supera los 64 KB y requiere sincronización por parche delta.
   */
  public isEligibleForDelta(path: string, byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength <= MAX_MAILBOX_NOTE_SIZE) return false;
    try {
      const normalized = validateVaultPath(path, this.vaultPathPolicy);
      if (normalized !== path) return false;
    } catch {
      return false;
    }
    return Boolean(path.match(ELIGIBLE_MAILBOX_EXTENSIONS));
  }

  /**
   * Publica una nota cifrada en el buzón de Nostr.
   * Si isDeleted es true, publica un tombstone para propagar el borrado asíncrono.
   */
  public async publishNote(
    path: string,
    content: string,
    mtime: number,
    isDeleted = false
  ): Promise<MailboxPublishResult> {
    if (!this.cryptoKey) {
      return { success: false, reason: 'Clave criptográfica no inicializada' };
    }
    if (typeof path !== 'string' || typeof content !== 'string' || !Number.isFinite(mtime) || mtime < 0) {
      return { success: false, reason: 'Datos de nota inválidos' };
    }

    let safePath: string;
    try {
      safePath = validateVaultPath(path, this.vaultPathPolicy);
      if (safePath !== path) throw new Error('ruta no normalizada');
    } catch {
      return { success: false, reason: 'Ruta de nota no permitida' };
    }
    if (isDeleted && content.length !== 0) {
      return { success: false, reason: 'Un tombstone no puede contener contenido' };
    }

    const utf8Bytes = new TextEncoder().encode(content);
    if (!isDeleted && utf8Bytes.length > MAX_MAILBOX_NOTE_SIZE) {
      return {
        success: false,
        reason: `El archivo supera el límite de ${MAX_MAILBOX_NOTE_SIZE / 1024} KB para el buzón asíncrono`,
      };
    }

    // 1. Etiqueta base para nota completa (64 chars hex puro - corte limpio v2)
    const dTag = await this.cryptoManager.computeHmacHex(
      `${this.roomId}:${safePath}`,
      this.pairingSecret,
      'mailbox-dtag-v2'
    );

    // 2. Empaquetar y cifrar con AES-256-GCM
    const payload: NostrMailboxNotePayload = {
      path: safePath,
      content,
      mtime,
      isDeleted,
      deviceId: this.deviceId,
      sentAt: Math.floor(Date.now() / 1000),
    };

    const encrypted = await this.cryptoManager.encrypt(payload, this.cryptoKey);

    // 3. Crear y firmar evento NIP-78 con NIP-40 expiration
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + MAILBOX_EXPIRATION_SECONDS;

    const event = finalizeEvent(
      {
        kind: MAILBOX_KIND,
        created_at: nowSec,
        tags: [
          ['d', dTag],
          ['t', this.roomId],
          ['expiration', String(expSec)],
        ],
        content: JSON.stringify(encrypted),
      },
      this.mailboxSecretKey
    );

    // 4. Enviar al relay
    try {
      await this.sendEventToRelay(this.relayUrl, event);
      return { success: true, eventId: event.id };
    } catch (err: any) {
      return { success: false, reason: sanitizeExternalError(err?.message, 'Error enviando al relay') };
    }
  }

  /**
   * Calcula los límites de corte de un parche en fragmentos multipart.
   *
   * El tamaño se mide en bytes UTF-8, no en unidades UTF-16. Los límites
   * tampoco parten un surrogate pair, de modo que el texto ensamblado nunca
   * contiene caracteres de reemplazo Unicode.
   */
  private computeChunkBoundaries(
    text: string,
    chunkSize: number
  ): Array<{ start: number; end: number }> {
    const boundaries: Array<{ start: number; end: number }> = [];
    const size = Math.max(1, Math.floor(chunkSize));
    let start = 0;

    while (start < text.length) {
      let end = start;
      let bytes = 0;

      while (end < text.length) {
        const first = text.charCodeAt(end);
        let codeUnits = 1;
        let codePointBytes = 1;

        if (first >= 0xd800 && first <= 0xdbff && end + 1 < text.length) {
          const second = text.charCodeAt(end + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            codeUnits = 2;
            codePointBytes = 4;
          } else {
            codePointBytes = 3;
          }
        } else if (first >= 0xd800 && first <= 0xdfff) {
          codePointBytes = 3;
        } else if (first <= 0x7f) {
          codePointBytes = 1;
        } else if (first <= 0x7ff) {
          codePointBytes = 2;
        } else {
          codePointBytes = 3;
        }

        // No se agrega un code point que exceda el límite si el fragmento ya
        // contiene bytes. El code point completo queda para el siguiente.
        if (bytes > 0 && bytes + codePointBytes > size) break;
        bytes += codePointBytes;
        end += codeUnits;
        if (bytes >= size) break;
      }

      boundaries.push({ start, end });
      start = end;
    }

    if (boundaries.length === 0) {
      boundaries.push({ start: 0, end: 0 });
    }

    return boundaries;
  }

  /**
   * Publica un parche delta diferencial para notas que superan los 64 KB.
   * Si el parche cabe en <= 64 KB, se envía como un único evento NIP-78.
   * Si el parche mide entre 64 KB y 1 MB, se fragmenta en hasta 16 chunks multipart.
   */
  public async publishDeltaPatch(
    path: string,
    baseHash: string,
    targetHash: string,
    patch: string,
    mtime: number
  ): Promise<MailboxPublishResult> {
    if (!this.cryptoKey) {
      return { success: false, reason: 'Clave criptográfica no inicializada' };
    }
    if (
      typeof path !== 'string' ||
      typeof patch !== 'string' ||
      patch.length === 0 ||
      !Number.isFinite(mtime) ||
      mtime < 0 ||
      typeof baseHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(baseHash) ||
      typeof targetHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(targetHash)
    ) {
      return { success: false, reason: 'Metadatos de parche delta inválidos' };
    }

    let safePath: string;
    try {
      safePath = validateVaultPath(path, this.vaultPathPolicy);
      if (safePath !== path) throw new Error('ruta no normalizada');
    } catch {
      return { success: false, reason: 'Ruta de nota no permitida' };
    }

    const patchBytes = new TextEncoder().encode(patch);
    if (patchBytes.length > MAX_DELTA_TOTAL_SIZE) {
      return {
        success: false,
        reason: `El parche delta supera el límite máximo de ${MAX_DELTA_TOTAL_SIZE / 1024} KB`,
      };
    }

    // Etiqueta base para nota delta completa (64 chars hex puro)
    const baseDTag = await this.cryptoManager.computeHmacHex(
      `${this.roomId}:${safePath}`,
      this.pairingSecret,
      'mailbox-dtag-v2'
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + MAILBOX_EXPIRATION_SECONDS;

    // Caso 1: Parche cabe en un único evento (<= 64 KB)
    if (patchBytes.length <= MAX_MAILBOX_NOTE_SIZE) {
      const payload: NostrMailboxNotePayload = {
        type: 'DELTA_PATCH',
        path: safePath,
        content: patch,
        mtime,
        deviceId: this.deviceId,
        sentAt: nowSec,
        baseHash,
        targetHash,
      };

      const encrypted = await this.cryptoManager.encrypt(payload, this.cryptoKey);
      const event = finalizeEvent(
        {
          kind: MAILBOX_KIND,
          created_at: nowSec,
          tags: [
            ['d', baseDTag],
            ['t', this.roomId],
            ['expiration', String(expSec)],
          ],
          content: JSON.stringify(encrypted),
        },
        this.mailboxSecretKey
      );

      try {
        await this.sendEventToRelay(this.relayUrl, event);
        return { success: true, eventId: event.id };
      } catch (err: any) {
        return { success: false, reason: sanitizeExternalError(err?.message, 'Error enviando al relay') };
      }
    }

    // Caso 2: Parche grande (64 KB a 1 MB) -> multipart chunking
    // El corte se hace por limites de punto de codigo (no por unidades UTF-16)
    // para no partir nunca un surrogate pair (emoji) entre dos fragmentos.
    const chunkBoundaries = this.computeChunkBoundaries(patch, DELTA_CHUNK_SIZE);
    const totalChunks = chunkBoundaries.length;
    if (totalChunks > MAX_DELTA_CHUNKS) {
      return {
        success: false,
        reason: `El parche requiere ${totalChunks} fragmentos (máximo permitido: ${MAX_DELTA_CHUNKS})`,
      };
    }

    const patchId = this.cryptoManager.generateNonce().substring(0, 16);
    let lastEventId: string | undefined;

    for (let i = 0; i < totalChunks; i++) {
      const chunkText = patch.substring(chunkBoundaries[i].start, chunkBoundaries[i].end);
      const chunkPayload: NostrMailboxNotePayload = {
        type: 'DELTA_CHUNK',
        path: safePath,
        content: chunkText,
        mtime,
        deviceId: this.deviceId,
        sentAt: nowSec,
        baseHash,
        targetHash,
        chunkIndex: i,
        totalChunks,
        patchId,
      };

      const encrypted = await this.cryptoManager.encrypt(chunkPayload, this.cryptoKey);
      const chunkDTag = await this.cryptoManager.computeHmacHex(
        `${this.roomId}:${safePath}:chunk:${i}:${totalChunks}:${patchId}`,
        this.pairingSecret,
        'mailbox-dtag-v2'
      );

      const chunkEvent = finalizeEvent(
        {
          kind: MAILBOX_KIND,
          created_at: nowSec,
          tags: [
            ['d', chunkDTag],
            ['t', this.roomId],
            ['expiration', String(expSec)],
          ],
          content: JSON.stringify(encrypted),
        },
        this.mailboxSecretKey
      );

      try {
        await this.sendEventToRelay(this.relayUrl, chunkEvent);
        lastEventId = chunkEvent.id;
      } catch (err: any) {
        return {
          success: false,
          reason: `Error enviando fragmento ${i + 1}/${totalChunks}: ${sanitizeExternalError(err?.message, 'error de red')}`,
        };
      }
    }

    return { success: true, eventId: lastEventId };
  }

  /**
   * Cifra y sube un archivo pesado a la red descentralizada Blossom,
   * y difunde su puntero criptográfico a través de un evento Nostr kind: 30078.
   */
  public async publishBlobAttachment(
    path: string,
    binaryData: Uint8Array,
    mtime: number
  ): Promise<MailboxPublishResult> {
    if (!this.cryptoKey || !this.blossomKey) {
      return { success: false, reason: 'Claves criptográficas no inicializadas' };
    }
    if (typeof path !== 'string' || !Number.isFinite(mtime) || mtime < 0) {
      return { success: false, reason: 'Datos de archivo inválidos' };
    }
    if (!(binaryData instanceof Uint8Array) || binaryData.byteLength === 0) {
      return { success: false, reason: 'El archivo está vacío o tiene un formato inválido' };
    }

    let safePath: string;
    try {
      safePath = validateVaultPath(path, this.vaultPathPolicy);
      if (safePath !== path) throw new Error('ruta no normalizada');
    } catch {
      return { success: false, reason: 'Ruta no permitida por política de seguridad' };
    }

    if (binaryData.byteLength > this.maxBlobSizeBytes) {
      const maxMb = (this.maxBlobSizeBytes / (1024 * 1024)).toFixed(0);
      return {
        success: false,
        reason: `El archivo (${(binaryData.byteLength / (1024 * 1024)).toFixed(1)} MB) supera el límite configurado de ${maxMb} MB para Blossom`,
      };
    }

    try {
      // 1. Cifrar los bytes binarios con AES-256-GCM y clave Blossom
      const encryptedBlob = await this.cryptoManager.encryptBinary(binaryData, this.blossomKey);

      // 2. Calcular hash SHA-256 del blob cifrado
      const blobSha256 = await this.cryptoManager.computeSha256Hex(encryptedBlob);

      // 3. Subir el blob cifrado a Blossom con fallback automático.
      //    La subida pasa por el limitador global para que nunca haya dos
      //    blobs de 50 MB en memoria al mismo tiempo.
      const uploadRes = await this.blossomLimiter.run(() =>
        BlossomClient.uploadBlob(
          encryptedBlob,
          blobSha256,
          this.blossomServers,
          this.blossomSecretKey,
          undefined,
          this.privateWorkerKey
            ? { privateKey: this.privateWorkerKey, privateHosts: this.privateWorkerHosts }
            : undefined
        )
      );

      // 4. Ofuscar ruta en la etiqueta #d mediante HMAC-SHA256 puro (64 chars hex)
      const dTag = await this.cryptoManager.computeHmacHex(
        `${this.roomId}:${safePath}`,
        this.pairingSecret,
        'mailbox-dtag-v2'
      );

      // 5. Empaquetar payload del puntero cifrado para Nostr
      const payload: NostrMailboxNotePayload = {
        type: 'BLOB_ATTACHMENT',
        path: safePath,
        content: '',
        mtime,
        deviceId: this.deviceId,
        sentAt: Math.floor(Date.now() / 1000),
        blobSha256: uploadRes.sha256,
        blobSize: uploadRes.size,
        blobServer: uploadRes.serverUrl,
      };

      const encryptedPayload = await this.cryptoManager.encrypt(payload, this.cryptoKey);

      // 6. Firmar y enviar evento Nostr NIP-78
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = nowSec + MAILBOX_EXPIRATION_SECONDS;

      const event = finalizeEvent(
        {
          kind: MAILBOX_KIND,
          created_at: nowSec,
          tags: [
            ['d', dTag],
            ['t', this.roomId],
            ['expiration', String(expSec)],
          ],
          content: JSON.stringify(encryptedPayload),
        },
        this.mailboxSecretKey
      );

      await this.sendEventToRelay(this.relayUrl, event);
      return { success: true, eventId: event.id };
    } catch (err: any) {
      return {
        success: false,
        reason: sanitizeExternalError(err?.message, 'Error publicando adjunto en Blossom'),
      };
    }
  }

  /**
   * Descarga un blob cifrado desde Blossom y lo descifra con la clave Blossom.
   */
  public async downloadBlobAttachment(note: NostrMailboxNotePayload): Promise<Uint8Array> {
    if (!this.blossomKey) {
      throw new Error('Clave Blossom no inicializada.');
    }
    if (!note.blobSha256 || !/^[a-f0-9]{64}$/.test(note.blobSha256)) {
      throw new Error('El puntero Blossom no contiene un hash SHA-256 válido.');
    }
    if (
      typeof note.blobSize !== 'number' ||
      !Number.isSafeInteger(note.blobSize) ||
      note.blobSize <= BLOSSOM_ENCRYPTION_OVERHEAD_BYTES ||
      note.blobSize > this.maxBlobSizeBytes + BLOSSOM_ENCRYPTION_OVERHEAD_BYTES
    ) {
      throw new Error('El puntero Blossom contiene un tamaño de blob inválido.');
    }

    // Las validaciones anteriores garantizan que ambos campos existen; se
    // copian a constantes locales para que el tipo se maintenga dentro del
    // closure que ejecuta la descarga.
    const blobSha256 = note.blobSha256;
    const blobSize = note.blobSize;
    const preferred = note.blobServer || this.blossomServers[0];
    const maxEncryptedSize = this.maxBlobSizeBytes + BLOSSOM_ENCRYPTION_OVERHEAD_BYTES;
    // La descarga también pasa por el limitador global: el cuerpo completo
    // del blob permanece en memoria junto con su copia descifrada.
    const encryptedBlob = await this.blossomLimiter.run(() =>
      BlossomClient.downloadBlob(
        blobSha256,
        preferred,
        this.blossomServers,
        (bytes) => this.cryptoManager.computeSha256Hex(bytes),
        30000,
        maxEncryptedSize,
        blobSize
      )
    );

    const plaintext = await this.cryptoManager.decryptBinary(encryptedBlob, this.blossomKey);
    if (plaintext.byteLength > this.maxBlobSizeBytes) {
      throw new Error('El archivo Blossom descifrado supera el límite configurado.');
    }
    return plaintext;
  }

  /**
   * Consulta las notas y parches delta pendientes depositados en el buzón desde una marca de tiempo.
   *
   * Cada nota devuelta incluye las claves reservadas en el guard de replay que
   * la respaldan. Si la aplicación local falla, el llamador debe liberar esas
   * reservas mediante {@link releaseReservations} para permitir el reintento.
   */
  public async fetchPendingNotes(sinceTimestamp?: number): Promise<MailboxPendingNote[]> {
    if (!this.cryptoKey) {
      this.lastFetchComplete = false;
      return [];
    }

    const subId = this.cryptoManager.generateHexId(8);
    const filter: Record<string, unknown> = {
      kinds: [MAILBOX_KIND],
      '#t': [this.roomId],
    };

    if (sinceTimestamp && sinceTimestamp > 0) {
      // Buffer defensivo de 120 segundos para tolerar diferencias de reloj entre clientes
      filter.since = Math.max(0, Math.floor(sinceTimestamp / 1000) - 120);
    }

    const { events: rawEvents, complete } = await this.queryRelay(this.relayUrl, subId, filter, 3500);
    this.lastFetchComplete = complete;
    // Límite defensivo: un relay no debe poder forzar un procesamiento masivo.
    const boundedEvents = rawEvents.slice(0, MAX_MAILBOX_EVENTS_PER_FETCH);
    const resultsMap = new Map<string, MailboxPendingNote>();

    for (const evt of boundedEvents) {
      try {
        const validated = await this.decryptAndValidateEventWithId(evt);
        if (!validated) continue;
        const note = validated.note;

        // Si es de nuestro propio dispositivo y no es más reciente, ignorar
        if (note.deviceId === this.deviceId) {
          // El evento propio no se aplica: su reserva se libera para no
          // retener el ID de forma indefinida.
          this.releaseReservations([validated.eventId]);
          continue;
        }

        if (note.type === 'DELTA_CHUNK') {
          const assembled = this.addMultipartChunk(note, validated.eventId);
          if (assembled) {
            const existing = resultsMap.get(assembled.note.path);
            if (!existing || assembled.note.mtime > existing.note.mtime) {
              // La versión anterior queda liberada: fue superada por otra más
              // reciente para la misma ruta.
              if (existing) this.releaseReservations(existing.reservationKeys);
              resultsMap.set(assembled.note.path, {
                note: assembled.note,
                reservationKeys: assembled.eventIds,
                eventCreatedAt: validated.eventCreatedAt,
              });
            } else {
              this.releaseReservations(assembled.eventIds);
            }
          }
          continue;
        }

        if (note.type === 'DELTA_PATCH' && !this.isValidDeltaPatchMetadata(note)) {
          this.releaseReservations([validated.eventId]);
          continue;
        }

        const existing = resultsMap.get(note.path);
        if (!existing || note.mtime > existing.note.mtime) {
          if (existing) this.releaseReservations(existing.reservationKeys);
          resultsMap.set(note.path, {
            note,
            reservationKeys: [validated.eventId],
            eventCreatedAt: validated.eventCreatedAt,
          });
        } else {
          this.releaseReservations([validated.eventId]);
        }
      } catch {
        // Ignorar paquetes corruptos, firmas inválidas o claves no coincidentes
      }
    }

    return Array.from(resultsMap.values());
  }

  /**
   * Libera las reservas de replay de una nota que no pudo aplicarse.
   *
   * Sin esta liberación, un fallo transitorio (red caída, servidor Blossom no
   * disponible, bóveda bloqueada) convertiría el evento en un duplicado
   * descartado y el cambio se perdería de forma silenciosa.
   */
  public releaseReservations(reservationKeys: string[]): void {
    if (!Array.isArray(reservationKeys)) return;
    for (const key of reservationKeys) {
      if (typeof key === 'string' && key.length > 0) {
        this.replayGuard.release(key);
      }
    }
  }

  /**
   * Acumula un fragmento delta. Si el grupo queda completo, lo elimina del
   * mapa y devuelve el parche ensamblado; de este modo solo un consumidor
   * (barrido o realtime) puede procesarlo.
   *
   * Las reservas de replay de los fragmentos rechazados se liberan aquí: un
   * evento que no se puede usar debe poder volver a procesarse más adelante.
   *
   * @param reservationKey Clave reservada en el guard de replay para este
   * fragmento. Se conserva hasta que el grupo se complete para poder liberar
   * todas las reservas si la aplicación del parche falla.
   */
  private addMultipartChunk(
    note: NostrMailboxNotePayload,
    reservationKey: string
  ): AssembledMultipart | null {
    if (!this.isValidDeltaChunkMetadata(note)) {
      this.releaseReservations([reservationKey]);
      return null;
    }

    const now = Date.now();
    for (const [id, entry] of this.multipartMap) {
      if (now - entry.createdAt > MAX_LIVE_MULTIPART_AGE_MS) {
        this.discardMultipartGroup(id);
      }
    }

    let entry = this.multipartMap.get(note.patchId!);
    if (!entry) {
      if (this.multipartMap.size >= MAX_LIVE_MULTIPART_GROUPS) {
        const oldestId = this.multipartMap.keys().next().value;
        if (oldestId !== undefined) this.discardMultipartGroup(oldestId);
      }
      entry = {
        path: note.path,
        baseHash: note.baseHash!,
        targetHash: note.targetHash!,
        mtime: note.mtime,
        deviceId: note.deviceId,
        totalChunks: note.totalChunks!,
        chunks: new Map(),
        bytes: 0,
        createdAt: now,
        eventIds: new Set<string>(),
      };
      this.multipartMap.set(note.patchId!, entry);
    } else if (
      entry.path !== note.path ||
      entry.baseHash !== note.baseHash ||
      entry.targetHash !== note.targetHash ||
      entry.totalChunks !== note.totalChunks ||
      entry.deviceId !== note.deviceId ||
      entry.mtime !== note.mtime
    ) {
      this.discardMultipartGroup(note.patchId!);
      this.releaseReservations([reservationKey]);
      return null;
    }

    const previous = entry.chunks.get(note.chunkIndex!);
    if (previous !== undefined) {
      // El mismo fragmento con otro ID de evento es redundante: su reserva se
      // libera para no retener IDs en el guard de replay sin uso.
      if (previous === note.content) {
        this.releaseReservations([reservationKey]);
        return null;
      }
      this.discardMultipartGroup(note.patchId!);
      this.releaseReservations([reservationKey]);
      return null;
    }

    const contentBytes = new TextEncoder().encode(note.content).byteLength;
    if (entry.bytes + contentBytes > MAX_LIVE_MULTIPART_BYTES) {
      this.discardMultipartGroup(note.patchId!);
      this.releaseReservations([reservationKey]);
      return null;
    }
    entry.chunks.set(note.chunkIndex!, note.content);
    entry.bytes += contentBytes;
    entry.eventIds.add(reservationKey);

    if (entry.chunks.size !== entry.totalChunks) return null;

    const sortedPieces: string[] = [];
    for (let i = 0; i < entry.totalChunks; i++) {
      const piece = entry.chunks.get(i);
      if (piece === undefined) return null;
      sortedPieces.push(piece);
    }
    this.multipartMap.delete(note.patchId!);
    return {
      note: {
        type: 'DELTA_PATCH',
        path: entry.path,
        content: sortedPieces.join(''),
        mtime: entry.mtime,
        deviceId: entry.deviceId,
        baseHash: entry.baseHash,
        targetHash: entry.targetHash,
      },
      eventIds: Array.from(entry.eventIds),
    };
  }

  /**
   * Descarta un grupo multipart incompleto y libera las reservas de replay de
   * sus fragmentos, que nunca llegaron a aplicarse.
   */
  private discardMultipartGroup(patchId: string): void {
    const entry = this.multipartMap.get(patchId);
    if (!entry) return;
    this.multipartMap.delete(patchId);
    this.releaseReservations(Array.from(entry.eventIds));
  }

  /** Valida los metadatos comunes de un fragmento delta. */
  private isValidDeltaChunkMetadata(note: NostrMailboxNotePayload): boolean {
    return Boolean(
      typeof note.chunkIndex === 'number' &&
      Number.isInteger(note.chunkIndex) &&
      note.chunkIndex >= 0 &&
      typeof note.totalChunks === 'number' &&
      Number.isInteger(note.totalChunks) &&
      note.totalChunks > 0 &&
      note.totalChunks <= MAX_DELTA_CHUNKS &&
      note.chunkIndex < note.totalChunks &&
      typeof note.patchId === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(note.patchId) &&
      typeof note.content === 'string' &&
      new TextEncoder().encode(note.content).byteLength <= DELTA_CHUNK_SIZE &&
      typeof note.baseHash === 'string' &&
      /^[a-f0-9]{64}$/.test(note.baseHash) &&
      typeof note.targetHash === 'string' &&
      /^[a-f0-9]{64}$/.test(note.targetHash)
    );
  }

  /** Valida los hashes exigidos por un parche delta completo. */
  private isValidDeltaPatchMetadata(note: NostrMailboxNotePayload): boolean {
    return Boolean(
      typeof note.baseHash === 'string' &&
      /^[a-f0-9]{64}$/.test(note.baseHash) &&
      typeof note.targetHash === 'string' &&
      /^[a-f0-9]{64}$/.test(note.targetHash)
    );
  }

  /**
   * Valida y descifra un evento Nostr del buzón, comprobando integridad de esquema,
   * firma criptográfica, expiración y política de rutas.
   */
  private async decryptAndValidateEvent(evt: unknown): Promise<NostrMailboxNotePayload | null> {
    const validated = await this.decryptAndValidateEventWithId(evt);
    return validated ? validated.note : null;
  }

  /**
   * Igual que {@link decryptAndValidateEvent}, pero devuelve además el ID del
   * evento. Ese ID es la reserva en el guard de replay y debe liberarse si la
   * aplicación local del contenido falla, para que un reintento posterior sea
   * posible en lugar de descartarse como duplicado.
   */
  private async decryptAndValidateEventWithId(
    evt: unknown
  ): Promise<{ note: NostrMailboxNotePayload; eventId: string; eventCreatedAt: number } | null> {
    if (!this.cryptoKey || !isPlainObject(evt)) return null;
    const event = evt as unknown as Event;
    if (event.kind !== MAILBOX_KIND) return null;
    if (typeof event.id !== 'string' || !/^[a-f0-9]{64}$/.test(event.id)) return null;
    if (typeof event.pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(event.pubkey)) return null;
    if (typeof event.sig !== 'string' || !/^[a-f0-9]{128}$/.test(event.sig)) return null;
    if (typeof event.content !== 'string' || event.content.length > MAX_MAILBOX_EVENT_CONTENT_LENGTH) return null;
    if (new TextEncoder().encode(event.content).byteLength > MAX_MAILBOX_EVENT_CONTENT_LENGTH) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(event.created_at) || event.created_at < nowSec - MAX_MAILBOX_EVENT_AGE_SECONDS || event.created_at > nowSec + 60) return null;
    if (!Array.isArray(event.tags) || event.tags.length > MAX_MAILBOX_EVENT_TAGS) return null;
    for (const tag of event.tags) {
      if (
        !Array.isArray(tag) ||
        tag.length === 0 ||
        tag.length > MAX_MAILBOX_TAG_PARAMETERS ||
        tag.some((value) => typeof value !== 'string' || value.length > MAX_MAILBOX_TAG_VALUE_LENGTH)
      ) {
        return null;
      }
    }

    // Las etiquetas de aislamiento deben aparecer exactamente una vez. Aceptar
    // duplicados permitiría que relays o clientes interpretaran el mismo
    // evento con identificadores de buzón contradictorios.
    const roomTags = event.tags.filter((tag) => tag[0] === 't');
    if (roomTags.length !== 1 || roomTags[0][1] !== this.roomId) return null;
    const expirationTags = event.tags.filter((tag) => tag[0] === 'expiration');
    if (expirationTags.length !== 1 || typeof expirationTags[0][1] !== 'string') return null;
    const expiration = Number(expirationTags[0][1]);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSec || expiration > nowSec + MAILBOX_EXPIRATION_SECONDS + 60) return null;
    if (!verifyEvent(event)) return null;

    let encryptedPayload: unknown;
    try {
      encryptedPayload = JSON.parse(event.content);
    } catch {
      return null;
    }
    const decrypted = await this.cryptoManager.decrypt<unknown>(encryptedPayload, this.cryptoKey);
    if (
      !isPlainObject(decrypted) ||
      typeof decrypted.path !== 'string' ||
      typeof decrypted.content !== 'string' ||
      typeof decrypted.mtime !== 'number' ||
      !Number.isFinite(decrypted.mtime) ||
      decrypted.mtime < 0 ||
      decrypted.mtime > Date.now() + MAX_MAILBOX_MTIME_SKEW_MS ||
      typeof decrypted.deviceId !== 'string' ||
      !isValidDeviceId(decrypted.deviceId)
    ) return null;
    if (decrypted.isDeleted !== undefined && typeof decrypted.isDeleted !== 'boolean') return null;
    // El instante de envío cifrado debe coincidir con el del evento firmado: un
    // relay que copie el contenido y firme con fecha nueva no supera esta marca.
    if (
      decrypted.sentAt !== undefined &&
      (!Number.isSafeInteger(decrypted.sentAt) ||
        Math.abs((decrypted.sentAt as number) - event.created_at) > MAX_MAILBOX_SENT_AT_SKEW_SECONDS)
    ) {
      return null;
    }
    let normalizedPath: string;
    try {
      normalizedPath = validateVaultPath(decrypted.path, this.vaultPathPolicy);
    } catch {
      return null;
    }
    if (normalizedPath !== decrypted.path) return null;

    const expectedBaseDTag = await this.cryptoManager.computeHmacHex(
      `${this.roomId}:${normalizedPath}`,
      this.pairingSecret,
      'mailbox-dtag-v2'
    );
    const dTags = event.tags.filter((tag) => tag[0] === 'd');
    if (dTags.length !== 1 || typeof dTags[0][1] !== 'string') return null;

    const note = decrypted as unknown as NostrMailboxNotePayload;
    const dTagVal = dTags[0][1];
    if (note.type === 'DELTA_CHUNK') {
      if (!this.isValidDeltaChunkMetadata(note)) return null;
      const expectedChunkDTag = await this.cryptoManager.computeHmacHex(
        `${this.roomId}:${normalizedPath}:chunk:${note.chunkIndex}:${note.totalChunks}:${note.patchId}`,
        this.pairingSecret,
        'mailbox-dtag-v2'
      );
      if (dTagVal !== expectedChunkDTag) return null;
    } else if (dTagVal !== expectedBaseDTag) {
      return null;
    }

    if (note.type === 'BLOB_ATTACHMENT') {
      const maxEncryptedSize = this.maxBlobSizeBytes + BLOSSOM_ENCRYPTION_OVERHEAD_BYTES;
      if (
        typeof note.blobSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(note.blobSha256) ||
        typeof note.blobSize !== 'number' ||
        !Number.isSafeInteger(note.blobSize) ||
        note.blobSize <= BLOSSOM_ENCRYPTION_OVERHEAD_BYTES ||
        note.blobSize > maxEncryptedSize ||
        note.content !== '' ||
        typeof note.blobServer !== 'string'
      ) {
        return null;
      }

      let canonicalServer: string;
      try {
        canonicalServer = BlossomClient.normalizeServerUrl(note.blobServer);
      } catch {
        return null;
      }
      // El servidor remoto se canonicaliza, pero no se contacta directamente:
      // BlossomClient lo acepta solo si pertenece a la allowlist local.
      note.blobServer = canonicalServer;
    } else if (note.type === undefined || note.type === 'FULL_NOTE') {
      if (!ELIGIBLE_MAILBOX_EXTENSIONS.test(normalizedPath)) return null;
      if (new TextEncoder().encode(note.content).byteLength > MAX_MAILBOX_NOTE_SIZE) return null;
    } else if (note.type === 'DELTA_PATCH') {
      if (!ELIGIBLE_MAILBOX_EXTENSIONS.test(normalizedPath)) return null;
      if (new TextEncoder().encode(note.content).byteLength > MAX_MAILBOX_NOTE_SIZE) return null;
    } else if (note.type === 'DELTA_CHUNK') {
      if (!ELIGIBLE_MAILBOX_EXTENSIONS.test(normalizedPath)) return null;
      if (new TextEncoder().encode(note.content).byteLength > DELTA_CHUNK_SIZE) return null;
    } else {
      return null;
    }

    // La reserva de replay se hace únicamente después de validar el payload
    // completo: un atacante no puede agotar la tabla con eventos malformados.
    if (!this.replayGuard.accept(event.id, nowSec * 1000)) return null;
    return { note, eventId: event.id, eventCreatedAt: event.created_at };
  }

  /**
   * Procesa un evento entrante en tiempo real a través de la suscripción WebSocket.
   */
  private async handleLiveIncomingEvent(evt: unknown): Promise<void> {
    try {
      const validated = await this.decryptAndValidateEventWithId(evt);
      if (!validated) return;
      const note = validated.note;

      // Ignorar eventos publicados por este mismo dispositivo
      if (note.deviceId === this.deviceId) {
        this.releaseReservations([validated.eventId]);
        return;
      }

      if (note.type === 'DELTA_CHUNK') {
        const assembled = this.addMultipartChunk(note, validated.eventId);
        if (assembled) {
          await this.deliverNote(assembled.note, assembled.eventIds);
        }
        return;
      }

      if (note.type === 'DELTA_PATCH' && !this.isValidDeltaPatchMetadata(note)) {
        // El parche no es utilizable: su reserva se libera para no retener el
        // ID en el guard de replay de forma indefinida.
        this.releaseReservations([validated.eventId]);
        return;
      }

      await this.deliverNote(note, [validated.eventId]);
    } catch (err) {
      console.warn(
        '[OmniSync Mailbox] Error procesando evento en tiempo real:',
        sanitizeExternalError(err instanceof Error ? err.message : err, 'error desconocido')
      );
    }
  }

  /**
   * Entrega una nota al consumidor local y libera sus reservas de replay si la
   * aplicación falla.
   *
   * La reserva se mantiene si la aplicación tiene éxito: el evento ya se
   * consumió y debe descartarse ante cualquier reemisión. Si la aplicación
   * falla (error transitorio de red, de Blossom o de bóveda), la reserva se
   * libera para que un reintento posterior pueda procesar el evento.
   */
  private async deliverNote(
    note: NostrMailboxNotePayload,
    reservationKeys: string[]
  ): Promise<void> {
    try {
      await this.onNoteReceived?.(note);
    } catch (err) {
      this.releaseReservations(reservationKeys);
      throw err;
    }
  }

  private activeSockets = new Set<WebSocket>();
  private isDestroyed = false;

  public destroy(): void {
    this.isDestroyed = true;
    this.liveSubscriptionActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pendingPublishes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('El buzón se cerró antes de confirmar la publicación.'));
    }
    this.pendingPublishes.clear();
    // Los grupos multipart incompletos liberan sus reservas: nunca se aplicaron.
    for (const patchId of Array.from(this.multipartMap.keys())) {
      this.discardMultipartGroup(patchId);
    }
    this.multipartMap.clear();

    if (this.persistentWs) {
      try {
        if (this.persistentWs.readyState === WebSocket.OPEN && this.persistentSubId) {
          this.persistentWs.send(JSON.stringify(['CLOSE', this.persistentSubId]));
        }
        this.persistentWs.close();
      } catch { }
      this.persistentWs = null;
    }

    for (const ws of this.activeSockets) {
      try {
        ws.close();
      } catch { }
    }
    this.activeSockets.clear();
  }

  private sendEventToRelay(relayUrl: string, event: any, timeoutMs = 4000): Promise<void> {
    if (this.isDestroyed) {
      return Promise.reject(new Error('El buzón está cerrado.'));
    }

    // Reutilizar el WebSocket persistente si coincide con la URL y está abierto
    if (
      relayUrl === this.relayUrl &&
      this.persistentWs &&
      this.persistentWs.readyState === WebSocket.OPEN
    ) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingPublishes.delete(event.id);
          reject(new Error('El relay no confirmó la publicación antes del tiempo límite.'));
        }, timeoutMs);

        this.pendingPublishes.set(event.id, { resolve, reject, timer });
        try {
          this.persistentWs!.send(JSON.stringify(['EVENT', event]));
        } catch {
          this.pendingPublishes.delete(event.id);
          clearTimeout(timer);
          this.sendStandaloneEvent(relayUrl, event, timeoutMs).then(resolve, reject);
        }
      });
    }

    return this.sendStandaloneEvent(relayUrl, event, timeoutMs);
  }

  private sendStandaloneEvent(relayUrl: string, event: any, timeoutMs = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) {
        reject(new Error('El buzón está cerrado.'));
        return;
      }

      let resolved = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.relaySocketUrl(relayUrl));
        this.activeSockets.add(ws);
      } catch {
        reject(new Error('No se pudo abrir la conexión con el relay.'));
        return;
      }

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.activeSockets.delete(ws);
          try { ws.close(); } catch { }
          reject(new Error('El relay no confirmó la publicación antes del tiempo límite.'));
        }
      }, timeoutMs);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['EVENT', event]));
        } catch { }
      };

      ws.onmessage = (msgEvt) => {
        try {
          const parsed = JSON.parse(msgEvt.data);
          if (Array.isArray(parsed) && parsed[0] === 'OK' && parsed[1] === event.id) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              this.activeSockets.delete(ws);
              try { ws.close(); } catch { }
              if (parsed[2] === false) {
                // El texto del relay es una entrada no confiable: se sanea
                // antes de propagarlo como motivo de fallo.
                reject(
                  new Error(
                    sanitizeExternalError(
                      parsed[3],
                      'Relay rechazó el evento',
                      MAX_RELAY_ERROR_LENGTH
                    )
                  )
                );
              } else {
                resolve();
              }
            }
          }
        } catch { }
      };

      ws.onerror = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.activeSockets.delete(ws);
          try { ws.close(); } catch { }
          reject(new Error('Error de red al publicar en el relay.'));
        }
      };

      ws.onclose = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.activeSockets.delete(ws);
          reject(new Error('El relay cerró la conexión antes de confirmar la publicación.'));
        }
      };
    });
  }

  private queryRelay(
    relayUrl: string,
    subId: string,
    filter: any,
    timeoutMs = 3500
  ): Promise<{ events: any[]; complete: boolean }> {
    return new Promise((resolve) => {
      if (this.isDestroyed) {
        resolve({ events: [], complete: false });
        return;
      }

      const events: any[] = [];
      let complete = false;
      let finished = false;
      let ws: WebSocket | null = null;

      const finish = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          if (ws) {
            this.activeSockets.delete(ws);
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['CLOSE', subId]));
              }
              ws.close();
            } catch { }
          }
          resolve({ events, complete });
        }
      };

      const timer = setTimeout(finish, timeoutMs);

      try {
        ws = new WebSocket(this.relaySocketUrl(relayUrl));
        this.activeSockets.add(ws);

        ws.onopen = () => {
          try {
            ws?.send(JSON.stringify(['REQ', subId, filter]));
          } catch { }
        };

        ws.onmessage = (msgEvt) => {
          // Un relay malicioso no debe poder agotar la memoria del cliente:
          // se acotan el tamaño del frame y el número de eventos retenidos.
          if (typeof msgEvt.data === 'string') {
            if (msgEvt.data.length > MAX_MAILBOX_EVENT_CONTENT_LENGTH) {
              finish();
              return;
            }
          } else if (msgEvt.data && typeof (msgEvt.data as any).byteLength === 'number') {
            if ((msgEvt.data as any).byteLength > MAX_MAILBOX_EVENT_CONTENT_LENGTH) {
              finish();
              return;
            }
          }

          try {
            const data = JSON.parse(msgEvt.data);
            if (!Array.isArray(data)) return;

            const [type, incomingSubId, evt] = data;
            if (incomingSubId === subId) {
              if (type === 'EVENT' && evt) {
                if (events.length >= MAX_MAILBOX_EVENTS_PER_FETCH) {
                  // Suficientes eventos: se cierra la suscripción para no
                  // seguir acumulando memoria bajo control de un relay.
                  complete = true;
                  finish();
                  return;
                }
                events.push(evt);
              } else if (type === 'EOSE') {
                complete = true;
                finish();
              }
            }
          } catch { }
        };

        ws.onerror = () => finish();
        ws.onclose = () => finish();
      } catch {
        finish();
      }
    });
  }
}
