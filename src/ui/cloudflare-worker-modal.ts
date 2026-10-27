/**
 * OmniSync - Cloudflare Worker + R2 Setup Assistant Modal
 * Asistente modal interactivo con soporte dual y pestañas:
 * 1. Pestaña 1 (Predeterminada): Todo-en-Uno (Blossom R2 + Relay WebSocket Privado con Durable Objects).
 * 2. Pestaña 2: Solo Blossom (100% Web sin terminal en el panel de Cloudflare).
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import type OmniSyncPlugin from '../main';
import { t } from '../i18n';
import { BlossomClient } from '../network/blossom-client';
import { validateSecureWebSocketUrl } from '../security/network-security';
import { MAX_PRIVATE_WORKER_HOSTS, normalizeWorkerHost } from '../security/worker-auth';
import {
  CLOUDFLARE_PUBKEY_PLACEHOLDER,
  CLOUDFLARE_BLOSSOM_WORKER_TEMPLATE,
  CLOUDFLARE_ALLINONE_WORKER_TEMPLATE,
  CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE,
  CLOUDFLARE_PACKAGE_JSON_TEMPLATE,
  CLOUDFLARE_ONELINER_DEPLOY_COMMAND,
} from '../templates/cloudflare-worker-template';

export class CloudflareWorkerModal extends Modal {
  private plugin: OmniSyncPlugin;
  private onSaved: () => void;
  private currentTab: 'allinone' | 'blossom';
  private workerUrl = '';

  // All-in-One state
  private isTestingDual = false;
  private blossomCardEl: HTMLElement | null = null;
  private blossomCardBodyEl: HTMLElement | null = null;
  private signalingCardEl: HTMLElement | null = null;
  private signalingCardBodyEl: HTMLElement | null = null;

  // Blossom-only state
  private isTestingBlossom = false;
  private blossomStatusBoxEl: HTMLElement | null = null;

  constructor(
    app: App,
    plugin: OmniSyncPlugin,
    onSaved: () => void,
    initialTab: 'allinone' | 'blossom' = 'allinone'
  ) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
    this.currentTab = initialTab;

    // Inicializar URL si ya existe una configurada en Workers
    const firstServer = this.plugin.settings.blossomServers?.[0] || '';
    if (firstServer.includes('workers.dev')) {
      this.workerUrl = firstServer;
    } else if (this.plugin.settings.signalingServer.includes('workers.dev')) {
      this.workerUrl = this.plugin.settings.signalingServer.replace(/^wss:\/\//i, 'https://');
    }
  }

  /** Sustituye el marcador por la clave pública de acceso de este vault. */
  private fillTemplate(text: string): string {
    return text.split(CLOUDFLARE_PUBKEY_PLACEHOLDER).join(this.plugin.workerAuthPublicKeyHex);
  }

  /** Valida la URL introducida y devuelve las bases HTTPS/WSS y el host normalizado. */
  private resolveWorkerEndpoints(raw: string): { host: string; httpUrl: string; wsUrl: string } {
    const host = normalizeWorkerHost(raw);
    if (!host) throw new Error('URL de Worker inválida');
    return {
      host,
      httpUrl: BlossomClient.normalizeServerUrl(`https://${host}`),
      wsUrl: validateSecureWebSocketUrl(`wss://${host}/`),
    };
  }

  /** Registra el host como Worker propio para presentarle la identidad estable. */
  private rememberPrivateHost(host: string): void {
    const hosts = this.plugin.settings.privateWorkerHosts.filter((h) => h !== host);
    this.plugin.settings.privateWorkerHosts = [host, ...hosts].slice(0, MAX_PRIVATE_WORKER_HOSTS);
  }

  /** Muestra la clave pública que debe figurar en ALLOWED_PUBKEYS. */
  private renderPubkeyRow(container: HTMLElement): void {
    const pubkey = this.plugin.workerAuthPublicKeyHex;
    new Setting(container)
      .setName(t('cloudflareModal.pubkeyName'))
      .setDesc(t('cloudflareModal.pubkeyDesc'))
      .addText((text) => text.setValue(pubkey).setDisabled(true))
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.pubkeyCopyBtn'))
          .setIcon('copy')
          .onClick(async () => {
            await this.copyToClipboard(pubkey, t('cloudflareModal.pubkeyCopiedNotice'));
          })
      );
  }

  /** Comando mínimo que fija la clave pública actual como ALLOWED_PUBKEYS sin reescribir el proyecto. */
  private renderUpdateKeyCommand(container: HTMLElement): void {
    const command = `cd omnisync-server && npx wrangler deploy --var ALLOWED_PUBKEYS:${this.plugin.workerAuthPublicKeyHex}`;
    const box = container.createDiv({ cls: 'omnisync-cf-step-card' });
    box.createEl('h4', { text: t('cloudflareModal.updateKeyTitle') });
    box.createEl('p', { text: t('cloudflareModal.updateKeyDesc') });
    box.createEl('pre', { cls: 'omnisync-cf-code-container is-scrollable' }).setText(command);
    new Setting(box).addButton((btn) =>
      btn
        .setButtonText(t('cloudflareModal.updateKeyCopyBtn'))
        .setIcon('copy')
        .onClick(async () => {
          await this.copyToClipboard(command, t('cloudflareModal.aioCommandCopiedNotice'));
        })
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('omnisync-cf-modal');

    // Título y descripción
    contentEl.createEl('h2', { text: t('cloudflareModal.title'), cls: 'omnisync-cf-title' });
    contentEl.createEl('p', { text: t('cloudflareModal.desc'), cls: 'omnisync-cf-desc' });

    // Botón para abrir el panel de Cloudflare directamente en el navegador
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.openDashboardBtn'))
          .setIcon('external-link')
          .onClick(() => {
            window.open('https://dash.cloudflare.com/', '_blank');
          })
      );

    // Barra de pestañas
    const tabsContainer = contentEl.createDiv({ cls: 'omnisync-cf-tabs' });
    const tabAioBtn = tabsContainer.createEl('button', {
      cls: 'omnisync-cf-tab',
      text: t('cloudflareModal.tabAllInOne'),
    });
    const tabBlossomBtn = tabsContainer.createEl('button', {
      cls: 'omnisync-cf-tab',
      text: t('cloudflareModal.tabBlossomOnly'),
    });

    const aioPane = contentEl.createDiv({ cls: 'omnisync-cf-tab-pane' });
    const blossomPane = contentEl.createDiv({ cls: 'omnisync-cf-tab-pane' });

    const updateTabUI = () => {
      if (this.currentTab === 'allinone') {
        tabAioBtn.addClass('is-active');
        tabBlossomBtn.removeClass('is-active');
        aioPane.removeClass('is-hidden');
        blossomPane.addClass('is-hidden');
      } else {
        tabBlossomBtn.addClass('is-active');
        tabAioBtn.removeClass('is-active');
        blossomPane.removeClass('is-hidden');
        aioPane.addClass('is-hidden');
      }
    };

    tabAioBtn.addEventListener('click', () => {
      this.currentTab = 'allinone';
      updateTabUI();
    });

    tabBlossomBtn.addEventListener('click', () => {
      this.currentTab = 'blossom';
      updateTabUI();
    });

    // Renderizar contenidos de cada pestaña
    this.renderAllInOnePane(aioPane);
    this.renderBlossomOnlyPane(blossomPane);

    updateTabUI();
  }

  private renderAllInOnePane(container: HTMLElement): void {
    // Banner Todo-en-Uno
    const banner = container.createDiv({ cls: 'omnisync-cf-banner' });
    banner.createDiv({ cls: 'omnisync-cf-banner-title', text: '⚡ ' + t('cloudflareModal.aioBannerTitle') });
    banner.createEl('p', { cls: 'omnisync-cf-banner-desc', text: t('cloudflareModal.aioBannerDesc') });

    this.renderPubkeyRow(container);
    this.renderUpdateKeyCommand(container);

    const steps = container.createDiv({ cls: 'omnisync-cf-steps' });

    // Paso 1: Despliegue con 1 comando
    const step1 = steps.createDiv({ cls: 'omnisync-cf-step-card' });
    step1.createEl('h4', { text: t('cloudflareModal.aioStep1Title') });
    step1.createEl('p', { text: t('cloudflareModal.aioStep1Desc') });

    // Se muestra exactamente el texto que se copia: nada oculto en el portapapeles.
    const deployCommand = this.fillTemplate(CLOUDFLARE_ONELINER_DEPLOY_COMMAND);
    step1.createEl('p', { text: t('cloudflareModal.deployPreviewNote'), cls: 'omnisync-cf-desc' });
    const codeContainer = step1.createEl('pre', { cls: 'omnisync-cf-code-container is-scrollable' });
    codeContainer.setText(deployCommand);

    const step1Setting = new Setting(step1)
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.aioCopyCommandBtn'))
          .setCta()
          .setIcon('copy')
          .onClick(async () => {
            await this.copyToClipboard(deployCommand, t('cloudflareModal.aioCommandCopiedNotice'));
          })
      );
    step1Setting.settingEl.addClass('omnisync-cf-inline-setting');

    // Paso 2: Archivos individuales
    const step2 = steps.createDiv({ cls: 'omnisync-cf-step-card' });
    step2.createEl('h4', { text: t('cloudflareModal.aioStep2Title') });
    step2.createEl('p', { text: t('cloudflareModal.aioStep2Desc') });

    const filesGrid = step2.createDiv({ cls: 'omnisync-cf-files-grid' });
    const btnWorker = filesGrid.createEl('button', { text: t('cloudflareModal.aioCopyWorkerBtn') });
    btnWorker.addEventListener('click', async () => {
      await this.copyToClipboard(this.fillTemplate(CLOUDFLARE_ALLINONE_WORKER_TEMPLATE), t('cloudflareModal.aioWorkerCopiedNotice'));
    });

    const btnWrangler = filesGrid.createEl('button', { text: t('cloudflareModal.aioCopyWranglerBtn') });
    btnWrangler.addEventListener('click', async () => {
      await this.copyToClipboard(this.fillTemplate(CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE), t('cloudflareModal.aioWranglerCopiedNotice'));
    });

    const btnPackage = filesGrid.createEl('button', { text: t('cloudflareModal.aioCopyPackageBtn') });
    btnPackage.addEventListener('click', async () => {
      await this.copyToClipboard(this.fillTemplate(CLOUDFLARE_PACKAGE_JSON_TEMPLATE), t('cloudflareModal.aioPackageCopiedNotice'));
    });

    // Paso 3: URL y Verificación Dual
    const step3 = steps.createDiv({ cls: 'omnisync-cf-step-card' });
    step3.createEl('h4', { text: t('cloudflareModal.aioStep3Title') });
    step3.createEl('p', { text: t('cloudflareModal.aioStep3Desc') });

    // URL input
    new Setting(container)
      .setName(t('cloudflareModal.urlSettingName'))
      .setDesc(t('cloudflareModal.urlSettingDesc'))
      .addText((text) =>
        text
          .setPlaceholder(t('cloudflareModal.aioUrlPlaceholder'))
          .setValue(this.workerUrl)
          .onChange((val) => {
            this.workerUrl = val.trim();
          })
      );

    // Tarjetas Dual Status
    const dualCards = container.createDiv({ cls: 'omnisync-cf-dual-cards' });

    this.blossomCardEl = dualCards.createDiv({ cls: 'omnisync-cf-status-card' });
    this.blossomCardEl.createDiv({ cls: 'omnisync-cf-status-card-header', text: '📦 Blossom R2 Storage' });
    this.blossomCardBodyEl = this.blossomCardEl.createDiv({
      cls: 'omnisync-cf-status-card-body',
      text: t('cloudflareModal.aioUrlPlaceholder'),
    });

    this.signalingCardEl = dualCards.createDiv({ cls: 'omnisync-cf-status-card' });
    this.signalingCardEl.createDiv({ cls: 'omnisync-cf-status-card-header', text: '⚡ WebSocket Signaling (Durable Objects)' });
    this.signalingCardBodyEl = this.signalingCardEl.createDiv({
      cls: 'omnisync-cf-status-card-body',
      text: t('cloudflareModal.aioUrlPlaceholder'),
    });

    // Botones de acción All-in-One
    const actions = new Setting(container);
    actions.addButton((btn) =>
      btn
        .setButtonText(t('cloudflareModal.aioTestDualBtn'))
        .setIcon('wifi')
        .onClick(async () => {
          if (this.isTestingDual) return;
          await this.testDualConnection();
        })
    );

    actions.addButton((btn) =>
      btn
        .setButtonText(t('cloudflareModal.aioSaveBtn'))
        .setCta()
        .setIcon('check')
        .onClick(async () => {
          await this.saveAndActivateAllInOne();
        })
    );
  }

  private renderBlossomOnlyPane(container: HTMLElement): void {
    this.renderPubkeyRow(container);
    const stepsContainer = container.createDiv({ cls: 'omnisync-cf-steps' });

    // Paso 1
    const step1El = stepsContainer.createDiv({ cls: 'omnisync-cf-step-card' });
    step1El.createEl('h4', { text: t('cloudflareModal.step1Title') });
    step1El.createEl('p', { text: t('cloudflareModal.step1Desc') });
    const step1Copy = new Setting(step1El)
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.copyBucketBtn'))
          .setIcon('copy')
          .onClick(async () => {
            await this.copyToClipboard('omnisync-blossom', t('cloudflareModal.bucketCopiedNotice'));
          })
      );
    step1Copy.settingEl.addClass('omnisync-cf-inline-setting');

    // Paso 2
    const step2El = stepsContainer.createDiv({ cls: 'omnisync-cf-step-card' });
    step2El.createEl('h4', { text: t('cloudflareModal.step2Title') });
    step2El.createEl('p', { text: t('cloudflareModal.step2Desc') });

    const warningBox = step2El.createDiv({ cls: 'omnisync-cf-warning-box' });
    warningBox.createEl('strong', { text: t('cloudflareModal.accessWarningTitle') });
    warningBox.createEl('p', { text: t('cloudflareModal.accessWarningDesc') });

    // Paso 3
    const step3El = stepsContainer.createDiv({ cls: 'omnisync-cf-step-card' });
    step3El.createEl('h4', { text: t('cloudflareModal.step3Title') });
    step3El.createEl('p', { text: t('cloudflareModal.step3Desc') });
    const step3Copy = new Setting(step3El)
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.copyVariableBtn'))
          .setIcon('copy')
          .onClick(async () => {
            await this.copyToClipboard('MY_BUCKET', t('cloudflareModal.variableCopiedNotice'));
          })
      );
    step3Copy.settingEl.addClass('omnisync-cf-inline-setting');

    // Paso 4
    const step4El = stepsContainer.createDiv({ cls: 'omnisync-cf-step-card' });
    step4El.createEl('h4', { text: t('cloudflareModal.step4Title') });
    step4El.createEl('p', { text: t('cloudflareModal.step4Desc') });
    const step4Copy = new Setting(step4El)
      .addButton((btn) =>
        btn
          .setButtonText(t('cloudflareModal.copyCodeBtn'))
          .setCta()
          .setIcon('copy')
          .onClick(async () => {
            await this.copyToClipboard(
              CLOUDFLARE_BLOSSOM_WORKER_TEMPLATE,
              t('cloudflareModal.codeCopiedNotice')
            );
          })
      );
    step4Copy.settingEl.addClass('omnisync-cf-inline-setting');

    // Paso 5
    const step5El = stepsContainer.createDiv({ cls: 'omnisync-cf-step-card' });
    step5El.createEl('h4', { text: t('cloudflareModal.step5Title') });
    step5El.createEl('p', { text: t('cloudflareModal.step5Desc') });

    // URL input
    new Setting(container)
      .setName(t('cloudflareModal.urlSettingName'))
      .setDesc(t('cloudflareModal.urlSettingDesc'))
      .addText((text) =>
        text
          .setPlaceholder(t('cloudflareModal.urlPlaceholder'))
          .setValue(this.workerUrl)
          .onChange((val) => {
            this.workerUrl = val.trim();
          })
      );

    this.blossomStatusBoxEl = container.createDiv({ cls: 'omnisync-cf-status-box' });

    const actionsSetting = new Setting(container);
    actionsSetting.addButton((btn) =>
      btn
        .setButtonText(t('cloudflareModal.testConnectionBtn'))
        .setIcon('wifi')
        .onClick(async () => {
          if (this.isTestingBlossom) return;
          await this.testBlossomOnlyConnection();
        })
    );

    actionsSetting.addButton((btn) =>
      btn
        .setButtonText(t('cloudflareModal.saveBtn'))
        .setCta()
        .setIcon('check')
        .onClick(async () => {
          await this.saveAndActivateBlossomOnly();
        })
    );
  }

  private async copyToClipboard(text: string, noticeText: string): Promise<void> {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      new Notice(noticeText);
    } catch (err) {
      console.error('[OmniSync] Error al copiar al portapapeles:', err);
      new Notice('No se pudo copiar automáticamente.');
    }
  }

  private async testDualConnection(): Promise<void> {
    if (!this.blossomCardEl || !this.blossomCardBodyEl || !this.signalingCardEl || !this.signalingCardBodyEl) {
      return;
    }

    const raw = this.workerUrl.trim();
    if (!raw) {
      this.blossomCardEl.className = 'omnisync-cf-status-card state-error';
      this.blossomCardBodyEl.setText(t('cloudflareModal.invalidUrlNotice'));
      this.signalingCardEl.className = 'omnisync-cf-status-card state-error';
      this.signalingCardBodyEl.setText(t('cloudflareModal.invalidUrlNotice'));
      return;
    }

    let httpOrigin = '';
    let wsOrigin = '';
    try {
      const endpoints = this.resolveWorkerEndpoints(raw);
      httpOrigin = endpoints.httpUrl;
      wsOrigin = endpoints.wsUrl;
    } catch {
      this.blossomCardEl.className = 'omnisync-cf-status-card state-error';
      this.blossomCardBodyEl.setText(t('cloudflareModal.invalidUrlNotice'));
      this.signalingCardEl.className = 'omnisync-cf-status-card state-error';
      this.signalingCardBodyEl.setText(t('cloudflareModal.invalidUrlNotice'));
      return;
    }

    this.isTestingDual = true;
    this.blossomCardEl.className = 'omnisync-cf-status-card state-testing';
    this.blossomCardBodyEl.setText(t('cloudflareModal.aioTestingDual'));
    this.signalingCardEl.className = 'omnisync-cf-status-card state-testing';
    this.signalingCardBodyEl.setText(t('cloudflareModal.aioTestingDual'));

    try {
      await Promise.all([
        this.runBlossomCheck(httpOrigin),
        this.runSignalingCheck(wsOrigin),
      ]);
    } finally {
      this.isTestingDual = false;
    }
  }

  private async runBlossomCheck(httpOrigin: string): Promise<boolean> {
    const card = this.blossomCardEl;
    const body = this.blossomCardBodyEl;
    if (!card || !body) return false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(httpOrigin + '/', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        let isReady = true;
        let missingAuth = false;
        try {
          const data = (await resp.json()) as {
            services?: { blossom?: { status?: string }; auth?: { status?: string } };
          };
          if (data?.services?.blossom?.status === 'missing_r2_binding') {
            isReady = false;
          }
          if (data?.services?.auth?.status === 'missing_allowed_pubkeys') {
            missingAuth = true;
          }
        } catch {}

        if (missingAuth) {
          card.className = 'omnisync-cf-status-card state-error';
          body.setText(t('cloudflareModal.aioStatusNotConfigured'));
          return false;
        }

        if (isReady) {
          card.className = 'omnisync-cf-status-card state-success';
          body.setText(t('cloudflareModal.aioStatusBlossomOk'));
          return true;
        } else {
          card.className = 'omnisync-cf-status-card state-error';
          body.setText(
            t('cloudflareModal.aioStatusBlossomFail', { error: 'Falta MY_BUCKET en R2' })
          );
          return false;
        }
      }

      card.className = 'omnisync-cf-status-card state-error';
      body.setText(
        t('cloudflareModal.aioStatusBlossomFail', { error: `HTTP ${resp.status} ${resp.statusText}` })
      );
      return false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      card.className = 'omnisync-cf-status-card state-error';
      body.setText(
        t('cloudflareModal.aioStatusBlossomFail', { error: errorMsg })
      );
      return false;
    }
  }

  private async runSignalingCheck(wsOrigin: string): Promise<boolean> {
    const card = this.signalingCardEl;
    const body = this.signalingCardBodyEl;
    if (!card || !body) return false;

    return new Promise<boolean>((resolve) => {
      try {
        // Misma ruta que usa el plugin: sala HMAC de 256 bits y token NIP-98 firmado.
        const probeRoom = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, '0')
        ).join('');
        const wsUrl = this.plugin.buildWorkerSignalingUrl(wsOrigin, probeRoom);
        const socket = new WebSocket(wsUrl);
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { socket.close(); } catch {}
            card.className = 'omnisync-cf-status-card state-error';
            body.setText(
              t('cloudflareModal.aioStatusSignalingFail', { error: 'Timeout de conexión (8s)' })
            );
            resolve(false);
          }
        }, 8000);

        socket.onopen = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch {}
            card.className = 'omnisync-cf-status-card state-success';
            body.setText(t('cloudflareModal.aioStatusSignalingOk'));
            resolve(true);
          }
        };

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            card.className = 'omnisync-cf-status-card state-error';
            body.setText(
              t('cloudflareModal.aioStatusSignalingFail', { error: 'Handshake rechazado (¿ALLOWED_PUBKEYS?)' })
            );
            // Mostrar de inmediato la clave actual y el comando para registrarla.
            this.renderUpdateKeyCommand(card);
            resolve(false);
          }
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        card.className = 'omnisync-cf-status-card state-error';
        body.setText(
          t('cloudflareModal.aioStatusSignalingFail', { error: errorMsg })
        );
        resolve(false);
      }
    });
  }

  private async testBlossomOnlyConnection(): Promise<boolean> {
    if (!this.blossomStatusBoxEl) return false;
    this.blossomStatusBoxEl.empty();

    let normalizedUrl = '';
    try {
      normalizedUrl = BlossomClient.normalizeServerUrl(this.workerUrl);
    } catch {
      this.blossomStatusBoxEl.className = 'omnisync-cf-status-box state-error';
      this.blossomStatusBoxEl.setText(t('cloudflareModal.invalidUrlNotice'));
      return false;
    }

    this.isTestingBlossom = true;
    this.blossomStatusBoxEl.className = 'omnisync-cf-status-box state-testing';
    this.blossomStatusBoxEl.setText(t('cloudflareModal.testingConnection'));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(normalizedUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        let isBlossom = false;
        try {
          const data = (await resp.json()) as { name?: string; protocol?: string };
          if (data && typeof data.name === 'string' && data.name.startsWith('OmniSync')) {
            isBlossom = true;
          }
        } catch {
          isBlossom = false;
        }

        if (isBlossom) {
          this.blossomStatusBoxEl.className = 'omnisync-cf-status-box state-success';
          this.blossomStatusBoxEl.setText(t('cloudflareModal.testSuccess'));
          return true;
        }
      }

      this.blossomStatusBoxEl.className = 'omnisync-cf-status-box state-error';
      this.blossomStatusBoxEl.setText(
        t('cloudflareModal.testFailed', { error: `HTTP ${resp.status} ${resp.statusText}` })
      );
      return false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.blossomStatusBoxEl.className = 'omnisync-cf-status-box state-error';
      this.blossomStatusBoxEl.setText(t('cloudflareModal.testFailed', { error: errorMsg }));
      return false;
    } finally {
      this.isTestingBlossom = false;
    }
  }

  private async saveAndActivateAllInOne(): Promise<void> {
    const raw = this.workerUrl.trim();
    if (!raw) {
      new Notice(t('cloudflareModal.invalidUrlNotice'));
      return;
    }

    let httpUrl = '';
    let wsUrl = '';
    let host = '';
    try {
      ({ host, httpUrl, wsUrl } = this.resolveWorkerEndpoints(raw));
    } catch {
      new Notice(t('cloudflareModal.invalidUrlNotice'));
      return;
    }

    // 1. Blossom R2
    const currentServers = this.plugin.settings.blossomServers || [];
    const filtered = currentServers.filter((s) => s !== httpUrl);
    this.plugin.settings.blossomServers = [httpUrl, ...filtered];
    this.plugin.settings.enableBlossomSync = true;
    this.plugin.settings.maxBlobSizePreset = '100mb';
    this.plugin.settings.customMaxBlobSizeMb = 100;
    // El Worker todo-en-uno incluye el buzón asíncrono (relay privado en Durable Objects).
    this.plugin.settings.enableNostrMailbox = true;

    // 2. Servidor de Señalización Privado y registro como Worker propio
    this.plugin.settings.signalingServer = wsUrl;
    this.rememberPrivateHost(host);

    // 3. Guardar y reiniciar red
    await this.plugin.saveSettings();
    this.plugin.reconnectNetwork();

    new Notice(t('cloudflareModal.aioSavedNotice'));
    this.onSaved();
    this.close();
  }

  private async saveAndActivateBlossomOnly(): Promise<void> {
    let normalizedUrl = '';
    try {
      normalizedUrl = BlossomClient.normalizeServerUrl(this.workerUrl);
    } catch {
      new Notice(t('cloudflareModal.invalidUrlNotice'));
      return;
    }

    // 1. Colocar el servidor al inicio de la lista de servidores Blossom
    const currentServers = this.plugin.settings.blossomServers || [];
    const filtered = currentServers.filter((s) => s !== normalizedUrl);
    this.plugin.settings.blossomServers = [normalizedUrl, ...filtered];

    // 2. Activar sincronización Blossom automáticamente y registrar el Worker como propio
    this.plugin.settings.enableBlossomSync = true;
    const ownHost = normalizeWorkerHost(normalizedUrl);
    if (ownHost) this.rememberPrivateHost(ownHost);

    // 3. Ajustar el preset y límite a 100 MB
    this.plugin.settings.maxBlobSizePreset = '100mb';
    this.plugin.settings.customMaxBlobSizeMb = 100;

    // 4. Guardar configuración y reiniciar red
    await this.plugin.saveSettings();
    this.plugin.reconnectNetwork();

    new Notice(t('cloudflareModal.savedNotice'));
    this.onSaved();
    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
