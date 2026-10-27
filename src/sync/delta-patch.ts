/**
 * OmniSync - Delta Patch Engine (Myers Diff & Unified Patch)
 *
 * Motor nativo de cálculo de diferencias (diff) y aplicación de parches (patch)
 * basado en el algoritmo de Eugene Myers (O(ND)).
 *
 *  - Cero dependencias externas (compatible con Desktop y Mobile).
 *  - Genera y parsea formato Unified Diff estándar con líneas de contexto.
 *  - Aplicación atómica: si un bloque de contexto no coincide exactamente,
 *    aborta sin alterar el texto base.
 */

export interface DiffHunk {
  oldStart: number; // 1-indexed
  oldLines: number;
  newStart: number; // 1-indexed
  newLines: number;
  lines: string[]; // Cada línea comienza con ' ', '+' o '-'
}

export interface UnifiedPatch {
  header?: string;
  hunks: DiffHunk[];
}

export interface PatchApplyResult {
  success: boolean;
  result?: string;
  error?: string;
}

/** Límite máximo de un parche que se acepta aplicar (protección DoS). */
export const MAX_PATCH_LENGTH = 4 * 1024 * 1024;
/** Límite máximo de bloques (hunks) por parche. */
export const MAX_PATCH_HUNKS = 10_000;
/** Número máximo de líneas de un hunk. */
export const MAX_PATCH_HUNK_LINES = 20_000;
/** Número de líneas de contexto admitido (0..100). */
export const MAX_CONTEXT_LINES = 100;
/**
 * Tope de la diferencia (D) en el algoritmo de Myers. La traza consume
 * O(D^2) memoria; este límite acota el peor caso a unos pocos MB.
 */
export const MAX_MYERS_DIFFERENCE = 4000;
/** Celdas Int32 máximas del rastro de Myers (~64 MiB). */
export const MAX_MYERS_TRACE_CELLS = 16 * 1024 * 1024;

export class DeltaPatchEngine {
  /**
   * Calcula el parche unificado estándar entre el texto base y el texto objetivo.
   *
   * @param baseText Texto antes de la edición
   * @param targetText Texto resultante tras la edición
   * @param contextLines Número de líneas de contexto alrededor de cada cambio (por defecto 3)
   * @param filePath Nombre de archivo opcional para la cabecera diff
   */
  public static computePatch(
    baseText: string,
    targetText: string,
    contextLines = 3,
    filePath = 'file'
  ): string {
    // El contexto se acota a un rango seguro: un valor de 0 provocaría que el
    // agrupador de hunks no avanzase (bucle infinito) y un valor enorme
    // multiplicaría el tamaño del parche sin benefiting al receptor.
    const safeContext = Math.min(
      MAX_CONTEXT_LINES,
      Math.max(0, Number.isFinite(contextLines) ? Math.floor(contextLines) : 3)
    );

    if (baseText === targetText) {
      return '';
    }

    const aLines = baseText.length === 0 ? [] : baseText.split('\n');
    const bLines = targetText.length === 0 ? [] : targetText.split('\n');

    // Obtener los pasos de edición (insert / delete / keep)
    const edits = this.myersDiff(aLines, bLines);

    // Agrupar ediciones contiguas en hunks con líneas de contexto
    const hunks = this.createHunks(edits, safeContext);
    if (hunks.length === 0) {
      return '';
    }

    const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
    const hunksText = hunks.map((h) => this.formatHunk(h)).join('\n');
    return header + hunksText;
  }

