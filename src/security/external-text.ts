/**
 * OmniSync - External Text Sanitizer
 *
 * Los relays, servidores Blossom y respuestas de red son entradas no
 * confiables: un tercero puede devolver texto de longitud arbitraria, con
 * caracteres de control, saltos de línea o secuencias de escape. Antes de
 * mostrar ese texto en una interfaz o registrarlo en consola se normaliza
 * para que no pueda:
 *
 * - inyectar saltos de línea o caracteres de control en los mensajes de la UI;
 * - inyectar secuencias de escape ANSI en la consola del desarrollador;
 * - hacer crecer los mensajes de error sin límite (DoS de memoria/logs);
 * - suplantar el prefijo de los mensajes del plugin ("OmniSync: ...").
 */

/** Longitud máxima por defecto de un texto externo saneado. */
export const MAX_EXTERNAL_TEXT_LENGTH = 160;

/**
 * Prefijo reservado de los mensajes emitidos por el plugin. Un texto externo
 * no puede presentarse como si procediera de OmniSync.
 */
const PLUGIN_MESSAGE_PREFIX = /\bOmniSync\s*:/gi;

/**
 * Convierte cualquier valor en un texto plano, acotado y sin caracteres de
 * control. Devuelve una cadena vacía si no queda contenido utilizable.
 */
export function sanitizeExternalText(
  value: unknown,
  maxLength: number = MAX_EXTERNAL_TEXT_LENGTH
): string {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : MAX_EXTERNAL_TEXT_LENGTH;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = value.message;
  } else if (value === null || value === undefined) {
    text = '';
  } else {
    try {
      text = String(value);
    } catch {
      return '';
    }
  }

  // Se eliminan los caracteres de control (incluidos saltos de línea y tabuladores)
  // y las secuencias de escape ANSI.
  text = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // El texto externo no puede suplantar un mensaje del plugin.
  text = text.replace(PLUGIN_MESSAGE_PREFIX, 'OmniSync');

  if (text.length > limit) {
    text = text.slice(0, limit).trim();
  }
  return text;
}

/**
 * Sanea el mensaje de un error procedente de una fuente externa (relay,
 * servidor Blossom, WebSocket) antes de propagarlo o mostrarlo.
 */
export function sanitizeExternalError(
  value: unknown,
  fallback: string = '',
  maxLength: number = MAX_EXTERNAL_TEXT_LENGTH
): string {
  const text = sanitizeExternalText(value, maxLength);
  if (text.length === 0) return fallback;
  return text;
}

/**
 * Registra un aviso con un texto externo interpolado.
 *
 * El texto dinámico se sanea y se pasa como argumento separado del literal
 * constante: de este modo nunca se interpreta como cadena de formato y no
 * puede inyectar especificadores (`%s`, `%d`) que falseen el registro.
 */
export function warnExternal(
  message: string,
  detail: unknown,
  error?: unknown
): void {
  const safeDetail = sanitizeExternalText(detail);
  if (error === undefined) {
    console.warn(message, safeDetail);
  } else {
    console.warn(message, safeDetail, error);
  }
}