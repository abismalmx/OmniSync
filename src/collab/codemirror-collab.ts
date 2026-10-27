/**
 * OmniSync - CodeMirror 6 Live Awareness & Collaborative Cursors
 *
 * Extensión de CodeMirror 6 que renderiza los cursores y las selecciones de
 * los dispositivos remotos sobre la nota abierta, y notifica la posición del
 * cursor local para su difusión por el canal de presencia en vivo.
 *
 * Dos mecanismos complementarios:
 *
 *  1. `StateField` + `StateEffect`: mantiene el estado de presencia remota
 *     dentro del `EditorState`. Al mapearse a través de los cambios del
 *     documento, las posiciones de los cursores remotos se ajustan solas,
 *     evitando desfases visuales cuando se inserta texto de forma remota.
 *  2. `ViewPlugin`: construye el `DecorationSet` a partir del estado de
 *     presencia y dibuja los cursores (`Decoration.widget`) y las selecciones
 *     (`Decoration.mark`).
 */

import {
  ChangeDesc,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RemoteCursor } from '../types';

/* ────────────────────────────────────────────────────────────────
 * Tipos públicos
 * ──────────────────────────────────────────────────────────────── */

/** Presencia de un dispositivo remoto dentro del editor. */
export interface RemotePresence {
  deviceId: string;
  deviceName: string;
  color: string;
  /** Posición del cursor (cabeza de la selección). */
  head: number;
  /** Inicio de la selección remota. */
  from: number;
  /** Fin de la selección remota. */
  to: number;
  /** Marca de tiempo de la última actualización. */
  lastUpdate: number;
}

/** Configuración del plugin de colaboración. */
export interface CollabConfig {
  /** Ruta del archivo abierto actualmente, o `null`. */
  getCurrentFilePath: () => string | null;
  /** Notifica la posición del cursor local para su difusión. */
  onLocalCursorChange: (pos: number, selection?: { from: number; to: number }) => void;
  /** Devuelve los cursores remotos conocidos. */
  getRemoteCursors: () => RemoteCursor[];
  /**
   * Tiempo máximo de vida de una presencia remota sin refrescar (ms).
   * Por defecto 30 segundos.
   */
  presenceTimeoutMs?: number;
}

/* ────────────────────────────────────────────────────────────────
 * Widget del cursor remoto
 * ──────────────────────────────────────────────────────────────── */

/**
 * Widget visual que representa el caret y la etiqueta del dispositivo remoto.
 */
class RemoteCursorWidget extends WidgetType {
  constructor(
    private readonly deviceName: string,
    private readonly color: string,
    private readonly lastUpdate: number
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'omnisync-remote-cursor-container';
    // Se fija el color como variable CSS para reutilizarlo en los pseudo-elementos.
    wrap.style.setProperty('--omnisync-remote-color', this.color);

    const caret = document.createElement('span');
    caret.className = 'omnisync-remote-caret';
    caret.style.backgroundColor = this.color;

    const label = document.createElement('span');
    label.className = 'omnisync-remote-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.deviceName;

    wrap.appendChild(caret);
    wrap.appendChild(label);
    return wrap;
  }

  override eq(other: RemoteCursorWidget): boolean {
    return (
      this.deviceName === other.deviceName &&
      this.color === other.color &&
      this.lastUpdate === other.lastUpdate
    );
  }
}

/* ────────────────────────────────────────────────────────────────
 * Estado de presencia (StateField + StateEffect)
 * ──────────────────────────────────────────────────────────────── */

/**
 * Efecto que fusiona un conjunto de presencias remotas en el editor.
 *
 * Las presencias entrantes se combinan con las ya almacenadas en lugar de
 * sustituirlas: así se conserva el remapeo de posiciones de los dispositivos
 * que todavía no han refrescado su cursor.
 */
export const setRemotePresence = StateEffect.define<RemotePresence[]>();