  /**
   * Aplica un parche unificado sobre el texto base.
   * La aplicación es estricta: todos los contextos y líneas a eliminar deben coincidir.
   */
  public static applyPatch(baseText: string, patchString: string): PatchApplyResult {
    if (typeof patchString !== 'string') {
      return { success: false, error: 'El parche no es una cadena válida.' };
    }
    if (patchString.length === 0) {
      return { success: true, result: baseText };
    }
    // Defensa contra DoS: un parche desmedido se rechaza antes de parsearlo.
    if (patchString.length > MAX_PATCH_LENGTH) {
      return {
        success: false,
        error: `El parche excede el límite de ${MAX_PATCH_LENGTH / (1024 * 1024)} MB.`,
      };
    }
    if (patchString.trim().length === 0) {
      return { success: true, result: baseText };
    }

    const hunks = this.parseUnifiedPatch(patchString);
    if (hunks.length === 0) {
      return { success: false, error: 'El parche no contiene bloques (hunks) válidos.' };
    }
    if (hunks.length > MAX_PATCH_HUNKS) {
      return {
        success: false,
        error: `El parche contiene demasiados bloques (máximo ${MAX_PATCH_HUNKS}).`,
      };
    }

    // Validación estructural de cada hunk antes de tocar el texto base.
    for (const hunk of hunks) {
      const structuralError = this.validateHunk(hunk);
      if (structuralError) {
        return { success: false, error: structuralError };
      }
    }

    const baseLines = baseText.length === 0 ? [] : baseText.split('\n');
    const resultLines: string[] = [];
    let baseIndex = 0; // 0-indexed cursor over baseLines

    for (const hunk of hunks) {
      const expectedOldStart0 = hunk.oldStart - 1;

      // Copiar líneas intactas antes de este hunk
      while (baseIndex < expectedOldStart0 && baseIndex < baseLines.length) {
        resultLines.push(baseLines[baseIndex]);
        baseIndex++;
      }

      // Procesar las líneas del hunk
      for (const line of hunk.lines) {
        const marker = line[0];
        const text = line.substring(1);

        if (marker === ' ') {
          // Contexto: debe coincidir con la línea actual de baseLines
          if (baseIndex >= baseLines.length || baseLines[baseIndex] !== text) {
            return {
              success: false,
              error: `Error de contexto en línea ${baseIndex + 1}: se esperaba '${text}' pero se encontró '${baseLines[baseIndex] ?? '<EOF>'}'`,
            };
          }
          resultLines.push(baseLines[baseIndex]);
          baseIndex++;
        } else if (marker === '-') {
          // Eliminación: debe coincidir con la línea a eliminar
          if (baseIndex >= baseLines.length || baseLines[baseIndex] !== text) {
            return {
              success: false,
              error: `Línea a eliminar no coincide en línea ${baseIndex + 1}: se esperaba '${text}' pero se encontró '${baseLines[baseIndex] ?? '<EOF>'}'`,
            };
          }
          baseIndex++; // Avanzamos sin agregarlo a resultLines
        } else if (marker === '+') {
          // Inserción: agregamos la nueva línea directamente
          resultLines.push(text);
        }
      }
    }

    // Copiar las líneas restantes de baseLines después del último hunk
    while (baseIndex < baseLines.length) {
      resultLines.push(baseLines[baseIndex]);
      baseIndex++;
    }

    return {
      success: true,
      result: resultLines.join('\n'),
    };
  }

  /* ────────────────────────────────────────────────────────────────
   * Algoritmo Myers Diff O(ND)
   * ──────────────────────────────────────────────────────────────── */

  private static myersDiff(
    a: string[],
    b: string[]
  ): Array<{ type: 'keep' | 'insert' | 'delete'; line: string }> {
    const N = a.length;
    const M = b.length;
    const max = N + M;

    if (max === 0) return [];

    // Tope de diferencia: el algoritmo de Myers es O(ND) en tiempo y O(D) en
    // memoria por iteración. Sin este límite, dos archivos muy distintos
    // (D cercano a N+M) provocarían un consumo de memoria O(D^2) desastroso.
    // `trace` guarda una copia de `v` (2·max+1 enteros) por iteración: el pico
    // de memoria es maxD·(2·max+1)·4 bytes, así que también se acota por presupuesto.
    const maxD = Math.min(
      max,
      MAX_MYERS_DIFFERENCE,
      Math.floor(MAX_MYERS_TRACE_CELLS / (2 * max + 1))
    );

    // Array v mapeado con offset de max para admitir índices negativos de -max a max
    const vOffset = max;
    const v = new Int32Array(2 * max + 1);
    const trace: Int32Array[] = [];

    v[vOffset + 1] = 0;

    let dFound = -1;
    for (let d = 0; d <= maxD; d++) {
      const vCopy = new Int32Array(v);
      trace.push(vCopy);

      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[vOffset + k - 1] < v[vOffset + k + 1])) {
          x = v[vOffset + k + 1]; // Moverse hacia abajo (inserción desde b)
        } else {
          x = v[vOffset + k - 1] + 1; // Moverse a la derecha (eliminación desde a)
        }

