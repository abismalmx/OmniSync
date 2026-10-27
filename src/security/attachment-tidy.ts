/** Carpeta de adjuntos que OmniSync configura y oculta; nombre fijo a propósito (nunca viene de datos externos). */
export const TIDY_ATTACHMENT_FOLDER = 'Adjuntos';

/**
 * Decide qué hacer con la ruta de adjuntos configurada.
 * - `setConfig`: la ruta está en el valor por defecto de Obsidian (raíz) y se puede reemplazar.
 * - `hide`: solo se oculta la carpeta propia y únicamente si no contiene notas (si el usuario ya
 *   tenía una carpeta «Adjuntos» con notas, ocultarla las haría desaparecer del explorador).
 */
export function planAttachmentTidy(
  current: unknown,
  folderHasNotes: (folder: string) => boolean
): { setConfig: boolean; hide: boolean } {
  const value = typeof current === 'string' ? current : '';
  const isDefault = value === '' || value === '/';
  const folder = isDefault ? TIDY_ATTACHMENT_FOLDER : value;
  if (folder !== TIDY_ATTACHMENT_FOLDER) return { setConfig: false, hide: false };
  return { setConfig: isDefault && !folderHasNotes(folder), hide: !folderHasNotes(folder) };
}

/** CSS fijo: sin interpolar ninguna ruta, no hay inyección posible. */
export const TIDY_ATTACHMENT_CSS =
  `.nav-folder-title[data-path="${TIDY_ATTACHMENT_FOLDER}"],` +
  `.nav-folder-title[data-path="${TIDY_ATTACHMENT_FOLDER}"] + .nav-folder-children { display: none; }`;
