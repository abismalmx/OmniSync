/**
 * OmniSync - Manifest Calculation & Delta Engine
 * Cálculo de deltas diferenciales entre manifiestos de bóvedas y detección de renombrados.
 */

import { FileManifestEntry, ManifestDelta, VaultManifest } from '../types';

export interface RenameEvent {
  oldPath: string;
  newPath: string;
  hash: string;
}

export class ManifestCalculator {
  /**
   * Compara el manifiesto local contra el remoto y opcionalmente el manifiesto base previo (ancestro)
   * para producir la lista precisa de sincronización.
   */
  public static computeDelta(
    localManifest: VaultManifest,
    remoteManifest: VaultManifest,
    baseManifest?: VaultManifest
  ): ManifestDelta {
    const toUpload: string[] = [];
    const toDownload: string[] = [];
    const conflicts: string[] = [];
    const toDelete: string[] = [];

    const localFiles = localManifest.files;
    const remoteFiles = remoteManifest.files;
    const baseFiles = baseManifest?.files || {};

    const allPaths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);

    // Solo propiedades propias: un archivo llamado `toString` no debe heredar
    // la función de Object.prototype y hacerse pasar por una entrada existente.
    const own = <T>(files: Record<string, T>, key: string): T | undefined =>
      Object.prototype.hasOwnProperty.call(files, key) ? files[key] : undefined;

    for (const path of allPaths) {
      const local = own(localFiles, path);
      const remote = own(remoteFiles, path);
      const base = own(baseFiles, path);

      // Caso 1: Archivo existe en ambos lados
      if (local && remote && !local.deleted && !remote.deleted) {
        if (local.hash === remote.hash) {
          // Contenido idéntico, nada que hacer
          continue;
        }

        // Si tenemos un ancestro base común
        if (base) {
          const localChanged = local.hash !== base.hash;
          const remoteChanged = remote.hash !== base.hash;

          if (localChanged && !remoteChanged) {
            toUpload.push(path);
          } else if (remoteChanged && !localChanged) {
            toDownload.push(path);
          } else if (localChanged && remoteChanged) {
            conflicts.push(path);
          }
        } else {
          // Sin base previa: comparar marcas de tiempo mtime
          if (local.mtime > remote.mtime) {
            toUpload.push(path);
          } else if (remote.mtime > local.mtime) {
            toDownload.push(path);
          } else {
            conflicts.push(path);
          }
        }
        continue;
      }

      // Caso 2: Solo en local (o remoto lo marcó borrado)
      if (local && !local.deleted && (!remote || remote.deleted)) {
        if (remote && remote.deleted) {
          // Lápida remota: se borra solo si el local no cambió después de la
          // versión que se borró; si es más reciente, el cambio local gana.
          if (local.mtime <= remote.mtime) {
            toDelete.push(path);
          } else {
            toUpload.push(path);
          }
        } else {
          // Es un archivo nuevo en local
          toUpload.push(path);
        }
        continue;
      }

      // Caso 3: Solo en remoto (o local lo marcó borrado)
      if (remote && !remote.deleted && (!local || local.deleted)) {
        // Con lápida local, el otro lado decide al calcular su propio delta
        // (borra su copia o la reenvía si es más reciente).
        if (!local) toDownload.push(path);
        continue;
      }
    }

    return { toUpload, toDownload, conflicts, toDelete };
  }

  /**
   * Detecta archivos que fueron renombrados o movidos comparando hashes de archivos eliminados y añadidos.
   */
  public static detectRenames(
    addedFiles: FileManifestEntry[],
    deletedFiles: FileManifestEntry[]
  ): RenameEvent[] {
    const renames: RenameEvent[] = [];
    const usedAdded = new Set<string>();

    for (const deleted of deletedFiles) {
      const match = addedFiles.find(
        (a) => !usedAdded.has(a.path) && a.hash === deleted.hash && a.size === deleted.size
      );
      if (match) {
        usedAdded.add(match.path);
        renames.push({
          oldPath: deleted.path,
          newPath: match.path,
          hash: match.hash,
        });
      }
    }

    return renames;
  }
}