        let y = x - k;

        // Seguir la diagonal de coincidencias
        while (x < N && y < M && a[x] === b[y]) {
          x++;
          y++;
        }

        v[vOffset + k] = x;

        if (x >= N && y >= M) {
          dFound = d;
          break;
        }
      }

      if (dFound !== -1) break;
    }

    // Si se alcanzó el tope de diferencia sin converger, la diferencia se
    // calcula de forma trivial (todo el base como eliminaciones y todo el
    // target como inserciones). Es un parche válido y aplicable, aunque no
    // mínimo; la verificación `targetHash` del receptor lo garantiza.
    if (dFound === -1) {
      const script: Array<{ type: 'keep' | 'insert' | 'delete'; line: string }> = [];
      for (let i = 0; i < N; i++) script.push({ type: 'delete', line: a[i] });
      for (let j = 0; j < M; j++) script.push({ type: 'insert', line: b[j] });
      return script;
    }

    // Reconstruir la ruta inversa de edición desde trace
    const script: Array<{ type: 'keep' | 'insert' | 'delete'; line: string }> = [];
    let x = N;
    let y = M;

    for (let d = dFound; d > 0; d--) {
      const vPrev = trace[d];
      const k = x - y;

      const prevK = (k === -d || (k !== d && vPrev[vOffset + k - 1] < vPrev[vOffset + k + 1]))
        ? k + 1
        : k - 1;

      const prevX = vPrev[vOffset + prevK];
      const prevY = prevX - prevK;

      if (prevK === k + 1) {
        // Paso vertical (inserción de b)
        while (x > prevX && y > prevY + 1) {
          x--;
          y--;
          script.push({ type: 'keep', line: a[x] });
        }
        y--;
        script.push({ type: 'insert', line: b[y] });
      } else {
        // Paso horizontal (eliminación de a)
        while (x > prevX + 1 && y > prevY) {
          x--;
          y--;
          script.push({ type: 'keep', line: a[x] });
        }
        x--;
        script.push({ type: 'delete', line: a[x] });
      }

      x = prevX;
      y = prevY;
    }

    // Procesar cualquier coincidencia diagonal restante para d = 0
    while (x > 0 && y > 0) {
      x--;
      y--;
      script.push({ type: 'keep', line: a[x] });
    }

    return script.reverse();
  }

  /* ────────────────────────────────────────────────────────────────
   * Generación y formateo de Hunks
   * ──────────────────────────────────────────────────────────────── */

  private static createHunks(
    edits: Array<{ type: 'keep' | 'insert' | 'delete'; line: string }>,
    contextLines: number
  ): DiffHunk[] {
    const hunks: DiffHunk[] = [];

    let i = 0;
    let oldLineNum = 1;
    let newLineNum = 1;

    while (i < edits.length) {
      // Avanzar hasta encontrar el próximo cambio (delete o insert)
      if (edits[i].type === 'keep') {
        oldLineNum++;
        newLineNum++;
        i++;
        continue;
      }

      // Encontramos un cambio. Determinar inicio de contexto anterior
      const changeStartIndex = i;
      const contextStartIndex = Math.max(0, changeStartIndex - contextLines);

      // Calcular número de líneas a retroceder para oldStart y newStart
      let hunkOldStart = oldLineNum;
      let hunkNewStart = newLineNum;
      for (let c = changeStartIndex - 1; c >= contextStartIndex; c--) {
        hunkOldStart--;
        hunkNewStart--;
      }

      // Buscar el final de este grupo de cambios (incluyendo contexto posterior o fusiones de cambios cercanos)
      let changeEndIndex = i;
      let trailingKeeps = 0;

      while (changeEndIndex < edits.length) {
        if (edits[changeEndIndex].type !== 'keep') {
          trailingKeeps = 0;
        } else {
          trailingKeeps++;
          // Si encontramos más de 2 * contextLines seguidos de keep, cerramos este hunk
          if (trailingKeeps > 2 * contextLines) {
            break;
          }
        }
        changeEndIndex++;
      }

      // Con `contextLines = 0` el grupo de contexto trailing es vacío: el hunk
      // debe terminar justo en el último cambio, de lo contrario el índice no
      // avanzaría y el agrupador entraría en bucle infinito.
      const trailingContext = Math.min(trailingKeeps, contextLines);
      const hunkEndIndex = Math.min(
        edits.length,
        changeEndIndex - Math.max(0, trailingKeeps - trailingContext)
      );

      // Garantía de progreso: si el hunk no cubre ningún cambio, se avanza
      // manualmente para evitar cualquier possibility de bucle infinito.
      let safeEndIndex = hunkEndIndex;
      if (safeEndIndex <= changeStartIndex) {
        safeEndIndex = Math.min(edits.length, changeStartIndex + 1);
      }

      // Construir las líneas del hunk
      const hunkLines: string[] = [];
      let oldHunkCount = 0;
      let newHunkCount = 0;

      for (let h = contextStartIndex; h < safeEndIndex; h++) {
        const item = edits[h];
        if (item.type === 'keep') {
          hunkLines.push(` ${item.line}`);
          oldHunkCount++;
          newHunkCount++;
        } else if (item.type === 'delete') {
          hunkLines.push(`-${item.line}`);
          oldHunkCount++;
        } else if (item.type === 'insert') {
          hunkLines.push(`+${item.line}`);
          newHunkCount++;
        }
      }

      hunks.push({
        oldStart: hunkOldStart,
        oldLines: oldHunkCount,
        newStart: hunkNewStart,
        newLines: newHunkCount,
        lines: hunkLines,
      });

      // Actualizar contadores para continuar después del hunk
      for (let k = changeStartIndex; k < safeEndIndex; k++) {
        if (edits[k].type === 'keep') {
          oldLineNum++;
          newLineNum++;
        } else if (edits[k].type === 'delete') {
          oldLineNum++;
        } else if (edits[k].type === 'insert') {
          newLineNum++;
        }
      }

      i = safeEndIndex;
    }

    return hunks;
  }

  /**
   * Valida la coherencia interna de un hunk antes de aplicarlo.
   *
   * Un parche recibido de la red puede llevar rangos manipulados. Si no se
   * validan, `Math.max(0, oldStart - 1)` los enmascararía y el parche se
   * aplicaría sobre líneas equivocadas del archivo, corrompiendo la nota.
   */
  private static validateHunk(hunk: DiffHunk): string | null {
    // En unified diff, `start = 0` con `lines = 0` es la convención para un
    // rango vacío (archivo vacío o fichero borrado). Cualquier otro valor
    // no negativo es válido.
    if (!Number.isSafeInteger(hunk.oldStart) || hunk.oldStart < 0) {
      return `Rango inválido en el bloque (oldStart=${hunk.oldStart}).`;
    }
    if (!Number.isSafeInteger(hunk.newStart) || hunk.newStart < 0) {
      return `Rango inválido en el bloque (newStart=${hunk.newStart}).`;
    }
    if (!Number.isSafeInteger(hunk.oldLines) || hunk.oldLines < 0) {
      return `Rango inválido en el bloque (oldLines=${hunk.oldLines}).`;
    }
    if (!Number.isSafeInteger(hunk.newLines) || hunk.newLines < 0) {
      return `Rango inválido en el bloque (newLines=${hunk.newLines}).`;
    }
    // Un inicio en 0 solo es válido si el rango está vacío.
    if (hunk.oldStart === 0 && hunk.oldLines !== 0) {
      return 'Rango inválido en el bloque: oldStart=0 exige oldLines=0.';
    }
    if (hunk.newStart === 0 && hunk.newLines !== 0) {
      return 'Rango inválido en el bloque: newStart=0 exige newLines=0.';
    }
    if (hunk.lines.length > MAX_PATCH_HUNK_LINES) {
      return `El bloque excede el máximo de ${MAX_PATCH_HUNK_LINES} líneas.`;
    }

    // Los recuentos declarados en la cabecera deben coincidir con las líneas
    // reales del bloque.
    let actualOld = 0;
    let actualNew = 0;
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      if (marker === ' ') {
        actualOld++;
        actualNew++;
      } else if (marker === '-') {
        actualOld++;
      } else if (marker === '+') {
        actualNew++;
      } else {
        return `Línea de bloque con prefijo inválido: '${marker}'.`;
      }
    }
    if (actualOld !== hunk.oldLines) {
      return `Recuento de líneas de contexto inconsistente (esperado ${hunk.oldLines}, real ${actualOld}).`;
    }
    if (actualNew !== hunk.newLines) {
      return `Recuento de líneas nuevas inconsistente (esperado ${hunk.newLines}, real ${actualNew}).`;
    }

    return null;
  }

  private static formatHunk(hunk: DiffHunk): string {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    return [header, ...hunk.lines].join('\n');
  }

  /**
   * Analiza la cabecera de un bloque unificado.
   *
   * Formato aceptado: `@@ -<oldStart>[,<oldLines>] +<newStart>[,<newLines>] @@`.
   *
   * Se analiza de forma manual en lugar de con una expresión regular: un
   * patrón con cuantificadores anidados sobre campos opcionales es un
   * candidato habitual a backtracking y resultaba marcado por los analizadores
   * de seguridad. El recorrido lineal es acotado por la longitud de la línea
   * y no puede degradarse con entradas adversarias.
   *
   * @returns Los contadores del bloque o `null` si la cabecera no es válida.
   */
  private static parseHunkHeader(line: string): DiffHunk | null {
    const HUNK_HEADER = '@@ -';
    const HUNK_HEADER_END = ' @@';

    if (!line.startsWith(HUNK_HEADER)) return null;

    let cursor = HUNK_HEADER.length;
    const readNumber = (): number | null => {
      const start = cursor;
      while (cursor < line.length) {
        const code = line.charCodeAt(cursor);
        // Solo dígitos ASCII (0-9).
        if (code < 48 || code > 57) break;
        cursor++;
      }
      if (cursor === start) return null;
      const value = Number(line.slice(start, cursor));
      return Number.isSafeInteger(value) ? value : null;
    };

    const oldStart = readNumber();
    if (oldStart === null) return null;

    let oldLines: number | undefined;
    if (line.charCodeAt(cursor) === 44 /* ',' */) {
      cursor++;
      const parsed = readNumber();
      // Una coma debe ir seguida obligatoriamente de un número.
      if (parsed === null) return null;
      oldLines = parsed;
    }

    // Separador obligatorio: ` +`.
    if (line.charCodeAt(cursor) !== 32 /* ' ' */) return null;
    cursor++;
    if (line.charCodeAt(cursor) !== 43 /* '+' */) return null;
    cursor++;

    const newStart = readNumber();
    if (newStart === null) return null;

    let newLines: number | undefined;
    if (line.charCodeAt(cursor) === 44 /* ',' */) {
      cursor++;
      const parsed = readNumber();
      if (parsed === null) return null;
      newLines = parsed;
    }

    // Cierre obligatorio: ` @@`.
    if (!line.startsWith(HUNK_HEADER_END, cursor)) return null;

    return {
      oldStart,
      oldLines: oldLines ?? 1,
      newStart,
      newLines: newLines ?? 1,
      lines: [],
    };
  }

  private static parseUnifiedPatch(patch: string): DiffHunk[] {
    const lines = patch.split('\n');
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;

    for (const line of lines) {
      const parsed = this.parseHunkHeader(line);
      if (parsed) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = parsed;
      } else if (currentHunk) {
        if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
          currentHunk.lines.push(line);
        }
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }
}
