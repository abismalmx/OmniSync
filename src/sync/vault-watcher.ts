/**
 * OmniSync - Vault Watcher
 * Escucha eventos del sistema de archivos de Obsidian con prevención de bucles de eco y debounce.
 */

import { App, EventRef, TAbstractFile, TFile } from 'obsidian';
import { CryptoManager } from '../crypto/crypto-manager';
import { VaultPathPolicy, validateVaultPath } from '../security/vault-security';
import { MySecretCompat } from '../security/mysecret-compat';
import { FileManifestEntry } from '../types';

export interface VaultWatcherCallbacks {
  onFileChanged: (path: string, entry: FileManifestEntry, data: Uint8Array) => void;
  onFileDeleted: (path: string, mtime: number) => void;
  onFileRenamed: (oldPath: string, newPath: string, mtime: number) => void;
}

export class VaultWatcher {
  private app: App;
  private cryptoManager: CryptoManager;
  private callbacks: VaultWatcherCallbacks;
  private debounceTimers = new Map<string, any>();
  /** Acción diferida por ruta: permite ejecutarla de inmediato al cerrar. */
  private debounceRunners = new Map<string, () => Promise<void>>();
  private ignoredPaths = new Map<string, { until: number; hash?: string }>();
  private syncAttachments: boolean;
  private syncObsidianConfig: boolean;
  private eventRefs: EventRef[] = [];

  private get pathPolicy(): VaultPathPolicy {
    return {
      syncAttachments: this.syncAttachments,
      syncObsidianConfig: this.syncObsidianConfig,
    };
  }

  constructor(
    app: App,
    cryptoManager: CryptoManager,
    syncAttachments: boolean,
    syncObsidianConfig: boolean,
    callbacks: VaultWatcherCallbacks
  ) {
    this.app = app;
    this.cryptoManager = cryptoManager;
    this.syncAttachments = syncAttachments;
    this.syncObsidianConfig = syncObsidianConfig;
    this.callbacks = callbacks;
  }

  public updateConfig(syncAttachments: boolean, syncObsidianConfig: boolean): void {
    this.syncAttachments = syncAttachments;
    this.syncObsidianConfig = syncObsidianConfig;
  }

  /**
   * Registra una ruta para ser ignorada durante un periodo (evita bucles al escribir cambios remotos).
   */
  public ignoreNextChange(path: string, windowMs = 2000, expectedHash?: string): void {
    this.ignoredPaths.set(path, { until: Date.now() + windowMs, hash: expectedHash });
  }

  /**
   * Una escritura remota registrada con hash esperado solo ignora el evento si
   * el contenido es el escrito: una edición del usuario dentro de la ventana
   * (contenido distinto) sí debe sincronizarse. `contentAware` difiere esa
   * comprobación hasta conocer el hash real del archivo.
   */
  private isIgnored(path: string, contentAware = false): boolean {
    const entry = this.ignoredPaths.get(path);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.ignoredPaths.delete(path);
      return false;
    }
    if (contentAware && entry.hash) return false;
    return true;
  }

  private matchesExpectedWrite(path: string, hash: string): boolean {
    const entry = this.ignoredPaths.get(path);
    return !!entry && !!entry.hash && Date.now() <= entry.until && entry.hash === hash;
  }

  private shouldSyncFile(path: string, contentAware = false): boolean {
    if (this.isIgnored(path, contentAware)) return false;
    // Las copias de conflicto son instantáneas locales: nunca se sincronizan.
    if (/\.conflict-\d{8}-\d{6}(\.|$)/.test(path)) return false;

    try {
      const normalized = validateVaultPath(path, this.pathPolicy);
      if (normalized !== path) return false;
    } catch {
      return false;
    }

    // `validateVaultPath` ya aplica la política de adjuntos y de `.obsidian`.
    return true;
  }

  public registerEvents(): void {
    this.eventRefs.push(
      this.app.vault.on('create', (file) => this.handleCreateOrModify(file)),
      this.app.vault.on('modify', (file) => this.handleCreateOrModify(file)),
      this.app.vault.on('delete', (file) => this.handleDelete(file)),
      this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
    );
  }

  private handleCreateOrModify(abstractFile: TAbstractFile): void {
    if (!(abstractFile instanceof TFile)) return;
    const path = abstractFile.path;

    if (!this.shouldSyncFile(path, true)) return;

    // Debounce de 350ms para no saturar con cada tecla
    if (this.debounceTimers.has(path)) {
      clearTimeout(this.debounceTimers.get(path));
    }

    const run = async (): Promise<void> => {
      this.debounceTimers.delete(path);
      this.debounceRunners.delete(path);
      if (this.isIgnored(path, true)) return;

      // Si la bóveda está protegida por MySecret y está bloqueada, no leer para evitar excepciones
      if (MySecretCompat.isLocked(this.app)) {
        return;
      }

      try {
        const isBinary = !abstractFile.extension.match(/^(md|txt|canvas|json|css|js)$/i);
        const dataBytes = await MySecretCompat.readVaultFileBytes(this.app, abstractFile);
        // `null` = contenido cifrado en reposo que no se puede descifrar.
        // No se difunde nada en ese caso: propagar el ciphertext ajeno
        // duplicaría el cifrado en el resto de dispositivos.
        if (dataBytes === null) {
          return;
        }
        const hash = await this.cryptoManager.computeHash(dataBytes);
        if (this.matchesExpectedWrite(path, hash)) return;

        const entry: FileManifestEntry = {
          path,
          mtime: abstractFile.stat.mtime,
          size: dataBytes.byteLength,
          hash,
          isBinary,
        };

        this.callbacks.onFileChanged(path, entry, dataBytes);
      } catch (err) {
        console.warn('[OmniSync VaultWatcher] Error leyendo archivo modificado:', path, err);
      }
    };

    this.debounceRunners.set(path, run);
    this.debounceTimers.set(path, setTimeout(() => void run(), 350));
  }

  private handleDelete(abstractFile: TAbstractFile): void {
    if (!(abstractFile instanceof TFile)) return;
    const path = abstractFile.path;
    if (this.isIgnored(path)) return;
    if (!this.shouldSyncFile(path)) return;

    this.callbacks.onFileDeleted(path, abstractFile.stat.mtime);
  }

  private handleRename(abstractFile: TAbstractFile, oldPath: string): void {
    if (!(abstractFile instanceof TFile)) return;
    const newPath = abstractFile.path;
    if (this.isIgnored(oldPath) || this.isIgnored(newPath)) return;
    if (!this.shouldSyncFile(newPath)) return;

    this.callbacks.onFileRenamed(oldPath, newPath, abstractFile.stat.mtime);
  }

  /** Ejecuta ya las ediciones que esperan su debounce (cierre de la app). */
  public async flushPendingEdits(): Promise<void> {
    const runners = Array.from(this.debounceRunners.entries());
    for (const [path] of runners) clearTimeout(this.debounceTimers.get(path));
    await Promise.all(runners.map(([, run]) => run().catch(() => {})));
  }

  public cleanup(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.debounceRunners.clear();
    this.ignoredPaths.clear();
    for (const ref of this.eventRefs) {
      try {
        this.app.vault.offref(ref);
      } catch {}
    }
    this.eventRefs = [];
  }
}
