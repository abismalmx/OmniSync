/**
 * OmniSync - Obsidian Plugin Main
 * Orquestador principal de sincronización P2P, presencia en vivo y cifrado de extremo a extremo.
 */

import { MarkdownView, Notice, Plugin, TFile, TFolder, normalizePath } from 'obsidian';
import { createCollabExtension } from './collab/codemirror-collab';
import {
  CryptoManager,
  MAILBOX_KEY_CONTEXT,
  SIGNALING_KEY_CONTEXT,
  BLOSSOM_KEY_CONTEXT,
} from './crypto/crypto-manager';
import {
  NostrMailbox,
  ELIGIBLE_MAILBOX_EXTENSIONS,
  MAX_MAILBOX_EVENT_AGE_SECONDS,
} from './network/nostr-mailbox';
import { SignalingClient } from './network/signaling-client';
import { BlossomClient } from './network/blossom-client';
import {
  clampMaxBlobSizeMb,
  resolveMaxBlobSizeBytes,
} from './network/blossom-providers';
import { WebRTCPeer } from './network/webrtc-peer';
import { DeltaPatchEngine } from './sync/delta-patch';
import { BaseSnapshotStore } from './sync/base-snapshot-store';
import { FileTransferManager } from './sync/file-transfer';
import { ManifestCalculator } from './sync/manifest-calc';
import { DiffMergeEngine } from './sync/diff-merge';
import { VaultWatcher } from './sync/vault-watcher';
import { ReplayGuard, isValidDeviceId } from './security/protocol-security';
import {
  MAX_TRANSFER_FILE_SIZE,
  validateFileDeletePayload,
  validateFileRenamePayload,
  validateRemoteManifest,
} from './security/transfer-security';
import {
  SecurityValidationError,
  VaultPathPolicy,
  isPlainObject,
  validateVaultPath,
} from './security/vault-security';
import {
  decideMailboxNote,
  decideRemoteDelete,
  decideRemoteRename,
  decideRemoteWrite,
} from './security/sync-policy';
import { PathOperationQueue } from './security/path-operation-queue';
import { validateSecureWebSocketUrl } from './security/network-security';
import { decodePairingPayload } from './security/pairing';
import {
  DEFAULT_PAIRING_RELAY,
  PairingGuestResult,
  PairingHostHandle,
  runPairingGuest,
  startPairingHost,
} from './network/pairing-channel';
import {
  PairingTransportKind,
  decodePairingInvite,
  PAIRING_LINK_ACTION,
  inviteUriFromLinkData,
  isPairingInviteUri,
} from './security/pairing-session';
import { sanitizeBooleanSettings } from './security/settings-security';
import { MySecretCompat } from './security/mysecret-compat';
import {
  BaseProtocolMessage,
  FileManifestEntry,
  NostrMailboxNotePayload,
  OmniSyncSettings,
  RemoteCursor,
  SyncState,
  VaultManifest,
  DEFAULT_BLOSSOM_SERVERS,
  LanguageOption,
} from './types';
import {
  buildAuthenticatedSignalingUrl,
  deriveWorkerAuthKey,
  isPrivateWorkerUrl,
  normalizeWorkerHost,
  normalizeWorkerHosts,
  workerAuthPublicKey,
} from './security/worker-auth';
import { PairingModal } from './ui/pairing-modal';
import { OmniSyncSettingTab } from './ui/settings-tab';
import { OmniSyncStatusBar } from './ui/status-bar';
import { registerOmniSyncIcons } from './ui/icons';
import { initI18n, t } from './i18n';

const DEFAULT_SETTINGS: OmniSyncSettings = {
  language: 'auto',
  deviceId: '',
  deviceName: 'Mi Dispositivo',
  devicePlatform: 'desktop',
  pairingSecret: '',
  masterKeySecretId: '',
  roomId: '',
  signalingServer: 'wss://nos.lol',
  autoSync: true,
  syncAttachments: true,
  syncObsidianConfig: false,
  enableNostrMailbox: false,
  enableBlossomSync: false,
  blossomServers: [...DEFAULT_BLOSSOM_SERVERS],
  privateWorkerHosts: [],
  maxBlobSizePreset: '25mb',
  customMaxBlobSizeMb: 25,
  pairedDevices: [],
  lastSyncTimestamp: 0,
  pendingP2PSync: [],
  deletedPaths: {},
};

/** Relays Nostr reconocidos para la sala de vinculación efímera. */
const NOSTR_PAIRING_RELAY_HOSTS = ['nos.lol', 'relay.snort.social', 'nostr.mom', 'relay.damus.io'];

const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TOMBSTONE_MAX_ENTRIES = 5000;

export default class OmniSyncPlugin extends Plugin {
  public settings: OmniSyncSettings = DEFAULT_SETTINGS;
  private cryptoManager: CryptoManager = new CryptoManager();
  private cryptoKey: CryptoKey | null = null;
  private signalingKey: CryptoKey | null = null;
  private mailboxKey: CryptoKey | null = null;
  private blossomKey: CryptoKey | null = null;
  private workerAuthKey: Uint8Array | null = null;
  private signalingRoomId = '';
  private mailboxRoomId = '';

  private statusBar: OmniSyncStatusBar | null = null;
  private ribbonIconEl: HTMLElement | null = null;
  private signalingClient: SignalingClient | null = null;
  private nostrMailbox: NostrMailbox | null = null;
  private peers = new Map<string, WebRTCPeer>();
  private readonly replayGuard = new ReplayGuard();
  private readonly mailboxPathQueue = new PathOperationQueue();
  private baseSnapshotStore: BaseSnapshotStore = new BaseSnapshotStore();
  private pendingP2PPaths: Set<string> = new Set<string>();

  private vaultWatcher: VaultWatcher | null = null;
  private fileTransferManager: FileTransferManager = new FileTransferManager(this.cryptoManager);

  private remoteCursors: RemoteCursor[] = [];
  private syncState: SyncState = 'disconnected';
  private wasMySecretLocked: boolean = false;
  private mySecretCheckInterval: any = null;

  async onload() {
    await this.loadSettings();
    initI18n(this.settings.language);
    this.pendingP2PPaths = new Set(this.settings.pendingP2PSync || []);
    await this.baseSnapshotStore.init();

    // Derivar o generar claves de identidad si es la primera vez
    await this.ensureIdentityAndKeys();

    // El almacén local de snapshots guarda texto plano de las notas: se cifra
    // con una clave derivada de la clave maestra para que nada legible
    // quede en disco fuera de la bóveda protegida por MySecret.
    await this.baseSnapshotStore.setEncryptionKey(
      this.cryptoManager,
      this.settings.pairingSecret
    );

    // 0. Registrar iconos de marca OmniSync
    registerOmniSyncIcons();

    // 1. Barra de estado interactiva
    const statusBarItem = this.addStatusBarItem();
    this.statusBar = new OmniSyncStatusBar(statusBarItem, () => {
      this.openPairingModal();
    });

    // 2. Icono en el Ribbon lateral
    this.ribbonIconEl = this.addRibbonIcon('omnisync-logo', t('ribbon.tooltip'), () => {
      this.openPairingModal();
    });
    this.ribbonIconEl.addClass('omnisync-ribbon-btn');

    // 3. Comandos de Obsidian
    this.addCommand({
      id: 'omnisync-open-pairing',
      name: t('commands.openPairing'),
      callback: () => this.openPairingModal(),
    });

    this.addCommand({
      id: 'omnisync-sync-now',
      name: t('commands.syncNow'),
      callback: () => this.triggerFullSync(),
    });

    this.addCommand({
      id: 'omnisync-repair-mysecret',
      name: t('commands.repairMySecret'),
      callback: () => this.repairDoubleEncryptedNotes(),
    });

    // Enlace del QR de vinculación: la cámara abre Obsidian y aquí se pide confirmación.
    this.registerObsidianProtocolHandler(PAIRING_LINK_ACTION, (params) => {
      void this.handlePairingLink(params.data);
    });

    // 4. Pestaña de configuración
    this.addSettingTab(new OmniSyncSettingTab(this.app, this));

    // 5. Extensión CodeMirror 6 para presencia colaborativa en vivo
    this.registerEditorExtension(
      createCollabExtension({
        getCurrentFilePath: () => {
          const activeFile = this.app.workspace.getActiveFile();
          return activeFile ? activeFile.path : null;
        },
        onLocalCursorChange: (pos, selection) => {
          this.broadcastCursorPosition(pos, selection);
        },
        getRemoteCursors: () => this.remoteCursors,
      })
    );

    // 6. Vigilante de archivos del Vault
    this.setupVaultWatcher();

    // 7. Iniciar conexión y señalización P2P
    if (this.settings.autoSync) {
      this.initNetwork();
    }

    // 8. Monitor de estado de bloqueo de MySecret para pausar/reanudar sincronización
    this.wasMySecretLocked = MySecretCompat.isLocked(this.app);
    this.mySecretCheckInterval = setInterval(() => {
      this.checkMySecretLockState();
    }, 2000);
  }

  async onunload() {
    if (this.mySecretCheckInterval) {
      clearInterval(this.mySecretCheckInterval);
      this.mySecretCheckInterval = null;
    }
    if (this.vaultWatcher) {
      this.vaultWatcher.cleanup();
    }
    this.clearPeerRetryTimers();
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    if (this.signalingClient) {
      this.signalingClient.disconnect();
    }
    if (this.nostrMailbox) {
      this.nostrMailbox.destroy();
    }
    this.baseSnapshotStore.close();
  }

  public updateRibbonTooltip(): void {
    if (this.ribbonIconEl) {
      this.ribbonIconEl.setAttribute('aria-label', t('ribbon.tooltip'));
    }
  }

  public updateLanguage(option: LanguageOption): void {
    initI18n(option);
    this.updateRibbonTooltip();
    this.statusBar?.refresh();
  }

  private async ensureIdentityAndKeys(): Promise<void> {
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.cryptoManager.generateDeviceId();
    }

    if (!this.settings.deviceName || this.settings.deviceName === 'Mi Dispositivo') {
      const isMobile = (this.app as any).isMobile;
      this.settings.devicePlatform = isMobile ? 'mobile' : 'desktop';
      this.settings.deviceName = isMobile ? 'Smartphone (Obsidian)' : 'PC Principal';
    }

    if (!this.settings.pairingSecret) {
      this.settings.pairingSecret = this.cryptoManager.generatePairingSecret();
    }

