# Auditoría de Seguridad — Anonimato de Relés y Autodetección/Límites de Blossom

> Documento técnico de la segunda revisión de seguridad de OmniSync, centrada en las
> nuevas implementaciones de **anonimato de relés** y **autodetección/límites de Blossom**.
>
> **Alcance:** `scripts/cloudflare-blossom-worker.js`, `src/network/blossom-client.ts`,
> `src/network/blossom-providers.ts`, `src/network/nostr-mailbox.ts`,
> `src/network/signaling-client.ts`, `src/crypto/crypto-manager.ts`,
> `src/security/concurrency-limiter.ts`, `src/security/settings-security.ts`,
> `src/main.ts`, `src/ui/settings-tab.ts`, `src/types.ts` y sus pruebas.
>
> **Resultado:** 10 hallazgos (`AN-01`…`AN-10`) corregidos y cubiertos con regresiones.
> `npx tsc --noEmit` 0 errores · `npm test` EXIT 0 · `npm run build` limpio ·
> `npm audit` 0 vulnerabilidades.
>
> Este documento complementa a [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md), que conserva la
> auditoría original del plugin. Los hallazgos `AN-*` también se han resumido allí.

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Tabla de hallazgos y parches](#2-tabla-de-hallazgos-y-parches)
3. [Worker de Cloudflare (AN-01…AN-03)](#3-worker-de-cloudflare-an-01an-03)
4. [Cliente Blossom (AN-07)](#4-cliente-blossom-an-07)
5. [Mailbox Nostr (AN-04, AN-05)](#5-mailbox-nostr-an-04-an-05)
6. [Señalización Nostr (AN-06)](#6-señalización-nostr-an-06)
7. [Configuración y persistencia (AN-08, AN-09)](#7-configuración-y-persistencia-an-08-an-09)
8. [Disponibilidad y memoria (AN-10)](#8-disponibilidad-y-memoria-an-10)
9. [Mapa de ficheros modificados](#9-mapa-de-ficheros-modificados)
10. [Cómo verificar los parches](#10-cómo-verificar-los-parches)
11. [Limitaciones y riesgos residuales](#11-limitaciones-y-riesgos-residuales)
12. [Recomendaciones de despliegue](#12-recomendaciones-de-despliegue)

---

## 1. Resumen ejecutivo

La revisión encontró **10 vulnerabilidades** en tres familias:

| Familia | Hallazgos | Impacto principal |
|---|---|---|
| Autorización del servidor Blossom | AN-01, AN-02, AN-03 | Una firma NIP-98 válida podía autorizar **otra** carga; el servidor persistía la identidad del uploader; el cuerpo se leía sin cota real |
| Anonimato en la red Nostr | AN-04, AN-05, AN-06 | Relé y Blossom compartían pubkey; etiquetas ambiguas permitían interpretaciones divergentes; el `subId` revelaba aplicación y parte del room ID |
| Configuración y recursos | AN-07, AN-08, AN-09, AN-10 | Descriptor de subida sin verificar; límites y allowlist manipulables; flags booleanos activables con `"false"`; cola de transferencias sin cota |

El hallazgo **AN-01** es el más grave: en `validateNip98Auth()` la etiqueta `u` se leía pero
**nunca se comparaba** con la URL de la petición, y la etiqueta `payload` ni siquiera se
exigía. El Worker verificaba correctamente la firma Schnorr y el hash del evento, pero eso
solo demuestra que *alguien* firmó una autorización; sin vincularla a URL, método y
cuerpo, la autorización era reutilizable.

### Antes / después en una línea

| Aspecto | Antes | Después |
|---|---|---|
| NIP-98 en el Worker | `u` ignorada, `payload` opcional y no comparada | `u` + `method` + `payload` vinculados a la petición real |
| Metadatos R2 | `uploaderPubkey` + `uploadedAt` | Solo hash, bytes y MIME |
| Lectura del cuerpo | `request.arrayBuffer()` | Chunks con corte de 100 MB y `Content-Length` consistente |
| Identidad Nostr | Una pubkey para relé y Blossom | Dos claves efímeras independientes |
| `subId` | `omni-<10 hex del room ID>` | 16 hex CSPRNG por conexión |
| Etiquetas `d`/`t`/`expiration` | Se tomaba la primera coincidencia | Unicidad estricta y límites de esquema |
| Descriptor de subida | Cualquier `200/201/409` era éxito | Hash, tamaño y URL del descriptor BUD-01 verificados |
| Límite de tamaño persistido | Sin cota superior efectiva | Clamp determinista 1–1024 MB |
| Allowlist | UI aceptaba `http://`; lista persistida != lista contactada | Canonicalización HTTPS única en UI, carga, guardado y transferencia |
| Flags booleanos | `"false"` (string) activaba funciones | Solo booleanos reales; resto a valor seguro |
| Cola Blossom | Ilimitada | Máx. 4 pendientes + 1 simultánea |

---

## 2. Tabla de hallazgos y parches

| # | ID | Severidad | Componente | Falla | Parche | Verificación |
|---|---|---|---|---|---|---|
| 1 | AN-01 | **Crítica** | Worker | NIP-98 sin vínculo con URL, método ni cuerpo | `u`, `method` y `payload` comparados con la petición | `test:cloudflare-worker` |
| 2 | AN-02 | Alta | Worker | Identidad y fecha del uploader persistidas en R2 | Bucket sin `customMetadata` | `test:cloudflare-worker` |
| 3 | AN-03 | Alta | Worker | Cuerpo de subida leído sin cota | Lectura por chunks con corte | `test:cloudflare-worker` |
| 4 | AN-04 | Alta | Mailbox | Misma pubkey para relé y Blossom | `mailboxSecretKey` / `blossomSecretKey` | `test:nostr` |
| 5 | AN-05 | Media | Mailbox | Etiquetas `d`/`t`/`expiration` ambiguas | Unicidad + límites de esquema | `test:nostr` |
| 6 | AN-06 | Media | Señalización | `subId` con prefijo y room ID | `generateHexId()` CSPRNG | `test:nostr` |
| 7 | AN-07 | Media | Cliente Blossom | Descriptor de subida no verificado | BUD-01 validado (hash/tamaño/URL) | `test:realtime-security` |
| 8 | AN-08 | Media | Configuración | Límites y allowlist manipulables | Clamp 1–1024 MB + allowlist HTTPS única | `test:realtime-security` |
| 9 | AN-09 | Media | Configuración | `"false"` activaba funciones | Saneado de booleanos | `test:realtime-security` |
| 10 | AN-10 | Media | Disponibilidad | Cola de transferencias sin cota | Máx. de pendientes en el limitador | `test:realtime-security` |

---

## 3. Worker de Cloudflare (AN-01…AN-03)

Archivo: `scripts/cloudflare-blossom-worker.js`

### AN-01 · NIP-98 no vinculaba URL, método ni cuerpo

**Estado vulnerable (antes).** El validador localizaba las etiquetas pero no las
contrastaba con la petición:

```js
// scripts/cloudflare-blossom-worker.js (antes)
const methodTag = event.tags.find(t => t[0] === 'method');
if (!methodTag || methodTag[1] !== request.method) { ... }

const urlTag = event.tags.find(t => t[0] === 'u');
if (!urlTag || typeof urlTag[1] !== 'string') {
  return { valid: false, reason: 'Etiqueta u (URL) ausente en evento NIP-98' };
}
// ... se verificaba ID y firma, pero `u` nunca se comparaba con targetUrl
```

`targetUrl` se recibía como parámetro y **no se usaba**. Tampoco existía verificación
de `payload`, por lo que una autorización obtenida para un cuerpo A servía para subir un
cuerpo B.

**Parche aplicado.** La autorización queda ligada de forma inequívoca a la petición:

```js
// scripts/cloudflare-blossom-worker.js (después)
const methodTags = getTagValues(event, 'method');
if (methodTags.length !== 1 || methodTags[0] !== request.method.toUpperCase()) {
  return { valid: false, reason: 'Etiqueta method en NIP-98 no coincide con método HTTP' };
}

const urlTags = getTagValues(event, 'u');
if (urlTags.length !== 1 || urlTags[0] !== targetUrl.toString()) {
  return { valid: false, reason: 'Etiqueta u (URL) no coincide con la URL absoluta solicitada' };
}

const payloadTags = getTagValues(event, 'payload');
if (payloadTags.length > 1) {
  return { valid: false, reason: 'Etiqueta payload duplicada' };
}
const payloadTag = payloadTags.length === 1 ? payloadTags[0] : null;
if (payloadTag !== null && !isLowerHex(payloadTag, 64)) { ... }
if (requirePayloadHash && payloadTag === null) {
  return { valid: false, reason: 'Falta el hash SHA-256 del cuerpo en payload' };
}
```

Y el hash firmado se confronta con los bytes realmente recibidos:

```js
const auth = await validateNip98Auth(request, url, true);
// ...
const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
const sha256Hex = bytesToHex(new Uint8Array(hashBuffer));
if (auth.payloadHash !== sha256Hex) {
  return new Response(
    JSON.stringify({ message: 'El hash del cuerpo no coincide con la autorización NIP-98' }),
    { status: 401, ... }
  );
}
```

Comprobaciones adicionales del mismo parche:

- `expiration` no puede estar caducado ni duplicado (ventana del cliente: 5 min).
- `kind` debe ser `27235`, `content` debe estar vacío y `created_at` dentro de ±120 s.
- `id`, `pubkey` y `sig` deben ser hexadecimales de longitud exacta (64/64/128).
- El Base64 se decodifica de forma estricta (sin espacios, con canonicalidad y límite
  de 32 KB para la cabecera y 16 KB para el evento).
- El número de etiquetas, sus parámetros y la longitud de sus valores están acotados.
- `method` y `u` deben aparecer **exactamente una vez** (se usa `getTagValues()` en lugar
  de `find()`, que habría tratado un duplicado como si fuera una etiqueta opcional
  ausente).

### AN-02 · Identidad del uploader persistida en R2

**Estado vulnerable (antes).**

```js
await env.MY_BUCKET.put(sha256Hex, arrayBuffer, {
  httpMetadata: { contentType: 'application/octet-stream' },
  customMetadata: {
    uploaderPubkey: auth.pubkey || '',
    uploadedAt: String(Date.now()),
  },
});
```

La plantilla afirma en la UI que el servidor «no ve el nombre, la ruta, la extensión ni
el contenido en claro», pero R2 conservaba de forma **persistente y consultable** la
pubkey del uploader y la hora de la subida. Eso permite correlacionar todas las subidas
de una identidad, incluso meses después.

**Parche aplicado.** El bucket solo guarda lo imprescindible para servir el blob:

```js
await env.MY_BUCKET.put(sha256Hex, arrayBuffer, {
  httpMetadata: { contentType: 'application/octet-stream' },
});
```

No se persiste `pubkey`, fecha, IP ni ningún otro metadato de uploader.

### AN-03 · Cuerpo de subida leído sin cota real

**Estado vulnerable (antes).**

```js
const contentLength = Number(request.headers.get('content-length') || 0);
if (contentLength > MAX_UPLOAD_SIZE_BYTES) { ... }

const arrayBuffer = await request.arrayBuffer();   // ← sin cota efectiva
```

Si el cliente no enviaba `Content-Length`, el cuerpo se acumulaba íntegro en memoria
antes de poder comprobar su tamaño (límite del Worker agotado, coste de CPU).

**Parche aplicado.** Lectura incremental con corte y validación de coherencia:

```js
async function readRequestBodyWithLimit(request, maxBytes) {
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try { await reader.cancel(); } catch { }
      return { ok: false, status: 413, reason: 'Cuerpo de la petición demasiado grande' };
    }
    chunks.push(value);
  }
  // ... se ensambla un Uint8Array del tamaño exacto leído
}
```

Además, `Content-Length` se valida como entero no negativo, se contrasta con los bytes
recibidos (`400` si difieren) y la cabecera `X-SHA-256`, si está presente, debe coincidir
con el hash recalculado.

---


## 4. Cliente Blossom (AN-07)

Archivo: `src/network/blossom-client.ts`

### AN-07 · Descriptor de subida no verificado

**Estado vulnerable (antes).** Cualquier respuesta con código de éxito se aceptaba como
prueba de que el blob se había almacenado:

```ts
// src/network/blossom-client.ts (antes)
if (response.status === 200 || response.status === 201 || response.status === 409) {
  return {
    sha256: computedHash,
    serverUrl,
    size: encryptedBytes.byteLength,
  };
}
```

Un servidor malicioso (o un intermediario) podía devolver `201` sin haber almacenado los
bytes, o haber almacenado contenido distinto. El cliente lo daría por subido y publicaría
un puntero `BLOB_ATTACHMENT` inservible.

**Parche aplicado.** Se introduce `readUploadDescriptor()`, que lee el cuerpo con tope de
16 KB y valida el descriptor BUD-01:

```ts
// src/network/blossom-client.ts (después)
const descriptor = await this.readUploadDescriptor(
  response,
  computedHash,
  encryptedBytes.byteLength
);
if (
  descriptor === 'valid' ||
  (response.status === 409 && descriptor === 'absent')
) {
  return { sha256: computedHash, serverUrl, size: encryptedBytes.byteLength };
}
```

Reglas aplicadas:

| Respuesta | Cuerpo | Resultado |
|---|---|---|
| `200` / `201` | Descriptor BUD-01 válido (`sha256`, `size`, `url` HTTPS) | Aceptada |
| `200` / `201` | Descriptor ausente o contradictorio | Rechazada, se prueba el siguiente servidor |
| `409` | Sin cuerpo | Aceptada como idempotente |
| `409` | Descriptor válido | Aceptada |
| `409` | Descriptor inválido | Rechazada |

El lector distingue tres estados (`'valid' | 'absent' | 'invalid'`) para no confundir un
`409` sin cuerpo con un descriptor corrupto.

Hardening adicional del mismo archivo:

- `expiration` de 5 minutos en el evento NIP-98 emitido (`NIP98_AUTH_EXPIRATION_SECONDS`).
- `MAX_BLOSSOM_SERVERS = 16` como tope de destinos contactados.
- Validación de `timeoutMs` (entero > 0 y ≤ 5 min) en subida y descarga.
- `normalizeServerList()` pasa a ser **pública** y se convierte en la única fuente de
  canonicalidad de la allowlist (HTTPS, sin credenciales, sin query ni fragmento,
  deduplicada, máximo 16 destinos).

---


## 5. Mailbox Nostr (AN-04, AN-05)

Archivo: `src/network/nostr-mailbox.ts`

### AN-04 · Misma identidad Nostr para el relé y Blossom

**Estado vulnerable (antes).** Una única clave efímera firmaba **todo**:

```ts
// src/network/nostr-mailbox.ts (antes)
private nostrSecretKey = generateSecretKey();
// ...
finalizeEvent({ kind: MAILBOX_KIND, ... }, this.nostrSecretKey);   // buzón
BlossomClient.uploadBlob(..., this.nostrSecretKey);                 // Blossom
```

Un servidor Blossom y un relé público recibían la **misma pubkey**. Bastaba correlacionar
ambos lados para saber que un blob y un evento de buzón pertenecían al mismo usuario,
eliminando el aislamiento que el plugin afirma ofrecer entre ambos servicios.

**Parche aplicado.** Dos identidades Nostr efímeras, independientes y nunca persistidas:

```ts
// src/network/nostr-mailbox.ts (después)
/**
 * Identidad Nostr exclusiva del buzón. No se reutiliza para Blossom: de lo
 * contrario, un servidor Blossom podría correlacionar una subida con la
 * actividad del mismo usuario en el relay.
 */
private mailboxSecretKey = generateSecretKey();
/** Identidad Nostr exclusiva para autenticaciones NIP-98 de Blossom. */
private readonly blossomSecretKey = generateSecretKey();
```

| Objetivo | Clave utilizada |
|---|---|
| Eventos NIP-78 del buzón (`publishNote`, `publishDeltaPatch`, `publishBlobAttachment`) | `mailboxSecretKey` |
| Cabeceras NIP-98 de subida Blossom | `blossomSecretKey` |

### AN-05 · Etiquetas ambiguas en eventos del buzón

**Estado vulnerable (antes).** El validador aceptaba la **primera** etiqueta que
encontraba:

```ts
// src/network/nostr-mailbox.ts (antes)
if (!event.tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === this.roomId)) return null;
const expirationTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'expiration');
// ...
const dTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'd');
```

Con `some()` una etiqueta `t` válida bastaba aunque la lista contuviera también una `t`
contradictoria; con `find()` un `d` duplicado hacía que el cliente eligiera uno distinto
del que leería el relé. Un evento podía interpretarse de dos maneras incompatibles.

**Parche aplicado.** Unicidad estricta y límites de esquema:

```ts
// src/network/nostr-mailbox.ts (después)
const roomTags = event.tags.filter((tag) => tag[0] === 't');
if (roomTags.length !== 1 || roomTags[0][1] !== this.roomId) return null;
const expirationTags = event.tags.filter((tag) => tag[0] === 'expiration');
if (expirationTags.length !== 1 || typeof expirationTags[0][1] !== 'string') return null;
// ...
const dTags = event.tags.filter((tag) => tag[0] === 'd');
if (dTags.length !== 1 || typeof dTags[0][1] !== 'string') return null;
```

Además, el esquema del evento se acota por completo:

- `id` (64 hex), `pubkey` (64 hex) y `sig` (128 hex) con formato exacto.
- `content` limitado a 256 KB **en caracteres y en bytes UTF-8**.
- Máximo 16 etiquetas, 8 parámetros por etiqueta y 1024 caracteres por valor.
- `expiration` debe ser un entero dentro de `(now, now + 7 días + 60 s]`.

**Compatibilidad preservada:** el HMAC de la etiqueta `d` sigue siendo
`mailbox-dtag-v2` con la fórmula `${roomId}:${ruta}`, de modo que los dispositivos ya
emparejados continúan intercambiando eventos sin migración.

---

## 6. Señalización Nostr (AN-06)

Archivo: `src/network/signaling-client.ts`

### AN-06 · `subId` identificable en el relé

**Estado vulnerable (antes).** El identificador de suscripción filtraba el nombre de la
aplicación y una parte del identificador de sala:

```ts
// src/network/signaling-client.ts (antes)
const req = [
  'REQ',
  `omni-${this.roomId.substring(0, 10)}`,   // ← prefijo legible + room ID
  { kinds: [25000], '#t': [this.roomId] },
];
```

Cualquier relé podía inferir que la conexión era de OmniSync y asociarla con una sala
concreta, lo que rompe la meta de «indistinguibilidad criptográfica total» del plan de
anonimato. El buzón usaba un patrón equivalente:

```ts
// src/network/nostr-mailbox.ts (antes)
this.persistentSubId = this.cryptoManager.generateNonce().slice(0, 16);
const subId = this.cryptoManager.generateNonce().slice(0, 16);
```

**Parche aplicado.** Generador CSPRNG dedicado y uso en cada conexión:

```ts
// src/crypto/crypto-manager.ts (después)
/**
 * Genera un identificador hexadecimal aleatorio para suscripciones WebSocket.
 *
 * Se usa en lugar de prefijos legibles o de fragmentos del room ID: un relay
 * no debe poder distinguir esta aplicación ni correlacionar dos sesiones a
 * partir del `subId`.
 */
public generateHexId(byteLength: number = 8): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 8 || byteLength > 32) {
    throw new SecurityValidationError('La longitud del identificador aleatorio no es válida.');
  }
  const bytes = new Uint8Array(byteLength);
  this.getCrypto().getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

```ts
// src/network/signaling-client.ts (después)
const req = ['REQ', this.cryptoManager.generateHexId(8), { ... }];

// src/network/nostr-mailbox.ts (después)
this.persistentSubId = this.cryptoManager.generateHexId(8);
const subId = this.cryptoManager.generateHexId(8);
```

El resultado es un `subId` de 16 hexadecimales, sin prefijo legible, sin relación con
el room ID y distinto en cada conexión.

**Validación adicional de la señalización** (mismo bloque):

- `id`, `pubkey` y `sig` con formato hexadecimal exacto.
- `content` limitado a 512 KB en caracteres y bytes UTF-8.
- Etiquetas acotadas en número, parámetros y longitud de valores.
- `t` única y coincidente con la sala.
- `d` **opcional** pero, si aparece, única y coincidente: se mantiene la compatibilidad
  con clientes antiguos que solo envían `t`.

---


## 7. Configuración y persistencia (AN-08, AN-09)

Archivos: `src/network/blossom-providers.ts`, `src/main.ts`, `src/ui/settings-tab.ts`,
`src/security/settings-security.ts` (nuevo), `src/types.ts`

### AN-08 · Límites y allowlist manipulables desde `data.json`

**Estado vulnerable (antes).** El límite persistido se aceptaba sin cota superior real y
la UI admitía URLs HTTP:

```ts
// src/network/blossom-providers.ts (antes)
if (
  typeof settings.customMaxBlobSizeMb === 'number' &&
  Number.isFinite(settings.customMaxBlobSizeMb) &&
  settings.customMaxBlobSizeMb > 0
) {
  return Math.floor(settings.customMaxBlobSizeMb * 1024 * 1024);
}
```

```ts
// src/ui/settings-tab.ts (antes)
const servers = value
  .split(/[\n,]/)
  .map((s) => s.trim())
  .filter((s) => s.startsWith('https://') || s.startsWith('http://'));
```

Consecuencias: un `data.json` alterado podía fijar un límite arbitrario (p. ej. 100 000 MB)
y la lista guardada en disco podía diferir de la allowlist realmente contactada por la
capa de red, porque cada capa normalizaba por su cuenta.

**Parche aplicado.** Política única, determinista y compartida:

```ts
// src/network/blossom-providers.ts (después)
export const MIN_MAX_BLOB_SIZE_MB = 1;
export const MAX_MAX_BLOB_SIZE_MB = 1024;

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
```

`resolveMaxBlobSizeBytes()` pasa a usar ese clamp y distingue el preset `custom` del
comportamiento heredado (compatibilidad con llamadores que solo pasaban el valor manual).

La allowlist tiene ahora **una única fuente de verdad**:

```ts
// src/network/blossom-client.ts (después)
public static normalizeServerList(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  const normalized: string[] = [];
  for (const server of servers) {
    if (typeof server !== 'string') continue;
    try {
      const canonical = this.normalizeServerUrl(server);
      if (!normalized.includes(canonical)) normalized.push(canonical);
      if (normalized.length >= MAX_BLOSSOM_SERVERS) break;
    } catch {
      // Una URL local inválida se ignora; no se intenta contactar.
    }
  }
  return normalized;
}
```

Se invoca en los cuatro puntos donde la lista de servidores es relevante:

| Punto de uso | Ubicación |
|---|---|
| Edición en la UI | `src/ui/settings-tab.ts` |
| Carga de ajustes | `src/main.ts` → `sanitizeBlossomSettings()` |
| Guardado de ajustes | `src/main.ts` → `saveSettings()` |
| Transferencias | `src/network/nostr-mailbox.ts` → `setBlossomConfig()` |

La UI deja de filtrar por prefijo de texto y usa la canonicalización real:

```ts
// src/ui/settings-tab.ts (después)
const servers = BlossomClient.normalizeServerList(
  value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
);
```

### AN-09 · Flags booleanos con coerción de tipo

**Estado vulnerable (antes).** Los indicadores de activación se copiaban desde
`data.json` sin validar el tipo:

```ts
// src/main.ts (antes)
this.settings = {
  ...DEFAULT_SETTINGS,
  ...persisted,      // ← "false" (string) se acepta tal cual
  pairingSecret: secret,
  // ...
};
```

En JavaScript el string `"false"` es **truthy**. Un `data.json` manipulado con
`"enableNostrMailbox": "false"` activaba el buzón, y lo mismo ocurría con Blossom,
`syncAttachments` o `syncObsidianConfig` (este último expone ficheros de configuración).

**Parche aplicado.** Módulo puro de saneado, aplicado al cargar **y** al guardar:

```ts
// src/security/settings-security.ts (nuevo)
/** Convierte un valor externo en booleano, conservando el fallback si no lo es. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

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
  ] as const) {
    settings[key] = coerceBoolean(settings[key], defaults[key]);
  }
}
```

```ts
// src/main.ts (después)
validateSecureWebSocketUrl(this.settings.signalingServer);
this.sanitizeBooleanSettings();
this.sanitizeBlossomSettings();
```

También se centralizó el tipo del preset (`MaxBlobSizePreset` en `src/types.ts`) para que
la configuración y el resolvedor no puedan divergir.

---


## 8. Disponibilidad y memoria (AN-10)

Archivo: `src/security/concurrency-limiter.ts`

### AN-10 · Cola de operaciones pesadas sin cota

**Estado vulnerable (antes).** El limitador acotaba las operaciones **simultáneas**, pero
su cola de espera no tenía límite:

```ts
// src/security/concurrency-limiter.ts (antes)
public async run<T>(operation: () => Promise<T>): Promise<T> {
  if (this.active >= this.limit) {
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);   // ← cola sin tope
    });
  }
  // ...
}
```

Cada operación Blossom pendiente retiene su copia cifrada en memoria (hasta 1 GB con los
límites actuales). Un relé o un disparador de eventos podía acumular cientos de
descargas en espera y agotar la memoria del plugin.

**Parche aplicado.** Cola acotada con rechazo explícito:

```ts
// src/security/concurrency-limiter.ts (después)
constructor(limit: number = 1, maxQueueLength: number = 64) {
  this.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
  this.maxQueueLength =
    Number.isSafeInteger(maxQueueLength) && maxQueueLength >= 0 ? maxQueueLength : 64;
}

public async run<T>(operation: () => Promise<T>): Promise<T> {
  if (this.active >= this.limit) {
    // Una cola ilimitada permite acumular operaciones pesadas sin límite.
    // Se rechaza el exceso con un error explícito en lugar de retener datos.
    if (this.waiters.length >= this.maxQueueLength) {
      throw new Error('Demasiadas operaciones pendientes; inténtalo de nuevo más tarde.');
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
  // ...
}
```

Aplicado en el buzón con un margen estrecho respecto al tope de eventos:

```ts
// src/network/nostr-mailbox.ts (después)
export const MAX_CONCURRENT_BLOSSOM_OPERATIONS = 1;
export const MAX_PENDING_BLOSSOM_OPERATIONS = 4;

private readonly blossomLimiter = new ConcurrencyLimiter(
  MAX_CONCURRENT_BLOSSOM_OPERATIONS,
  MAX_PENDING_BLOSSOM_OPERATIONS
);
```

---


## 9. Mapa de ficheros modificados

| Fichero | Hallazgos | Cambios principales |
|---|---|---|
| `scripts/cloudflare-blossom-worker.js` | AN-01, AN-02, AN-03 | `validateNip98Auth()` con vínculo URL/método/payload; `getTagValues()`; `readRequestBodyWithLimit()`; eliminación de `customMetadata` |
| `src/network/blossom-client.ts` | AN-07, AN-08 | `readUploadDescriptor()`; `normalizeServerList()` público; `expiration` NIP-98; topes de servidores y timeouts |
| `src/network/blossom-providers.ts` | AN-08 | `clampMaxBlobSizeMb()`, `resolveMaxBlobSizeBytes()` defensivo, constantes de rango |
| `src/network/nostr-mailbox.ts` | AN-04, AN-05, AN-06, AN-08, AN-10 | `mailboxSecretKey`/`blossomSecretKey`; etiquetas únicas; `generateHexId()`; allowlist canónica; cola acotada |
| `src/network/signaling-client.ts` | AN-06 | `generateHexId()` para el `subId`; validación estricta de etiquetas y formato del evento |
| `src/crypto/crypto-manager.ts` | AN-06 | Nuevo `generateHexId()` (CSPRNG) |
| `src/security/concurrency-limiter.ts` | AN-10 | `maxQueueLength` con rechazo del exceso |
| `src/security/settings-security.ts` | AN-09 | **Nuevo**: `coerceBoolean()` y `sanitizeBooleanSettings()` |
| `src/main.ts` | AN-08, AN-09 | `sanitizeBlossomSettings()` y `sanitizeBooleanSettings()` en carga y guardado |
| `src/ui/settings-tab.ts` | AN-08 | Allowlist y límite mediante las funciones canónicas |
| `src/types.ts` | AN-08 | Tipo `MaxBlobSizePreset` centralizado |
| `tests/test-cloudflare-worker.ts` | AN-01…AN-03 | **Nuevo**: 10 escenarios con bucket R2 en memoria |
| `tests/test-realtime-security.ts` | AN-06…AN-10 | Descriptor BUD-01, clamp, allowlist, booleanos, cola |
| `tests/test-nostr-mailbox.ts` | AN-04, AN-05 | Etiquetas duplicadas, sala ajena, identidades separadas |
| `package.json` | — | Nuevo script `test:cloudflare-worker`, incluido en `npm test` |
| `SECURITY_AUDIT.md` | — | Resumen `AN-01`…`AN-10` y actualización de la cobertura |

---

## 10. Cómo verificar los parches

```bash
cd '/home/lord/Documentos/Coding Project/Extensiones/OmniSync'

# Comprobación de tipos
npx tsc --noEmit

# Suite completa (incluye el nuevo test del Worker)
npm test

# Solo la regresión del Worker
npm run test:cloudflare-worker

# Solo la regresión realtime + Blossom
npm run test:realtime-security

# Build de producción
npm run build

# Dependencias
npm audit
```

### Resultado esperado

| Comprobación | Resultado |
|---|---|
| `npx tsc --noEmit` | 0 errores |
| `npm test` | EXIT 0 |
| `test:minimax` | 39/39 |
| `test:security` | 128/128 |
| `test:realtime-security` | 62/62 |
| `test:cloudflare-worker` | ✅ todas las regresiones pasan |
| `npm run build` | limpio |
| `npm audit` | 0 vulnerabilidades |

### Verificación manual del bundle

```bash
node -e "
const s = require('fs').readFileSync('main.js','utf8');
console.log('generateHexId:        ', (s.match(/generateHexId/g)||[]).length);
console.log('sanitizeBooleanSettings:', (s.match(/sanitizeBooleanSettings/g)||[]).length);
console.log('normalizeServerList:  ', (s.match(/normalizeServerList/g)||[]).length);
console.log('subId con prefijo:    ', (s.match(/omni-/g)||[]).length);
console.log('zero-knowledge:       ', (s.match(/zero.?knowledge/gi)||[]).length);
console.log('vault.delete:         ', (s.match(/vault\.delete\(/g)||[]).length);
console.log('secretos literales:   ', (s.match(/['\"][A-Za-z0-9+\/]{43}=['\"]/g)||[]).length);
"
```

Resultado esperado: `generateHexId > 0`, `sanitizeBooleanSettings > 0`,
`normalizeServerList > 0` y **0** en `subId con prefijo`, `zero-knowledge`,
`vault.delete` y `secretos literales`.

---


## 11. Limitaciones y riesgos residuales

1. **Metadatos de red inherentes.** Los relés siguen observando IP, hora de conexión,
   identificador de sala seudónimo y tamaño aproximado del evento. El `subId` ya no es
   identificable, pero el fingerprint de tráfico (cadencia, volumen) sigue siendo un
   vector de correlación. El buzón y Blossom siguen siendo **opt-in**.

2. **Identidad Nostr efímera ≠ anonimato absoluto.** Las claves `mailboxSecretKey` y
   `blossomSecretKey` son efímeras (se pierden al reiniciar Obsidian), pero durante una
   sesión el mismo relé ve la misma pubkey. Esto evita la correlación **entre servicios**,
   no el seguimiento dentro de cada servicio.

3. **El Worker endurecido es más estricto que NIP-98.** NIP-98 obliga a incluir `u` y
   `method`, y solo *recomienda* `payload`; este Worker **exige** `payload` en las cargas.
   Cualquier cliente NIP-98 que no lo incluya será rechazado con `401`. El cliente de
   OmniSync sí lo emite; otros clientes contra esa plantilla deben actualizarse.

4. **La ventana de tiempo sigue siendo una heurística.** La ventana de ±120 s y la
   `expiration` de 5 minutos reducen la reutilización, pero un atacante con reloj
   sincronizado podría reutilizar una autorización dentro de esa ventana. NIP-98 no
   define un nonce de un solo uso.

5. **La identidad del uploader sigue siendo visible para el servidor en la conexión.** El
   Worker ya no la *persiste*, pero el servidor que atiende la petición ve la IP, la
   pubkey de la autorización y el momento de la subida. Eliminar eso exigiría un modelo
   de anonymous credentials o pagos fuera de banda.

6. **Los hashes de los blobs son públicos por diseño.** El contenido está cifrado, pero
   el SHA-256 del ciphertext permite a quien conozca el hash detectar la presencia del
   mismo blob en el bucket (equivalente a un dedo de miel). Es una consecuencia de
   Blossom como almacenamiento direccionable por contenido.

7. **La capa de red no valida la política del servidor Blossom.** El cliente comprueba
   el hash y el tamaño de lo descargado, pero no puede verificar que el servidor remoto
   no registre IP o metadatos de la petición. Para servidores de terceros eso es una
   condición de confianza externa, no un defecto del plugin.

8. **El clamp de tamaño protege el cliente, no el servidor.** Un servidor Blossom
   autohospedado con un límite distinto (o un atacante) puede imponer sus propias
   restricciones; el plugin simplemente se adapta y cae al siguiente destino.

---

## 12. Recomendaciones de despliegue

1. Desplegar la plantilla endurecida de `scripts/cloudflare-blossom-worker.js` en
   Cloudflare Workers y revisar los consumidores externos que no incluyan la etiqueta
   `payload` en sus eventos NIP-98 (serán rechazados con `401`).
2. Ejecutar pruebas manuales de interoperabilidad contra servidores Blossom/NIP-98
   públicos para confirmar que el descriptor BUD-01 y la `expiration` son aceptados.
3. Revisar y mergear los cambios en el sistema de control de versiones cuando se
   disponga de él: el repositorio de trabajo no contiene metadata Git, por lo que las
   comparaciones se realizaron sobre copias temporales en `/tmp/insp/`.
4. Verificar en el panel de Cloudflare que el bucket R2 no re-exponga `customMetadata`
   creado por despliegues anteriores (el parche solo afecta a las escrituras nuevas).

---

*Documento generado tras la segunda auditoría de seguridad de OmniSync. Para el
histórico completo de la auditoría original, ver [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).*