/**
 * Campo de estado que almacena las presencias remotas.
 *
 * Al recibir un cambio en el documento, las posiciones de cada presencia se
 * remapean a través del `ChangeDesc` de la transacción, de modo que los
 * cursores remotos siguen al texto cuando se inserta o elimina contenido.
 */
export const remotePresenceField = StateField.define<RemotePresence[]>({
  create(): RemotePresence[] {
    return [];
  },

  update(value: RemotePresence[], tr: Transaction): RemotePresence[] {
    // 1. Presencias remotas entrantes: se fusionan con las existentes.
    for (const effect of tr.effects) {
      if (effect.is(setRemotePresence)) {
        return mergePresence(value, effect.value);
      }
    }

    // 2. Sin cambios en el documento: el estado se conserva intacto.
    if (!tr.docChanged) {
      return value;
    }

    // 3. El documento cambió: se remapean las posiciones de los cursores.
    return value.map((presence) => mapPresence(presence, tr.changes));
  },
});

/**
 * Remapea las posiciones de una presencia a través de un conjunto de cambios.
 *
 * - `assoc = -1` mantiene la posición pegada al carácter anterior, de modo
 *   que un cursor situado justo antes de una inserción remota no se desplaza.
 * - `assoc = 1` mueve la posición con el texto insertado, que es el
 *   comportamiento natural para el extremo de una selección.
 */
function mapPresence(presence: RemotePresence, changes: ChangeDesc): RemotePresence {
  const head = clampToDoc(changes.mapPos(presence.head, -1));
  const from = clampToDoc(changes.mapPos(presence.from, -1));
  const to = clampToDoc(changes.mapPos(presence.to, 1));

  return {
    ...presence,
    head,
    from,
    to,
  };
}

/** Acota una posición al rango válido del documento. */
function clampToDoc(pos: number): number {
  return Math.max(0, pos);
}

/**
 * Mezcla las presencias remotas entrantes con las ya almacenadas.
 *
 * Solo se sobrescribe la presencia de un dispositivo cuando su marca de
 * tiempo es más reciente. Esto preserva el remapeo de posiciones aplicado
 * por el `StateField` cuando el documento local ha cambiado y el remoto aún
 * no ha enviado una actualización.
 */
function mergePresence(
  current: RemotePresence[],
  incoming: RemotePresence[]
): RemotePresence[] {
  const merged = new Map<string, RemotePresence>();
  for (const presence of current) {
    merged.set(presence.deviceId, presence);
  }

  for (const presence of incoming) {
    const existing = merged.get(presence.deviceId);
    if (!existing || presence.lastUpdate >= existing.lastUpdate) {
      merged.set(presence.deviceId, presence);
    }
  }

  return Array.from(merged.values());
}

/** Valida un color hexadecimal usado en estilos inline. */
function safeCursorColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : '#3b82f6';
}

/** Acota el nombre mostrado en la etiqueta del cursor. */
function safeCursorName(value: unknown): string {
  if (typeof value !== 'string') return 'Dispositivo';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 100) || 'Dispositivo';
}

/**
 * Convierte los cursores remotos expuestos por el orquestador en presencias
 * internas, normalizando las posiciones al rango válido del documento.
 */
function toPresence(
  cursor: RemoteCursor,
  docLength: number
): RemotePresence {
  // El orquestador informa `from`/`to`; la posición del caret se toma de
  // `to` salvo que el dispositivo remoto informe un `head` explícito.
  const headRaw = (cursor as RemoteCursor & { head?: number }).head;
  const head = clampPosition(
    headRaw !== undefined ? headRaw : cursor.to,
    docLength
  );

  return {
    deviceId: cursor.deviceId,
    deviceName: safeCursorName(cursor.deviceName),
    color: safeCursorColor(cursor.color),
    head,
    from: clampPosition(Math.min(cursor.from, cursor.to), docLength),
    to: clampPosition(Math.max(cursor.from, cursor.to), docLength),
    lastUpdate: cursor.lastUpdate,
  };
}

