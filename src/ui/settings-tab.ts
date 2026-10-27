/**
 * OmniSync - Settings Tab
 * Pestaña de configuración integrada en las preferencias de Obsidian.
 * Creado por abismalmx.
 */

import { App, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type OmniSyncPlugin from '../main';
import { validateSecureWebSocketUrl } from '../security/network-security';
import { OMNISYNC_BANNER_DATA } from './icons';
import { BlossomClient } from '../network/blossom-client';
import {
  clampMaxBlobSizeMb,
  detectBlossomProvider,
  MAX_MAX_BLOB_SIZE_MB,
} from '../network/blossom-providers';
import { t, getLocalizedBlossomProviderInfo, LanguageOption } from '../i18n';
import { CloudflareWorkerModal } from './cloudflare-worker-modal';

export class OmniSyncSettingTab extends PluginSettingTab {
  plugin: OmniSyncPlugin;

  constructor(app: App, plugin: OmniSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Mantiene "Personalizado" seleccionado aunque la URL coincida con un preset. */
  private signalingCustomMode = false;

  private applyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Agrupa guardado y reconexión para no repetirlos en cada pulsación de tecla. */
  private saveAndReconnectDebounced(): void {
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      void this.plugin.saveSettings().then(() => this.plugin.reconnectNetwork());
    }, 700);
  }

  hide(): void {
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
      this.applyTimer = null;
      void this.plugin.saveSettings().then(() => this.plugin.reconnectNetwork());
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('omnisync-settings-tab');

    // Hero Header con Logo Oficial de OmniSync y Créditos de Autor
    const heroEl = containerEl.createDiv({ cls: 'omnisync-settings-hero' });
    heroEl.createEl('img', {
      cls: 'omnisync-settings-banner',
      attr: { src: OMNISYNC_BANNER_DATA, alt: 'OmniSync Logo' },
    });
    const heroInfo = heroEl.createDiv({ cls: 'omnisync-hero-info' });
    heroInfo.createEl('h2', { text: t('hero.title'), cls: 'omnisync-hero-title' });
    heroInfo.createEl('p', {
      text: t('hero.subtitle'),
      cls: 'omnisync-hero-subtitle',
    });
    heroInfo.createEl('div', {
      text: t('hero.author'),
      cls: 'omnisync-hero-author',
    });

    // Botón de acceso rápido al asistente de vinculación
    new Setting(containerEl)
      .setName(t('settings.pairingAssistantName'))
      .setDesc(t('settings.pairingAssistantDesc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.pairingAssistantBtn'))
          .setCta()
          .onClick(() => {
            this.plugin.openPairingModal();
          })
      );

    // Sección: Sincronización Automática
    containerEl.createEl('h3', { text: t('settings.automationHeader') });

    new Setting(containerEl)
      .setName(t('settings.autoSyncName'))
      .setDesc(t('settings.autoSyncDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.reconnectNetwork();
            }
          })
      );

    // Sección: Identidad del Dispositivo
    containerEl.createEl('h3', { text: t('settings.identityHeader') });

    new Setting(containerEl)
      .setName(t('settings.deviceNameName'))
      .setDesc(t('settings.deviceNameDesc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.deviceNamePlaceholder'))
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim() || t('settings.deviceNamePlaceholder');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.devicePlatformName'))
      .setDesc(t('settings.devicePlatformDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('desktop', t('settings.devicePlatformDesktop'))
          .addOption('mobile', t('settings.devicePlatformMobile'))
          .setValue(this.plugin.settings.devicePlatform)
          .onChange(async (value: any) => {
            this.plugin.settings.devicePlatform = value;
            await this.plugin.saveSettings();
          })
      );

    // Sección: Alcance de la Sincronización
    containerEl.createEl('h3', { text: t('settings.scopeHeader') });

    new Setting(containerEl)
      .setName(t('settings.syncAttachmentsName'))
      .setDesc(t('settings.syncAttachmentsDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAttachments)
          .onChange(async (value) => {
            this.plugin.settings.syncAttachments = value;
            await this.plugin.saveSettings();
            this.plugin.updateWatcherSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.syncConfigName'))
      .setDesc(t('settings.syncConfigDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianConfig)
          .onChange(async (value) => {
            this.plugin.settings.syncObsidianConfig = value;
            await this.plugin.saveSettings();
            this.plugin.updateWatcherSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.nostrMailboxName'))
      .setDesc(t('settings.nostrMailboxDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableNostrMailbox)
          .onChange(async (value) => {
            this.plugin.settings.enableNostrMailbox = value;
            await this.plugin.saveSettings();
            this.plugin.reconnectNetwork();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.blossomStorageName'))
      .setDesc(t('settings.blossomStorageDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlossomSync)
          .onChange(async (value) => {
            this.plugin.settings.enableBlossomSync = value;
            await this.plugin.saveSettings();
            this.plugin.reconnectNetwork();
            this.display();
          })
      );

    // Callout y acceso directo a la configuración de Cloudflare Worker + R2 (siempre visible)
    const calloutEl = containerEl.createDiv({ cls: 'omnisync-template-callout' });
    const calloutTitle = calloutEl.createDiv({ cls: 'omnisync-callout-title' });
    calloutTitle.setText(t('settings.blossomCalloutTitle'));
    const calloutDesc = calloutEl.createDiv({ cls: 'omnisync-callout-desc' });
    calloutDesc.setText(t('settings.blossomCalloutDesc'));

    new Setting(calloutEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.blossomCalloutAction'))
          .setCta()
          .setIcon('zap')
          .onClick(() => {
            new CloudflareWorkerModal(this.app, this.plugin, () => {
              this.display();
            }).open();
          })
      );

    if (this.plugin.settings.enableBlossomSync) {
      const serversSetting = new Setting(containerEl)
        .setName(t('settings.blossomServersName'))
        .setDesc(t('settings.blossomServersDesc'));

      // Insignia reactiva de proveedor detectado
      const providerCardEl = containerEl.createDiv({ cls: 'omnisync-blossom-card' });
      let limitInputEl: HTMLInputElement | null = null;
      let limitDropdown: any = null;

      const updateProviderUI = (firstUrl: string, autoUpdateLimit = false) => {
        const rawInfo = detectBlossomProvider(firstUrl);
        const localized = getLocalizedBlossomProviderInfo(rawInfo.type, rawInfo.badge, rawInfo.description);
        providerCardEl.empty();

        const badgeEl = providerCardEl.createDiv({ cls: 'omnisync-blossom-badge' });
        badgeEl.setText(localized.badge);

        const descEl = providerCardEl.createDiv({ cls: 'omnisync-blossom-desc' });
        descEl.setText(localized.description);

        if (autoUpdateLimit) {
          this.plugin.settings.customMaxBlobSizeMb = rawInfo.suggestedLimitMb;
          if (rawInfo.suggestedLimitMb === 25) {
            this.plugin.settings.maxBlobSizePreset = '25mb';
          } else if (rawInfo.suggestedLimitMb === 50) {
            this.plugin.settings.maxBlobSizePreset = '50mb';
          } else if (rawInfo.suggestedLimitMb === 100) {
            this.plugin.settings.maxBlobSizePreset = '100mb';
          } else {
            this.plugin.settings.maxBlobSizePreset = 'custom';
          }
          if (limitInputEl) {
            limitInputEl.value = String(rawInfo.suggestedLimitMb);
          }
          if (limitDropdown) {
            limitDropdown.setValue(this.plugin.settings.maxBlobSizePreset);
          }
        }
      };

      serversSetting.addTextArea((text) => {
        text
          .setPlaceholder(t('settings.blossomServersPlaceholder'))
          .setValue(this.plugin.settings.blossomServers?.join('\n') || '')
          .onChange(async (value) => {
            const servers = BlossomClient.normalizeServerList(
              value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
            );
            if (servers.length > 0) {
              const previousFirst = this.plugin.settings.blossomServers?.[0] || '';
              this.plugin.settings.blossomServers = servers;
              const newFirst = servers[0] || '';
              const prevProvider = detectBlossomProvider(previousFirst);
              const newProvider = detectBlossomProvider(newFirst);
              const providerChanged = prevProvider.type !== newProvider.type;
              updateProviderUI(newFirst, providerChanged);
              this.saveAndReconnectDebounced();
            }
          });
        text.inputEl.rows = 3;
        text.inputEl.cols = 35;
      });

      // Inicializar badge con el servidor actual
      const initialFirstServer = this.plugin.settings.blossomServers?.[0] || '';
      updateProviderUI(initialFirstServer, false);

      // Selector de presets
      new Setting(containerEl)
        .setName(t('settings.blossomPresetName'))
        .setDesc(t('settings.blossomPresetDesc'))
        .addDropdown((dropdown) => {
          limitDropdown = dropdown;
          dropdown.addOption('25mb', t('settings.blossomPreset25mb'));
          dropdown.addOption('50mb', t('settings.blossomPreset50mb'));
          dropdown.addOption('100mb', t('settings.blossomPreset100mb'));
          dropdown.addOption('custom', t('settings.blossomPresetCustom'));
          dropdown.setValue(this.plugin.settings.maxBlobSizePreset || '25mb');
          dropdown.onChange(async (val) => {
            this.plugin.settings.maxBlobSizePreset = val as '25mb' | '50mb' | '100mb' | 'custom';
            if (val === '25mb') {
              this.plugin.settings.customMaxBlobSizeMb = 25;
            } else if (val === '50mb') {
              this.plugin.settings.customMaxBlobSizeMb = 50;
            } else if (val === '100mb') {
              this.plugin.settings.customMaxBlobSizeMb = 100;
            }
            if (limitInputEl && this.plugin.settings.customMaxBlobSizeMb) {
              limitInputEl.value = String(this.plugin.settings.customMaxBlobSizeMb);
            }
            await this.plugin.saveSettings();
            this.plugin.reconnectNetwork();
          });
        });

      // Control numérico directo libre en MB
      new Setting(containerEl)
        .setName(t('settings.blossomCustomLimitName'))
        .setDesc(t('settings.blossomCustomLimitDesc'))
        .addText((text) => {
          limitInputEl = text.inputEl;
          text.inputEl.type = 'number';
          text.inputEl.min = '1';
          text.inputEl.max = String(MAX_MAX_BLOB_SIZE_MB);
          const currentMb =
            this.plugin.settings.customMaxBlobSizeMb ||
            (this.plugin.settings.maxBlobSizePreset === '100mb'
              ? 100
              : this.plugin.settings.maxBlobSizePreset === '50mb'
              ? 50
              : 25);
          text.setValue(String(currentMb));
          text.setPlaceholder(t('settings.blossomCustomLimitPlaceholder'));
          text.onChange(async (val) => {
            const parsed = clampMaxBlobSizeMb(Number(val));
            if (parsed !== null) {
              this.plugin.settings.customMaxBlobSizeMb = parsed;
              this.plugin.settings.maxBlobSizePreset =
                parsed === 25
                  ? '25mb'
                  : parsed === 50
                  ? '50mb'
                  : parsed === 100
                  ? '100mb'
                  : 'custom';
              if (limitDropdown) {
                limitDropdown.setValue(this.plugin.settings.maxBlobSizePreset);
              }
              this.saveAndReconnectDebounced();
            }
          });
        });
    }

    // Sección: Conectividad y Red
    containerEl.createEl('h3', { text: t('settings.networkHeader') });

    new Setting(containerEl)
      .setName(t('settings.signalingCloudflareBtnName'))
      .setDesc(t('settings.signalingCloudflareBtnDesc'))
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.signalingCloudflareBtn'))
          .setIcon('zap')
          .setCta()
          .onClick(() => {
            new CloudflareWorkerModal(this.app, this.plugin, () => {
              this.display();
            }, 'allinone').open();
          })
      );

    const isCloudflare = this.plugin.settings.signalingServer.includes('workers.dev');
    const PRESETS: Record<string, { name: string; url: string }> = {
      'nostr-noslol': {
        name: t('settings.signalingPresets.noslol'),
        url: 'wss://nos.lol',
      },
      'nostr-snort': {
        name: t('settings.signalingPresets.snort'),
        url: 'wss://relay.snort.social',
      },
      'nostr-mom': {
        name: t('settings.signalingPresets.mom'),
        url: 'wss://nostr.mom',
      },
      'nostr-damus': {
        name: t('settings.signalingPresets.damus'),
        url: 'wss://relay.damus.io',
      },
      ...(isCloudflare
        ? {
            'cloudflare': {
              name: t('settings.signalingPresets.cloudflareWorker'),
              url: this.plugin.settings.signalingServer,
            },
          }
        : {}),
      'custom': {
        name: t('settings.signalingPresets.custom'),
        url: '',
      },
    };

    let selectedKey = 'custom';
    for (const [k, v] of Object.entries(PRESETS)) {
      if (!this.signalingCustomMode && k !== 'custom' && this.plugin.settings.signalingServer === v.url) {
        selectedKey = k;
        break;
      }
    }

    let serverUrlText: TextComponent | undefined;

    new Setting(containerEl)
      .setName(t('settings.signalingServerName'))
      .setDesc(t('settings.signalingServerDesc'))
      .addDropdown((dropdown) => {
        for (const [key, info] of Object.entries(PRESETS)) {
          dropdown.addOption(key, info.name);
        }
        dropdown.setValue(selectedKey);
        dropdown.onChange(async (val) => {
          if (val === 'custom') {
            // La URL ya es editable abajo: no reconstruir la página (saltaba al inicio).
            this.signalingCustomMode = true;
            return;
          }
          this.signalingCustomMode = false;
          this.plugin.settings.signalingServer = PRESETS[val].url;
          await this.plugin.saveSettings();
          this.plugin.reconnectNetwork();
          // Actualizar el campo en sitio: reconstruir la página reinicia el scroll.
          serverUrlText?.setValue(PRESETS[val].url);
        });
      });

    new Setting(containerEl)
      .setName(t('settings.serverUrlName'))
      .setDesc(t('settings.serverUrlDesc'))
      .addText((text) => {
        serverUrlText = text;
        text
          .setPlaceholder(t('settings.serverUrlPlaceholder'))
          .setValue(this.plugin.settings.signalingServer)
          .onChange(async (value) => {
            const next = value.trim() || 'wss://nos.lol';
            try {
              validateSecureWebSocketUrl(next);
            } catch {
              return;
            }
            this.plugin.settings.signalingServer = next;
            this.saveAndReconnectDebounced();
          });
      });

    // Sección: Seguridad
    containerEl.createEl('h3', { text: t('settings.securityHeader') });

    new Setting(containerEl)
      .setName(t('settings.roomIdName'))
      .setDesc(t('settings.roomIdDesc'))
      .addText((text) =>
        text
          .setValue(this.plugin.signalingPublicRoomId)
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName(t('settings.trashProtectionName'))
      .setDesc(t('settings.trashProtectionDesc'))
      .addText((text) =>
        text
          .setValue(t('settings.trashProtectionValue'))
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName(t('settings.resetMasterKeyName'))
      .setDesc(t('settings.resetMasterKeyDesc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.resetMasterKeyBtn'))
          .setWarning()
          .onClick(async () => {
            if (
              confirm(t('settings.resetMasterKeyConfirm'))
            ) {
              await this.plugin.resetMasterKey();
              this.display();
            }
          })
      );

    // Sección: Idioma / Language (Ubicado al final de los ajustes)
    containerEl.createEl('h3', { text: t('settings.languageHeader') });

    new Setting(containerEl)
      .setName(t('settings.languageSettingName'))
      .setDesc(t('settings.languageSettingDesc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', t('settings.languageOptions.auto'))
          .addOption('en', t('settings.languageOptions.en'))
          .addOption('es', t('settings.languageOptions.es'))
          .addOption('ru', t('settings.languageOptions.ru'))
          .addOption('zh', t('settings.languageOptions.zh'))
          .setValue(this.plugin.settings.language || 'auto')
          .onChange(async (val) => {
            this.plugin.settings.language = val as LanguageOption;
            await this.plugin.saveSettings();
            this.plugin.updateLanguage(val as LanguageOption);
            this.display();
          });
      });
  }
}
