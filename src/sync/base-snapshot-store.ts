/**
 * OmniSync - Base Snapshot Store
 *
 * Almacén persistente de versiones base (ancestros) para notas y archivos de texto
 * que superan el umbral del buzón (< 64 KB).
 *
 *  - Implementado sobre IndexedDB (OmniSync_BaseSnapshots).
 *  - Compatible con Obsidian Desktop (Electron) y Obsidian Mobile (Android / iOS).
 *  - Mecanismo de fallback a memoria para entornos de prueba headless / Node.js.
 *
 * Seguridad: el contenido almacenado es el TEXTO PLANO de las notas. MySecret
 * protege la bóveda, pero IndexedDB es un almacén independiente: sin cifrado,
 * el texto plano de todas las notas quedaría en claro en el disco, eludiendo
 * la contraseña maestra del dispositivo. Por eso el contenido se cifra con
 * AES-256-GCM usando una clave derivada de la clave de emparejamiento.
 */

import { CryptoManager } from '../crypto/crypto-manager';
import { EncryptedMessagePayload } from '../types';

export interface BaseSnapshot {
  path: string;
  hash: string;
  /** Texto plano (solo en memoria) o vacío si el contenido va cifrado. */
  content: string;
  mtime: number;
  updatedAt: number;
  /** Marca de formato: `1` = contenido cifrado con AES-256-GCM. */
  encrypted?: number;
  /** Vector de inicialización y ciphertext del contenido cifrado. */
  iv?: string;
  ct?: string;
}

const DB_NAME = 'OmniSync_BaseSnapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

/** Contexto de derivación independiente para el almacén local de snapshots. */
export const SNAPSHOT_KEY_CONTEXT = 'OmniSync-Snapshot-v1';

export class BaseSnapshotStore {
  private db: IDBDatabase | null = null;
  private memoryFallback = new Map<string, BaseSnapshot>();
  private isMemoryMode = false;
  private initPromise: Promise<void> | null = null;
  private cryptoManager: CryptoManager | null = null;
  private snapshotKey: CryptoKey | null = null;

  constructor() {
    if (typeof indexedDB === 'undefined') {
      this.isMemoryMode = true;
    }
  }

  /**
   * Configura la clave de cifrado del almacén. Si no se configura, el
   * contenido NO se persiste en disco: solo se mantiene en memoria.
   */
  public async setEncryptionKey(
    cryptoManager: CryptoManager,
    pairingSecret: string
  ): Promise<void> {
    try {
      this.cryptoManager = cryptoManager;
      this.snapshotKey = await cryptoManager.deriveAesKey(
        pairingSecret,
        SNAPSHOT_KEY_CONTEXT
      );
    } catch (err) {
      console.warn(
        '[OmniSync BaseStore] No se pudo derivar la clave del almacén de snapshots.',
        err
      );
      this.snapshotKey = null;
    }
  }