/** Acota una posición al intervalo [0, docLength]. */
function clampPosition(pos: number, docLength: number): number {
  if (!Number.isFinite(pos)) return 0;
  return Math.min(Math.max(0, pos), docLength);
}

/**
 * Construye el conjunto de decoraciones a partir de las presencias remotas.
 *
 * Las decoraciones se ordenan por `from` y, a igualdad, por el lado del
 * widget. `Decoration.set` con `sort = true` garantiza un orden válido
 * incluso cuando una selección remota invertida coincide con la posición
 * del caret, combinación que `RangeSetBuilder` rechaza.
 */
function buildDecorations(
  presences: RemotePresence[],
  docLength: number
): DecorationSet {
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];

  for (const presence of presences) {
    const from = clampPosition(presence.from, docLength);
    const to = clampPosition(presence.to, docLength);
    const head = clampPosition(presence.head, docLength);

    // Selección remota: marca sobre el rango resaltado.
    if (to > from) {
      ranges.push({
        from,
        to,
        value: Decoration.mark({
          class: 'omnisync-remote-selection',
          attributes: {
            style: `background-color: ${presence.color}33;`,
          },
        }),
      });
    }

    // Cursor remoto: widget en la posición del caret.
    ranges.push({
      from: head,
      to: head,
      value: Decoration.widget({
        widget: new RemoteCursorWidget(presence.deviceName, presence.color, presence.lastUpdate),
        // `side: -1` ancla el caret al texto que lo precede, de modo que
        // el texto insertado por otro dispositivo aparece después del cursor.
        side: -1,
      }),
    });
  }

  if (ranges.length === 0) {
    return Decoration.none;
  }

  return Decoration.set(ranges, true);
}

/* ────────────────────────────────────────────────────────────────
 * ViewPlugin
 * ──────────────────────────────────────────────────────────────── */

/**
 * Clase interna del plugin de vista. Mantiene el `DecorationSet` que dibuja
 * los cursores y selecciones remotas.
 */
class CollabViewPlugin {
  decorations: DecorationSet;

  /** Presencia remota conocida por el plugin, para la reconciliación. */
  private presence: RemotePresence[] = [];

  /** Evita reenviar la posición local cuando no ha cambiado. */
  private lastBroadcast = '';

  constructor(
    private readonly view: EditorView,
    private readonly config: CollabConfig
  ) {
    this.decorations = Decoration.none;
    this.syncPresence();
  }

