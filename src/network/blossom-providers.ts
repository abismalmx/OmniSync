/**
 * OmniSync - Blossom Storage Provider Detection and Limits
 *
 * Módulo puro encargado de la heurística de reconocimiento y catálogo de capacidades
 * para servidores de almacenamiento Blossom (Cloudflare Workers+R2, VPS, relays públicos, S3).
 */

import type { MaxBlobSizePreset } from '../types';

export type BlossomProviderType =
  | 'cloudflare'
  | 'vps_local'
  | 'satellite'
  | 'primal'
  | 'nostr_download'
  | 'nostrbuild'
  | 'supabase'
  | 's3_compatible'
  | 'custom';

/** Límite inferior configurable del tamaño de un blob, en MB. */
export const MIN_MAX_BLOB_SIZE_MB = 1;
/** Límite superior configurable del tamaño de un blob, en MB. */
export const MAX_MAX_BLOB_SIZE_MB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export interface BlossomProviderInfo {
  type: BlossomProviderType;
  name: string;
  suggestedLimitMb: number;
  description: string;
  badge: string;
  icon: string;
  isSelfHosted: boolean;
}

const PROVIDERS: Record<BlossomProviderType, BlossomProviderInfo> = {
  cloudflare: {
    type: 'cloudflare',
    name: 'Cloudflare Workers + R2',
    suggestedLimitMb: 100,
    description: 'Cloudflare Worker personal con R2 (máx. 100 MB por petición en plan gratuito, 10 GB de almacenamiento gratis).',
    badge: '⚡ Cloudflare Workers + R2 (100 MB)',
    icon: 'zap',
    isSelfHosted: true,
  },
  vps_local: {
    type: 'vps_local',
    name: 'VPS / Docker / Localhost',
    suggestedLimitMb: 500,
    description: 'Servidor Blossom autohospedado en red local o VPS propio sin restricciones de cuota pública.',
    badge: '🖥️ Servidor Local / VPS (500 MB)',
    icon: 'server',
    isSelfHosted: true,
  },
  satellite: {
    type: 'satellite',
    name: 'Satellite.earth',
    suggestedLimitMb: 25,
    description: 'Servidor público de Satellite.earth (límite estándar 25 MB).',
    badge: '🛰️ Satellite.earth (25 MB)',
    icon: 'globe',
    isSelfHosted: false,
  },
  primal: {
    type: 'primal',
    name: 'Primal Blossom',
    suggestedLimitMb: 25,
    description: 'Infraestructura Blossom de Primal Caching (límite estándar 25 MB).',
    badge: '🪐 Primal Blossom (25 MB)',
    icon: 'globe',
    isSelfHosted: false,
  },
  nostr_download: {
    type: 'nostr_download',
    name: 'Nostr.download',
    suggestedLimitMb: 25,
    description: 'Buzón de archivos multimedia Nostr.download (límite 25 MB).',
    badge: '📥 Nostr.download (25 MB)',
    icon: 'download',
    isSelfHosted: false,
  },
  nostrbuild: {
    type: 'nostrbuild',
    name: 'NostrBuild',
    suggestedLimitMb: 50,
    description: 'Servicio NostrBuild Blossom (límite comunitario 50 MB).',
    badge: '🏗️ NostrBuild (50 MB)',
    icon: 'image',
    isSelfHosted: false,
  },
  supabase: {
    type: 'supabase',
    name: 'Supabase Storage',
    suggestedLimitMb: 50,
    description: 'Almacenamiento de objetos Supabase Storage (límite 50 MB).',
    badge: '⚡ Supabase Storage (50 MB)',
    icon: 'database',
    isSelfHosted: true,
  },
  s3_compatible: {
    type: 's3_compatible',
    name: 'S3 Compatible (AWS / Wasabi / Backblaze)',
    suggestedLimitMb: 200,
    description: 'Servicio de almacenamiento compatible con S3 (límite recomendado 200 MB).',
    badge: '🪣 S3 Compatible (200 MB)',
    icon: 'hard-drive',
    isSelfHosted: true,
  },
  custom: {
    type: 'custom',
    name: 'Servidor Blossom Personalizado',
    suggestedLimitMb: 50,
    description: 'Servidor Blossom estándar o no identificado (límite por defecto 50 MB).',
    badge: '🌸 Blossom Personalizado (50 MB)',
    icon: 'cloud',
    isSelfHosted: false,
  },
};