    this.settings.roomId = await this.cryptoManager.deriveRoomId(this.settings.pairingSecret);
    await this.deriveDomainKeys();
    await this.saveSettings();
  }

  /** Deriva claves e identificadores independientes para cada dominio de red. */
  private async deriveDomainKeys(): Promise<void> {
    const secret = this.settings.pairingSecret;
    this.cryptoKey = await this.cryptoManager.deriveAesKey(secret);
    this.signalingKey = await this.cryptoManager.deriveAesKey(secret, SIGNALING_KEY_CONTEXT);
    this.mailboxKey = await this.cryptoManager.deriveAesKey(secret, MAILBOX_KEY_CONTEXT);
    this.blossomKey = await this.cryptoManager.deriveAesKey(secret, BLOSSOM_KEY_CONTEXT);
    this.workerAuthKey = await deriveWorkerAuthKey(this.cryptoManager, secret);
    this.signalingRoomId = await this.cryptoManager.deriveSignalingRoomId(secret);
    this.mailboxRoomId = await this.cryptoManager.deriveMailboxRoomId(secret);
  }

  /** Clave pública que debe figurar en ALLOWED_PUBKEYS del Worker; no es secreta. */
  public get workerAuthPublicKeyHex(): string {
    return this.workerAuthKey ? workerAuthPublicKey(this.workerAuthKey) : '';
  }

  /** Firma un token de acceso para probar la conexión con el Worker desde el asistente. */
  public buildWorkerSignalingUrl(serverUrl: string, room: string): string {
    if (!this.workerAuthKey) {
      throw new Error('La identidad de acceso al Worker no está disponible.');
    }
    return buildAuthenticatedSignalingUrl(serverUrl, room, this.workerAuthKey);
  }

  /** Identificador público de señalización; no es una clave. */
  public get signalingPublicRoomId(): string {
    return this.signalingRoomId;
  }

  /** Identificador público del buzón; no es una clave. */
  public get mailboxPublicRoomId(): string {
    return this.mailboxRoomId;
  }

  public updateWatcherSettings(): void {
    if (this.vaultWatcher) {
      this.vaultWatcher.updateConfig(
        this.settings.syncAttachments,
        this.settings.syncObsidianConfig
      );
    }
    this.fileTransferManager.setVaultPathPolicy(this.vaultPathPolicy);
    if (this.nostrMailbox) {
      this.nostrMailbox.setVaultPathPolicy(this.vaultPathPolicy);
    }
  }

  /** Política única de rutas usada por todos los límites de confianza. */
  private get vaultPathPolicy(): VaultPathPolicy {
    return {
      syncAttachments: this.settings.syncAttachments,
      syncObsidianConfig: this.settings.syncObsidianConfig,
    };
  }

  /**
   * Rota la clave maestra compartida.
   *
   * La clave es compartida por todos los dispositivos, por lo que rotarla es la
   * única revocación real del acceso del dispositivo retirado. Como consecuencia,
   * los dispositivos restantes quedan desvinculados y deben emparejarse de nuevo.
   */
  public async resetMasterKey(): Promise<void> {
    // 1. Cerrar toda conexión autenticada con la clave anterior.
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.remoteCursors = [];

    // 2. Generar y derivar material nuevo: clave maestra, room IDs y claves
    //    por dominio (bóveda, señalización y buzón).
    this.settings.pairingSecret = this.cryptoManager.generatePairingSecret();
    this.settings.roomId = await this.cryptoManager.deriveRoomId(this.settings.pairingSecret);
    await this.deriveDomainKeys();

    // 3. Invalidar el estado de sincronización y la marca del buzón: la sala
    //    nueva no debe heredar marcas de tiempo de la sesión revocada.
    this.settings.pairedDevices = [];
    this.settings.lastSyncTimestamp = 0;
    this.settings.lastMailboxFetchTimestamp = 0;
    this.replayGuard.clear();

    // 4. Persistir la clave nueva en SecretStorage (nunca en data.json).
    await this.saveSettings();

    // 5. Reiniciar la red con las credenciales nuevas.
    this.initNetwork();
    this.updateStatus();
    new Notice(t('notices.newKeyGenerated'), 8000);
  }

  private setupVaultWatcher(): void {
    this.vaultWatcher = new VaultWatcher(
      this.app,
      this.cryptoManager,
      this.settings.syncAttachments,
      this.settings.syncObsidianConfig,
      {
        onFileChanged: async (path, entry, data) => {
          this.clearTombstone(path);
          await this.broadcastFileChange(path, entry, data);
        },
        onFileDeleted: async (path, mtime) => {
          this.recordTombstone(path, mtime);
          await this.broadcastFileDelete(path, mtime);
        },
        onFileRenamed: async (oldPath, newPath, mtime) => {
          this.recordTombstone(oldPath, mtime);
          this.clearTombstone(newPath);
          await this.broadcastFileRename(oldPath, newPath, mtime);
        },
      }
    );
    this.vaultWatcher.registerEvents();
  }

  public reconnectNetwork(): void {
    this.initNetwork();
  }

  private initNetwork(): void {
    if (!this.cryptoKey || !this.signalingKey) return;

    this.updateStatus('signaling');

    // Las conexiones autenticadas con una clave anterior deben cerrarse.
    this.clearPeerRetryTimers();
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();

    if (this.signalingClient) {
      this.signalingClient.disconnect();
    }

    this.signalingClient = new SignalingClient(
      this.settings.signalingServer,
      this.signalingRoomId,
      this.settings.deviceId,
      this.cryptoManager
    );
    this.signalingClient.setCryptoKey(this.signalingKey!);
    // Solo se presenta la identidad estable a un Worker que el usuario marcó como propio.
    if (
      this.workerAuthKey &&
      isPrivateWorkerUrl(this.settings.signalingServer, this.settings.privateWorkerHosts)
    ) {
      this.signalingClient.setWorkerAuthKey(this.workerAuthKey);
    }

    // El buzón asíncrono es opt-in y usa un dominio criptográfico separado.
    if (this.nostrMailbox) {
      this.nostrMailbox.destroy();
      this.nostrMailbox = null;
    }
    // Un Worker propio (all-in-one) actúa como relay del buzón: se autentica con NIP-98.
    if (this.settings.enableNostrMailbox) {
      this.nostrMailbox = new NostrMailbox(
        this.settings.signalingServer,
        this.mailboxRoomId,
        this.settings.deviceId,
        this.settings.pairingSecret,
        this.cryptoManager
      );
      this.nostrMailbox.setCryptoKey(this.mailboxKey!);
      if (this.blossomKey) {
        this.nostrMailbox.setBlossomKey(this.blossomKey);
      }
      const maxBlobBytes = resolveMaxBlobSizeBytes({
        maxBlobSizePreset: this.settings.maxBlobSizePreset,
        customMaxBlobSizeMb: this.settings.customMaxBlobSizeMb,
      });
      this.nostrMailbox.setBlossomConfig(this.settings.blossomServers, maxBlobBytes);
      if (this.workerAuthKey) {
        this.nostrMailbox.setPrivateWorkerAuth(this.workerAuthKey, this.settings.privateWorkerHosts);
      }
      this.nostrMailbox.setVaultPathPolicy(this.vaultPathPolicy);
      this.nostrMailbox.onReconnected = () => {
        void this.pollMailboxOnStartup();
      };
      this.nostrMailbox.onNoteReceived = async (note) => {
        if (note.deviceId === this.settings.deviceId) return;
        await this.mailboxPathQueue.run(note.path, async () => {
          await this.applyMailboxNote(note);
        });
      };
      this.nostrMailbox.startLiveSubscription();
      this.pollMailboxOnStartup();
    }

    this.signalingClient.onPeerJoined = (peerId) => {
      this.replaceStalePeer(peerId);
      // Si el ID local es mayor, este nodo actúa como iniciador
      if (this.settings.deviceId > peerId) {
        this.createPeerConnection(peerId, true);
      } else {
        // Si el ID local es menor, responder con presencia para que el nodo con ID mayor inicie la oferta
        this.signalingClient?.sendSignal(peerId, { type: 'peer-announce', senderId: this.settings.deviceId }).catch((err) => {
          console.warn('[OmniSync Signaling] Error anunciando el dispositivo:', err);
        });
      }
    };

    this.signalingClient.onPeerLeft = (peerId) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.close();
        this.peers.delete(peerId);
        this.updateDeviceOnlineStatus(peerId, false);
        this.updateStatus();
      }
    };

    this.signalingClient.onSignalMessage = async (senderId, signal) => {
      if (!isPlainObject(signal)) return;
      if (signal.type === 'peer-announce') {
        this.replaceStalePeer(senderId);
        // El otro nodo se anunció y nosotros tenemos el ID mayor: iniciar oferta
        if (this.settings.deviceId > senderId) {
          this.createPeerConnection(senderId, true);
        }
        return;
      }

      // Una oferta nueva significa que el remoto perdió su sesión anterior.
      if (signal.type === 'offer') this.replaceStalePeer(senderId, true);
      let peer = this.peers.get(senderId);
      if (!peer) {
        peer = this.createPeerConnection(senderId, false);
      }
      await peer.handleSignal(signal);
    };

    this.signalingClient.onConnectionChange = (connected) => {
      if (!connected) {
        this.updateStatus('disconnected');
      }
    };

    this.signalingClient.connect();
  }

  private createPeerConnection(remotePeerId: string, isInitiator: boolean): WebRTCPeer {
    if (this.peers.has(remotePeerId)) {
      return this.peers.get(remotePeerId)!;
    }

    const peer = new WebRTCPeer({
      localDeviceId: this.settings.deviceId,
      localDeviceName: this.settings.deviceName,
      remotePeerId,
      cryptoManager: this.cryptoManager,
      cryptoKey: this.cryptoKey!,
      pairingSecret: this.settings.pairingSecret,
      isInitiator,
      replayGuard: this.replayGuard,
      vaultPathPolicy: this.vaultPathPolicy,
      sendSignal: (signal) => {
        if (this.signalingClient) {
          this.signalingClient.sendSignal(remotePeerId, signal).catch((err) => {
            console.warn('[OmniSync Signaling] Error enviando señal:', err);
          });
        }
      },
      onConnected: (p) => {
        this.updateDeviceOnlineStatus(remotePeerId, true, p.remoteDeviceName);
        this.updateStatus('connected');
        new Notice(t('notices.peerConnected', { name: p.remoteDeviceName }));
        // Iniciar intercambio de manifiestos
        this.syncVaultWithPeer(p).catch((err) => {
          console.warn('[OmniSync] Error iniciando la sincronización:', err);
        });
      },
      onDisconnected: (p) => {
        // Un cierre tardío de un peer ya reemplazado no debe expulsar al vigente.
        if (this.peers.get(remotePeerId) !== p) return;
        this.updateDeviceOnlineStatus(remotePeerId, false);
        this.peers.delete(remotePeerId);
        p.close();
        this.updateStatus();
        this.schedulePeerRetry(remotePeerId, 0);
      },
      onMessage: async (p, msg) => {
        await this.handleIncomingProtocolMessage(p, msg);
      },
      onLiveCursor: (p, data) => {
        this.handleRemoteCursorUpdate(p, data);
      },
    });

    this.peers.set(remotePeerId, peer);
    this.peerCreatedAt.set(remotePeerId, Date.now());
    return peer;
  }

  private peerCreatedAt = new Map<string, number>();
  private peerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cierra y descarta un peer que ya no es válido para que pueda recrearse. */
  private replaceStalePeer(id: string, force = false): void {
    const existing = this.peers.get(id);
    if (!existing) return;
    const age = Date.now() - (this.peerCreatedAt.get(id) ?? 0);
    if (age < 3000) return;
    if (!force && ((existing.isConnected && existing.isAuthenticated) || age < 8000)) return;
    this.peers.delete(id);
    existing.close();
    this.updateDeviceOnlineStatus(id, false);
  }

  /** Reintenta la conexión con un peer caído con espera creciente (máx. 5 intentos). */
  private schedulePeerRetry(id: string, attempt: number): void {
    if (attempt >= 5 || this.peerRetryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.peerRetryTimers.delete(id);
      if (!this.signalingClient) return;
      const current = this.peers.get(id);
      if (current && current.isConnected && current.isAuthenticated) return;
      if (current) {
        this.peers.delete(id);
        current.close();
      }
      if (this.settings.deviceId > id) {
        this.createPeerConnection(id, true);
      } else {
        this.signalingClient
          .sendSignal(id, { type: 'peer-announce', senderId: this.settings.deviceId })
          .catch(() => {});
      }
      this.schedulePeerRetry(id, attempt + 1);
    }, 3000 * Math.pow(2, attempt));
    this.peerRetryTimers.set(id, timer);
  }

  private clearPeerRetryTimers(): void {
    for (const timer of this.peerRetryTimers.values()) clearTimeout(timer);
    this.peerRetryTimers.clear();
  }

  private updateDeviceOnlineStatus(
    id: string,
    isOnline: boolean,
    deviceName?: string,
    platform?: 'desktop' | 'mobile'
  ): void {
    let dev = this.settings.pairedDevices.find((d) => d.id === id);
    if (!dev) {
      const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
      const chosenColor = colors[this.settings.pairedDevices.length % colors.length];
      dev = {
        id,
        name: deviceName || 'Dispositivo Remoto',
        platform: platform ?? 'desktop',
        pairedAt: Date.now(),
        lastSeen: Date.now(),
        isOnline,
        color: chosenColor,
      };
      this.settings.pairedDevices.push(dev);
    } else {
      dev.isOnline = isOnline;
      dev.lastSeen = Date.now();
      if (deviceName) dev.name = deviceName;
      if (platform) dev.platform = platform;
    }
    void this.saveSettings().catch((err) => {
      console.warn('[OmniSync] Error guardando el estado de dispositivos:', err);
    });
    for (const listener of this.deviceListeners) listener();
  }

  /** Alinea el estado en línea guardado con los peers realmente conectados y reanuncia presencia. */
  public refreshDevices(): void {
    for (const dev of this.settings.pairedDevices) {
      const peer = this.peers.get(dev.id);
      dev.isOnline = !!peer && peer.isConnected && peer.isAuthenticated;
    }
    this.signalingClient?.connect();
  }

  private deviceListeners = new Set<() => void>();

  /** Suscribe un callback a cambios en la lista de dispositivos; devuelve la función para cancelar. */
  public onDevicesChanged(listener: () => void): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  private updateStatus(state?: SyncState, message?: string): void {
    if (state) this.syncState = state;
    const onlineCount = Array.from(this.peers.values()).filter((p) => p.isConnected && p.isAuthenticated).length;

    if (onlineCount > 0 && this.syncState !== 'syncing') {
      this.syncState = 'connected';
    } else if (onlineCount === 0 && this.syncState === 'connected') {
      this.syncState = 'signaling';
    }

    if (this.statusBar) {
      this.statusBar.updateState(this.syncState, onlineCount, message);
    }
  }

  public async triggerFullSync(): Promise<void> {
    if (MySecretCompat.isLocked(this.app)) {
      new Notice(t('notices.mySecretLocked'));
      return;
    }

    const authenticatedPeers = Array.from(this.peers.values()).filter((p) => p.isAuthenticated);
    if (authenticatedPeers.length === 0) {
      new Notice(t('notices.noPeersConnected'));
      return;
    }

    this.updateStatus('syncing', t('statusBar.statusIndexing'));
    for (const peer of authenticatedPeers) {
      await this.syncVaultWithPeer(peer);
    }
  }

  private async syncVaultWithPeer(peer: WebRTCPeer): Promise<void> {
    this.updateStatus('syncing', t('statusBar.statusComparing'));
    const manifest = await this.buildLocalManifest();

    await peer.sendMessage({
      type: 'MANIFEST_EXCHANGE',
      senderId: this.settings.deviceId,
      messageId: this.cryptoManager.generateNonce(),
      timestamp: Date.now(),
      payload: manifest,
    });
  }

  private async buildLocalManifest(): Promise<VaultManifest> {
    if (MySecretCompat.isLocked(this.app)) {
      return {
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        files: {},
        isLocked: true,
      };
    }

    const files = this.app.vault.getFiles();
    const manifestFiles: Record<string, FileManifestEntry> = {};

    for (const file of files) {
      const path = file.path;
      try {
        // La misma política de rutas se aplica al manifiesto local y al remoto.
        validateVaultPath(path, this.vaultPathPolicy);
        if (normalizePath(path) !== path) continue;
      } catch {
        continue;
      }

      const isBinary = !file.extension.match(/^(md|txt|canvas|json|css|js)$/i);
      if (isBinary && !this.settings.syncAttachments) continue;

      try {
        const dataBytes = await MySecretCompat.readVaultFileBytes(this.app, file);
        // `null` significa que el contenido está cifrado en reposo y no se ha
        // podido descifrar: se omite del manifiesto en vez de publicar el
        // hash de un ciphertext (que produciría conflictos permanentes).
        if (dataBytes === null) {
          continue;
        }
        // Un archivo por encima del tope haría que el par descartase el manifiesto entero.
        if (dataBytes.byteLength > MAX_TRANSFER_FILE_SIZE) {
          console.warn('[OmniSync] Archivo demasiado grande para sincronizar, se omite:', path);
          continue;
        }
        const hash = await this.cryptoManager.computeHash(dataBytes);

        manifestFiles[path] = {
          path,
          mtime: file.stat.mtime,
          size: dataBytes.byteLength,
          hash,
          isBinary,
        };
      } catch (err) {
        console.warn('[OmniSync] Error leyendo hash de:', path, err);
      }
    }

    // Lápidas de borrados locales: solo para rutas que ya no existen.
    for (const [tPath, tomb] of Object.entries(this.settings.deletedPaths ?? {})) {
      if (Object.prototype.hasOwnProperty.call(manifestFiles, tPath)) continue;
      try {
        if (validateVaultPath(tPath, this.vaultPathPolicy) !== tPath) continue;
      } catch {
        continue;
      }
      manifestFiles[tPath] = {
        path: tPath,
        mtime: tomb.mtime,
        size: 0,
        hash: '0'.repeat(64),
        isBinary: !tPath.match(/\.(md|txt|canvas|json|css|js)$/i),
        deleted: true,
      };
    }

    return {
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      files: manifestFiles,
      isLocked: false,
    };
  }

  private async handleIncomingProtocolMessage(peer: WebRTCPeer, msg: BaseProtocolMessage): Promise<void> {
    switch (msg.type) {
      case 'MANIFEST_EXCHANGE': {
        validateRemoteManifest(msg.payload, this.vaultPathPolicy);
        const remoteManifest = msg.payload as VaultManifest;
        if (remoteManifest.deviceId !== peer.remotePeerId) {
          throw new SecurityValidationError('El manifiesto no corresponde al peer autenticado.');
        }

        // Si el peer remoto está bloqueado, pausar sincronización P2P
        if (remoteManifest.isLocked) {
          new Notice(t('notices.remoteMySecretLocked'));
          this.updateStatus('connected', t('statusBar.statusWaitingUnlock'));
          break;
        }

        // Si este dispositivo tiene MySecret bloqueado, no proceder
        if (MySecretCompat.isLocked(this.app)) {
          this.updateStatus('error', t('statusBar.statusMySecretLocked'));
          break;
        }

        const localManifest = await this.buildLocalManifest();
        const delta = ManifestCalculator.computeDelta(localManifest, remoteManifest);

        // Si tenemos archivos con parches delta desfasados y el remoto los posee, asegurar descarga completa
        for (const pendingPath of this.pendingP2PPaths) {
          if (remoteManifest.files[pendingPath] && !delta.toDownload.includes(pendingPath)) {
            delta.toDownload.push(pendingPath);
          }
        }

        // Borrados hechos en el otro dispositivo mientras éste estaba apagado:
        // van a la papelera, nunca se destruyen.
        for (const delPath of delta.toDelete) {
          const file = this.app.vault.getAbstractFileByPath(delPath);
          const tomb = remoteManifest.files[delPath];
          if (
            file instanceof TFile &&
            tomb &&
            decideRemoteDelete(file.stat.mtime, tomb.mtime) === 'trash'
          ) {
            if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(delPath);
            await this.app.vault.trash(file, true);
            await this.baseSnapshotStore.deleteBase(delPath);
            this.recordTombstone(delPath, tomb.mtime);
          }
        }

        // Conflictos (mismo mtime, contenido distinto): gana de forma
        // determinista el dispositivo con el id menor y envía su versión; el otro
        // la recibe y conserva la suya en una única copia de conflicto.
        if (this.settings.deviceId < remoteManifest.deviceId) {
          for (const conflictPath of delta.conflicts) {
            if (!delta.toUpload.includes(conflictPath)) delta.toUpload.push(conflictPath);
          }
        }

        // Subir archivos que local tiene más recientes
        for (const path of delta.toUpload) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const dataBytes = await MySecretCompat.readVaultFileBytes(this.app, file);
            // Si el archivo está cifrado en reposo y no se puede descifrar, se
            // omite: enviar el ciphertext produciría un archivo ilegible en el
            // otro dispositivo y un ciclo de conflictos sin fin.
            if (dataBytes === null) {
              continue;
            }
            await this.sendFileToPeer(peer, path, dataBytes, file.stat.mtime);
          }
        }

        this.updateStatus('connected');
        break;
      }

      case 'FILE_HEADER': {
        this.fileTransferManager.registerIncomingHeader(msg.payload);
        this.updateStatus('syncing', t('statusBar.statusReceiving', { path: (msg.payload as { path: string }).path }));
        break;
      }

      case 'FILE_CHUNK': {
        const result = await this.fileTransferManager.handleIncomingChunk(msg.payload);
        if (result.complete && result.data) {
          // El `mtime` remoto es obligatorio: sin él no se puede comparar con
          // la versión local y no se debe escribir nada.
          if (typeof result.mtime !== 'number' || !Number.isFinite(result.mtime)) {
            throw new SecurityValidationError(
              'La transferencia recibida no incluye una marca de tiempo válida.'
            );
          }
          await this.saveIncomingFile(result.path, result.data, result.mtime);
          this.updateStatus('connected');
        }
        break;
      }

      case 'FILE_DELETE': {
        validateFileDeletePayload(msg.payload, this.vaultPathPolicy);
        const { path, mtime } = msg.payload;
        const file = this.app.vault.getAbstractFileByPath(path);
        const localMtime = file instanceof TFile ? file.stat.mtime : null;
        if (file instanceof TFile && decideRemoteDelete(localMtime, mtime) === 'trash') {
          // Nunca destruir: Obsidian mantiene la versión recuperable en la papelera.
          if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(path);
          await this.app.vault.trash(file, true);
          this.recordTombstone(path, mtime);
        }
        break;
      }

      case 'FILE_RENAME': {
        validateFileRenamePayload(msg.payload, this.vaultPathPolicy);
        const { oldPath, newPath, mtime } = msg.payload;
        const file = this.app.vault.getAbstractFileByPath(oldPath);
        const destination = this.app.vault.getAbstractFileByPath(newPath);
        const localMtime = file instanceof TFile ? file.stat.mtime : null;
        const decision = decideRemoteRename(
          localMtime,
          mtime,
          destination !== null && destination !== undefined
        );
        if (file instanceof TFile && decision === 'rename') {
          if (this.vaultWatcher) {
            this.vaultWatcher.ignoreNextChange(oldPath);
            this.vaultWatcher.ignoreNextChange(newPath);
          }
          await this.app.fileManager.renameFile(file, newPath);
          this.recordTombstone(oldPath, mtime);
          this.clearTombstone(newPath);
        }
        break;
      }
    }
  }

  private async handleConflict(path: string): Promise<void> {
    const localFile = this.app.vault.getAbstractFileByPath(path);
    if (!(localFile instanceof TFile)) return;

    // Se conserva la versión local de todo archivo de texto, no solo de las notas.
    if (/^(md|txt|canvas|json|css|js)$/i.test(localFile.extension)) {
      let localContent = await this.app.vault.read(localFile);
      if (MySecretCompat.isArmored(localContent)) {
        const dec = await MySecretCompat.decryptArmored(this.app, localContent, path);
        if (dec === null) {
          // Fail-closed: la copia de respaldo no debe contener un bloque
          // cifrado que el usuario no puede abrir.
          console.warn(
            '[OmniSync] Se omite la copia de conflicto: el contenido no se puede descifrar.',
            path
          );
          return;
        }
        localContent = dec;
      }
      // Fusión de seguridad: Creamos respaldo con etiqueta de conflicto
      const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
      // No se incorpora el nombre remoto a la ruta: podría contener separadores.
      const conflictCopyName = `${localFile.basename} (conflicto remoto ${timestampStr}).${localFile.extension}`;
      const conflictPath = localFile.parent ? `${localFile.parent.path}/${conflictCopyName}` : conflictCopyName;
      validateVaultPath(conflictPath, this.vaultPathPolicy);

      // No se duplica: si ya existe una copia de conflicto con este contenido, basta.
      const siblings = localFile.parent ? localFile.parent.children : this.app.vault.getRoot().children;
      const prefix = `${localFile.basename} (conflicto remoto `;
      for (const sibling of siblings) {
        if (sibling instanceof TFile && sibling.extension === localFile.extension && sibling.name.startsWith(prefix)) {
          if ((await this.app.vault.read(sibling)) === localContent) return;
        }
      }

      await MySecretCompat.createTextSafely(this.app, conflictPath, localContent);
      new Notice(t('notices.conflictSaved', { name: localFile.name, backup: conflictCopyName }), 8000);
    }
  }

  private async sendFileToPeer(
    peer: WebRTCPeer,
    path: string,
    fileBytes: Uint8Array,
    mtime: number
  ): Promise<boolean> {
    const channel = peer.getSyncChannel();
    if (!channel || channel.readyState !== 'open') return false;

    const hash = await this.cryptoManager.computeHash(fileBytes);
    const isBinary = !path.match(/\.(md|txt|canvas|json)$/i);

    const { header, chunks } = this.fileTransferManager.prepareOutgoingChunks(
      path,
      fileBytes,
      mtime,
      hash,
      isBinary
    );

    await this.fileTransferManager.sendFileOverChannel(
      channel,
      this.cryptoKey!,
      header,
      chunks,
      this.settings.deviceId,
      (progress) => {
        this.updateStatus('syncing', t('statusBar.statusSending', { percent: progress.percentage }));
      }
    );
    return true;
  }

  /**
   * El mtime del archivo escrito debe ser el del origen: si fuera la hora de
   * llegada, los borrados y renombrados posteriores del origen (que llevan su
   * mtime) se descartarían como "local más reciente".
   */
  private remoteWriteOptions(mtime: number): { mtime: number } {
    return { mtime: Math.min(mtime, Date.now()) };
  }

  /**
   * Antes de sobrescribir una nota con la versión remota, conserva la local en
   * una copia de conflicto si cambió desde la última base sincronizada.
   */
  private async reconcileBeforeOverwrite(
    existing: TFile,
    safePath: string,
    incomingText: string
  ): Promise<{ text: string; merged: boolean }> {
    const keepIncoming = { text: incomingText, merged: false };
    let incoming = incomingText;
    if (MySecretCompat.isArmored(incoming)) {
      const dec = await MySecretCompat.decryptArmored(this.app, incoming, safePath);
      if (dec === null) return keepIncoming;
      incoming = dec;
    }
    let local = await this.app.vault.read(existing);
    if (MySecretCompat.isArmored(local)) {
      const dec = await MySecretCompat.decryptArmored(this.app, local, safePath);
      if (dec === null) return keepIncoming;
      local = dec;
    }
    if (local === incoming) return keepIncoming;
    const base = await this.baseSnapshotStore.getBase(safePath);
    const localHash = await this.cryptoManager.computeHash(new TextEncoder().encode(local));
    if (base && base.hash === localHash) return keepIncoming;

    // Ambos lados cambiaron: se intenta una fusión limpia de 3 vías antes de
    // recurrir a la copia de conflicto.
    const mergedText = this.tryCleanMerge(base, local, incoming);
    if (mergedText !== null) {
      new Notice(t('notices.mergedAutomatically', { name: existing.name }));
      return { text: mergedText, merged: true };
    }
    await this.handleConflict(safePath);
    return keepIncoming;
  }

  private tryCleanMerge(
    base: { content: string } | null,
    local: string,
    incoming: string
  ): string | null {
    if (!base || typeof base.content !== 'string') return null;
    const result = DiffMergeEngine.threeWayMerge(base.content, local, incoming);
    return result.success && !result.hasConflicts ? result.mergedText : null;
  }

  private async saveIncomingFile(
    path: string,
    data: Uint8Array,
    mtime: number
  ): Promise<void> {
    const safePath = validateVaultPath(path, this.vaultPathPolicy);
    if (normalizePath(safePath) !== safePath) {
      throw new SecurityValidationError('La ruta de escritura no está normalizada.');
    }
    if (data.byteLength > MAX_TRANSFER_FILE_SIZE) {
      throw new SecurityValidationError('El archivo recibido excede el límite permitido.');
    }
    if (this.vaultWatcher) {
      // Con hash esperado, solo se ignora el eco de esta escritura: una edición
      // del usuario dentro de la ventana sí se sincroniza.
      // Si el contenido llega blindado por MySecret, lo escrito difiere de `data`:
      // en ese caso se ignora solo por tiempo.
      const isTextPath = /\.(md|txt|canvas|json|css|js)$/i.test(safePath);
      const maySelfEncrypt = isTextPath
        ? MySecretCompat.isArmored(new TextDecoder().decode(data.subarray(0, 64)))
        : MySecretCompat.isBinaryEncrypted(data);
      this.vaultWatcher.ignoreNextChange(
        safePath,
        2000,
        maySelfEncrypt ? undefined : await this.cryptoManager.computeHash(data)
      );
    }
    this.clearTombstone(safePath);

    // Asegurar carpetas intermedias
    const parts = safePath.split('/');
    if (parts.length > 1) {
      let currentPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        if (!this.app.vault.getAbstractFileByPath(currentPath)) {
          await this.app.vault.createFolder(currentPath);
        }
      }
    }

    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const existing = this.app.vault.getAbstractFileByPath(safePath);
    const isBinary = !safePath.match(/\.(md|txt|canvas|json|css|js)$/i);

    if (existing instanceof TFolder) {
      throw new SecurityValidationError('La ruta remota corresponde a una carpeta.');
    }

    if (existing instanceof TFile) {
      // Una versión local más reciente nunca se sobrescribe con una antigua.
      if (decideRemoteWrite(existing.stat.mtime, mtime) === 'skip_newer_local') return;

      if (!isBinary) {
        const text = new TextDecoder().decode(data);
        const reconciled = await this.reconcileBeforeOverwrite(existing, safePath, text);
        // Un resultado fusionado es una edición local nueva: conserva el mtime
        // actual para que se propague al otro dispositivo como más reciente.
        await MySecretCompat.writeTextSafely(
          this.app,
          existing,
          reconciled.text,
          reconciled.merged ? undefined : this.remoteWriteOptions(mtime)
        );
        const hash = await this.cryptoManager.computeHash(data);
        await this.baseSnapshotStore.setBase(safePath, text, hash, mtime);
        if (this.pendingP2PPaths.delete(safePath)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      } else {
        await this.writeBinarySafely(existing, safePath, data, arrayBuffer, mtime);
      }
    } else {
      if (!isBinary) {
        const text = new TextDecoder().decode(data);
        await MySecretCompat.createTextSafely(this.app, safePath, text, this.remoteWriteOptions(mtime));
        const hash = await this.cryptoManager.computeHash(data);
        await this.baseSnapshotStore.setBase(safePath, text, hash, mtime);
        if (this.pendingP2PPaths.delete(safePath)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      } else {
        await this.writeBinarySafely(null, safePath, data, arrayBuffer, mtime);
      }
    }
  }

  /**
   * Escribe un adjunto binario recibido de forma segura frente a MySecret.
   *
   * Si el adjunto llega cifrado en reposo (cabecera `MYSE`), no se escribe tal
   * cual: se intenta descifrar con la clave de este dispositivo para que cada
   * equipo cifre con su propia contraseña. Si no se puede descifrar, se aborta
   * (fail-closed) en lugar de materializar un bloque que el usuario no puede
   * abrir.
   */
  private makeConflictPath(safePath: string): string {
    const ts = new Date().toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15);
    const dot = safePath.lastIndexOf('.');
    const slash = safePath.lastIndexOf('/');
    return dot > slash
      ? `${safePath.slice(0, dot)}.conflict-${ts}${safePath.slice(dot)}`
      : `${safePath}.conflict-${ts}`;
  }

  private async saveConflictCopy(existing: TFile, safePath: string): Promise<void> {
    try {
      const conflictPath = this.makeConflictPath(safePath);
      const existingData = await this.app.vault.readBinary(existing);
      if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(conflictPath, 3000);
      await this.app.vault.createBinary(conflictPath, existingData);
    } catch {
      // Copia de conflicto es de mejor esfuerzo; no bloquea la sincronización.
    }
  }

  private async writeBinarySafely(
    existing: TFile | null,
    safePath: string,
    data: Uint8Array,
    arrayBuffer: ArrayBuffer,
    mtime: number
  ): Promise<void> {
    const options = this.remoteWriteOptions(mtime);
    if (!MySecretCompat.isBinaryEncrypted(data)) {
      // Binario en claro: MySecret lo cifrará al escribir si está activo.
      if (existing) {
        await this.saveConflictCopy(existing, safePath);
        await this.app.vault.modifyBinary(existing, arrayBuffer, options);
      } else {
        await this.app.vault.createBinary(safePath, arrayBuffer, options);
      }
      return;
    }

    const plain = await MySecretCompat.decryptBinaryEncrypted(this.app, data, safePath);
    if (plain === null) {
      throw new SecurityValidationError(
        `El adjunto '${safePath}' llega cifrado y no se puede descifrar en este dispositivo: ` +
          'se omite para no materializar un bloque ilegible.'
      );
    }

    // El contenido ya está en claro: se deja que el hook de MySecret lo cifre
    // con la contraseña local de este dispositivo.
    const plainBuffer = plain.buffer.slice(
      plain.byteOffset,
      plain.byteOffset + plain.byteLength
    ) as ArrayBuffer;

    if (existing) {
      await this.saveConflictCopy(existing, safePath);
      await this.app.vault.modifyBinary(existing, plainBuffer, options);
    } else {
      await this.app.vault.createBinary(safePath, plainBuffer, options);
    }
  }

  private broadcastChain: Promise<void> = Promise.resolve();

  /** Serializa los envíos: el receptor admite pocas transferencias simultáneas. */
  private broadcastFileChange(path: string, entry: FileManifestEntry, data: Uint8Array): Promise<void> {
    const run = this.broadcastChain.then(() => this.doBroadcastFileChange(path, entry, data));
    this.broadcastChain = run.catch(() => {});
    return run;
  }

  private async doBroadcastFileChange(path: string, entry: FileManifestEntry, data: Uint8Array): Promise<void> {
    if (MySecretCompat.isLocked(this.app)) return;

    const authenticatedPeers = Array.from(this.peers.values()).filter((p) => p.isAuthenticated && p.isConnected);
    if (authenticatedPeers.length > 0) {
      let allSent = true;
      for (const peer of authenticatedPeers) {
        if (!(await this.sendFileToPeer(peer, path, data, entry.mtime))) allSent = false;
      }
      if (!allSent) {
        // Envío incompleto: se reintentará; no se marca como sincronizado.
        this.pendingP2PPaths.add(path);
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
        return;
      }
      if (!entry.isBinary) {
        const text = new TextDecoder().decode(data);
        await this.baseSnapshotStore.setBase(path, text, entry.hash, entry.mtime);
        if (this.pendingP2PPaths.delete(path)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      }
    } else {
      // Sin pares WebRTC conectados: depositar en el buzón asíncrono
      if (!this.nostrMailbox) return;

      // Caso 1: Archivo <= 64 KB -> enviar nota completa
      if (this.nostrMailbox.isEligibleForMailbox(path, data.byteLength)) {
        const text = new TextDecoder().decode(data);
        const pubResult = await this.nostrMailbox.publishNote(path, text, entry.mtime, false);
        if (pubResult.success) {
          await this.baseSnapshotStore.setBase(path, text, entry.hash, entry.mtime);
          if (this.pendingP2PPaths.delete(path)) {
            this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
            void this.saveSettings();
          }
        } else {
          this.pendingP2PPaths.add(path);
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
          new Notice(t('notices.directP2pSync', { path }));
        }
      }
      // Caso 2: Archivo de texto > 64 KB -> sincronización delta
      else if (this.nostrMailbox.isEligibleForDelta(path, data.byteLength)) {
        const currentText = new TextDecoder().decode(data);
        const base = await this.baseSnapshotStore.getBase(path);

        if (base && base.content) {
          // Generar parche unificado acumulativo contra la última versión base sincronizada
          const patch = DeltaPatchEngine.computePatch(base.content, currentText, 3, path);
          if (patch.length > 0) {
            const pubResult = await this.nostrMailbox.publishDeltaPatch(
              path,
              base.hash,
              entry.hash,
              patch,
              entry.mtime
            );

            if (pubResult.success) {
              await this.baseSnapshotStore.setBase(path, currentText, entry.hash, entry.mtime);
              if (this.pendingP2PPaths.delete(path)) {
                this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
                void this.saveSettings();
              }
              const sizeKb = (new TextEncoder().encode(patch).length / 1024).toFixed(1);
              new Notice(t('notices.deltaSent', { path, sizeKb }));
            } else if (this.settings.enableBlossomSync && this.nostrMailbox.isEligibleForBlossom(path, data.byteLength)) {
              // El parche supera el límite delta: subir nota completa a Blossom
              const bRes = await this.nostrMailbox.publishBlobAttachment(path, data, entry.mtime);
              if (bRes.success) {
                await this.baseSnapshotStore.setBase(path, currentText, entry.hash, entry.mtime);
                if (this.pendingP2PPaths.delete(path)) {
                  this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
                  void this.saveSettings();
                }
                const sizeMb = (data.byteLength / (1024 * 1024)).toFixed(1);
                new Notice(t('notices.blossomUploaded', { path, sizeMb }));
              } else {
                this.pendingP2PPaths.add(path);
                this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
                void this.saveSettings();
                new Notice(t('notices.directP2pSync', { path }));
              }
            } else {
              this.pendingP2PPaths.add(path);
              this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
              void this.saveSettings();
              new Notice(t('notices.mailboxLimitExceeded', { path }));
            }
          }
        } else if (this.settings.enableBlossomSync && this.nostrMailbox.isEligibleForBlossom(path, data.byteLength)) {
          // Nota grande sin base previa: subir completa a Blossom
          const bRes = await this.nostrMailbox.publishBlobAttachment(path, data, entry.mtime);
          if (bRes.success) {
            await this.baseSnapshotStore.setBase(path, currentText, entry.hash, entry.mtime);
            if (this.pendingP2PPaths.delete(path)) {
              this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
              void this.saveSettings();
            }
            const sizeMb = (data.byteLength / (1024 * 1024)).toFixed(1);
            new Notice(t('notices.blossomUploaded', { path, sizeMb }));
          } else {
            await this.baseSnapshotStore.setBase(path, currentText, entry.hash, entry.mtime);
            this.pendingP2PPaths.add(path);
            this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
            void this.saveSettings();
            new Notice(t('notices.directP2pSync', { path }));
          }
        } else {
          // Nota grande sin ancestro previo: registrar versión actual y agendar sincronización completa P2P
          await this.baseSnapshotStore.setBase(path, currentText, entry.hash, entry.mtime);
          this.pendingP2PPaths.add(path);
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
          new Notice(t('notices.directP2pSync', { path }));
        }
      }
      // Caso 3: Archivo binario (fotos, PDFs, audios, canvas, etc.) sincronizado mediante Blossom
      else if (this.settings.enableBlossomSync && this.nostrMailbox.isEligibleForBlossom(path, data.byteLength)) {
        const pubResult = await this.nostrMailbox.publishBlobAttachment(path, data, entry.mtime);
        if (pubResult.success) {
          if (this.pendingP2PPaths.delete(path)) {
            this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
            void this.saveSettings();
          }
          const sizeMb = (data.byteLength / (1024 * 1024)).toFixed(1);
          new Notice(t('notices.blossomAttachmentUploaded', { path, sizeMb }));
        } else {
          this.pendingP2PPaths.add(path);
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
          new Notice(t('notices.blossomAttachmentFallback', { path, reason: pubResult.reason || 'error' }));
        }
      }
    }
  }

  private async broadcastFileDelete(path: string, mtime: number): Promise<void> {
    if (MySecretCompat.isLocked(this.app)) return;

    const authenticatedPeers = Array.from(this.peers.values()).filter((p) => p.isAuthenticated && p.isConnected);
    if (authenticatedPeers.length > 0) {
      for (const peer of authenticatedPeers) {
        await peer.sendMessage({
          type: 'FILE_DELETE',
          senderId: this.settings.deviceId,
          messageId: this.cryptoManager.generateNonce(),
          timestamp: Date.now(),
          payload: { path, mtime },
        });
      }
    } else {
      // Propagar tombstone de borrado asíncrono en Nostr
      if (this.nostrMailbox && path.match(ELIGIBLE_MAILBOX_EXTENSIONS)) {
        const publishResult = await this.nostrMailbox.publishNote(path, '', mtime, true);
        if (publishResult.success) {
          await this.baseSnapshotStore.deleteBase(path);
          if (this.pendingP2PPaths.delete(path)) {
            this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
            void this.saveSettings();
          }
        }
      }
    }
  }

  /**
   * Consulta el buzón asíncrono en Nostr al iniciar o reconectar para traer notas creadas u modificadas offline.
   */
  /**
   * Elimina del almacén de snapshots las instantáneas cuyo archivo ya no
   * existe en la bóveda. Sin esta poda, el almacén crecería de forma
   * indefinida conservando el contenido de notas ya borradas.
   */
  private async pruneBaseSnapshots(): Promise<void> {
    try {
      const validPaths = new Set<string>();
      for (const file of this.app.vault.getFiles()) {
        try {
          validateVaultPath(file.path, this.vaultPathPolicy);
          validPaths.add(file.path);
        } catch {
          // Ruta fuera de política: no se considera válida.
        }
      }
      await this.baseSnapshotStore.prune(validPaths);
    } catch (err) {
      console.warn('[OmniSync] Error podando el almacén de snapshots:', err);
    }
  }

  private mailboxPolling = false;

  private async pollMailboxOnStartup(): Promise<void> {
    // Podar el almacén de snapshots: las instantáneas de notas que ya no
    // existen se eliminan para no conservar indefinidamente el texto plano
    // (cifrado) de notas borradas.
    await this.pruneBaseSnapshots();

    if (!this.nostrMailbox || !this.settings.autoSync) return;

    // Si la bóveda está protegida por MySecret y está bloqueada, aplazar la consulta
    // para no aplicar notas mientras el usuario no haya introducido su contraseña.
    if (MySecretCompat.isLocked(this.app)) {
      return;
    }

    if (this.mailboxPolling) return;
    this.mailboxPolling = true;
    try {
      // La marca de la consulta anterior delimita qué cambios locales se
      // consideran propios. Debe seguir intacta mientras se aplican las notas.
      const previousFetchTimestamp = this.settings.lastMailboxFetchTimestamp || 0;
      const pendingNotes = await this.nostrMailbox.fetchPendingNotes(
        previousFetchTimestamp
      );
      // Si el relay falló o expiró sin EOSE, no se avanza la marca: esa ventana
      // de eventos debe volver a consultarse.
      const fetchComplete = this.nostrMailbox.lastFetchComplete;

      if (pendingNotes.length > 0) {
        let updatedCount = 0;
        // Marca mínima entre los eventos que no pudieron aplicarse: la consulta
        // siguiente debe volver a descargarlos en lugar de omitirlos.
        let oldestFailedEventSec = Number.POSITIVE_INFINITY;
        for (const pending of pendingNotes) {
          const note = pending.note;
          try {
            await this.mailboxPathQueue.run(note.path, async () => {
              await this.applyMailboxNote(note, previousFetchTimestamp);
            });
            updatedCount++;
          } catch (err) {
            // La aplicación falló: se liberan las reservas de replay para
            // que el evento pueda procesarse de nuevo en la próxima consulta.
            // Sin esto, un error transitorio perdería el cambio en silencio.
            this.nostrMailbox.releaseReservations(pending.reservationKeys);
            oldestFailedEventSec = Math.min(oldestFailedEventSec, pending.eventCreatedAt);
            console.warn(
              '[OmniSync Mailbox] No se pudo aplicar:',
              note.path,
              err instanceof Error ? err.message : 'error desconocido'
            );
          }
        }
        if (updatedCount > 0) {
          new Notice(t('notices.mailboxSyncSuccess', { count: updatedCount }));
        }

        // La marca se avanza solo después de aplicar todo, y nunca por encima
        // del evento fallido más antiguo: así el cambio pendiente se reintenta.
        // El piso de 8 días coincide con la edad máxima aceptada por el buzón:
        // un evento más antiguo ya no sería admitido de todos modos.
        const nowMs = Date.now();
        const oldestWindowMs = nowMs - MAX_MAILBOX_EVENT_AGE_SECONDS * 1000;
        const failedBoundaryMs = Number.isFinite(oldestFailedEventSec)
          ? Math.max(oldestWindowMs, oldestFailedEventSec * 1000)
          : nowMs;
        if (fetchComplete) {
          this.settings.lastMailboxFetchTimestamp = Math.min(nowMs, failedBoundaryMs);
          await this.saveSettings();
        }
        return;
      }

      if (!fetchComplete) return;

      // La marca se avanza solo después de aplicar todo, para que la próxima
      // consulta detecte correctamente los cambios locales posteriores.
      this.settings.lastMailboxFetchTimestamp = Date.now();
      await this.saveSettings();
    } catch (err) {
      console.warn('[OmniSync Mailbox] Error al consultar buzón:', err);
    } finally {
      this.mailboxPolling = false;
    }
  }

  /**
   * Aplica de forma segura una nota descargada del buzón asíncrono de Nostr.
   *
   * @param previousFetchTimestamp Marca de la última consulta: los archivos
   * modificados después de ella son cambios locales propios y generan un
   * conflicto en lugar de sobrescribirse en silencio.
   */
  private async applyMailboxNote(
    note: NostrMailboxNotePayload,
    previousFetchTimestamp: number = this.settings.lastMailboxFetchTimestamp || 0
  ): Promise<void> {
    // Si la bóveda está bloqueada, no escribir. Se lanza un error para que el
    // llamador libere la reserva de replay: el evento debe poder aplicarse
    // cuando la bóveda se desbloquee, en lugar de descartarse en silencio.
    if (MySecretCompat.isLocked(this.app)) {
      throw new Error('La bóveda está bloqueada; el cambio del buzón se reintentará al desbloquear.');
    }

    const safePath = validateVaultPath(note.path, this.vaultPathPolicy);
    if (safePath !== note.path || !Number.isFinite(note.mtime) || note.mtime < 0) {
      throw new SecurityValidationError('Nota del buzón inválida.');
    }
    const existing = this.app.vault.getAbstractFileByPath(safePath);

    if (note.isDeleted) {
      const localMtime = existing instanceof TFile ? existing.stat.mtime : null;
      if (
        existing instanceof TFile &&
        decideRemoteDelete(localMtime, note.mtime) === 'trash'
      ) {
        // Un tombstone antiguo no elimina una versión local más reciente.
        if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(safePath);
        await this.app.vault.trash(existing, true);
        this.recordTombstone(safePath, note.mtime);
        await this.baseSnapshotStore.deleteBase(safePath);
        if (this.pendingP2PPaths.delete(safePath)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      }
      return;
    }

    // Caso 0: Archivo o adjunto pesado descargado desde Blossom
    if (note.type === 'BLOB_ATTACHMENT') {
      if (!this.nostrMailbox || !this.settings.enableBlossomSync) {
        return;
      }
      const localMtime = existing instanceof TFile ? existing.stat.mtime : null;
      if (decideRemoteWrite(localMtime, note.mtime) === 'skip_newer_local') {
        return;
      }

      try {
        const decryptedBytes = await this.nostrMailbox.downloadBlobAttachment(note);
        await this.saveIncomingFile(safePath, decryptedBytes, note.mtime);
        if (this.pendingP2PPaths.delete(safePath)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
        new Notice(t('notices.blossomReceived', { name: safePath.split('/').pop() || safePath }));
      } catch (err: any) {
        console.warn('[OmniSync Mailbox] Error descargando adjunto Blossom:', safePath, err);
        // Propagar el error impide avanzar la marca del barrido: el adjunto se
        // reintentará en la siguiente consulta en lugar de perderse.
        throw err;
      }
      return;
    }

    // Caso A: Parche Delta
    if (note.type === 'DELTA_PATCH') {
      // Los hashes del parche deben tener forma válida antes de usarlos como
      // referencia de integridad. Un valor manipulado haría que la
      // comparación `localHash !== note.baseHash` fuera siempre cierta y la
      // verificación post-parche quedaría anulada.
      if (
        typeof note.baseHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(note.baseHash) ||
        typeof note.targetHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(note.targetHash)
      ) {
        console.warn(
          '[OmniSync Mailbox] Se omite: el parche delta carece de hashes válidos.',
          safePath
        );
        return;
      }

      if (!(existing instanceof TFile)) {
        this.pendingP2PPaths.add(safePath);
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
        new Notice(t('notices.directP2pSync', { path: safePath }));
        return;
      }

      let localContent = await this.app.vault.read(existing);
      if (MySecretCompat.isArmored(localContent)) {
        const recovered = await MySecretCompat.decryptArmored(this.app, localContent, safePath);
        if (recovered !== null) {
          localContent = recovered;
          void this.app.vault.modify(existing, recovered).catch(() => {});
        } else {
          this.pendingP2PPaths.add(safePath);
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
          return;
        }
      }

      const localHash = await this.cryptoManager.computeHash(new TextEncoder().encode(localContent));

      // 1. Verificación pre-parche: baseHash debe coincidir estrictamente con el archivo local
      if (localHash !== note.baseHash) {
        this.pendingP2PPaths.add(safePath);
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
        new Notice(t('notices.baseMismatchP2P', { name: existing.name }));
        return;
      }

      // 2. Aplicar parche quirúrgico
      const patchRes = DeltaPatchEngine.applyPatch(localContent, note.content);
      if (!patchRes.success || patchRes.result === undefined) {
        this.pendingP2PPaths.add(safePath);
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
        new Notice(t('notices.patchFailedP2P', { name: existing.name }));
        return;
      }

      // 3. Verificación post-parche: targetHash debe coincidir
      const patchedText = patchRes.result;
      const patchedHash = await this.cryptoManager.computeHash(new TextEncoder().encode(patchedText));
      if (patchedHash !== note.targetHash) {
        this.pendingP2PPaths.add(safePath);
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
        new Notice(t('notices.integrityFailedP2P', { name: existing.name }));
        return;
      }

      // 4. Escritura segura y refresco de base
      if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(safePath);
      await MySecretCompat.writeTextSafely(this.app, existing, patchedText, this.remoteWriteOptions(note.mtime));
      await this.baseSnapshotStore.setBase(safePath, patchedText, patchedHash, note.mtime);
      if (this.pendingP2PPaths.delete(safePath)) {
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
      }
      new Notice(t('notices.patchApplied', { name: existing.name }));
      return;
    }

    // Caso B: Nota completa
    if (existing instanceof TFile) {
      const localMtime = existing.stat.mtime;
      let localContent = await this.app.vault.read(existing);

      // Si localContent está doblemente cifrado de sincronizaciones anteriores, recuperar el texto plano
      if (MySecretCompat.isArmored(localContent)) {
        const recovered = await MySecretCompat.decryptArmored(this.app, localContent, safePath);
        if (recovered === null) {
          console.warn(
            '[OmniSync Mailbox] Se omite: el contenido local no se puede descifrar.',
            safePath
          );
          return;
        }
        localContent = recovered;
        void this.app.vault.modify(existing, recovered).catch(() => {});
      }

      // Si la nota remota viene con envelope de MySecret, descifrarla
      let incomingContent = note.content;
      if (MySecretCompat.isArmored(incomingContent)) {
        const dec = await MySecretCompat.decryptArmored(this.app, incomingContent, safePath);
        if (dec === null) {
          console.warn(
            '[OmniSync Mailbox] Se omite: el contenido remoto no se puede descifrar.',
            safePath
          );
          return;
        }
        incomingContent = dec;
      }

      // Un cambio local aún no publicado cuenta como modificado localmente.
      const locallyModifiedSince = this.pendingP2PPaths.has(safePath) ? 0 : previousFetchTimestamp;
      const decision = decideMailboxNote(
        localMtime,
        note.mtime,
        localContent,
        incomingContent,
        locallyModifiedSince
      );

      let mailboxMerged: string | null = null;
      if (decision === 'conflict') {
        mailboxMerged = this.tryCleanMerge(
          await this.baseSnapshotStore.getBase(safePath),
          localContent,
          incomingContent
        );
        if (mailboxMerged !== null) {
          new Notice(t('notices.mergedAutomatically', { name: existing.name }));
        }
      }

      if (decision === 'conflict' && mailboxMerged === null) {
        const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
        const conflictCopyName = `${existing.basename} (conflicto buzón ${timestampStr}).md`;
        const conflictPath = existing.parent
          ? `${existing.parent.path}/${conflictCopyName}`
          : conflictCopyName;
        validateVaultPath(conflictPath, this.vaultPathPolicy);
        await MySecretCompat.createTextSafely(this.app, conflictPath, localContent);
        new Notice(t('notices.conflictBackupCreated', { name: existing.name }));
      }

      if (decision === 'apply' || decision === 'conflict') {
        this.clearTombstone(safePath);
        if (this.vaultWatcher) {
          // Si se fusionó, el resultado difiere de lo recibido y debe propagarse.
          this.vaultWatcher.ignoreNextChange(
            safePath,
            2000,
            mailboxMerged !== null
              ? await this.cryptoManager.computeHash(new TextEncoder().encode(incomingContent))
              : undefined
          );
        }
        await MySecretCompat.writeTextSafely(
          this.app,
          existing,
          mailboxMerged ?? incomingContent,
          mailboxMerged !== null ? undefined : this.remoteWriteOptions(note.mtime)
        );
        const hash = await this.cryptoManager.computeHash(new TextEncoder().encode(incomingContent));
        await this.baseSnapshotStore.setBase(safePath, incomingContent, hash, note.mtime);
        if (this.pendingP2PPaths.delete(safePath)) {
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      }
    } else {
      let incomingContent = note.content;
      if (MySecretCompat.isArmored(incomingContent)) {
        const dec = await MySecretCompat.decryptArmored(this.app, incomingContent, safePath);
        if (dec === null) {
          console.warn(
            '[OmniSync Mailbox] Se omite: el contenido remoto no se puede descifrar.',
            safePath
          );
          return;
        }
        incomingContent = dec;
      }

      await this.saveIncomingFile(
        safePath,
        new TextEncoder().encode(incomingContent),
        note.mtime
      );
      const hash = await this.cryptoManager.computeHash(new TextEncoder().encode(incomingContent));
      await this.baseSnapshotStore.setBase(safePath, incomingContent, hash, note.mtime);
      if (this.pendingP2PPaths.delete(safePath)) {
        this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
        void this.saveSettings();
      }
    }
  }

  private async broadcastFileRename(
    oldPath: string,
    newPath: string,
    mtime: number
  ): Promise<void> {
    if (MySecretCompat.isLocked(this.app)) return;

    const authenticatedPeers = Array.from(this.peers.values()).filter((p) => p.isAuthenticated && p.isConnected);
    if (authenticatedPeers.length > 0) {
      for (const peer of authenticatedPeers) {
        await peer.sendMessage({
          type: 'FILE_RENAME',
          senderId: this.settings.deviceId,
          messageId: this.cryptoManager.generateNonce(),
          timestamp: Date.now(),
          payload: { oldPath, newPath, mtime },
        });
      }
    } else {
      // Propagar renombrado asíncrono en Nostr: tombstone para ruta previa y publicación de nueva ruta
      if (this.nostrMailbox && oldPath.match(/\.(md|markdown|txt)$/i)) {
        await this.nostrMailbox.publishNote(oldPath, '', mtime, true);
      }
      const newFile = this.app.vault.getAbstractFileByPath(newPath);
      if (newFile instanceof TFile && this.nostrMailbox && this.nostrMailbox.isEligibleForMailbox(newPath, newFile.stat.size)) {
        let content = await this.app.vault.read(newFile);
        if (MySecretCompat.isArmored(content)) {
          const dec = await MySecretCompat.decryptArmored(this.app, content, newPath);
          if (dec === null) {
            // Fail-closed: no se publica en un relay público un bloque cifrado
            // que el resto de dispositivos no podrá descifrar.
            console.warn(
              '[OmniSync] Se omite la publicación: el contenido no se puede descifrar.',
              newPath
            );
            return;
          }
          content = dec;
        }
        const publishResult = await this.nostrMailbox.publishNote(newPath, content, newFile.stat.mtime, false);
        if (!publishResult.success) {
          this.pendingP2PPaths.add(newPath);
          this.settings.pendingP2PSync = Array.from(this.pendingP2PPaths);
          void this.saveSettings();
        }
      }
    }
  }

  private broadcastCursorPosition(pos: number, selection?: { from: number; to: number }): void {
    const activeFile = this.app.workspace.getActiveFile();
    const data = {
      filePath: activeFile ? activeFile.path : null,
      pos,
      selection,
    };

    for (const peer of this.peers.values()) {
      if (peer.isAuthenticated) {
        peer.sendLiveCursor(data).catch((err) => {
          console.warn('[OmniSync] Error enviando presencia:', err);
        });
      }
    }
  }

  private handleRemoteCursorUpdate(
    peer: WebRTCPeer,
    data: {
      filePath: string | null;
      pos?: number;
      selection?: { from: number; to: number };
    }
  ): void {
    const paired = this.settings.pairedDevices.find((d) => d.id === peer.remotePeerId);
    const color = paired?.color || '#3b82f6';
    const name = paired?.name || peer.remoteDeviceName;

    // Actualizar cursor remoto
    const existingIdx = this.remoteCursors.findIndex((c) => c.deviceId === peer.remotePeerId);
    const cursorObj: RemoteCursor = {
      deviceId: peer.remotePeerId,
      deviceName: name,
      color,
      filePath: data.filePath ?? '',
      from: data.selection ? data.selection.from : data.pos ?? 0,
      to: data.selection ? data.selection.to : data.pos ?? 0,
      lastUpdate: Date.now(),
    };

    if (existingIdx >= 0) {
      this.remoteCursors[existingIdx] = cursorObj;
    } else {
      this.remoteCursors.push(cursorObj);
    }

    // Forzar actualización de vista de CodeMirror
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && (activeView.editor as any).cm) {
      const cmView = (activeView.editor as any).cm;
      cmView.dispatch();
    }
  }

  private checkMySecretLockState(): void {
    const isLocked = MySecretCompat.isLocked(this.app);
    if (isLocked !== this.wasMySecretLocked) {
      this.wasMySecretLocked = isLocked;
      const count = Array.from(this.peers.values()).filter((p) => p.isConnected).length;
      if (isLocked) {
        if (this.statusBar) {
          this.statusBar.updateState('error', count, t('statusBar.statusMySecretLocked'));
        }
      } else {
        if (this.statusBar) {
          this.statusBar.updateState(count > 0 ? 'connected' : 'signaling', count);
        }
        new Notice(t('notices.mySecretUnlocked'));
        void this.pollMailboxOnStartup();
        void this.triggerFullSync();
        void this.repairDoubleEncryptedNotes(false);
      }
    }
  }

  public async repairDoubleEncryptedNotes(verbose = true): Promise<number> {
    if (MySecretCompat.isLocked(this.app)) {
      if (verbose) {
        new Notice(t('notices.unlockMySecretToRepair'));
      }
      return 0;
    }

    const files = this.app.vault.getMarkdownFiles();
    let repairedCount = 0;

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        if (MySecretCompat.isArmored(content)) {
          const decrypted = await MySecretCompat.decryptArmored(this.app, content, file.path);
          if (decrypted !== null) {
            if (this.vaultWatcher) this.vaultWatcher.ignoreNextChange(file.path);
            await this.app.vault.modify(file, decrypted);
            repairedCount++;
          }
        }
      } catch (err) {
        console.warn('[OmniSync] Error examinando nota:', file.path, err);
      }
    }

    if (repairedCount > 0) {
      new Notice(t('notices.repairedNotesCount', { count: repairedCount }));
    } else if (verbose) {
      new Notice(t('notices.noDoubleEncryptedNotes'));
    }

    return repairedCount;
  }

  public openPairingModal(): void {
    new PairingModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      (key) => this.pairNewDevice(key),
      (id) => this.unpairDevice(id),
      () => this.triggerFullSync(),
      (listener) => this.onDevicesChanged(listener),
      () => this.refreshDevices(),
      {
        start: (transport, onPaired, onEnded) => this.startPairingInvite(transport, onPaired, onEnded),
        workerAvailable: () =>
          isPrivateWorkerUrl(this.settings.signalingServer, this.settings.privateWorkerHosts),
      }
    ).open();
  }

  /**
   * Inicia una invitación efímera: el QR lleva un token de un solo uso (2 min) y la
   * clave maestra viaja cifrada por ECDH solo cuando el otro dispositivo lo presenta.
   */
  public async startPairingInvite(
    transport: PairingTransportKind,
    onPaired: () => void,
    onEnded: (reason: 'expired' | 'closed') => void
  ): Promise<PairingHostHandle> {
    const server = this.resolvePairingServer(transport);
    if (transport === 'worker' && !this.workerAuthKey) {
      throw new Error('La identidad de acceso al Worker no está disponible.');
    }
    return startPairingHost({
      transport,
      server,
      workerAuthKey: transport === 'worker' ? (this.workerAuthKey ?? undefined) : undefined,
      getPayload: async () => ({
        v: 1,
        name: this.settings.deviceName,
        platform: this.settings.devicePlatform,
        secret: this.settings.pairingSecret,
        roomId: this.settings.roomId,
        server: this.settings.signalingServer,
        privateWorker: isPrivateWorkerUrl(this.settings.signalingServer, this.settings.privateWorkerHosts),
      }),
      onPaired: (guest) => {
        if (
          isPlainObject(guest) &&
          typeof guest.deviceId === 'string' &&
          isValidDeviceId(guest.deviceId) &&
          typeof guest.deviceName === 'string' &&
          guest.deviceName.length <= 100 &&
          !/[\u0000-\u001f\u007f]/.test(guest.deviceName)
        ) {
          const platform =
            guest.devicePlatform === 'mobile' || guest.devicePlatform === 'desktop' ? guest.devicePlatform : undefined;
          // Quien tiene el código no puede renombrar ni reetiquetar un dispositivo ya vinculado.
          const known = this.settings.pairedDevices.some((d) => d.id === guest.deviceId);
          if (known) this.updateDeviceOnlineStatus(guest.deviceId, false);
          else this.updateDeviceOnlineStatus(guest.deviceId, false, guest.deviceName, platform);
        }
        onPaired();
      },
      onEnded,
    });
  }

  /** Servidor de encuentro: el Worker propio, o un relay Nostr (el configurado o nos.lol). */
  private resolvePairingServer(transport: PairingTransportKind): string {
    const configured = this.settings.signalingServer;
    if (transport === 'worker') {
      if (!isPrivateWorkerUrl(configured, this.settings.privateWorkerHosts)) {
        throw new Error('El canal por Worker requiere un Cloudflare Worker propio configurado.');
      }
      return configured;
    }
    const host = normalizeWorkerHost(configured) ?? '';
    return NOSTR_PAIRING_RELAY_HOSTS.includes(host) ? configured : DEFAULT_PAIRING_RELAY;
  }

  private pairingLinkBusy = false;

  /**
   * Entrada por enlace `obsidian://omnisync-pair`. Cualquier página puede lanzar este enlace, así que
   * nunca vincula sin una confirmación explícita, y solo atiende una a la vez.
   */
  private async handlePairingLink(data: unknown): Promise<void> {
    if (this.pairingLinkBusy) return;
    this.pairingLinkBusy = true;
    try {
      let uri: string;
      let server: string;
      try {
        uri = inviteUriFromLinkData(data);
        server = decodePairingInvite(uri).server;
      } catch {
        new Notice(t('pairingModal.invalidKeyNotice'));
        return;
      }
      // El invitado se conecta a este servidor antes de ver el resto: se muestra el destino real.
      if (!confirm(t('pairingModal.deepLinkConfirm', { server }))) return;
      const ok = await this.pairNewDevice(uri);
      new Notice(ok ? t('pairingModal.linkSuccessNotice') : t('pairingModal.invalidKeyNotice'));
    } finally {
      this.pairingLinkBusy = false;
    }
  }

  /** Una sola vinculación a la vez: dos en paralelo entrelazarían la escritura de clave, sala y claves derivadas. */
  private pairingInFlight = false;

  public async pairNewDevice(pairingDataOrUri: string): Promise<boolean> {
    if (this.pairingInFlight) {
      new Notice(t('pairingModal.pairingInProgress'));
      return false;
    }
    this.pairingInFlight = true;
    let guest: PairingGuestResult<unknown> | null = null;
    try {
      let input = pairingDataOrUri;
      if (isPairingInviteUri(pairingDataOrUri)) {
        // Código efímero: la clave maestra llega cifrada tras el intercambio ECDH.
        guest = await runPairingGuest<unknown>(decodePairingInvite(pairingDataOrUri));
        input = JSON.stringify(guest.payload);
      }
      const parsed = decodePairingPayload(input);
      const expectedRoomId = await this.cryptoManager.deriveRoomId(parsed.secret);
      if (expectedRoomId !== parsed.roomId) {
        guest?.abort();
        return false;
      }

      // El servidor viene del otro dispositivo (o de un QR ajeno): si cambia, se confirma antes de adoptarlo.
      if (parsed.server && parsed.server !== this.settings.signalingServer) {
        if (!confirm(t('pairingModal.newServerConfirm', { server: parsed.server }))) {
          guest?.abort();
          return false;
        }
      }

      this.settings.pairingSecret = parsed.secret;
      this.settings.roomId = expectedRoomId;
      // Ambos equipos deben compartir servidor de señalización o nunca se verán.
      if (parsed.server) {
        this.settings.signalingServer = validateSecureWebSocketUrl(parsed.server);
        if (parsed.privateWorker) {
          const host = normalizeWorkerHost(parsed.server);
          if (host && !this.settings.privateWorkerHosts.includes(host)) {
            this.settings.privateWorkerHosts.push(host);
          }
        }
      }
      await this.deriveDomainKeys();

      await this.saveSettings();
      this.initNetwork();
      try {
        await guest?.complete({
          deviceId: this.settings.deviceId,
          deviceName: this.settings.deviceName,
          devicePlatform: this.settings.devicePlatform,
        });
      } catch (e) {
        // La clave ya se adoptó: el anfitrión verá este dispositivo en cuanto se conecten.
        console.warn('[OmniSync] No se pudo confirmar la vinculación al anfitrión:', e);
      }
      return true;
    } catch (e) {
      guest?.abort();
      console.error('Error al decodificar clave de vinculación:', e);
      return false;
    } finally {
      this.pairingInFlight = false;
    }
  }

  public async unpairDevice(deviceId: string): Promise<void> {
    const peer = this.peers.get(deviceId);
    if (peer) {
      peer.close();
      this.peers.delete(deviceId);
    }
    // La clave es compartida: rotarla es la única revocación real del acceso
    // del dispositivo retirado. Esto exige volver a vincular los restantes.
    await this.resetMasterKey();
    this.updateStatus();
  }

  async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    const persisted = isPlainObject(raw) ? { ...raw } : {};
    const legacySecret =
      typeof persisted.pairingSecret === 'string' ? persisted.pairingSecret : '';
    delete persisted.pairingSecret;
    delete persisted.roomId;

    const storage = this.app.secretStorage;
    if (!storage) {
      throw new Error('Obsidian 1.11.4 o posterior es required para guardar la clave maestra de forma segura.');
    }

    const persistedSecretId = persisted.masterKeySecretId;
    const secretId =
      typeof persistedSecretId === 'string' &&
      /^[a-z0-9-]{1,128}$/.test(persistedSecretId)
        ? persistedSecretId
        : this.cryptoManager.generateSecretId();
    persisted.masterKeySecretId = secretId;

    let secret: string | null = storage.getSecret(secretId);
    if (!secret && legacySecret) {
      // Migración única: valida la clave antigua y la traslada al almacén seguro.
      this.cryptoManager.requirePairingSecret(legacySecret);
      secret = legacySecret;
      storage.setSecret(secretId, secret);
    }
    if (!secret) {
      secret = this.cryptoManager.generatePairingSecret();
      storage.setSecret(secretId, secret);
    } else {
      this.cryptoManager.requirePairingSecret(secret);
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...persisted,
      pairingSecret: secret,
      masterKeySecretId: secretId,
      roomId: '',
    };
    validateSecureWebSocketUrl(this.settings.signalingServer);
    this.sanitizeTombstones();
    this.sanitizeBooleanSettings();
    this.sanitizeBlossomSettings();
    this.sanitizeLanguageSettings();
  }

  /** `data.json` no es de confianza: solo se conservan lápidas bien formadas. */
  private sanitizeTombstones(): void {
    const clean: Record<string, { mtime: number; deletedAt: number }> = {};
    const raw: unknown = this.settings.deletedPaths;
    if (isPlainObject(raw)) {
      for (const [path, value] of Object.entries(raw)) {
        if (!isPlainObject(value)) continue;
        if (!Number.isSafeInteger(value.mtime) || !Number.isSafeInteger(value.deletedAt)) continue;
        try {
          if (validateVaultPath(path, this.vaultPathPolicy) !== path) continue;
        } catch {
          continue;
        }
        clean[path] = { mtime: value.mtime as number, deletedAt: value.deletedAt as number };
      }
    }
    this.settings.deletedPaths = clean;
    this.pruneTombstones();
  }

  private recordTombstone(path: string, mtime: number): void {
    const map = (this.settings.deletedPaths ??= {});
    map[path] = { mtime, deletedAt: Date.now() };
    this.pruneTombstones();
    void this.saveSettings();
  }

  private clearTombstone(path: string): void {
    const map = this.settings.deletedPaths;
    if (map && Object.prototype.hasOwnProperty.call(map, path)) {
      delete map[path];
      void this.saveSettings();
    }
  }

  /** Las lápidas caducan a los 30 días y se acotan para no crecer sin límite. */
  private pruneTombstones(): void {
    const map = this.settings.deletedPaths;
    if (!map) return;
    const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
    for (const [path, tomb] of Object.entries(map)) {
      if (tomb.deletedAt < cutoff) delete map[path];
    }
    const entries = Object.entries(map);
    if (entries.length > TOMBSTONE_MAX_ENTRIES) {
      entries.sort((a, b) => b[1].deletedAt - a[1].deletedAt);
      for (const [path] of entries.slice(TOMBSTONE_MAX_ENTRIES)) delete map[path];
    }
  }

  private sanitizeLanguageSettings(): void {
    const valid: LanguageOption[] = ['auto', 'en', 'es', 'ru', 'zh'];
    if (!this.settings.language || !valid.includes(this.settings.language)) {
      this.settings.language = 'auto';
    }
  }

  /**
   * Sanea las preferencias Blossom antes de usarlas o persistirlas.
   *
   * `data.json` no es una fuente de confianza: una lista de servidores no
   * HTTPS o un límite fuera de rango se rechazan y se sustituyen por valores
   * válidos, de modo que ni la UI ni la capa de red puedan divergir.
   */
  private sanitizeBlossomSettings(): void {
    this.settings.blossomServers = BlossomClient.normalizeServerList(
      this.settings.blossomServers
    );
    this.settings.privateWorkerHosts = normalizeWorkerHosts(this.settings.privateWorkerHosts);
    if (
      this.settings.maxBlobSizePreset !== '25mb' &&
      this.settings.maxBlobSizePreset !== '50mb' &&
      this.settings.maxBlobSizePreset !== '100mb' &&
      this.settings.maxBlobSizePreset !== 'custom'
    ) {
      this.settings.maxBlobSizePreset = '25mb';
    }
    const clamped = clampMaxBlobSizeMb(this.settings.customMaxBlobSizeMb);
    if (clamped === null) {
      this.settings.customMaxBlobSizeMb =
        this.settings.maxBlobSizePreset === '100mb'
          ? 100
          : this.settings.maxBlobSizePreset === '50mb'
          ? 50
          : 25;
    } else {
      this.settings.customMaxBlobSizeMb = clamped;
    }
  }

  /**
   * Sanea los indicadores booleanos de confianza antes de usarlos.
   */
  private sanitizeBooleanSettings(): void {
    sanitizeBooleanSettings(this.settings, DEFAULT_SETTINGS);
  }

  async saveSettings(): Promise<void> {
    this.cryptoManager.requirePairingSecret(this.settings.pairingSecret);
    if (!/^[a-z0-9-]{1,128}$/.test(this.settings.masterKeySecretId)) {
      throw new Error('El identificador del almacén de secretos es inválido.');
    }
    this.sanitizeBooleanSettings();
    this.sanitizeBlossomSettings();
    this.app.secretStorage.setSecret(
      this.settings.masterKeySecretId,
      this.settings.pairingSecret
    );

    const persisted: Partial<OmniSyncSettings> = { ...this.settings };
    // La clave maestra y el identificador derivado nunca se guardan en data.json.
    delete persisted.pairingSecret;
    delete persisted.roomId;
    await this.saveData(persisted);
  }
}
