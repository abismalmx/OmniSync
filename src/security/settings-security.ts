/**
 * OmniSync - Trusted Settings Sanitization
 *
 * `data.json` no es una fuente de confianza: puede estar corrupto, migrado desde
 * otra versión o manipulado. Estas funciones normalizan los valores que
 * controlan activaciones de red, rutas y límites antes de usarlos.
 */

import type { OmniSyncSettings } from '../types';

/** Convierte un valor externo en booleano, conservando el fallback si no lo es. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Flags booleanos que controlan funcionalidad de red o exposición de datos. */
export type BooleanSettingKey =
  | 'autoSync'
  | 'syncAttachments'
  | 'syncObsidianConfig'
  | 'enableNostrMailbox'
  | 'enableBlossomSync'
  | 'tidyAttachments';

/**
 * Sanea los indicadores booleanos de confianza.
 *
 * En JavaScript el string `"false"` es *truthy*. Si un `data.json` manipulado
 * contenía ese valor, podría activar contra la intención del usuario el buzón,
 * Blossom o la sincronización de adjuntos. Solo se acepta un booleano real.
 */
export function sanitizeBooleanSettings(
  settings: OmniSyncSettings,
  defaults: Pick<OmniSyncSettings, BooleanSettingKey>
): void {
  for (const key of [
    'autoSync',
    'syncAttachments',
    'syncObsidianConfig',
    'enableNostrMailbox',
    'enableBlossomSync',
    'tidyAttachments',
  ] as const) {
    settings[key] = coerceBoolean(settings[key], defaults[key]);
  }
}
