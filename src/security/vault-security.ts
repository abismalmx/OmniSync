/**
 * OmniSync - Vault Path Security Policy
 *
 * Política única para toda ruta que cruce la frontera de confianza. Impide
 * traversal, rutas absolutas, sincronización de la papelera/Git y código
 * ejecutable de plugins de Obsidian.
 */

/** Límite defensivo para una ruta dentro de la bóveda. */
export const MAX_VAULT_PATH_LENGTH = 1024;
/** Máximo número de segmentos en una ruta. */
export const MAX_VAULT_PATH_SEGMENTS = 100;
/** Longitud máxima de un segmento individual. */
export const MAX_VAULT_PATH_SEGMENT_LENGTH = 255;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/**
 * Caracteres que Windows no admite en un nombre (y que Obsidian tampoco permite).
 * Incluye `:` (flujos alternativos NTFS como `nota.md:script.js`).
 */
const FORBIDDEN_SEGMENT_CHARACTERS = /[<>:"|?*]/;
/** Nombres de dispositivo reservados de Windows, con o sin extensión. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Alias corto 8.3 de NTFS (`PLUGIN~1`) que resuelve a un directorio bloqueado. */
const SHORT_NAME_ALIAS = /~\d/;
/** Nombres heredados de Object.prototype: no pueden ser claves de un manifiesto. */
const PROTOTYPE_PROPERTY_NAMES = new Set([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'prototype',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/**
 * Forma con la que el sistema de archivos resolverá el segmento: Windows elimina
 * los puntos y espacios finales, y los volúmenes por defecto no distinguen
 * mayúsculas. Las comparaciones de directorios protegidos usan esta forma.
 */
function canonicalSegment(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

export interface VaultPathPolicy {
  /** Permite adjuntos y otros archivos no Markdown. */
  syncAttachments: boolean;
  /** Permite una selección segura de configuración de Obsidian. */
  syncObsidianConfig: boolean;
}

export const DEFAULT_VAULT_PATH_POLICY: VaultPathPolicy = {
  syncAttachments: true,
  syncObsidianConfig: false,
};

/** Error de validación apto para logs, sin datos sensibles. */
export class SecurityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityValidationError';
    Object.setPrototypeOf(this, SecurityValidationError.prototype);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Decodifica Base64 estándar de forma canónica y sin tolerar espacios. */
export function decodeCanonicalBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new SecurityValidationError('Valor Base64 inválido.');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new SecurityValidationError('Valor Base64 inválido.');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new SecurityValidationError('Valor Base64 inválido.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let canonical = '';
  for (let i = 0; i < bytes.length; i++) canonical += String.fromCharCode(bytes[i]);
  if (btoa(canonical) !== value) {
    throw new SecurityValidationError('Valor Base64 no canónico.');
  }
  return bytes;
}

/**
 * Normaliza y valida una ruta remota. Devuelve siempre la forma canónica.
 */
export function validateVaultPath(
  path: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY
): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SecurityValidationError('La ruta del Vault debe ser una cadena no vacía.');
  }
  if (path.length > MAX_VAULT_PATH_LENGTH) {
    throw new SecurityValidationError('La ruta del Vault supera la longitud máxima permitida.');
  }
  if (CONTROL_CHARACTERS.test(path)) {
    throw new SecurityValidationError('La ruta del Vault contiene caracteres de control.');
  }

  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new SecurityValidationError('Las rutas absolutas no están permitidas en el Vault.');
  }
  if (normalized.endsWith('/')) {
    throw new SecurityValidationError('Una ruta de archivo no puede terminar en "/".');
  }

  const segments = normalized.split('/');
  if (segments.length > MAX_VAULT_PATH_SEGMENTS) {
    throw new SecurityValidationError('La ruta del Vault contiene demasiados segmentos.');
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new SecurityValidationError('La ruta del Vault contiene segmentos no permitidos.');
    }
    // Impide claves de Object.prototype en manifests y paths.
    if (PROTOTYPE_PROPERTY_NAMES.has(segment)) {
      throw new SecurityValidationError('La ruta del Vault contiene un segmento reservado.');
    }
    if (segment.length > MAX_VAULT_PATH_SEGMENT_LENGTH) {
      throw new SecurityValidationError('Un segmento de la ruta supera la longitud máxima.');
    }
    // Windows normaliza `plugins.` o `.git ` al directorio sin punto/espacio final.
    if (/[. ]$/.test(segment)) {
      throw new SecurityValidationError('Un segmento de la ruta no puede terminar en punto o espacio.');
    }
    if (FORBIDDEN_SEGMENT_CHARACTERS.test(segment)) {
      throw new SecurityValidationError('Un segmento de la ruta contiene caracteres no permitidos.');
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new SecurityValidationError('Un segmento de la ruta usa un nombre reservado del sistema.');
    }
  }

  const root = canonicalSegment(segments[0]);
  // Los directorios ocultos de nivel superior pueden resolverse por su alias 8.3.
  if (root.startsWith('.') && segments.some((segment) => SHORT_NAME_ALIAS.test(segment))) {
    throw new SecurityValidationError('Un segmento de la ruta usa un alias corto no permitido.');
  }
  // `.obsidian`, `.git` y `.trash` se resuelven como OBSIDI~1, GIT~1 y TRASH~1,
  // que no empiezan por punto: el alias de un directorio raíz se rechaza siempre.
  if (segments.length > 1 && /^[^.]{1,6}~\d+$/.test(root)) {
    throw new SecurityValidationError('Un segmento de la ruta usa un alias corto no permitido.');
  }
  if (root === '.trash' || root === '.git') {
    throw new SecurityValidationError('No se permite sincronizar la papelera ni el repositorio Git.');
  }

  if (root === '.obsidian') {
    if (!policy.syncObsidianConfig) {
      throw new SecurityValidationError('La sincronización de configuración de Obsidian está desactivada.');
    }
    if (segments[1] !== undefined && canonicalSegment(segments[1]) === 'plugins') {
      throw new SecurityValidationError('No se permite sincronizar plugins ejecutables de Obsidian.');
    }
    const fileName = canonicalSegment(segments[segments.length - 1]);
    if (
      fileName === 'community-plugins.json' ||
      fileName === 'workspace.json' ||
      fileName === 'graph.json'
    ) {
      throw new SecurityValidationError('El archivo de configuración de Obsidian está excluido por seguridad.');
    }
    return normalized;
  }

  const extension = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? '';
  const isCoreTextFile = extension === 'md' || extension === 'txt' || extension === 'canvas';
  if (!isCoreTextFile && !policy.syncAttachments) {
    throw new SecurityValidationError('Los adjuntos están desactivados en este dispositivo.');
  }

  return normalized;
}

/** Indica si una ruta cumple la política sin lanzar una excepción. */
export function isAllowedVaultPath(
  path: unknown,
  policy: VaultPathPolicy = DEFAULT_VAULT_PATH_POLICY
): boolean {
  try {
    validateVaultPath(path, policy);
    return true;
  } catch {
    return false;
  }
}