/**
 * Detecta el proveedor de almacenamiento Blossom a partir de una URL dada.
 */
export function detectBlossomProvider(rawUrl: string): BlossomProviderInfo {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return PROVIDERS.custom;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return PROVIDERS.custom;
  }

  let hostname = '';
  let port = '';

  try {
    const parsed = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    hostname = trimmed.toLowerCase();
  }

  // 1. Cloudflare Workers / R2
  if (
    hostname.endsWith('.workers.dev') ||
    hostname === 'workers.dev' ||
    hostname.endsWith('.r2.cloudflarestorage.com') ||
    hostname === 'r2.cloudflarestorage.com'
  ) {
    return PROVIDERS.cloudflare;
  }

  // 2. Satellite.earth
  if (hostname.endsWith('.satellite.earth') || hostname === 'satellite.earth') {
    return PROVIDERS.satellite;
  }

  // 3. Primal
  if (hostname.endsWith('.primal.net') || hostname === 'primal.net') {
    return PROVIDERS.primal;
  }

  // 4. Nostr.download
  if (hostname.endsWith('.nostr.download') || hostname === 'nostr.download') {
    return PROVIDERS.nostr_download;
  }

  // 5. NostrBuild
  if (hostname.endsWith('.nostrbuild.com') || hostname === 'nostrbuild.com') {
    return PROVIDERS.nostrbuild;
  }

  // 6. Supabase
  if (hostname.endsWith('.supabase.co') || hostname === 'supabase.co') {
    return PROVIDERS.supabase;
  }

  // 7. S3 Compatible (AWS, Wasabi, Backblaze B2)
  if (
    hostname.endsWith('.amazonaws.com') ||
    hostname.endsWith('.wasabisys.com') ||
    hostname.endsWith('.backblazeb2.com')
  ) {
    return PROVIDERS.s3_compatible;
  }

  // 8. VPS / Docker / Localhost / IPs privadas o puertos no estándar
  const isLocalIp =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);

  const hasCustomPort =
    port !== '' && port !== '80' && port !== '443';

  if (isLocalIp || hasCustomPort) {
    return PROVIDERS.vps_local;
  }

  return PROVIDERS.custom;
}

/**
 * Resuelve el límite máximo en bytes a partir de los ajustes de configuración.
 *
 * La política es determinista y defensiva: un valor persistido manipulado,
 * NaN, Infinity, fraccionario o fuera del rango se descarta y se usa el
 * preset. Un preset desconocido equivale al preset seguro de 25 MB.
 */
export function resolveMaxBlobSizeBytes(settings: {
  maxBlobSizePreset?: MaxBlobSizePreset;
  customMaxBlobSizeMb?: number;
}): number {
  const preset = settings.maxBlobSizePreset;
  if (preset === 'custom') {
    const custom = clampMaxBlobSizeMb(settings.customMaxBlobSizeMb);
    return (custom ?? 25) * BYTES_PER_MB;
  }

  if (preset === '100mb') {
    return 100 * BYTES_PER_MB;
  }

  if (preset === '50mb') {
    return 50 * BYTES_PER_MB;
  }

  if (preset === '25mb') {
    return 25 * BYTES_PER_MB;
  }

  // Compatibilidad con llamadores heredados que solo proporcionaban el valor
  // manual: se acepta únicamente si cumple el rango defensivo.
  const legacyCustom = clampMaxBlobSizeMb(settings.customMaxBlobSizeMb);
  return (legacyCustom ?? 25) * BYTES_PER_MB;
}

/**
 * Normaliza el límite manual en MB y lo acota al rango admitido.
 * Devuelve `null` si el valor no representa un entero válido.
 */
export function clampMaxBlobSizeMb(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_MAX_BLOB_SIZE_MB ||
    value > MAX_MAX_BLOB_SIZE_MB
  ) {
    return null;
  }
  return value;
}