  public async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve) => {
      if (this.isMemoryMode) {
        resolve();
        return;
      }

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (evt: IDBVersionChangeEvent) => {
          const db = (evt.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'path' });
          }
        };

        req.onsuccess = () => {
          this.db = req.result;
          resolve();
        };

        req.onerror = () => {
          // Si falla la apertura de IndexedDB (ej. modo incógnito restrictivo), degradar a memoria
          console.warn('[OmniSync BaseStore] Error abriendo IndexedDB, usando memoria temporal.');
          this.isMemoryMode = true;
          resolve();
        };
      } catch {
        // Cualquier fallo al abrir IndexedDB degrada a memoria temporal.
        this.isMemoryMode = true;
        resolve();
      }
    });

    return this.initPromise;
  }

  public async getBase(path: string): Promise<BaseSnapshot | null> {
    await this.init();

    let stored: BaseSnapshot | null = null;
    if (this.isMemoryMode || !this.db) {
      stored = this.memoryFallback.get(path) ?? null;
    } else {
      stored = await new Promise<BaseSnapshot | null>((resolve) => {
        try {
          const tx = this.db!.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(path);

          req.onsuccess = () => {
            resolve((req.result as BaseSnapshot) || null);
          };
          req.onerror = () => {
            resolve(this.memoryFallback.get(path) ?? null);
          };
        } catch {
          resolve(this.memoryFallback.get(path) ?? null);
        }
      });
    }

    if (!stored) return null;

    // Si el contenido persistido está cifrado, se descifra antes de devolverlo.
    if (stored.encrypted === 1 && stored.iv && stored.ct) {
      const plain = await this.decryptContent(stored);
      if (plain === null) {
        // No se puede descifrar (clave rotada o datos corruptos): se descarta.
        return null;
      }
      return { ...stored, content: plain };
    }

    return stored;
  }

  public async setBase(
    path: string,
    content: string,
    hash: string,
    mtime: number
  ): Promise<void> {
    await this.init();

    // La copia en memoria conserva el texto plano para los cálculos de diff.
    const memorySnapshot: BaseSnapshot = {
      path,
      hash,
      content,
      mtime,
      updatedAt: Date.now(),
    };
    this.memoryFallback.set(path, memorySnapshot);

    // Lo que se persiste se cifra: el texto plano nunca debe tocar el disco.
    const persisted = await this.encryptSnapshot(memorySnapshot);
    if (!persisted) {
      // Sin clave no se persiste nada en disco; solo queda en memoria.
      if (!this.isMemoryMode && this.db) {
        await this.removePersisted(path);
      }
      return;
    }

    if (this.isMemoryMode || !this.db) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(persisted);

        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async deleteBase(path: string): Promise<void> {
    await this.init();

    this.memoryFallback.delete(path);

    if (this.isMemoryMode || !this.db) {
      return;
    }

    await this.removePersisted(path);
  }

  /** Elimina una entrada persistida sin tocar la copia en memoria. */
  private async removePersisted(path: string): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(path);

        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /** Cifra el contenido de una instantánea con AES-256-GCM. */
  private async encryptSnapshot(
    snapshot: BaseSnapshot
  ): Promise<BaseSnapshot | null> {
    if (!this.cryptoManager || !this.snapshotKey) return null;
    try {
      const payload: EncryptedMessagePayload = await this.cryptoManager.encrypt(
        snapshot.content,
        this.snapshotKey
      );
      return {
        path: snapshot.path,
        hash: snapshot.hash,
        content: '',
        mtime: snapshot.mtime,
        updatedAt: snapshot.updatedAt,
        encrypted: 1,
        iv: payload.iv,
        ct: payload.ct,
      };
    } catch (err) {
      console.warn(
        '[OmniSync BaseStore] No se pudo cifrar la instantánea de:',
        snapshot.path,
        err
      );
      return null;
    }
  }

  /** Descifra el contenido persistido de una instantánea. */
  private async decryptContent(snapshot: BaseSnapshot): Promise<string | null> {
    if (!this.cryptoManager || !this.snapshotKey || !snapshot.iv || !snapshot.ct) {
      return null;
    }
    try {
      return await this.cryptoManager.decryptText(
        { v: 1, iv: snapshot.iv, ct: snapshot.ct },
        this.snapshotKey
      );
    } catch {
      return null;
    }
  }

  public async prune(validPaths: Set<string>): Promise<number> {
    await this.init();

    let prunedCount = 0;

    // Podar en memoria
    for (const p of this.memoryFallback.keys()) {
      if (!validPaths.has(p)) {
        this.memoryFallback.delete(p);
        prunedCount++;
      }
    }

    if (this.isMemoryMode || !this.db) {
      return prunedCount;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();

        req.onsuccess = (evt: any) => {
          const cursor = evt.target.result;
          if (cursor) {
            const key = cursor.key as string;
            if (!validPaths.has(key)) {
              cursor.delete();
              prunedCount++;
            }
            cursor.continue();
          } else {
            resolve(prunedCount);
          }
        };

        req.onerror = () => resolve(prunedCount);
      } catch {
        resolve(prunedCount);
      }
    });
  }

  public async clear(): Promise<void> {
    this.memoryFallback.clear();

    if (this.isMemoryMode || !this.db) {
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
    this.initPromise = null;
    this.snapshotKey = null;
    this.cryptoManager = null;
  }
}
