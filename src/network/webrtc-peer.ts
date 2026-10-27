/**
 * OmniSync - WebRTC Peer Connection Manager
 * Gestiona conexiones punto a punto RTCPeerConnection con canales de datos duales
 * (Confiable para archivos/manifiestos y Rápido para cursores en vivo).
 */

import { CryptoManager } from '../crypto/crypto-manager';
import {
  ReplayGuard,
  MAX_ENCRYPTED_MESSAGE_BYTES,
  validateAuthChallengePayload,
  validateAuthResponsePayload,
  validateBaseProtocolMessage,
  validatePresencePayload,
  validateWebRtcSignal,
} from '../security/protocol-security';
import { VaultPathPolicy } from '../security/vault-security';
import { BaseProtocolMessage, EncryptedMessagePayload } from '../types';

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

export interface WebRTCPeerOptions {
  localDeviceId: string;
  localDeviceName: string;
  remotePeerId: string;
  cryptoManager: CryptoManager;
  cryptoKey: CryptoKey;
  pairingSecret: string;
  isInitiator: boolean;
  iceServers?: RTCIceServer[];
  /** Guard compartido por todos los peers para impedir replay entre reconexiones. */
  replayGuard?: ReplayGuard;
  /** Política de rutas compartida con el orquestador. */
  vaultPathPolicy?: VaultPathPolicy;
  sendSignal: (signal: unknown) => void;
  onConnected: (peer: WebRTCPeer) => void;
  onDisconnected: (peer: WebRTCPeer) => void;
  onMessage: (peer: WebRTCPeer, msg: BaseProtocolMessage) => void;
  onLiveCursor: (peer: WebRTCPeer, data: {
    filePath: string | null;
    pos?: number;
    selection?: { from: number; to: number };
  }) => void;
}

/** Tiempo que se espera a que un estado 'disconnected' se recupere antes de darlo por caído. */
const DISCONNECT_GRACE_MS = 5000;

export class WebRTCPeer {
  public remotePeerId: string;
  public remoteDeviceName = 'Dispositivo Remoto';
  public isConnected = false;
  public isAuthenticated = false;

  private pc: RTCPeerConnection;
  private syncChannel: RTCDataChannel | null = null;
  private liveChannel: RTCDataChannel | null = null;
  private options: WebRTCPeerOptions;
  private cryptoManager: CryptoManager;
  private cryptoKey: CryptoKey;
  private authChallengeNonce = '';
  private replayGuard: ReplayGuard;
  private vaultPathPolicy?: VaultPathPolicy;
  private authState: 'idle' | 'challenge_sent' | 'awaiting_counter' | 'authenticated' = 'idle';
  private counterChallengeNonce = '';