  update(update: ViewUpdate): void {
    // 1. El documento cambió: las posiciones ya fueron remapeadas por el
    //    `StateField`, así que solo hay que redibujar.
    const presenceApplied = update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(setRemotePresence))
    );
    if (update.docChanged || presenceApplied) {
      this.presence = update.state.field(remotePresenceField, false) ?? this.presence;
      this.decorations = buildDecorations(this.presence, update.state.doc.length);
    }
    if (update.docChanged) {
      this.broadcastLocalCursor(update.state);
    }

    // 2. La selección local cambió: se difunde la nueva posición.
    if (update.selectionSet) {
      this.broadcastLocalCursor(update.state);
    }

    // 3. Se comprueba si hay presencias remotas nuevas o actualizadas.
    //    La comparación se hace fuera del ciclo de renderizado para no
    //    provocar un `dispatch()` mientras CodeMirror actualiza la vista.
    const incoming = this.collectRemotePresence();
    if (this.hasChanged(incoming)) {
      this.pendingPresence = incoming;
      // Se aplaza la aplicación al siguiente ciclo: `dispatch()` no puede
      // invocarse mientras la vista se está actualizando.
      this.schedulePresenceUpdate();
    }
  }

  /** Presencias remotas pendientes de aplicar al `EditorState`. */
  private pendingPresence: RemotePresence[] | null = null;

  /** Identificador del temporizador de aplicación diferida. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Aplica diferidamente las presencias remotas al `EditorState`.
   */
  private schedulePresenceUpdate(): void {
    if (this.pendingTimer !== null) return;

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const pending = this.pendingPresence;
      this.pendingPresence = null;
      if (!pending) return;

      // `EditorView` no expone un estado público de destrucción, por lo que
      // se comprueba que la vista siga teniendo un `EditorState` válido.
      if (!this.view.state) return;

      this.view.dispatch({
        effects: setRemotePresence.of(pending),
      });
    }, 0);
  }

  /**
   * Recolecta las presencias remotas visibles en el archivo actual.
   */
  private collectRemotePresence(): RemotePresence[] {
    const currentFile = this.config.getCurrentFilePath();
    if (!currentFile) return [];

    const docLength = this.view.state.doc.length;
    const timeout = this.config.presenceTimeoutMs ?? 30000;
    const now = Date.now();

    return this.config
      .getRemoteCursors()
      .filter(
        (cursor) =>
          cursor.filePath === currentFile && now - cursor.lastUpdate <= timeout
      )
      .map((cursor) => toPresence(cursor, docLength));
  }

  /**
   * Compara el conjunto entrante con el actual para detectar cambios.
   */
  private hasChanged(incoming: RemotePresence[]): boolean {
    if (incoming.length !== this.presence.length) return true;

    for (const candidate of incoming) {
      const current = this.presence.find(
        (p) => p.deviceId === candidate.deviceId
      );
      if (!current) return true;
      if (
        current.head !== candidate.head ||
        current.from !== candidate.from ||
        current.to !== candidate.to ||
        current.lastUpdate !== candidate.lastUpdate
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sincroniza la presencia remota inicial al arrancar el editor.
   */
  private syncPresence(): void {
    const incoming = this.collectRemotePresence();
    if (incoming.length === 0) return;

    this.presence = incoming;
    this.decorations = buildDecorations(incoming, this.view.state.doc.length);
    this.pendingPresence = incoming;
    this.schedulePresenceUpdate();
  }

  /**
   * Difunde la posición del cursor local, evitando emisiones duplicadas.
   */
  private broadcastLocalCursor(state: EditorState): void {
    const currentFile = this.config.getCurrentFilePath();
    if (!currentFile) return;

    const main = state.selection.main;
    const hasRange = main.from !== main.to;
    const payload = hasRange
      ? `${currentFile}:${main.from}:${main.to}:${main.head}`
      : `${currentFile}:${main.head}`;

    // Solo se notifica cuando la posición ha cambiado realmente.
    if (payload === this.lastBroadcast) return;
    this.lastBroadcast = payload;

    this.config.onLocalCursorChange(
      main.head,
      hasRange ? { from: main.from, to: main.to } : undefined
    );
  }

  destroy(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * Fábrica de la extensión
 * ──────────────────────────────────────────────────────────────── */

/**
 * Crea la extensión de CodeMirror 6 para la presencia colaborativa en vivo.
 *
 * La extensión combina:
 *  - Un `StateField` que mantiene las presencias remotas y remapea sus
 *    posiciones a través de los cambios del documento.
 *  - Un `ViewPlugin` que construye las decoraciones (cursores y
 *    selecciones) y difunde la posición del cursor local.
 */
export function createCollabExtension(config: CollabConfig): Extension {
  return [
    remotePresenceField,
    ViewPlugin.define(
      (view) => new CollabViewPlugin(view, config),
      {
        decorations: (plugin) => plugin.decorations,
      }
    ),
  ];
}

/**
 * Efecto público para inyectar presencias remotas desde el orquestador.
 *
 * Permite que la capa de red actualice la presencia de un dispositivo sin
 * depender del mecanismo interno de difusión.
 */
export function setRemotePresences(
  view: EditorView,
  presences: RemotePresence[]
): void {
  view.dispatch({ effects: setRemotePresence.of(presences) });
}

