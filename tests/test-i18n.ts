/**
 * OmniSync - Unit Tests for Internationalization (i18n)
 */

import * as assert from 'assert';
import {
  initI18n,
  t,
  detectObsidianLocale,
  resolveEffectiveLanguage,
  getCurrentLanguage,
  getLocalizedBlossomProviderInfo,
} from '../src/i18n';
import { en } from '../src/i18n/locales/en';
import { es } from '../src/i18n/locales/es';
import { ru } from '../src/i18n/locales/ru';
import { zh } from '../src/i18n/locales/zh';

function getDeepKeys(obj: any, prefix = ''): string[] {
  let keys: string[] = [];
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      keys = keys.concat(getDeepKeys(val, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

console.log('=== Iniciando Suite de Pruebas: Internacionalización OmniSync (i18n) ===\n');

// 1. Verificación de paridad de claves entre todos los diccionarios
console.log('[Test 1] Verificación de estructura y completitud de claves');
const enKeys = new Set(getDeepKeys(en));
const esKeys = new Set(getDeepKeys(es));
const ruKeys = new Set(getDeepKeys(ru));
const zhKeys = new Set(getDeepKeys(zh));

// Comprobar que español tiene todas las claves de inglés
for (const k of enKeys) {
  assert.ok(esKeys.has(k), `es debe contener la clave '${k}'`);
  assert.ok(ruKeys.has(k), `ru debe contener la clave '${k}'`);
  assert.ok(zhKeys.has(k), `zh debe contener la clave '${k}'`);
}

// Comprobar que no hay claves huérfanas en los otros diccionarios
assert.strictEqual(esKeys.size, enKeys.size, 'es debe tener el mismo número de claves que en');
assert.strictEqual(ruKeys.size, enKeys.size, 'ru debe tener el mismo número de claves que en');
assert.strictEqual(zhKeys.size, enKeys.size, 'zh debe tener el mismo número de claves que en');
console.log(`  ✓ Los 4 diccionarios poseen exactamente ${enKeys.size} claves idénticas.\n`);

// 2. Comprobación de traducción básica e interpolación en cada idioma
console.log('[Test 2] Traducción e interpolación dinámica de variables');

// Español
initI18n('es');
assert.strictEqual(getCurrentLanguage(), 'es');
assert.strictEqual(t('hero.title'), 'OmniSync');
assert.strictEqual(t('hero.author'), 'Creado por abismalmx');
assert.strictEqual(
  t('notices.peerConnected', { name: 'Mi Celular' }),
  "¡OmniSync conectado con 'Mi Celular'!"
);
assert.strictEqual(
  t('statusBar.connectedLabel', { count: 3 }),
  'OmniSync (3)'
);

// Inglés
initI18n('en');
assert.strictEqual(getCurrentLanguage(), 'en');
assert.strictEqual(t('hero.title'), 'OmniSync');
assert.strictEqual(t('hero.author'), 'Created by abismalmx');
assert.strictEqual(
  t('notices.peerConnected', { name: 'My Phone' }),
  "OmniSync connected to 'My Phone'!"
);
assert.strictEqual(
  t('statusBar.connectedLabel', { count: 3 }),
  'OmniSync (3)'
);

// Ruso
initI18n('ru');
assert.strictEqual(getCurrentLanguage(), 'ru');
assert.strictEqual(t('hero.title'), 'OmniSync');
assert.strictEqual(t('hero.author'), 'Создано abismalmx');
assert.strictEqual(
  t('notices.peerConnected', { name: 'Телефон' }),
  "OmniSync подключен к 'Телефон'!"
);
assert.strictEqual(
  t('statusBar.connectedLabel', { count: 3 }),
  'OmniSync (3)'
);

// Chino Simplificado
initI18n('zh');
assert.strictEqual(getCurrentLanguage(), 'zh');
assert.strictEqual(t('hero.title'), 'OmniSync');
assert.strictEqual(t('hero.author'), '由 abismalmx 创建');
assert.strictEqual(
  t('notices.peerConnected', { name: '手机' }),
  'OmniSync 已与“手机”建立连接！'
);
assert.strictEqual(
  t('statusBar.connectedLabel', { count: 3 }),
  'OmniSync (3)'
);
console.log('  ✓ Interpolación de variables ({name}, {count}) verificada en los 4 idiomas.\n');

// 3. Fallback defensivo
console.log('[Test 3] Fallback defensivo cuando falta una clave o es desconocida');
initI18n('ru');
assert.strictEqual(t('non_existent.path.key'), 'non_existent.path.key');
console.log('  ✓ Fallbacks de claves inexistentes probados correctamente.\n');

// 4. Resolución y detección de idioma
console.log('[Test 4] Detección de idioma y resolución de configuración');
assert.strictEqual(resolveEffectiveLanguage('es'), 'es');
assert.strictEqual(resolveEffectiveLanguage('en'), 'en');
assert.strictEqual(resolveEffectiveLanguage('ru'), 'ru');
assert.strictEqual(resolveEffectiveLanguage('zh'), 'zh');

// Simular entorno global de Obsidian
const originalWindow = (global as any).window;
try {
  (global as any).window = {
    localStorage: {
      getItem: (key: string) => (key === 'language' ? 'zh-cn' : null),
    },
  };
  assert.strictEqual(detectObsidianLocale(), 'zh');
  assert.strictEqual(resolveEffectiveLanguage('auto'), 'zh');

  (global as any).window.localStorage.getItem = (key: string) => (key === 'language' ? 'ru' : null);
  assert.strictEqual(detectObsidianLocale(), 'ru');

  (global as any).window.localStorage.getItem = (key: string) => (key === 'language' ? 'es-ES' : null);
  assert.strictEqual(detectObsidianLocale(), 'es');

  (global as any).window.localStorage.getItem = (key: string) => (key === 'language' ? 'fr' : null);
  assert.strictEqual(detectObsidianLocale(), 'en'); // Fallback a inglés para idiomas no soportados
} finally {
  (global as any).window = originalWindow;
}
console.log('  ✓ Detección con localStorage y fallback a inglés verificado.\n');

// 5. Localización de proveedores Blossom
console.log('[Test 5] Localización dinámica de tarjetas de proveedores Blossom');
initI18n('ru');
const ruCloudflare = getLocalizedBlossomProviderInfo('cloudflare', 'Default Badge', 'Default Desc');
assert.ok(ruCloudflare.badge.includes('Cloudflare'));
assert.ok(ruCloudflare.description.includes('Персональный'));

initI18n('zh');
const zhCloudflare = getLocalizedBlossomProviderInfo('cloudflare', 'Default Badge', 'Default Desc');
assert.ok(zhCloudflare.badge.includes('Cloudflare'));
assert.ok(zhCloudflare.description.includes('个人 Cloudflare Worker'));

initI18n('en');
const enCloudflare = getLocalizedBlossomProviderInfo('cloudflare', 'Default Badge', 'Default Desc');
assert.ok(enCloudflare.badge.includes('Cloudflare'));
assert.ok(enCloudflare.description.includes('Personal Cloudflare Worker'));
console.log('  ✓ Tarjetas Blossom adaptadas a cada idioma correctamente.\n');

console.log('======================================================');
console.log('🎉 TODAS LAS PRUEBAS DE i18n CONCLUYERON CON ÉXITO');
console.log('======================================================\n');