  constructor(options: WebRTCPeerOptions) {
    this.options = options;
    this.remotePeerId = options.remotePeerId;
    this.cryptoManager = options.cryptoManager;
    this.cryptoKey = options.cryptoKey;
    this.replayGuard = options.replayGuard ?? new ReplayGuard();
    this.vaultPathPolicy = options.vaultPathPolicy;

    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers || DEFAULT_ICE_SERVERS,
    });

    this.setupPeerConnection();

    if (options.isInitiator) {
      this.createChannels();
      this.initiateOffer();
    }
  }

  public getSyncChannel(): RTCDataChannel | null {
    return this.syncChannel;
  }

  private setupPeerConnection(): void {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.sendSignal({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this.clearDisconnectTimer();
        this.isConnected = true;
      } else if (state === 'disconnected') {
        // 'disconnected' es transitorio: ICE puede recuperarse sin intervención.
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (this.pc.connectionState !== 'disconnected') return;
            this.isConnected = false;
            this.isAuthenticated = false;
            this.options.onDisconnected(this);
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === 'failed' || state === 'closed') {
        this.clearDisconnectTimer();
        this.isConnected = false;
        this.isAuthenticated = false;
        this.options.onDisconnected(this);
      }
    };

    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'omnisync-sync') {
        this.syncChannel = channel;
        this.bindSyncChannel(channel);
      } else if (channel.label === 'omnisync-live') {
        this.liveChannel = channel;
        this.bindLiveChannel(channel);
      }
    };
  }

  private createChannels(): void {
    // Canal ordenado y confiable para archivos y comandos
    this.syncChannel = this.pc.createDataChannel('omnisync-sync', { ordered: true });
    this.bindSyncChannel(this.syncChannel);

    // Canal rápido de baja latencia para cursores en tiempo real
    this.liveChannel = this.pc.createDataChannel('omnisync-live', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.bindLiveChannel(this.liveChannel);
  }

  private bindSyncChannel(channel: RTCDataChannel): void {
    channel.onopen = async () => {
      if (this.options.isInitiator) {
        // El desafío se genera con CSPRNG y solo puede consumirse una vez.
        this.authChallengeNonce = this.cryptoManager.generateNonce();
        this.authState = 'challenge_sent';
        await this.sendMessage({
          type: 'AUTH_CHALLENGE',
          senderId: this.options.localDeviceId,
          messageId: this.cryptoManager.generateNonce(),
          timestamp: Date.now(),
          payload: {
            nonce: this.authChallengeNonce,
            deviceName: this.options.localDeviceName,
          },
        });
      }
    };

    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > MAX_ENCRYPTED_MESSAGE_BYTES) {
          throw new Error('Mensaje WebRTC fuera de los límites permitidos.');
        }
        const encryptedPayload: EncryptedMessagePayload = JSON.parse(event.data);
        const decrypted = await this.cryptoManager.decrypt<BaseProtocolMessage>(
          encryptedPayload,
          this.cryptoKey
        );
        await this.handleProtocolMessage(decrypted);
      } catch (err) {
        console.warn('[OmniSync WebRTC] Mensaje de canal sync descartado:', err);
      }
    };

    channel.onclose = () => {
      this.isConnected = false;
      this.isAuthenticated = false;
      this.options.onDisconnected(this);
    };
  }

  private bindLiveChannel(channel: RTCDataChannel): void {
    channel.onmessage = async (event) => {
      try {
        if (!this.isAuthenticated) return;
        if (typeof event.data !== 'string' || event.data.length > MAX_ENCRYPTED_MESSAGE_BYTES) {
          throw new Error('Mensaje de presencia fuera de los límites permitidos.');
        }
        const encryptedPayload: EncryptedMessagePayload = JSON.parse(event.data);
        const message = await this.cryptoManager.decrypt<BaseProtocolMessage>(
          encryptedPayload,
          this.cryptoKey
        );
        validateBaseProtocolMessage(message, this.remotePeerId);
        if (!this.replayGuard.accept(message.messageId)) {
          throw new Error('Mensaje de presencia repetido.');
        }
        if (message.type !== 'PRESENCE_CURSOR') {
          throw new Error('Tipo de presencia inválido.');
        }
        validatePresencePayload(message.payload, this.vaultPathPolicy);
        this.options.onLiveCursor(this, message.payload);
      } catch { }
    };
  }

  private async handleProtocolMessage(msg: BaseProtocolMessage): Promise<void> {
    validateBaseProtocolMessage(msg, this.remotePeerId);
    if (!this.replayGuard.accept(msg.messageId)) {
      throw new Error('Mensaje de protocolo repetido.');
    }

    if (msg.type === 'AUTH_CHALLENGE') {
      // Solo el lado que no inició el canal atiende el desafío inicial.
      if (this.authState !== 'idle') return;
      validateAuthChallengePayload(msg.payload);
      const challenge = msg.payload.nonce;
      this.remoteDeviceName = msg.payload.deviceName || 'Dispositivo';
      const proof = await this.cryptoManager.createAuthToken(
        challenge,
        this.options.pairingSecret
      );

      // Responder con prueba HMAC y desafío recíproco. El receptor todavía no
      // marca la conexión como autenticada: debe verificar nuestra contraproba.
      const localNonce = this.cryptoManager.generateNonce();
      this.counterChallengeNonce = localNonce;
      this.authState = 'awaiting_counter';

      await this.sendMessage({
        type: 'AUTH_RESPONSE',
        senderId: this.options.localDeviceId,
        messageId: this.cryptoManager.generateNonce(),
        timestamp: Date.now(),
        payload: {
          proof,
          counterNonce: localNonce,
          deviceName: this.options.localDeviceName,
        },
      });
      return;
    }

    if (msg.type === 'AUTH_RESPONSE') {
      validateAuthResponsePayload(msg.payload);
      const proof = msg.payload.proof;
      const counterNonce = msg.payload.counterNonce;
      this.remoteDeviceName = msg.payload.deviceName || this.remoteDeviceName;

      if (this.authState === 'awaiting_counter') {
        // Verifica la contraproba: demuestra que el peer conoce la clave.
        if (!this.counterChallengeNonce || counterNonce) {
          throw new Error('Contradesafío de autenticación inválido.');
        }
        const counterValid = await this.cryptoManager.verifyAuthToken(
          this.counterChallengeNonce,
          proof,
          this.options.pairingSecret
        );
        this.counterChallengeNonce = '';
        if (!counterValid) {
          console.error('[OmniSync WebRTC] Falló la contraproba de autenticación.');
          this.close();
          return;
        }
        this.authState = 'authenticated';
        this.isAuthenticated = true;
        this.options.onConnected(this);
        return;
      }

      if (this.authState !== 'challenge_sent') {
        throw new Error('Respuesta de autenticación en un estado inesperado.');
      }
      if (!this.authChallengeNonce) {
        throw new Error('Respuesta de autenticación sin desafío activo.');
      }
      const isValid = await this.cryptoManager.verifyAuthToken(
        this.authChallengeNonce,
        proof,
        this.options.pairingSecret
      );
      if (!isValid) {
        console.error('[OmniSync WebRTC] Falló la verificación de autenticación del dispositivo remoto.');
        this.close();
        return;
      }

      // El desafío se consume: una copia posterior del mismo envelope falla.
      this.authChallengeNonce = '';

      // Probar el desafío recíproco enviado por el peer.
      if (!counterNonce) {
        throw new Error('El peer no envió un desafío recíproco.');
      }
      const counterProof = await this.cryptoManager.createAuthToken(
        counterNonce,
        this.options.pairingSecret
      );
      await this.sendMessage({
        type: 'AUTH_RESPONSE',
        senderId: this.options.localDeviceId,
        messageId: this.cryptoManager.generateNonce(),
        timestamp: Date.now(),
        payload: { proof: counterProof, deviceName: this.options.localDeviceName },
      });

      this.authState = 'authenticated';
      this.isAuthenticated = true;
      this.options.onConnected(this);
      return;
    }

    if (!this.isAuthenticated) {
      console.warn('[OmniSync WebRTC] Mensaje descartado: dispositivo remoto no autenticado.');
      return;
    }

    // Delegar al orquestador de sincronización.
    this.options.onMessage(this, msg);
  }

  public async sendMessage(msg: BaseProtocolMessage): Promise<void> {
    if (!this.syncChannel || this.syncChannel.readyState !== 'open') {
      return;
    }
    const encrypted = await this.cryptoManager.encrypt(msg, this.cryptoKey);
    this.syncChannel.send(JSON.stringify(encrypted));
  }

  public async sendLiveCursor(data: unknown): Promise<void> {
    validatePresencePayload(data, this.vaultPathPolicy);
    if (!this.liveChannel || this.liveChannel.readyState !== 'open') {
      return;
    }
    const encrypted = await this.cryptoManager.encrypt(
      {
        type: 'PRESENCE_CURSOR' as const,
        senderId: this.options.localDeviceId,
        messageId: this.cryptoManager.generateNonce(),
        timestamp: Date.now(),
        payload: data,
      },
      this.cryptoKey
    );
    this.liveChannel.send(JSON.stringify(encrypted));
  }

  private pendingCandidates: RTCIceCandidateInit[] = [];

  public async handleSignal(signal: unknown): Promise<void> {
    validateWebRtcSignal(signal);
    if (signal.type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal));
      await this.drainPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.options.sendSignal({
        type: 'answer',
        sdp: answer.sdp,
      });
    } else if (signal.type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal));
      await this.drainPendingCandidates();
    } else if (signal.type === 'candidate' && signal.candidate) {
      if (!this.pc.remoteDescription) {
        if (this.pendingCandidates.length >= 100) {
          throw new Error('Demasiados candidatos ICE pendientes.');
        }
        this.pendingCandidates.push(signal.candidate);
      } else {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (err) {
          console.warn('[OmniSync WebRTC] Error añadiendo candidato ICE:', err);
        }
      }
    }
  }

  private async drainPendingCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('[OmniSync WebRTC] Error drenando candidato ICE pendiente:', err);
        }
      }
    }
  }

  private async initiateOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.options.sendSignal({
      type: 'offer',
      sdp: offer.sdp,
    });
  }

  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  public close(): void {
    this.clearDisconnectTimer();
    if (this.syncChannel) {
      try { this.syncChannel.close(); } catch { }
      this.syncChannel = null;
    }
    if (this.liveChannel) {
      try { this.liveChannel.close(); } catch { }
      this.liveChannel = null;
    }
    try {
      this.pc.close();
    } catch { }
    this.isConnected = false;
    this.isAuthenticated = false;
    this.authState = 'idle';
    this.authChallengeNonce = '';
    this.counterChallengeNonce = '';
  }
}
