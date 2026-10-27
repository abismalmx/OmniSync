/**
 * OmniSync - Temporal Sync Policy
 *
 * Decisiones puras sobre qué hacer con una orden remota respecto al estado
 * local. Centralizar estas reglas evita que cada handler aplique su propio
 * criterio y que una orden antigua destruya trabajo reciente.
 *
 * Regla general: una orden remota solo se aplica si su `mtime` es
 * posterior o igual al de la versión local. En caso contrario, la versión
 * local se conserva intacta.
 */

/** Resultado de evaluar una escritura remota sobre un archivo local. */
export type WriteDecision = 'apply' | 'skip_newer_local' | 'skip_folder';

/** Resultado de evaluar un borrado remoto sobre un archivo local. */
export type DeleteDecision = 'trash' | 'skip_newer_local' | 'skip_missing';

/** Resultado de evaluar un renombrado remoto sobre un archivo local. */
export type RenameDecision =
  | 'rename'
  | 'skip_newer_local'
  | 'skip_destination_exists'
  | 'skip_missing';

/**
 * Decide si una escritura remota debe aplicarse.
 *
 * @param localMtime `mtime` del archivo local existente, o `null` si no existe.
 * @param remoteMtime `mtime` de la versión remota.
 */
export function decideRemoteWrite(
  localMtime: number | null,
  remoteMtime: number
): WriteDecision {
  if (localMtime === null) return 'apply';
  // Una versión local estrictamente más reciente nunca se sobrescribe.
  if (localMtime > remoteMtime) return 'skip_newer_local';
  return 'apply';
}

/**
 * Decide si un borrado remoto debe aplicarse.
 *
 * El borrado nunca es destructivo: se usa la papelera de Obsidian para que la
 * acción sea reversible.
 */
export function decideRemoteDelete(
  localMtime: number | null,
  remoteMtime: number
): DeleteDecision {
  if (localMtime === null) return 'skip_missing';
  if (localMtime > remoteMtime) return 'skip_newer_local';
  return 'trash';
}

/**
 * Decide si un renombrado remoto debe aplicarse.
 *
 * No se sobrescribe un destino existente: el archivo local en el destino se
 * conserva y el renombrado se descarta.
 */
export function decideRemoteRename(
  localMtime: number | null,
  remoteMtime: number,
  destinationExists: boolean
): RenameDecision {
  if (localMtime === null) return 'skip_missing';
  if (destinationExists) return 'skip_destination_exists';
  if (localMtime > remoteMtime) return 'skip_newer_local';
  return 'rename';
}

/**
 * Decide cómo aplicar una nota remota del buzón asíncrono.
 *
 * - `apply`: la nota es más reciente y se escribe sin más.
 * - `skip`: la versión local es igual o más reciente, no se toca nada.
 * - `conflict`: la nota remota es más reciente pero el local cambió por su
 *   cuenta; se escribe la remota y se conserva la local en una copia.
 */
export type MailboxDecision = 'apply' | 'skip' | 'conflict';

export function decideMailboxNote(
  localMtime: number | null,
  noteMtime: number,
  localContent: string | null,
  noteContent: string,
  locallyModifiedSince: number
): MailboxDecision {
  if (localMtime === null) return 'apply';
  // La nota remota no es más reciente que la versión local.
  if (noteMtime <= localMtime) return 'skip';
  // Contenido idéntico: no hay nada que escribir.
  if (localContent !== null && localContent === noteContent) return 'skip';
  // El local se modificó desde la última sincronización: hay dos versiones.
  if (localMtime > locallyModifiedSince) return 'conflict';
  return 'apply';
}
