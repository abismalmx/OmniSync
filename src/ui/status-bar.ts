/**
 * OmniSync - Status Bar UI
 * Indicador de estado interactivo en la barra inferior de Obsidian.
 */

import { setIcon } from 'obsidian';
import { SyncState } from '../types';
import { t } from '../i18n';

export class OmniSyncStatusBar {
  private element: HTMLElement;
  private iconEl: HTMLElement;
  private textEl: HTMLElement;
  private onClickCallback: () => void;
  private lastState: SyncState = 'disconnected';
  private lastPeerCount: number = 0;
  private lastCustomMessage?: string;

  constructor(statusBarItem: HTMLElement, onClick: () => void) {
    this.element = statusBarItem;
    this.onClickCallback = onClick;

    this.element.addClass('omnisync-status-bar');
    this.element.setAttribute('aria-label', t('statusBar.tooltipDefault'));

    this.iconEl = this.element.createSpan({ cls: 'omnisync-status-icon' });
    this.textEl = this.element.createSpan({ cls: 'omnisync-status-text' });

    this.element.addEventListener('click', () => {
      this.onClickCallback();
    });

    this.updateState('disconnected', 0);
  }

  public updateState(state: SyncState, peerCount: number, customMessage?: string): void {
    this.lastState = state;
    this.lastPeerCount = peerCount;
    this.lastCustomMessage = customMessage;

    this.element.removeClass('state-connected', 'state-syncing', 'state-connecting', 'state-signaling', 'state-disconnected', 'state-error');
    this.element.addClass(`state-${state}`);

    this.iconEl.empty();
    this.iconEl.removeClass('omnisync-spin', 'omnisync-pulse');

    switch (state) {
      case 'connected':
        setIcon(this.iconEl, 'wifi');
        this.textEl.setText(t('statusBar.connectedLabel', { count: peerCount }));
        this.element.setAttribute(
          'aria-label',
          t('statusBar.connectedTooltip', { count: peerCount })
        );
        break;

      case 'syncing':
        setIcon(this.iconEl, 'refresh-cw');
        this.iconEl.addClass('omnisync-spin');
        this.textEl.setText(customMessage || t('statusBar.syncingLabel'));
        this.element.setAttribute('aria-label', t('statusBar.syncingTooltip'));
        break;

      case 'connecting':
      case 'signaling':
        setIcon(this.iconEl, 'loader-2');
        this.iconEl.addClass('omnisync-pulse');
        this.textEl.setText(t('statusBar.connectingLabel'));
        this.element.setAttribute('aria-label', t('statusBar.connectingTooltip'));
        break;

      case 'error':
        setIcon(this.iconEl, 'alert-circle');
        this.textEl.setText(t('statusBar.errorLabel'));
        this.element.setAttribute('aria-label', t('statusBar.errorTooltip'));
        break;

      case 'disconnected':
      default:
        setIcon(this.iconEl, 'wifi-off');
        this.textEl.setText(t('statusBar.disconnectedLabel'));
        this.element.setAttribute('aria-label', t('statusBar.disconnectedTooltip'));
        break;
    }
  }

  public refresh(): void {
    this.updateState(this.lastState, this.lastPeerCount, this.lastCustomMessage);
  }
}
