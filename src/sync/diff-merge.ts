/**
 * OmniSync - Diff & 3-Way Merge Engine
 * Fusión de texto tripartita determinista para notas de Obsidian modificadas sin conexión.
 */

export interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  mergedText: string;
  conflictingHunksCount: number;
}

/** Presupuesto de comparaciones de la fusión: acota el tiempo con entradas hostiles. */
export const MAX_MERGE_COMPARISONS = 20_000_000;

export class DiffMergeEngine {
  /**
   * Ejecuta una fusión tripartita entre el texto base original (ancestro), la versión local y la remota.
   */
  public static threeWayMerge(
    ancestor: string,
    local: string,
    remote: string,
    localLabel = 'LOCAL',
    remoteLabel = 'REMOTE'
  ): MergeResult {
    // Si ambas versiones son idénticas, no hay conflicto
    if (local === remote) {
      return { success: true, hasConflicts: false, mergedText: local, conflictingHunksCount: 0 };
    }

    // Si local no cambió respecto al ancestro, toma remoto
    if (local === ancestor) {
      return { success: true, hasConflicts: false, mergedText: remote, conflictingHunksCount: 0 };
    }

    // Si remoto no cambió respecto al ancestro, toma local
    if (remote === ancestor) {
      return { success: true, hasConflicts: false, mergedText: local, conflictingHunksCount: 0 };
    }

    const eol = local.includes('\r\n') || (!local.includes('\n') && remote.includes('\r\n')) ? '\r\n' : '\n';
    const aLines = ancestor.split(/\r?\n/);
    const lLines = local.split(/\r?\n/);
    const rLines = remote.split(/\r?\n/);

    const mergedLines: string[] = [];
    let hasConflicts = false;
    let conflictCount = 0;

    let aIdx = 0;
    let lIdx = 0;
    let rIdx = 0;
    const budget = { remaining: MAX_MERGE_COMPARISONS };
    const failed: MergeResult = { success: false, hasConflicts: true, mergedText: '', conflictingHunksCount: 0 };

    while (aIdx < aLines.length || lIdx < lLines.length || rIdx < rLines.length) {
      // Caso 1: Los tres coinciden
      if (
        aIdx < aLines.length &&
        lIdx < lLines.length &&
        rIdx < rLines.length &&
        aLines[aIdx] === lLines[lIdx] &&
        aLines[aIdx] === rLines[rIdx]
      ) {
        mergedLines.push(aLines[aIdx]);
        aIdx++;
        lIdx++;
        rIdx++;
        continue;
      }

      // Caso 2: Local y Remoto hicieron exactamente el mismo cambio
      if (
        lIdx < lLines.length &&
        rIdx < rLines.length &&
        lLines[lIdx] === rLines[rIdx]
      ) {
        mergedLines.push(lLines[lIdx]);
        if (aIdx < aLines.length) aIdx++;
        lIdx++;
        rIdx++;
        continue;
      }

      // Buscar siguiente punto de sincronización común
      const syncPoint = this.findNextSyncPoint(aLines, aIdx, lLines, lIdx, rLines, rIdx, budget);
      // Presupuesto agotado: el llamador conserva una copia de conflicto.
      if (budget.remaining < 0) return failed;

      if (syncPoint) {
        const localChunk = lLines.slice(lIdx, syncPoint.nextL);
        const remoteChunk = rLines.slice(rIdx, syncPoint.nextR);
        const ancestorChunk = aLines.slice(aIdx, syncPoint.nextA);

        const localChanged = !this.arraysEqual(ancestorChunk, localChunk);
        const remoteChanged = !this.arraysEqual(ancestorChunk, remoteChunk);

        if (localChanged && !remoteChanged) {
          mergedLines.push(...localChunk);
        } else if (remoteChanged && !localChanged) {
          mergedLines.push(...remoteChunk);
        } else if (this.arraysEqual(localChunk, remoteChunk)) {
          mergedLines.push(...localChunk);
        } else {
          // Conflicto simultáneo en el mismo bloque
          hasConflicts = true;
          conflictCount++;
          mergedLines.push(`<<<<<<< ${localLabel}`);
          mergedLines.push(...localChunk);
          mergedLines.push('=======');
          mergedLines.push(...remoteChunk);
          mergedLines.push(`>>>>>>> ${remoteLabel}`);
        }

        aIdx = syncPoint.nextA;
        lIdx = syncPoint.nextL;
        rIdx = syncPoint.nextR;
      } else {
        // No hay más sincronización hasta el fin de archivo
        const localTail = lLines.slice(lIdx);
        const remoteTail = rLines.slice(rIdx);
        const ancestorTail = aLines.slice(aIdx);

        const localChanged = !this.arraysEqual(ancestorTail, localTail);
        const remoteChanged = !this.arraysEqual(ancestorTail, remoteTail);

        if (localChanged && !remoteChanged) {
          mergedLines.push(...localTail);
        } else if (remoteChanged && !localChanged) {
          mergedLines.push(...remoteTail);
        } else if (this.arraysEqual(localTail, remoteTail)) {
          mergedLines.push(...localTail);
        } else {
          hasConflicts = true;
          conflictCount++;
          mergedLines.push(`<<<<<<< ${localLabel}`);
          mergedLines.push(...localTail);
          mergedLines.push('=======');
          mergedLines.push(...remoteTail);
          mergedLines.push(`>>>>>>> ${remoteLabel}`);
        }
        break;
      }
    }

    return {
      success: true,
      hasConflicts,
      mergedText: mergedLines.join(eol),
      conflictingHunksCount: conflictCount,
    };
  }

  private static findNextSyncPoint(
    aLines: string[], aIdx: number,
    lLines: string[], lIdx: number,
    rLines: string[], rIdx: number,
    budget: { remaining: number }
  ): { nextA: number; nextL: number; nextR: number } | null {
    const maxLookahead = 50;

    for (let offset = 1; offset < maxLookahead; offset++) {
      for (let da = 0; da <= offset; da++) {
        for (let dl = 0; dl <= offset; dl++) {
          for (let dr = 0; dr <= offset; dr++) {
            if (--budget.remaining < 0) return null;
            const curA = aIdx + da;
            const curL = lIdx + dl;
            const curR = rIdx + dr;

            if (curA < aLines.length && curL < lLines.length && curR < rLines.length) {
              if (aLines[curA] === lLines[curL] && aLines[curA] === rLines[curR]) {
                // Verificar coincidencia de al menos 1 línea
                return { nextA: curA, nextL: curL, nextR: curR };
              }
            }
          }
        }
      }
    }

    return null;
  }

  private static arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
