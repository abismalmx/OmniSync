/**
 * OmniSync - Signaling Client
 * Cliente de señalización seguro con cifrado E2EE antes de transmitir cualquier SDP o ICE candidate.
 * Soporta servidores WebSocket estándar (PieSocket, SimpleWebRTC, Cloudflare, Local)
 * y Relays Descentralizados de la red Nostr (Damus, Nos.lol, Primal) con eventos efímeros firmados.
 */

import {
  finalizeEvent,
  generateSecretKey,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { CryptoManager } from '../crypto/crypto-manager';
import {
  MAX_PROTOCOL_CLOCK_SKEW_MS,
  MAX_PROTOCOL_MESSAGE_AGE_MS,
  ReplayGuard,
  isValidDeviceId,
  isValidMessageId,
  validateWebRtcSignal,
} from '../security/protocol-security';
import { isPlainObject } from '../security/vault-security';
import { validateSecureWebSocketUrl } from '../security/network-security';
import { buildAuthenticatedSignalingUrl } from '../security/worker-auth';
import { EncryptedMessagePayload } from '../types';

/** Tope de un frame WebSocket de señalización. */
export const MAX_SIGNALING_FRAME_LENGTH = 512 * 1024;
/** Edad máxima de una señal efímera Nostr. */
export const MAX_NOSTR_SIGNAL_AGE_SECONDS = 10 * 60;
/** Número máximo de etiquetas admitidas en una señal Nostr. */
export const MAX_SIGNALING_EVENT_TAGS = 16;
/** Número máximo de parámetros admitidos por etiqueta. */
export const MAX_SIGNALING_TAG_PARAMETERS = 8;
/** Longitud máxima del valor de un parámetro de etiqueta. */
export const MAX_SIGNALING_TAG_VALUE_LENGTH = 1024;

type InnerSignalType =
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'join'
  | 'peer-announce'
  | 'peer-joined'
  | 'peer-left';

interface InnerSignal {
  type: InnerSignalType;
  senderId: string;
  messageId: string;
  /** Marca de tiempo de emisión; acota la ventana de replay más allá del ReplayGuard en memoria. */
  timestamp?: number;
  targetId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

interface SignalingEnvelope {
  type: 'join' | 'signal';
  roomId: string;
  payload: EncryptedMessagePayload;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private roomId: string;
  private deviceId: string;
  private cryptoManager: CryptoManager;
  private cryptoKey: CryptoKey | null = null;
  private isDestroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isNostr = false;
  private nostrSecretKey = generateSecretKey();
  private workerAuthKey: Uint8Array | null = null;
  private readonly replayGuard = new ReplayGuard();

  public onPeerJoined?: (peerId: string) => void;
  public onPeerLeft?: (peerId: string) => void;
  public onSignalMessage?: (senderId: string, signal: unknown) => void;
  public onConnectionChange?: (connected: boolean) => void;

  constructor(
    serverUrl: string,
    roomId: string,
    deviceId: string,
    cryptoManager: CryptoManager
  ) {
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this.deviceId = deviceId;
    this.cryptoManager = cryptoManager;
    this.detectProtocol();
  }

  private detectProtocol(): void {
    // Un Worker propio autenticado habla el protocolo de sala, nunca el de Nostr.
    if (this.workerAuthKey) {
      this.isNostr = false;
      return;
    }
    let host = '';
    try {
      host = new URL(this.serverUrl).hostname.toLowerCase();
    } catch {
      host = this.serverUrl.toLowerCase();
    }
    // Coincidencia por dominio completo: `damus.io.evil.com` no es damus.io.
    const isDomainOrSubdomain = (domain: string): boolean =>
      host === domain || host.endsWith(`.${domain}`);
    this.isNostr =
      isDomainOrSubdomain('damus.io') ||
      isDomainOrSubdomain('nos.lol') ||
      isDomainOrSubdomain('primal.net') ||
      host.split('.').some((label) => label.startsWith('nostr'));
  }

  /** Activa la autenticación NIP-98 de un Worker propio (solo para hosts marcados como privados). */
  public setWorkerAuthKey(key: Uint8Array | null): void {
    this.workerAuthKey = key;
    this.detectProtocol();
  }

  /** Valida que el relay use TLS y que la URL no contenga credenciales. */
  private validateServerUrl(): void {
    validateSecureWebSocketUrl(this.serverUrl);
  }

  public setCryptoKey(key: CryptoKey): void {
    this.cryptoKey = key;
  }

  public connect(): void {
    if (this.isDestroyed || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) {
      return;
    }

    this.detectProtocol();

    try {
      this.validateServerUrl();
      // El token de acceso es de un solo uso: se firma uno nuevo en cada conexión.
      const endpoint = this.workerAuthKey
        ? buildAuthenticatedSignalingUrl(this.serverUrl, this.roomId, this.workerAuthKey)
        : this.serverUrl;
      this.ws = new WebSocket(endpoint);

      this.ws.onopen = async () => {
        if (this.onConnectionChange) this.onConnectionChange(true);

        if (this.isNostr) {
          // Suscribirse a eventos efímeros kind:25000 filtrados por la etiqueta #t (hashtag universalmente indexado)
          const req = [
            'REQ',
            this.cryptoManager.generateHexId(8),
            {
              kinds: [25000],
              '#t': [this.roomId],
            },
          ];
          this.sendRaw(req);

          // La presencia se cifra; el relay solo ve la sala pseudónima.
          await this.sendEncrypted('join', {
            type: 'peer-joined',
            senderId: this.deviceId,
            messageId: this.cryptoManager.generateNonce(),
          });
        } else {
          // Protocolo estándar de sala. La identidad del emisor va cifrada.
          await this.sendEncrypted('join', {
            type: 'join',
            senderId: this.deviceId,
            messageId: this.cryptoManager.generateNonce(),
          });
        }
      };

      this.ws.onmessage = async (event) => {
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_SIGNALING_FRAME_LENGTH) {
            return;
          }
          const rawData = JSON.parse(event.data);

          if (this.isNostr && Array.isArray(rawData)) {
            const [action, , nostrEvent] = rawData;
            if (action === 'EVENT') {
              await this.handleNostrEvent(nostrEvent);
            }
            return;
          }

          await this.handleIncomingEnvelope(rawData);
        } catch {
          // Ignorar mensajes irrelevantes, duplicados o corruptos.
        }
      };

      this.ws.onclose = () => {
        if (this.onConnectionChange) this.onConnectionChange(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.warn('[OmniSync Signaling] Error en WebSocket:', err);
      };
    } catch (e) {
      console.warn('[OmniSync Signaling] Error conectando a señalización:', e);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, 5000);
  }

  /** Procesa un envelope de sala estándar tras validar sala y ciphertext. */
  private async handleIncomingEnvelope(value: unknown, nostrEventId?: string): Promise<void> {
    if (!isPlainObject(value)) return;
    if (value.roomId !== this.roomId) return;
    if (value.type !== 'join' && value.type !== 'signal') return;
    if (!isPlainObject(value.payload) || !this.cryptoKey) return;

    const inner = await this.cryptoManager.decrypt<InnerSignal>(
      value.payload,
      this.cryptoKey
    );
    // El ID del evento solo se reserva tras descifrar: así un evento firmado con
    // una clave ajena y contenido basura no puede desplazar IDs legítimos del guard.
    if (nostrEventId !== undefined && !this.replayGuard.accept(nostrEventId)) return;
    this.handleInnerSignal(inner);
  }

  /** Verifica un evento Nostr antes de aceptar su contenido. */
  private async handleNostrEvent(value: unknown): Promise<void> {
    if (!isPlainObject(value)) return;
    const event = value as unknown as Event;
    if (event.kind !== 25000) return;
    if (typeof event.id !== 'string' || !/^[a-f0-9]{64}$/.test(event.id)) return;
    if (typeof event.pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(event.pubkey)) return;
    if (typeof event.sig !== 'string' || !/^[a-f0-9]{128}$/.test(event.sig)) return;
    if (typeof event.content !== 'string' || event.content.length > MAX_SIGNALING_FRAME_LENGTH) return;
    if (new TextEncoder().encode(event.content).byteLength > MAX_SIGNALING_FRAME_LENGTH) return;
    if (!Number.isSafeInteger(event.created_at)) return;

    const now = Math.floor(Date.now() / 1000);
    if (
      event.created_at < now - MAX_NOSTR_SIGNAL_AGE_SECONDS ||
      event.created_at > now + 60
    ) {
      return;
    }
    if (!Array.isArray(event.tags) || event.tags.length > MAX_SIGNALING_EVENT_TAGS) return;
    for (const tag of event.tags) {
      if (
        !Array.isArray(tag) ||
        tag.length === 0 ||
        tag.length > MAX_SIGNALING_TAG_PARAMETERS ||
        tag.some(
          (tagValue: unknown) =>
            typeof tagValue !== 'string' || tagValue.length > MAX_SIGNALING_TAG_VALUE_LENGTH
        )
      ) {
        return;
      }
    }
    const roomTags = event.tags.filter((tag) => tag[0] === 't');
    if (roomTags.length !== 1 || roomTags[0][1] !== this.roomId) {
      return;
    }
    // La etiqueta `d` es una extensión opcional de OmniSync. Si aparece, debe
    // ser única y coherente con la sala; no se exige su presencia para no
    // romper interoperabilidad con clientes anteriores que solo envían `t`.
    const dTags = event.tags.filter((tag) => tag[0] === 'd');
    if (dTags.length > 1 || (dTags.length === 1 && dTags[0][1] !== this.roomId)) {
      return;
    }
    if (!verifyEvent(event)) return;
    if (this.replayGuard.isAccepted(event.id)) return;

    try {
      await this.handleIncomingEnvelope(JSON.parse(event.content), event.id);
    } catch {
      // Contenido corrupto: se descarta.
    }
  }

  /** Aplica controles de identidad, destino, tipo y replay al mensaje descifrado. */
  private handleInnerSignal(value: InnerSignal): void {
    if (!isPlainObject(value)) return;
    if (!isValidDeviceId(value.senderId) || value.senderId === this.deviceId) return;
    if (!isValidMessageId(value.messageId)) return;
    // Sin marca de tiempo reciente una señal capturada podría reproducirse tras
    // un reinicio, cuando el ReplayGuard en memoria ya no la recuerda.
    const timestamp = value.timestamp;
    const now = Date.now();
    if (
      !Number.isSafeInteger(timestamp) ||
      (timestamp as number) < now - MAX_PROTOCOL_MESSAGE_AGE_MS ||
      (timestamp as number) > now + MAX_PROTOCOL_CLOCK_SKEW_MS
    ) {
      return;
    }
    if (value.targetId !== undefined && value.targetId !== this.deviceId) return;
    if (!this.replayGuard.accept(value.messageId)) return;

    if (value.type === 'join' || value.type === 'peer-joined') {
      this.onPeerJoined?.(value.senderId);
      return;
    }
    if (value.type === 'peer-left') {
      this.onPeerLeft?.(value.senderId);
      return;
    }
    if (value.type === 'peer-announce') {
      this.onSignalMessage?.(value.senderId, value);
      return;
    }

    validateWebRtcSignal(value);
    this.onSignalMessage?.(value.senderId, value);
  }

  /**
   * Envía una señal P2P cifrada hacia un peer de destino o a la sala.
   */
  public async sendSignal(targetId: string | undefined, signal: unknown): Promise<void> {
    if (!this.cryptoKey) {
      throw new Error('Clave criptográfica no asignada al cliente de señalización.');
    }
    if (!isPlainObject(signal)) {
      throw new Error('Señal WebRTC inválida.');
    }
    if (targetId !== undefined && !isValidDeviceId(targetId)) {
      throw new Error('Destino de señalización inválido.');
    }

    let sanitized: InnerSignal;
    if (signal.type === 'offer' || signal.type === 'answer') {
      validateWebRtcSignal(signal);
      const description = signal as { type: 'offer' | 'answer'; sdp: string };
      sanitized = {
        type: description.type,
        senderId: this.deviceId,
        messageId: this.cryptoManager.generateNonce(),
        targetId,
        sdp: description.sdp,
      };
    } else if (signal.type === 'candidate') {
      validateWebRtcSignal(signal);
      const candidate = signal as { type: 'candidate'; candidate: RTCIceCandidateInit };
      sanitized = {
        type: 'candidate',
        senderId: this.deviceId,
        messageId: this.cryptoManager.generateNonce(),
        targetId,
        candidate: candidate.candidate,
      };
    } else if (signal.type === 'peer-announce') {
      sanitized = {
        type: 'peer-announce',
        senderId: this.deviceId,
        messageId: this.cryptoManager.generateNonce(),
        targetId,
      };
    } else {
      throw new Error('Tipo de señal WebRTC desconocido.');
    }

    await this.sendEncrypted('signal', sanitized);
  }

  /** Cifra y envía un mensaje interno de señalización. */
  private async sendEncrypted(
    type: SignalingEnvelope['type'],
    inner: InnerSignal
  ): Promise<void> {
    if (!this.cryptoKey) {
      throw new Error('Clave criptográfica no asignada al cliente de señalización.');
    }
    const envelope: SignalingEnvelope = {
      type,
      roomId: this.roomId,
      payload: await this.cryptoManager.encrypt({ ...inner, timestamp: Date.now() }, this.cryptoKey),
    };

    if (this.isNostr) {
      await this.broadcastNostrSignal(envelope);
    } else {
      this.sendRaw(envelope);
    }
  }

  private async broadcastNostrSignal(data: unknown): Promise<void> {
    try {
      const event = finalizeEvent(
        {
          kind: 25000, // Ephemeral event (NIP-16/NIP-01) - los relays no lo guardan en disco
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', this.roomId],
            ['t', this.roomId],
          ],
          content: JSON.stringify(data),
        },
        this.nostrSecretKey
      );
      this.sendRaw(['EVENT', event]);
    } catch (err) {
      console.warn('[OmniSync Nostr] Error emitiendo evento efímero:', err);
    }
  }

  private sendRaw(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  public disconnect(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
