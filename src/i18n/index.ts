/**
 * OmniSync - Internationalization (i18n) Engine
 */

import { LanguageOption, SupportedLanguage, TranslationSchema } from './types';
import { en } from './locales/en';
import { es } from './locales/es';
import { ru } from './locales/ru';
import { zh } from './locales/zh';

export * from './types';

const LOCALES: Record<SupportedLanguage, TranslationSchema> = {
  en,
  es,
  ru,
  zh,
};

let currentLanguage: SupportedLanguage = 'en';
let currentLanguageOption: LanguageOption = 'auto';

/**
 * Claves reservadas de `Object.prototype`. Se rechazan durante el recorrido
 * de una ruta de traducción para impedir el acceso a la cadena de prototipos.
 */
const RESERVED_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Detects the active language from Obsidian or the browser runtime.
 */
export function detectObsidianLocale(): SupportedLanguage {
  try {
    // 1. Obsidian stores the configured UI language in localStorage under 'language'
    if (typeof window !== 'undefined' && window.localStorage) {
      const obsidianLang = window.localStorage.getItem('language');
      if (obsidianLang) {
        const lower = obsidianLang.toLowerCase();
        if (lower.startsWith('es')) return 'es';
        if (lower.startsWith('ru')) return 'ru';
        if (lower.startsWith('zh')) return 'zh';
        if (lower.startsWith('en')) return 'en';
        return 'en';
      }
    }

    // 2. Fallback to moment.js locale if available in Obsidian global scope
    const globalWithMoment = globalThis as {
      moment?: { locale?: () => string };
    };
    const momentLocale =
      (typeof window !== 'undefined' && globalWithMoment.moment?.locale?.()) || '';
    if (momentLocale) {
      const lower = momentLocale.toLowerCase();
      if (lower.startsWith('es')) return 'es';
      if (lower.startsWith('ru')) return 'ru';
      if (lower.startsWith('zh')) return 'zh';
      if (lower.startsWith('en')) return 'en';
    }

    // 3. Fallback to navigator.language
    if (typeof navigator !== 'undefined' && navigator.language) {
      const lower = navigator.language.toLowerCase();
      if (lower.startsWith('es')) return 'es';
      if (lower.startsWith('ru')) return 'ru';
      if (lower.startsWith('zh')) return 'zh';
    }
  } catch {
    // Silently fallback to English on any sandbox or runtime error
  }

  return 'en';
}

/**
 * Resolves the effective language from the user preference.
 */
export function resolveEffectiveLanguage(option?: LanguageOption): SupportedLanguage {
  if (!option || option === 'auto') {
    return detectObsidianLocale();
  }
  if (option === 'es' || option === 'en' || option === 'ru' || option === 'zh') {
    return option;
  }
  return 'en';
}

/**
 * Initializes the i18n engine with the given language option.
 */
export function initI18n(option: LanguageOption = 'auto'): void {
  currentLanguageOption = option;
  currentLanguage = resolveEffectiveLanguage(option);
}

/**
 * Returns the currently active effective language.
 */
export function getCurrentLanguage(): SupportedLanguage {
  return currentLanguage;
}

/**
 * Returns the configured language option (e.g. 'auto', 'en', etc.).
 */
export function getCurrentLanguageOption(): LanguageOption {
  return currentLanguageOption;
}

/**
 * Recorre un objeto anidado por una ruta separada por puntos.
 *
 * Se usan `Object.getOwnPropertyDescriptor` y `hasOwnProperty` para leer
 * únicamente propiedades propias: las heredadas nunca se leen y los
 * accesores (`getters`) del prototipo no se ejecutan. Además, el nombre de
 * cada propiedad se valida contra las claves reservadas de
 * `Object.prototype` (`__proto__`, `constructor`, `prototype`) para que una
 * clave de traducción procedente de la interfaz nunca pueda alcanzar la
 * cadena de prototipos.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let node: unknown = obj;
  for (const part of parts) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    if (RESERVED_PROTOTYPE_KEYS.has(part)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(node, part);
    // `getOwnPropertyDescriptor` solo devuelve descriptores de propiedades
    // propias: una clave heredada del prototipo se descarta aquí.
    if (!descriptor) return undefined;
    node = descriptor.value;
  }
  return node;
}

/**
 * Translates a given key with optional variable replacement.
 *
 * Example: t('notices.peerConnected', { name: 'Phone' })
 */
export function t(path: string, params?: Record<string, string | number>): string {
  // 1. Try current language
  let text = getNestedValue(LOCALES[currentLanguage], path);

  // 2. Fallback to English if missing
  if (text === undefined && currentLanguage !== 'en') {
    text = getNestedValue(LOCALES.en, path);
  }

  // 3. Fallback to Spanish if still missing
  if (text === undefined && currentLanguage !== 'es') {
    text = getNestedValue(LOCALES.es, path);
  }

  // 4. Fallback to key path itself
  if (text === undefined || typeof text !== 'string') {
    return path;
  }

  // Interpolate variables e.g. {name}, {count}
  if (params && Object.keys(params).length > 0) {
    return text.replace(/\{(\w+)\}/g, (match, key) => {
      if (params[key] !== undefined && params[key] !== null) {
        return String(params[key]);
      }
      return match;
    });
  }

  return text;
}

/**
 * Helper to get localized provider badge and description for Blossom providers.
 */
export function getLocalizedBlossomProviderInfo(
  providerType: string,
  fallbackBadge: string,
  fallbackDesc: string
): { badge: string; description: string } {
  const providersObj = LOCALES[currentLanguage]?.blossomProviders;
  // Solo se aceptan proveedores conocidos: una clave arbitraria no debe
  // poder alcanzar el prototipo ni devolver un objeto heredado.
  if (
    !providersObj ||
    !Object.prototype.hasOwnProperty.call(providersObj, providerType) ||
    RESERVED_PROTOTYPE_KEYS.has(providerType)
  ) {
    return { badge: fallbackBadge, description: fallbackDesc };
  }
  const entry = providersObj[providerType];
  if (entry) {
    return {
      badge: entry.badge || fallbackBadge,
      description: entry.description || fallbackDesc,
    };
  }
  return { badge: fallbackBadge, description: fallbackDesc };
}
