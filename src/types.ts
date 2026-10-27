/** Presets admitidos para el límite máximo de un blob Blossom. */
export type MaxBlobSizePreset = '25mb' | '50mb' | '100mb' | 'custom';

/**
 * Definiciones de tipos e interfaces para OmniSync
 */

export type DevicePlatform = 'desktop' | 'mobile';

export type SyncState = 'disconnected' | 'signaling' | 'connecting' | 'connected' | 'syncing' | 'error';

export interface PairedDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  pairedAt: number;
  lastSeen: number;
  isOnline: boolean;
  color: string;
}

export type LanguageOption = 'auto' | 'en' | 'es' | 'ru' | 'zh';

export interface OmniSyncSettings {
  language?: LanguageOption;
  deviceId: string;
  deviceName: string;
  devicePlatform: DevicePlatform;
  pairingSecret: string; // Clave maestra en memoria; persistida en SecretStorage cuando está disponible
  /** Referencia opaca al secreto de Obsidian; no es material criptográfico. */
  masterKeySecretId: string;
  roomId: string;        // ID pseudónimo de la sala de sincronización
  signalingServer: string; // URL WebSocket segura de señalización
  autoSync: boolean;
  syncAttachments: boolean;
  syncObsidianConfig: boolean;
  /** Permite el buzón asíncrono cifrado en relays Nostr públicos. */
  enableNostrMailbox: boolean;
  /** Permite almacenamiento de adjuntos y archivos pesados en la red Blossom. */
  enableBlossomSync: boolean;
  /** Servidores Blossom públicos con fallback automático. */
  blossomServers: string[];
  /** Hosts de Workers propios (host[:puerto]) a los que se presenta la identidad estable. */
  privateWorkerHosts: string[];
  /** Preset o modo de límite: '25mb' | '50mb' | 'custom' */
  maxBlobSizePreset: MaxBlobSizePreset;
  /** Límite numérico manual en megabytes configurado por el usuario */
  customMaxBlobSizeMb?: number;
  pairedDevices: PairedDevice[];
  lastSyncTimestamp: number;
  lastMailboxFetchTimestamp?: number;
  /** Rutas que requieren sincronización íntegra vía WebRTC por desfase de parche delta. */
  pendingP2PSync?: string[];
  /** Rutas locales cuya publicación en el buzón del relay falló y debe reintentarse. */
  pendingMailboxOut?: string[];
  /**
   * Lápidas de borrados locales: ruta -> mtime del archivo borrado y momento del
   * borrado. Permiten propagar borrados hechos mientras el otro dispositivo
   * estaba apagado sin que el archivo reaparezca.
   */
  deletedPaths?: Record<string, { mtime: number; deletedAt: number }>;
}

export const DEFAULT_BLOSSOM_SERVERS: string[] = [
  'https://nostr.download',
  'https://cdn.satellite.earth',
  'https://blossom.primal.net',
];

export type MailboxPayloadType = 'FULL_NOTE' | 'DELTA_PATCH' | 'DELTA_CHUNK' | 'BLOB_ATTACHMENT';

export interface NostrMailboxNotePayload {
  type?: MailboxPayloadType;
  path: string;
  content: string;
  mtime: number;
  isDeleted?: boolean;
  deviceId: string;
  /**
   * Segundos Unix de envío, dentro del texto cifrado. Liga el contenido al
   * `created_at` del evento: un relay no puede re-firmar un evento antiguo con
   * fecha nueva. Ausente en remitentes anteriores (se acepta por compatibilidad).
   */
  sentAt?: number;
  /** Hash SHA-256 del contenido base esperado antes de aplicar el parche */
  baseHash?: string;
  /** Hash SHA-256 del contenido esperado tras aplicar el parche */
  targetHash?: string;
  /** Índice de fragmento (0-indexed) para parches delta multipart */
  chunkIndex?: number;
  /** Total de fragmentos para parches delta multipart */
  totalChunks?: number;
  /** Identificador de grupo para el ensamblador multipart */
  patchId?: string;
  /** Hash SHA-256 del blob cifrado almacenado en servidores Blossom */
  blobSha256?: string;
  /** Tamaño del blob cifrado en bytes (incluye IV y etiqueta AES-GCM). */
  blobSize?: number;
  /** URL del servidor Blossom donde se depositó el blob */
  blobServer?: string;
}

export interface FileManifestEntry {
  path: string;
  mtime: number;
  size: number;
  hash: string; // SHA-256
  isBinary: boolean;
  deleted?: boolean;
}

export interface VaultManifest {
  deviceId: string;
  timestamp: number;
  files: Record<string, FileManifestEntry>;
  isLocked?: boolean;
}

export interface ManifestDelta {
  toUpload: string[];   // Rutas que el dispositivo local tiene más recientes
  toDownload: string[]; // Rutas que el remoto tiene más recientes
  conflicts: string[];  // Rutas con modificaciones concurrentes en ambos lados
  toDelete: string[];   // Archivos eliminados
}

export interface RemoteCursor {
  deviceId: string;
  deviceName: string;
  color: string;
  filePath: string;
  from: number;
  to: number;
  lastUpdate: number;
}

export interface TextOp {
  from: number;
  to: number;
  insert: string;
}

export type MessageType =
  | 'AUTH_CHALLENGE'
  | 'AUTH_RESPONSE'
  | 'AUTH_COMPLETE'
  | 'MANIFEST_EXCHANGE'
  | 'FILE_HEADER'
  | 'FILE_CHUNK'
  | 'FILE_COMPLETE'
  | 'FILE_DELETE'
  | 'FILE_RENAME'
  | 'PRESENCE_CURSOR'
  | 'LIVE_TEXT_DELTA'
  | 'PING'
  | 'PONG';

export interface EncryptedMessagePayload {
  v: number;       // Versión del protocolo
  iv: string;      // Base64 12-byte IV para AES-GCM
  ct: string;      // Base64 Ciphertext + Auth Tag
}

export interface BaseProtocolMessage {
  type: MessageType;
  senderId: string;
  messageId: string;
  timestamp: number;
  payload: unknown;
}

export interface FileChunkMessage {
  transferId: string;
  path: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // Base64 chunk
  checksum?: string;
}

export interface FileHeaderMessage {
  transferId: string;
  path: string;
  size: number;
  mtime: number;
  totalChunks: number;
  hash: string;
  isBinary: boolean;
}

export interface PresenceMessage {
  deviceId: string;
  deviceName: string;
  color: string;
  filePath: string | null;
  cursorPos?: number;
  selection?: { from: number; to: number };
}
