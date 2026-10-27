/**
 * OmniSync - Pairing Modal
 * Modal interactivo con generación de código QR, copia de claves criptográficas y gestión de dispositivos.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import * as QRCode from 'qrcode';
import { decodePairingPayload, encodePairingPayload } from '../security/pairing';
import { PairingHostHandle } from '../network/pairing-channel';
import { PairingTransportKind, encodePairingInvite, encodePairingLink, isPairingInviteUri } from '../security/pairing-session';
import { OmniSyncSettings } from '../types';
import { isPrivateWorkerUrl } from '../security/worker-auth';
import { t } from '../i18n';

export class PairingModal extends Modal {
  private settings: OmniSyncSettings;
  private onSaveSettings: () => Promise<void>;
  private onPairNewDevice: (pairingKey: string) => Promise<boolean>;
  private onUnpairDevice: (deviceId: string) => Promise<void>;
  private onTriggerSync: () => void;
  private subscribeDevices?: (listener: () => void) => () => void;
  private unsubscribeDevices?: () => void;
  private onRefreshDevices?: () => void;
  private startInviteFn?: (
    transport: PairingTransportKind,
    onPaired: () => void,
    onEnded: (reason: 'expired' | 'closed') => void
  ) => Promise<PairingHostHandle>;
  private workerAvailable?: () => boolean;
  private devicesCard: HTMLElement | null = null;

  constructor(
    app: App,
    settings: OmniSyncSettings,
    onSaveSettings: () => Promise<void>,
    onPairNewDevice: (pairingKey: string) => Promise<boolean>,
    onUnpairDevice: (deviceId: string) => Promise<void>,
    onTriggerSync: () => void,
    subscribeDevices?: (listener: () => void) => () => void,
    onRefreshDevices?: () => void,
    invites?: {
      start: NonNullable<PairingModal['startInviteFn']>;
      workerAvailable: () => boolean;
    }
  ) {
    super(app);
    this.settings = settings;
    this.onSaveSettings = onSaveSettings;
    this.onPairNewDevice = onPairNewDevice;
    this.onUnpairDevice = onUnpairDevice;
    this.onTriggerSync = onTriggerSync;
    this.subscribeDevices = subscribeDevices;
    this.onRefreshDevices = onRefreshDevices;
    this.startInviteFn = invites?.start;
    this.workerAvailable = invites?.workerAvailable;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('omnisync-pairing-modal');

    // Header
    const headerEl = contentEl.createDiv({ cls: 'omnisync-modal-header' });
    const iconEl = headerEl.createSpan({ cls: 'omnisync-header-icon' });
    setIcon(iconEl, 'omnisync-logo');
    const titleContainer = headerEl.createDiv();
    titleContainer.createEl('h2', { text: t('pairingModal.title'), cls: 'omnisync-title' });
    titleContainer.createEl('p', {
      text: t('pairingModal.subtitle'),
      cls: 'omnisync-subtitle',
    });
    titleContainer.createEl('span', {
      text: t('pairingModal.author'),
      cls: 'omnisync-modal-author',
    });

    // Contenedor principal de pestañas / columnas
    const bodyEl = contentEl.createDiv({ cls: 'omnisync-modal-body' });

    // Sección 1: QR y Clave para compartir
    this.renderShareSection(bodyEl);

    // Sección 2: Vincular nuevo dispositivo
    this.renderConnectSection(bodyEl);

    // Sección 3: Dispositivos enlazados
    this.renderPairedDevicesSection(bodyEl);

    // Los dispositivos se registran de forma asíncrona al conectar: refrescar en vivo.
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = this.subscribeDevices?.(() => {
      if (!this.devicesCard?.isConnected) return;
      const parent = this.devicesCard.parentElement!;
      this.devicesCard.remove();
      this.renderPairedDevicesSection(parent);
    });
  }

  private shareCard: HTMLElement | null = null;
  private invite: PairingHostHandle | null = null;
  private inviteUri = '';
  /** Contenido del QR: enlace que abre Obsidian. El código copiable (`inviteUri`) es la alternativa. */
  private inviteLink = '';
  private inviteStatus: 'idle' | 'starting' | 'active' | 'paired' | 'expired' | 'error' = 'idle';
  private inviteError = '';
  private inviteTransport: PairingTransportKind = 'nostr';
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Identifica la invitación vigente: respuestas tardías de una anterior (o tras cerrar) se descartan. */
  private inviteGen = 0;
  private legacyOpen = false;

  private renderShareSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'omnisync-card' });
    this.shareCard = card;
    this.paintShareCard();
    if (this.inviteStatus === 'idle') void this.startInvite();
  }

  private stopInvite(): void {
    this.invite?.cancel();
    this.invite = null;
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  private async startInvite(): Promise<void> {
    if (!this.startInviteFn) return;
    this.stopInvite();
    const gen = ++this.inviteGen;
    this.inviteStatus = 'starting';
    this.inviteError = '';
    this.paintShareCard();
    try {
      const handle = await this.startInviteFn(
        this.inviteTransport,
        () => {
          if (gen !== this.inviteGen) return;
          this.inviteStatus = 'paired';
          this.stopInvite();
          new Notice(t('pairingModal.invitePairedNotice'));
          this.paintShareCard();
        },
        (reason) => {
          if (gen !== this.inviteGen || this.inviteStatus !== 'active') return;
          if (reason === 'expired') {
            // El código caducó sin usarse: muere y se genera otro nuevo mientras el modal siga abierto.
            void this.startInvite();
            return;
          }
          this.inviteStatus = 'error';
          this.inviteError = t('pairingModal.inviteChannelClosed');
          this.stopInvite();
          this.paintShareCard();
        }
      );
      if (gen !== this.inviteGen) {
        // Se pidió otra invitación o se cerró el modal mientras esta se abría: no dejar el canal abierto.
        handle.cancel();
        return;
      }
      this.invite = handle;
      this.inviteUri = encodePairingInvite(handle.invite);
      this.inviteLink = encodePairingLink(handle.invite);
      this.inviteStatus = 'active';
      this.countdownTimer = setInterval(() => this.updateCountdown(), 1000);
    } catch (err: any) {
      if (gen !== this.inviteGen) return;
      this.inviteStatus = 'error';
      this.inviteError = err?.message || String(err);
    }
    this.paintShareCard();
  }

  private updateCountdown(): void {
    const el = this.shareCard?.querySelector('.omnisync-invite-countdown');
    if (!el || !this.invite) return;
    const left = Math.max(0, Math.ceil((this.invite.expiresAt - Date.now()) / 1000));
    el.setText(t('pairingModal.inviteExpiresIn', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }));
  }

  private paintShareCard(): void {
    const card = this.shareCard;
    if (!card || !card.isConnected) return;
    card.empty();
    const header = card.createDiv({ cls: 'omnisync-card-header' });
    const icon = header.createSpan();
    setIcon(icon, 'qr-code');
    header.createEl('h3', { text: t('pairingModal.step1Title') });

    card.createEl('p', { text: t('pairingModal.inviteDesc'), cls: 'omnisync-card-desc' });

    // Canal de encuentro: Nostr (sin montar nada) o el Worker propio.
    const channelRow = card.createDiv({ cls: 'omnisync-input-group' });
    const select = channelRow.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { value: 'nostr', text: t('pairingModal.channelNostr') });
    const workerOpt = select.createEl('option', { value: 'worker', text: t('pairingModal.channelWorker') });
    if (!this.workerAvailable?.()) workerOpt.disabled = true;
    select.value = this.inviteTransport;
    select.addEventListener('change', () => {
      this.inviteTransport = select.value as PairingTransportKind;
      void this.startInvite();
    });
    const regen = channelRow.createEl('button', { cls: 'omnisync-small-btn', text: t('pairingModal.inviteRegenBtn') });
    regen.addEventListener('click', () => void this.startInvite());

    if (this.inviteStatus === 'active' && this.inviteUri) {
      const qrWrapper = card.createDiv({ cls: 'omnisync-qr-wrapper' });
      const canvas = qrWrapper.createEl('canvas', { cls: 'omnisync-qr-canvas' });
      QRCode.toCanvas(canvas, this.inviteLink, {
        width: 200,
        margin: 2,
        color: { dark: '#1e293b', light: '#ffffff' },
      }).catch((err: any) => {
        console.error('Error generando QR:', err);
        qrWrapper.createEl('p', { text: t('pairingModal.qrError') });
      });
      card.createEl('p', { cls: 'omnisync-card-desc omnisync-invite-countdown' });
      this.updateCountdown();

      const btnContainer = card.createDiv({ cls: 'omnisync-btn-group' });
      const copyBtn = btnContainer.createEl('button', {
        cls: 'mod-cta omnisync-copy-btn',
        text: t('pairingModal.copyInviteBtn'),
      });
      setIcon(copyBtn.createSpan({ cls: 'omnisync-btn-icon' }), 'copy');
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(this.inviteUri);
        new Notice(t('pairingModal.copyNotice'));
      });
    } else {
      const messages: Record<string, string> = {
        starting: t('pairingModal.inviteStarting'),
        paired: t('pairingModal.invitePairedNotice'),
        expired: t('pairingModal.inviteExpired'),
        error: this.inviteError || t('pairingModal.inviteError'),
        idle: '',
      };
      card.createEl('p', { text: messages[this.inviteStatus], cls: 'omnisync-empty-state' });
    }

    // Modo heredado: clave permanente. Cualquiera que la vea conserva acceso de por vida.
    const details = card.createEl('details');
    details.createEl('summary', { text: t('pairingModal.legacyTitle') });
    const target = details.createDiv();
    target.createEl('p', { text: t('pairingModal.legacyWarning'), cls: 'omnisync-card-desc' });
    let painted = false;
    // La tarjeta se repinta al renovarse el QR: conservar si «Avanzado» estaba abierto.
    if (this.legacyOpen) {
      details.open = true;
      painted = true;
      this.renderLegacyShare(target);
    }
    details.addEventListener('toggle', () => {
      this.legacyOpen = details.open;
      if (!details.open || painted) return;
      painted = true;
      this.renderLegacyShare(target);
    });
  }

  private renderLegacyShare(target: HTMLElement): void {
    const card = target;
    const qrWrapper = card.createDiv({ cls: 'omnisync-qr-wrapper' });
    const canvas = qrWrapper.createEl('canvas', { cls: 'omnisync-qr-canvas' });

    // Payload canónico y estrictamente validado.
    const encodedPayload = encodePairingPayload({
      v: 1,
      name: this.settings.deviceName,
      platform: this.settings.devicePlatform,
      secret: this.settings.pairingSecret,
      roomId: this.settings.roomId,
      server: this.settings.signalingServer,
      privateWorker: isPrivateWorkerUrl(this.settings.signalingServer, this.settings.privateWorkerHosts),
    });

    QRCode.toCanvas(canvas, encodedPayload, {
      width: 200,
      margin: 2,
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
    }).catch((err: any) => {
      console.error('Error generando QR:', err);
      qrWrapper.createEl('p', { text: t('pairingModal.qrError') });
    });

    const btnContainer = card.createDiv({ cls: 'omnisync-btn-group' });
    const copyBtn = btnContainer.createEl('button', {
      cls: 'mod-cta omnisync-copy-btn',
      text: t('pairingModal.copyKeyBtn'),
    });
    const copyIcon = copyBtn.createSpan({ cls: 'omnisync-btn-icon' });
    setIcon(copyIcon, 'copy');

    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(encodedPayload);
      new Notice(t('pairingModal.copyNotice'));
      copyBtn.setText(t('pairingModal.keyCopiedBtn'));
      setTimeout(() => {
        copyBtn.setText(t('pairingModal.copyKeyBtn'));
      }, 2500);
    });
  }


  private renderConnectSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'omnisync-card' });
    const header = card.createDiv({ cls: 'omnisync-card-header' });
    const icon = header.createSpan();
    setIcon(icon, 'link');
    header.createEl('h3', { text: t('pairingModal.step2Title') });

    card.createEl('p', {
      text: t('pairingModal.step2Desc'),
      cls: 'omnisync-card-desc',
    });

    const inputWrapper = card.createDiv({ cls: 'omnisync-input-group' });
    const input = inputWrapper.createEl('input', {
      type: 'text',
      cls: 'omnisync-text-input',
      placeholder: t('pairingModal.step2Placeholder'),
    });

    const connectBtn = inputWrapper.createEl('button', {
      cls: 'mod-cta',
      text: t('pairingModal.linkBtn'),
    });

    connectBtn.addEventListener('click', async () => {
      const val = input.value.trim();
      if (!val) {
        new Notice(t('pairingModal.emptyKeyNotice'));
        return;
      }

      // Vincular reemplaza la clave maestra: avisar antes de que un Worker propio deje de aceptarnos.
      try {
        const replacesKey = isPairingInviteUri(val) || decodePairingPayload(val).secret !== this.settings.pairingSecret;
        if (replacesKey && !confirm(t('pairingModal.replaceKeyConfirm'))) {
          return;
        }
      } catch {
        // Un payload inválido lo notifica onPairNewDevice.
      }

      connectBtn.disabled = true;
      connectBtn.setText(t('pairingModal.linkingBtn'));

      try {
        const success = await this.onPairNewDevice(val);
        if (success) {
          new Notice(t('pairingModal.linkSuccessNotice'));
          input.value = '';
          // La clave de este dispositivo cambió: la invitación anterior ya no es válida, se genera otra.
          this.stopInvite();
          this.inviteGen++;
          this.inviteStatus = 'idle';
          this.onOpen(); // Recargar modal
        } else {
          new Notice(t('pairingModal.invalidKeyNotice'));
        }
      } catch (err: any) {
        new Notice(t('pairingModal.linkErrorNotice', { error: err.message || err }));
      } finally {
        connectBtn.disabled = false;
        connectBtn.setText(t('pairingModal.linkBtn'));
      }
    });
  }

  private renderPairedDevicesSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'omnisync-card omnisync-full-width' });
    this.devicesCard = card;
    const header = card.createDiv({ cls: 'omnisync-card-header' });
    const icon = header.createSpan();
    setIcon(icon, 'devices');
    header.createEl('h3', { text: t('pairingModal.step3Title') });

    const refreshBtn = header.createEl('button', {
      cls: 'omnisync-small-btn',
      attr: { 'aria-label': t('pairingModal.refreshBtn'), title: t('pairingModal.refreshBtn') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.style.marginLeft = 'auto';
    refreshBtn.addEventListener('click', () => {
      this.onRefreshDevices?.();
      const container = card.parentElement;
      if (!container) return;
      card.remove();
      this.renderPairedDevicesSection(container);
    });

    const count = this.settings.pairedDevices.length;
    if (count === 0) {
      card.createEl('p', {
        text: t('pairingModal.emptyDevices'),
        cls: 'omnisync-empty-state',
      });
      return;
    }

    const list = card.createDiv({ cls: 'omnisync-device-list' });

    for (const device of this.settings.pairedDevices) {
      const item = list.createDiv({ cls: 'omnisync-device-item' });

      const devIcon = item.createSpan({ cls: 'omnisync-dev-icon' });
      setIcon(devIcon, device.platform === 'mobile' ? 'smartphone' : 'laptop');

      const info = item.createDiv({ cls: 'omnisync-dev-info' });
      const nameLine = info.createDiv({ cls: 'omnisync-dev-name-line' });
      nameLine.createSpan({ text: device.name, cls: 'omnisync-dev-name' });

      const statusBadge = nameLine.createSpan({
        cls: `omnisync-badge ${device.isOnline ? 'badge-online' : 'badge-offline'}`,
      });
      statusBadge.setText(device.isOnline ? t('pairingModal.statusOnline') : t('pairingModal.statusOffline'));

      const lastSeen = device.lastSeen ? new Date(device.lastSeen).toLocaleTimeString() : t('pairingModal.noActivity');
      info.createSpan({
        text: t('pairingModal.lastSync', { time: lastSeen }),
        cls: 'omnisync-dev-meta',
      });

      const actions = item.createDiv({ cls: 'omnisync-dev-actions' });
      const unpairBtn = actions.createEl('button', {
        cls: 'mod-warning omnisync-small-btn',
        text: t('pairingModal.unpairBtn'),
      });

      unpairBtn.addEventListener('click', async () => {
        if (
          confirm(t('pairingModal.unpairConfirm', { name: device.name }))
        ) {
          await this.onUnpairDevice(device.id);
          new Notice(t('pairingModal.unpairNotice'));
          this.onOpen();
        }
      });
    }

    const footer = card.createDiv({ cls: 'omnisync-card-footer' });
    const syncNowBtn = footer.createEl('button', {
      cls: 'mod-cta',
      text: t('pairingModal.syncNowBtn'),
    });
    syncNowBtn.addEventListener('click', () => {
      this.onTriggerSync();
      new Notice(t('pairingModal.syncNowNotice'));
    });
  }

  onClose() {
    this.stopInvite();
    this.inviteGen++;
    this.legacyOpen = false;
    this.inviteStatus = 'idle';
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = undefined;
    const { contentEl } = this;
    contentEl.empty();
  }
}
