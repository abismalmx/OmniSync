# Auditoría de Seguridad de OmniSync — Fugas Encontradas y Parches Aplicados

> Documento de referencia interno. Registra cada vulnerabilidad detectada durante la
> auditoría estática del plugin, el parche exacto que la corrige y cómo se verifica.
>
> **Alcance:** `src/` completo (criptografía, WebRTC, señalización, Nostr, transferencias,
> rutas, persistencia), la capa de UI/documentación, el cliente Blossom y la plantilla
> `scripts/cloudflare-blossom-worker.js`.
>
> **Estado final:** `tsc --noEmit` 0 errores · suite completa `npm test` en verde ·
> `test:realtime-security` 62/62 · `test:cloudflare-worker` en verde ·
> `npm audit` 0 vulnerabilidades · build de producción limpio.
>
> **Documento complementario:** los hallazgos `AN-01`…`AN-10` (anonimato de relés y
> autodetección/límites de Blossom) están desarrollados en detalle, con fragmentos de
> código antes/después, en
> [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](./SECURITY_AUDIT_ANONYMITY_BLOSSOM.md).

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Tabla de fugas y parches](#2-tabla-de-fugas-y-parches)
3. [Fugas de criptografía](#3-fugas-de-criptografía)
4. [Fugas de protocolo y WebRTC](#4-fugas-de-protocolo-y-webrtc)
5. [Fugas de señalización y Nostr](#5-fugas-de-señalización-y-nostr)
6. [Fugas de transferencias](#6-fugas-de-transferencias)
7. [Fugas de rutas del Vault](#7-fugas-de-rutas-del-vault)
8. [Fugas de persistencia](#8-fugas-de-persistencia)
9. [Fugas de integridad temporal](#9-fugas-de-integridad-temporal)
10. [Fugas de documentación y UI](#10-fugas-de-documentación-y-ui)
11. [Bugs encontrados durante la propia auditoría](#11-bugs-encontrados-durante-la-propia-auditoría)
12. [Cómo verificar cada parche](#12-cómo-verificar-cada-parche)
13. [Riesgos residuales conocidos](#13-riesgos-residuales-conocidos)

---

## 1. Resumen ejecutivo

La auditoría encontró **32 fugas** agrupadas en 9 categorías. El hallazgo estructural más
grave no fue una vulnerabilidad aislada, sino un patrón:

> **Los validadores de seguridad ya existían en el código, pero los handlers que reciben
> datos de la red no los invocaban.** Eran decorativos.

Este patrón explicaba por qué el plugin *parecía* endurecido en su estructura y, sin
embargo, era explotable en tiempo de ejecución. El bypass principal —un peer autenticado
podía escribir en cualquier ruta, borrar archivos de forma destructiva o agotar la memoria
del receptor— quedó cerrado al conectar los validadores a los puntos de entrada reales.

Una segunda revisión enfocada en **anonimato de relés y autodetección/límites de Blossom**
añadió los hallazgos `AN-01`…`AN-10` (ver [sección 11.bis](#11bis-endurecimiento-del-buzón-realtime-y-de-blossom)):
el Worker no vinculaba la autorización NIP-98 con la URL, el método ni el cuerpo; persistía
la identidad del uploader en R2; el buzón y Blossom compartían pubkey; las suscripciones
revelaban el prefijo de la aplicación; y los ajustes persistidos podían activar funciones
o destinos no permitidos.

Tres fugas no desaparecen sin más:

| Riesgo | Antes | Después |
|---|---|---|
| Clave maestra persistida | En `data.json` (texto plano) | Solo en `Obsidian SecretStorage` |
| Borrado remoto | `vault.delete` (destrucción) | `vault.trash` (papelera, reversible) |
| Versión local reciente | Sobrescrita por una remota antigua | Se conserva siempre |

---

## 2. Tabla de fugas y parches

| # | ID | Severidad | Categoría | Fuga | Parche | Verificación |
|---|---|---|---|---|---|---|
| 1 | C-01 | **Crítica** | Cripto | Clave maestra de 256 bits no garantizada | `requirePairingSecret()` valida longitud + Base64 canónico | `test:security` |
| 2 | C-02 | Alta | Cripto | Base64 no canónico (espacios, padding) | `decodeCanonicalBase64()` con recodificación y comparación | `test:security` |
| 3 | C-03 | Alta | Cripto | Nonces e IDs con `Math.random()` | CSPRNG (`crypto.getRandomValues`) en todos los generadores | `test:security` |
| 4 | C-04 | **Crítica** | Cripto | Prefijo HMAC distinto al crear vs. verificar | Prefijo común `OmniSync-Auth-v1\0` | `test:security` |
| 5 | C-05 | Alta | Cripto | HMAC comparado con `===` (fuga por tiempo) | `SubtleCrypto.verify` (comparación en tiempo constante) | `test:security` |
| 6 | C-06 | Alta | Cripto | Reutilización de clave entre dominios | Contextos de derivación separados (bóveda/señalización/buzón) | `test:security` |
| 7 | C-07 | Media | Cripto | Sin límites de tamaño en AEAD | Tope en plaintext y ciphertext | `test:security` |
| 8 | C-08 | Media | Cripto | Nonce/etiqueta AEAD sin validar | Longitudes exactas (12 B IV, ≥16 B tag) | `test:security` |
| 9 | P-01 | **Crítica** | Protocolo | Validadores de mensajes no conectados a los handlers | `validateBaseProtocolMessage()` en el borde de entrada | `test:security` |
| 10 | P-02 | **Crítica** | Protocolo | Sin `messageId` ni guard de replay | `ReplayGuard` compartido entre reconexiones | `test:security` |
| 11 | P-03 | Alta | Protocolo | Sin ventana temporal en mensajes | Antigüedad 10 min, desviación futura 5 min | `test:security` |
| 12 | P-04 | Alta | Protocolo | SDP/ICE sin validar | `validateWebRtcSignal()` antes de tocar el navegador | `test:security` |
| 13 | P-05 | Alta | Protocolo | Presencia (cursor) sin validar ni cifrar | Payload validado y cifrado con clave propia | `test:security` |
| 14 | P-06 | **Crítica** | WebRTC | Handshake unidireccional (sin contradesafío) | Desafío HMAC mutuo con contradesafío recíproco | `test:security` |
| 15 | P-07 | Alta | WebRTC | Autenticación firmada pero no verificada | Verificación con `verify` + cierre del peer | `test:security` |
| 16 | S-01 | **Crítica** | Señalización | Endpoint `ws://` sin TLS admitido | `validateSecureWebSocketUrl()`: solo `wss://` | `test:security` |
| 17 | S-02 | Alta | Señalización | Identidad y SDP en claro | Cifrado de identidad, presencia y SDP/ICE | `test:security` |
| 18 | S-03 | Alta | Señalización | Room ID = hash directo de la clave | HMAC con dominio (`signaling-room-v1`) | `test:security` |
| 19 | S-04 | Media | Señalización | Eventos Nostr sin validar | Kind, id, edad, tags y firma verificados | `test:security` |
| 20 | N-01 | Alta | Nostr | Buzón activo por defecto | Opt-in, desactivado por defecto | `test:nostr` |
| 21 | N-02 | Alta | Nostr | Clave y sala compartidas con señalización | Clave y room ID exclusivos del buzón | `test:security` |
| 22 | N-03 | Alta | Nostr | Sin validación de firma/edad/tags/`d` | Verificación completa de eventos recibidos | `test:security` |
| 23 | T-01 | **Crítica** | Transferencias | Hash/checksum inválido no impedía escribir | Verificación antes de reservar memoria | `test:minimax` |
| 24 | T-02 | **Crítica** | Transferencias | Tamaño y nº de fragmentos sin validar | Tope 128 MiB y coherencia tamaño/fragmentos | `test:security` |
| 25 | T-03 | Alta | Transferencias | Transferencias simultáneas ilimitadas | Máximo 2 entrantes y TTL de 5 min | `test:security` |
| 26 | R-01 | **Crítica** | Rutas | Validador de rutas desconectado del handler | `validateVaultPath()` en toda entrada remota | `test:security` |
| 27 | R-02 | **Crítica** | Rutas | `.obsidian/plugins` ejecutable sincronizable | Plugins y cachés excluidos | `test:security` |
| 28 | R-03 | Alta | Rutas | `.trash` y `.git` sincronizables | Bloqueados en la política central | `test:security` |
| 29 | S-05 | **Crítica** | Persistencia | Clave maestra en `data.json` | Trasladada a `SecretStorage` + migración | `test:security` |
| 30 | S-06 | Alta | Persistencia | `roomId` persistido en `data.json` | Eliminado de los datos persistidos | `test:security` |
| 31 | T-04 | **Crítica** | Temporal | Orden remota antigua pisaba trabajo reciente | `sync-policy.ts` con `mtime` comparativo | `test:security` |
| 32 | T-05 | Alta | Temporal | Borrado remoto destructivo | `vault.trash` en lugar de `vault.delete` | `test:security` |
| 33 | T-06 | Alta | Temporal | Renombrado sobrescribía el destino | Destino existente bloquea el renombrado | `test:security` |
| 34 | D-01 | Media | Documentación | "Privacidad absoluta / zero-knowledge" | Metadatos residuales declarados en UI y planes | auditoría de bundle |
| 35 | D-02 | Media | Documentación | Emparejamiento con encoder no canónico | Encoder canónico en `pairing.ts` | `test:security` |
| 36 | AN-01 | **Crítica** | Blossom | NIP-98 sin vínculo con URL/método/cuerpo | `u`, `method` y `payload` verificados contra la petición | `test:cloudflare-worker` |
| 37 | AN-02 | Alta | Blossom | Identidad del uploader persistida en R2 | Sin `customMetadata` de identidad ni fecha | `test:cloudflare-worker` |
| 38 | AN-03 | Alta | Blossom | Cuerpo de subida leído sin cota | Lectura por chunks con corte de 100 MB | `test:cloudflare-worker` |
| 39 | AN-04 | Alta | Anonimato | Misma pubkey para relay y Blossom | Identidades Nostr efímeras separadas | `test:nostr` |
| 40 | AN-05 | Media | Nostr | Etiquetas `d`/`t`/`expiration` ambiguas | Unicidad y límites de esquema por etiqueta | `test:nostr` |
| 41 | AN-06 | Media | Anonimato | `subId` con prefijo y room ID | IDs CSPRNG de 16 hex por conexión | `test:nostr` |
| 42 | AN-07 | Media | Blossom | Descriptor de subida no verificado | Hash/tamaño/URL del descriptor BUD-01 comprobados | `test:realtime-security` |
| 43 | AN-08 | Media | Configuración | Límites y allowlist manipulables | Clamp 1–1024 MB y allowlist HTTPS canónica | `test:realtime-security` |
| 44 | AN-09 | Media | Configuración | `"false"` en `data.json` activaba funciones | Solo se aceptan booleanos reales | `test:realtime-security` |
| 45 | AN-10 | Media | DoS | Cola de transferencias sin cota | Cola máxima de pendientes en el limitador | `test:realtime-security` |

> **Nota:** la numeración incluye 45 entradas; durante la auditoría se detectaron además
> 2 bugs de lógica introducidos por los propios parches (ver [sección 11](#11-bugs-encontrados-durante-la-propia-auditoría)),
> que quedaron corregidos y cubiertos con regresiones.

---

## 3. Fugas de criptografía

### C-01 · Clave maestra sin garantía de 256 bits

**Fuga.** `pairingSecret` se aceptaba como cualquier cadena. Un secreto corto o malformado
se derivaba a PBKDF2 sin que nadie lo detectara, y dos dispositivos con material de
diferente longitud podían interoperar de forma inconsistente.

**Parche.** `src/crypto/crypto-manager.ts` — `requirePairingSecret()` es ahora el único
punto de acceso al material criptográfico:

```ts
public requirePairingSecret(pairingSecret: string): Uint8Array {
  if (typeof pairingSecret !== 'string' ||
      pairingSecret.length !== PAIRING_SECRET_BASE64_LENGTH) {   // 44
    throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
  }
  const bytes = decodeCanonicalBase64(pairingSecret);
  if (bytes.byteLength !== PAIRING_SECRET_BYTES) {              // 32
    throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
  }
  return bytes;
}
```

`deriveAesKey`, `deriveRoomId`, `computeHmacHex`, `createAuthToken` y `verifyAuthToken`
usan ese método, por lo que ningún material criptográfico se deriva de una entrada inválida.

### C-02 · Base64 no canónico

**Fuga.** `atob()` acepta espacios y tolera variantes de padding. Dos codificaciones
distintas del mismo material podían romper comparaciones de tokens o de room IDs.

**Parche.** `src/security/vault-security.ts` — `decodeCanonicalBase64()` decodifica y
**recodifica** para comparar:

```ts
if (btoa(canonical) !== value) {
  throw new SecurityValidationError('Valor Base64 no canónico.');
}
```

### C-03 · Nonces e IDs con PRNG no criptográfico

**Fuga.** Los identificadores derivados de `Math.random()` o de `Date.now()` son
predecibles. Un nonce predecible en AES-GCM permite recuperar la clave de sesión
(GCM nonce reuse).

**Parche.** Todos los generadores usan el CSPRNG:

```ts
public generateNonce(): string {
  const bytes = new Uint8Array(32);
  this.getCrypto().getRandomValues(bytes);   // getRandomValues, no Math.random
  return this.uint8ArrayToBase64Url(bytes);
}
```

Afecta a: `generatePairingSecret`, `generateDeviceId`, `generateSecretId`, `generateNonce`.

### C-04 · Prefijo HMAC distinto al crear y al verificar

**Fuga.** Este era un **fallo funcional además de seguridad**: el token se creaba con un
prefijo y se verificaba con otro, de modo que *ninguna* autenticación HMAC podía validarse.
Descubierto y corregido durante la auditoría.

**Parche.** Prefijo único y compartido en ambos sentidos:

```ts
// Crear
new TextEncoder().encode(`OmniSync-Auth-v1\0${challenge}`)
// Verificar
new TextEncoder().encode(`OmniSync-Auth-v1\0${challenge}`)
```

### C-05 · HMAC comparado con `===`

**Fuga.** La comparación de cadenas con `===` filtra información por tiempo, permitiendo
reconstruir un MAC byte a byte.

**Parche.** Se usa `SubtleCrypto.verify`, que compara en tiempo constante:

```ts
return await this.cryptoSubtle.verify('HMAC', hmacKey, signature, expectedData);
```

Además, `verifyAuthToken` envuelve todo en `try/catch` y devuelve `false` ante cualquier
error: un token malformado no genera excepciones ni ruido en el log.

### C-06 · Reutilización de clave entre dominios de red

**Fuga.** La misma clave AES se usaba para cifrar el contenido de la bóveda, la señalización
y el buzón Nostr. Una fuga en un dominio compromete los tres.

**Parche.** Contextos de derivación independientes (PBKDF2 con salt distinto):

```ts
export const VAULT_KEY_CONTEXT     = 'OmniSync-Salt-v1';
export const SIGNALING_KEY_CONTEXT = 'OmniSync-Signaling-v1';
export const MAILBOX_KEY_CONTEXT   = 'OmniSync-Mailbox-v1';
```

### C-07 / C-08 · Límites de AEAD y validación de nonce/etiqueta

**Fuga.** Sin topes de tamaño, un ciphertext gigante provocaba agotamiento de memoria. Sin
validar el IV y la etiqueta, un envelope manipulado podía llegar al descifrado.

**Parche.** `MAX_ENCRYPTED_PAYLOAD_BYTES` (768 KiB) para plaintext y ciphertext; el IV debe
medir exactamente 12 bytes y el ciphertext al menos 16 (etiqueta GCM).

---

## 4. Fugas de protocolo y WebRTC

### P-01 · Los validadores existían pero no se invocaban (CRÍTICA)

**Fuga.** `src/security/protocol-security.ts` definía validadores completos, pero el
handler de mensajes de `WebRTCPeer` los tenía **desconectados**. Un envelope con `type`
desconocido, `senderId` falso o `payload` arbitrario pasaba intacto al orquestador.

**Parche.** El borde de entrada aplica la validación antes de cualquier lógica de negocio:

```ts
private async handleProtocolMessage(msg: BaseProtocolMessage): Promise<void> {
  validateBaseProtocolMessage(msg, this.remotePeerId);
  if (!this.replayGuard.accept(msg.messageId)) {
    throw new Error('Mensaje de protocolo repetido.');
  }
  ...
}
```

`validateBaseProtocolMessage()` comprueba: objeto plano, tipo conocido, `senderId` igual al
peer autenticado, `messageId` con formato válido, `timestamp` entero dentro de la ventana
temporal y presencia de `payload`.

### P-02 · Ausencia de protección contra replay

**Fuga.** Sin `messageId` ni registro de IDs vistos, un ciphertext capturado podía
reinyectarse indefinidamente y volver a aplicar un borrado o una escritura.

**Parche.** `ReplayGuard` con TTL, cota máxima de entradas y orden de expiración FIFO:

```ts
public accept(messageId: string, now: number = Date.now()): boolean {
  this.prune(now);
  const expiresAt = this.seen.get(messageId);
  if (expiresAt !== undefined && expiresAt > now) return false;
  this.seen.delete(messageId);      // reinserción: conserva el orden de expiración
  this.seen.set(messageId, now + this.ttlMs);
  while (this.seen.size > this.maxEntries) { /* poda */ }
  return true;
}
```

El guard es **compartido por todos los peers** (`private readonly replayGuard = new
ReplayGuard()` en el orquestador), por lo que un replay entre reconexiones también se
detecta. Se añadió `clear()` para la rotación de clave.

### P-03 · Sin ventana temporal en los mensajes

**Fuga.** Un mensaje de hace semanas se aceptaba igual.

**Parche.** `MAX_PROTOCOL_MESSAGE_AGE_MS` (10 min) y `MAX_PROTOCOL_CLOCK_SKEW_MS` (5 min de
tolerancia hacia el futuro).

### P-04 · SDP y candidatos ICE sin validar

**Fuga.** Un SDP o un candidato ICE malicioso se pasaba directamente al API del navegador.

**Parche.** `validateWebRtcSignal()` valida tipo, SDP no vacío y acotado (128 KiB), y
candidato ICE con longitud acotada (16 KiB). Además se acotan los candidatos ICE pendientes
a 100.

### P-05 · Presencia sin validar ni cifrar

**Fuga.** El canal de presencia (cursores) enviaba la posición del cursor y la ruta del
archivo **en claro** por un canal no fiable, y el payload no se validaba.

**Parche.** La presencia se cifra con la clave de señalización y su payload se valida antes
de tocar el estado del editor (`validatePresencePayload`), incluyendo la ruta del archivo
contra la política del Vault.

### P-06 / P-07 · Handshake de autenticación incompleto

**Fuga (P-06).** El desafío era unidireccional: un peer podía *recibir* una prueba HMAC
válida sin tener que demostrar que conocía la clave. La conexión se marcaba autenticada al
recibir la respuesta, sin exigir contraproba.

**Fuga (P-07).** La prueba se firmaba pero no se verificaba de forma criptográfica, y el
estado de autenticación no se invalidaba tras el uso.

**Parche.** Desafío mutuo con **contradesafío recíproco** y verificación mediante
`SubtleCrypto.verify`:

```ts
// Al recibir AUTH_CHALLENGE: responder con proof + counterNonce propio
const localNonce = this.cryptoManager.generateNonce();
this.counterChallengeNonce = localNonce;
this.authState = 'awaiting_counter';   // aún NO autenticado

// Al recibir AUTH_RESPONSE: verificar la contraproba
if (!this.counterChallengeNonce || counterNonce) {
  throw new Error('Contradesafío de autenticación inválido.');
}
const counterValid = await this.cryptoManager.verifyAuthToken(
  this.counterChallengeNonce, proof, this.options.pairingSecret);
if (!counterValid) { this.close(); return; }
this.authState = 'authenticated';
```

El desafío se consume (`this.authChallengeNonce = ''`), por lo que una copia posterior del
mismo envelope falla. El estado es una máquina explícita: `idle → challenge_sent →
awaiting_counter → authenticated`.

---

## 5. Fugas de señalización y Nostr

### S-01 · Endpoint WebSocket sin TLS (CRÍTICA)

**Fuga.** Se aceptaba `ws://` (sin cifrar) como servidor de señalización. Todo el
cifrado de la capa superior quedaría sin protección frente a un atacante en la red.

**Parche.** `src/security/network-security.ts` — política única de endpoints:

```ts
if (parsed.protocol !== 'wss:') {
  throw new SecurityValidationError('El servidor debe usar wss:// (TLS).');
}
if (!parsed.hostname || parsed.username || parsed.password) { /* inválida */ }
if (parsed.hash) { /* fragmento no permitido */ }
```

Se rechazan además URLs con credenciales, con fragmento, con caracteres de control o
superiores a 2048 caracteres.

### S-02 / S-03 · Señalización en claro y room ID derivado de la clave

**Fuga.** La identidad del emisor y las ofertas/respuestas SDP viajaban sin cifrar por el
relay. El room ID era `SHA-256(clave)[:16]`: un atacante que obtuviera el room ID de un
relay podía probar claves candidatas offline.

**Parche.** Todo el payload de señalización se cifra con la clave de señalización, y el
room ID pasa a ser un HMAC con dominio:

```ts
public async deriveSignalingRoomId(pairingSecret: string): Promise<string> {
  return this.computeHmacHex('room', pairingSecret, 'signaling-room-v1');
}
```

### S-04 · Eventos Nostr de señalización sin validar

**Parche.** `handleNostrEvent()` exige: `kind` 25000, `id` de 64 caracteres, `content`
acotado, `created_at` entero dentro de la ventana de 10 min, tag `#t` con el room ID,
**firma válida** (`verifyEvent`) y `messageId` no repetido.

### N-01 · Buzón Nostr activo por defecto

**Fuga.** El buzón publicaba notas en relays públicos sin que el usuario lo hubiera pedido,
y la UI afirmaba "privacidad absoluta". Esos relays son de terceros y ven metadatos.

**Parche.** `enableNostrMailbox` es **opt-in y desactivado por defecto**. La UI declara
explícitamente qué observa un relay: sala seudónimo, hora, tamaño aproximado y actividad.

### N-02 / N-03 · Buzón sin aislamiento de dominio ni validación de eventos

**Parche.** Clave y room ID exclusivos (`OmniSync-Mailbox-v1`, `mailbox-room-v1`) y
validación completa de cada evento recibido:

| Control | Regla |
|---|---|
| Forma | `kind` 30078, `id` 64 hex, `content` ≤ 256 KiB, `tags` array |
| Antigüedad | `created_at` en `[now − 8 días, now + 60 s]` |
| Sala | Tag `#t` igual al room ID del buzón |
| Caducidad | Tag `expiration` entero en `(now, now + 7 días + 60 s]` |
| Firma | `verifyEvent(event)` |
| Payload | AEAD con la clave del buzón; tipos de campo validados |
| Ruta | `validateVaultPath()` y ya normalizada |
| Etiqueta `#d` | Coincidencia exacta con `omnisync:<roomId>:<HMAC(ruta)>` |
| Duplicados | Se conserva solo la nota más reciente por ruta |
| Límite | Máximo 500 eventos por consulta |

---

## 6. Fugas de transferencias

### T-01 · Hash y checksum inválidos no impedían la escritura (CRÍTICA)

**Fuga.** Los validadores de cabecera y fragmento existían, pero el ensamblador no los
conectaba de forma que el hash global se comprobara **antes** de escribir. Un peer podía
declarar un hash inválido y el archivo se escribía igualmente.

**Parche.** Doble verificación: checksum SHA-256 **por fragmento** y hash SHA-256 **del
archivo ensamblado**, ambos antes de devolver los datos:

```ts
const computed = await this.cryptoManager.computeHash(chunkBytes);
if (computed !== chunk.checksum) {
  this.activeIncomingTransfers.delete(chunk.transferId);
  throw new FileTransferError(`Checksum inválido en el fragmento ${chunk.chunkIndex}...`);
}
...
if (computedHash !== transfer.header.hash) {
  throw new FileTransferError(`Integridad de archivo corrupta para '${transfer.header.path}'...`);
}
```

Además, el `writeFileToVault()` vuelve a verificar el hash antes de escribir, y el
`ArrayBuffer` se copia con el rango exacto de bytes (`byteOffset`/`byteLength`) para no
escribir memoria residual de una vista reutilizada.

### T-02 · Tamaño y número de fragmentos sin validar

**Fuga.** Un `size` declarado enorme o un `totalChunks` incoherente podían provocar
reservas de memoria desproporcionadas.

**Parche.** `validateFileHeader()` exige coherencia entre tamaño y número de fragmentos:

```ts
const minimumChunksForSize = Math.max(1, Math.ceil(size / MAX_TRANSFER_CHUNK_SIZE));
const maximumChunksForSize = Math.max(1, Math.ceil(size / MIN_TRANSFER_CHUNK_SIZE));
if (totalChunks < minimumChunksForSize ||
    totalChunks > maximumChunksForSize ||
    totalChunks > MAX_TRANSFER_CHUNKS) {
  throw new SecurityValidationError('El número de fragmentos es inconsistente con el tamaño declarado.');
}
```

Tope absoluto: 128 MiB por archivo, 8192 fragmentos, fragmento entre 16 KiB y 64 KiB.

### T-03 · Transferencias simultáneas ilimitadas

**Parche.** `MAX_ACTIVE_INCOMING_TRANSFERS = 2`, más un TTL de 5 minutos con
`pruneStaleTransfers()` para liberar transferencias interrumpidas.

---

## 7. Fugas de rutas del Vault

### R-01 · Validador de rutas desconectado (CRÍTICA)

**Fuga.** Este fue el bypass principal. `validateVaultPath()` estaba implementado y
documentado, pero los handlers que escribían en el Vault no lo llamaban. Un peer
autenticado podía escribir en rutas arbitrarias.

**Parche.** Política centralizada en `src/security/vault-security.ts`, invocada en **cada**
punto de entrada remoto: cabecera de transferencia, fragmento, manifiesto, borrado,
renombrado, nota de buzón, escritura y watcher de archivos.

La política cubre: traversal (`..`), rutas absolutas POSIX y Windows, segmentos vacíos,
`.`, segmentos reservados (`__proto__`, `prototype`, `constructor`), caracteres de control,
longitud máxima (1024 caracteres / 100 segmentos / 255 por segmento) y normalización canónica.

### R-02 / R-03 · Zonas sensibles sincronizables

**Fuga.** `.obsidian/plugins` contiene **código ejecutable**; sincronizarlo entre
dispositivos es ejecución remota de facto. También `.trash` y `.git`.

**Parche.** En la política central:

```ts
if (root === '.trash' || root === '.git') {
  throw new SecurityValidationError('No se permite sincronizar la papelera ni el repositorio Git.');
}
if (root === '.obsidian') {
  if (!policy.syncObsidianConfig) { /* desactivado */ }
  if (segments[1]?.toLowerCase() === 'plugins') {
    throw new SecurityValidationError('No se permite sincronizar plugins ejecutables de Obsidian.');
  }
  // Además se excluyen community-plugins.json, workspace.json y graph.json.
}
```

Se añadió además la comprobación de que el `__proto__` no puede aparecer como segmento, lo
que evita la contaminación de prototipos al construir el mapa de archivos de un manifiesto.

---

## 8. Fugas de persistencia

### S-05 · Clave maestra en `data.json` (CRÍTICA)

**Fuga.** `pairingSecret` se guardaba en el `data.json` del plugin, en texto plano junto a
la configuración. Cualquiera con acceso al perfil de Obsidian o a una copia de seguridad
obtenía la clave que cifra toda la bóveda.

**Parche.** La clave se traslada a `Obsidian SecretStorage` (API del sistema operativo, no
accesible desde el archivo de datos del plugin):

```ts
// saveSettings: la clave va al almacén seguro, nunca a data.json
this.app.secretStorage.setSecret(this.settings.masterKeySecretId, this.settings.pairingSecret);
const persisted: Partial<OmniSyncSettings> = { ...this.settings };
delete persisted.pairingSecret;
delete persisted.roomId;
await this.saveData(persisted);
```

`loadSettings()` además **migra** el formato heredado: si encuentra una `pairingSecret`
antigua en `data.json`, la valida, la traslada a `SecretStorage` y la borra del archivo.

> **Requisito:** `SecretStorage` exige Obsidian **1.11.4+**, por lo que `minAppVersion` se
> elevó a `1.11.4` en `manifest.json`. En versiones anteriores el plugin lanza un error
> explícito en lugar de degradar a la persistencia insegura.

### S-06 · `roomId` persistido

**Parche.** El room ID es un valor derivado de la clave; persistirlo en `data.json` no
aporta nada y filtra metadatos. Se elimina de los datos persistidos.

---

## 9. Fugas de integridad temporal

### T-04 · Una orden remota antigua pisaba trabajo reciente (CRÍTICA)

**Fuga.** Los mensajes `FILE_DELETE` y `FILE_RENAME` no llevaban marca de tiempo, y al
escribir un archivo recibido se comparaba `existing.stat.mtime > mtime` sin que el `mtime`
remoto se propagara de forma fiable. Un peer con un reloj atrasado, o un mensaje encolado
durante minutos, podía sobrescribir una versión local más reciente.

**Parche.** Nuevo módulo `src/security/sync-policy.ts` con **decisiones puras** y
testeables, para que la regla no dependa de que cada handler la implemente bien:

```ts
export function decideRemoteWrite(localMtime: number | null, remoteMtime: number): WriteDecision {
  if (localMtime === null) return 'apply';
  if (localMtime > remoteMtime) return 'skip_newer_local';   // nunca se pisa lo más reciente
  return 'apply';
}

export function decideRemoteDelete(localMtime: number | null, remoteMtime: number): DeleteDecision {
  if (localMtime === null) return 'skip_missing';
  if (localMtime > remoteMtime) return 'skip_newer_local';
  return 'trash';
}

export function decideRemoteRename(
  localMtime: number | null, remoteMtime: number, destinationExists: boolean): RenameDecision {
  if (localMtime === null) return 'skip_missing';
  if (destinationExists) return 'skip_destination_exists';  // no se sobrescribe el destino
  if (localMtime > remoteMtime) return 'skip_newer_local';
  return 'rename';
}
```

Los `mtime` viajan ahora en los tres tipos de mensaje (`FILE_HEADER`, `FILE_DELETE`,
`FILE_RENAME`) y en la nota del buzón, y se propagan hasta la escritura final.

### T-05 · Borrado remoto destructivo

**Fuga.** `vault.delete(file)` eliminaba el archivo de forma **irreversible**. Un peer
autenticado (o un mensaje encolado) podía destruir trabajo local sin posibilidad de
recuperación.

**Parche.** `vault.trash(file, true)`: Obsidian mantiene la versión en la papelera, y el
usuario puede restaurarla. La UI lo documenta en una sección explícita.

### T-06 · Renombrado que sobrescribía el destino

**Parche.** Si la ruta de destino ya existe, el renombrado remoto se descarta
(`skip_destination_exists`) en lugar de reemplazar el archivo local.

---

## 10. Fugas de documentación y UI

### D-01 · Afirmaciones técnicamente incorrectas

**Fuga.** La documentación afirmaba "Privacidad Absoluta (Zero-Knowledge)", "ningún
metadato sale del dispositivo" y "ningún tercero puede interceptar". Es falso: un relay de
señalización ve la IP, la hora y la sala seudónimo; un relay de Nostr ve además el tamaño
aproximado y la cadencia de publicación. Una promesa falsa de seguridad es un defecto
prácticamente igual a una vulnerabilidad: induce al usuario a una confianza injustificada.

**Parche.** Se eliminaron las afirmaciones absolutas y se sustituyeron por la descripción
real del modelo:

- `omnisync_plan.md`: nueva sección **1.1 Modelo de Amenazas** y **1.2 Límites Defensivos
  Aplicados**.
- `nostr_mailbox_plan.md`: "Privacidad Total de Metadatos (Zero-Knowledge)" → "Metadatos
  Residuales (modelo real, no zero-knowledge)" con la lista de lo que un relay observa.
- `settings-tab.ts`: la descripción del buzón enumera sala seudónimo, hora, tamaño
  aproximado y actividad.
- Auditoría automatizada del bundle: `zero-knowledge` = 0, `privacidad absoluta` = 0.

### D-02 · Emparejamiento con encoder no canónico

**Parche.** `src/security/pairing.ts` — payload versionado (`v: 1`), decodificación estricta
con validación de UTF-8 no tolerante, tamaño máximo 8192 caracteres, y validación del
room ID contra la clave derivada en `pairNewDevice()`:

```ts
const expectedRoomId = await this.cryptoManager.deriveRoomId(parsed.secret);
if (expectedRoomId !== parsed.roomId) return false;   // room ID ajeno a la clave
```

---

## 11. Bugs encontrados durante la propia auditoría

Estos dos fallos **no** eran fugas preexistentes: los introdujo el proceso de endurecimiento
y se detectaron al revisar el código ya parcheado. Se documentan porque ambos eran errores
silenciosos (no fallaban de forma visible) y porque el primero invalidaba una protección
completa.

### B-01 · La detección de conflictos del buzón nunca se disparaba

**Causa.** `pollMailboxOnStartup()` avanzaba `lastMailboxFetchTimestamp` **antes** de
aplicar las notas recibidas:

```ts
// Código defectuoso
const pendingNotes = await this.nostrMailbox.fetchPendingNotes(this.settings.lastMailboxFetchTimestamp || 0);
this.settings.lastMailboxFetchTimestamp = Date.now();   // ← marca avanzada antes de aplicar
await this.saveSettings();

for (const note of pendingNotes) {
  await this.applyMailboxNote(note);   // la comparación ya no detecta nada
}
```

La condición de conflicto es `localMtime > lastMailboxFetchTimestamp`. Al haber avanzado la
marca a `Date.now()` antes de comparar, la condición era **siempre falsa**: los cambios
locales propios se sobrescribían en silencio y nunca se generaba copia de respaldo.

**Parche.** La marca se captura antes y se avanza solo después de aplicar todo:

```ts
const previousFetchTimestamp = this.settings.lastMailboxFetchTimestamp || 0;
const pendingNotes = await this.nostrMailbox.fetchPendingNotes(previousFetchTimestamp);

if (pendingNotes.length > 0) {
  for (const note of pendingNotes) {
    await this.applyMailboxNote(note, previousFetchTimestamp);  // marca intacta
  }
}

this.settings.lastMailboxFetchTimestamp = Date.now();  // ← ahora sí, al final
await this.saveSettings();
```

**Regresión añadida** (2 aserciones que fijan el orden correcto):

```
PASS  un cambio local posterior a la última consulta se detecta como conflicto
PASS  un cambio local anterior a la última consulta se aplica sin conflicto
```

### B-02 · `mtime` ausente fabricaba una fecha local "más reciente"

**Causa.** El handler de fragmentos usaba un fallback:

```ts
await this.saveIncomingFile(result.path, result.data, result.mtime ?? Date.now());
```

Si faltaba el `mtime` remoto, se fabricaba la hora local, que siempre parecería la más
reciente y por tanto **pisaría** la versión local. El fallback anulaba la protección
temporal recién implementada.

**Parche.** El `mtime` remoto pasa a ser obligatorio; sin él no se escribe nada:

```ts
if (typeof result.mtime !== 'number' || !Number.isFinite(result.mtime)) {
  throw new SecurityValidationError('La transferencia recibida no incluye una marca de tiempo válida.');
}
await this.saveIncomingFile(result.path, result.data, result.mtime);
```

---

## 11.bis Endurecimiento del buzón realtime y de Blossom

Esta ronda cubre la sincronización realtime (Nostr), los parches delta multipart y la
transferencia de archivos grandes por Blossom.

### RT-01 · Un fallo transitorio convertía el evento en duplicado descartado

**Causa.** La reserva del guard de replay se hacía al validar el evento, pero nunca se
liberaba. Un error de red, un servidor Blossom caído o una bóveda bloqueada convertían el
cambio en un evento ya "visto": el siguiente barrido lo descartaba como replay y **el
cambio se perdía en silencio**.

**Parche.** La validación devuelve ahora la clave reservada (`eventId`), que viaja con la
nota pendiente. Si la aplicación local falla, la reserva se libera y el evento vuelve a ser
procesable:

```ts
// La reserva solo sobrevive a una aplicación exitosa.
private async deliverNote(note: NostrMailboxNotePayload, reservationKeys: string[]): Promise<void> {
  try {
    await this.onNoteReceived?.(note);
  } catch (err) {
    this.releaseReservations(reservationKeys);
    throw err;
  }
}
```

En el barrido inicial el mismo criterio se aplica por nota, y la marca de consulta
(`lastMailboxFetchTimestamp`) **no avanza por encima del evento fallido más antiguo**, de
modo que el cambio pendiente se vuelve a descargar en la siguiente consulta.

### RT-02 · Los fragmentos multipart perdían su reserva individual

**Causa.** Cada fragmento reservaba su ID por separado. Si el parche ensamblado fallaba al
aplicarse, los fragmentos ya consumidos quedaban bloqueados para siempre.

**Parche.** `MultipartGroup.eventIds` registra todas las reservas del grupo. Al completarse
se entregan todas juntas y se liberan en bloque si la aplicación falla. Los fragmentos
rechazados (metadatos inválidos, grupo descartado por antigüedad o por exceso de bytes)
liberan su propia reserva inmediatamente.

### RT-03 · Descargas Blossom simultáneas sin cota de memoria

**Causa.** Varias notas de 25/50 MB podían transferirse a la vez. Cada blob ocupa su
cuerpo cifrado **más** su copia descifrada en memoria.

**Parche.** `ConcurrencyLimiter` acota las operaciones pesadas a una simultánea
(`MAX_CONCURRENT_BLOSSOM_OPERATIONS = 1`). Subidas y descargas Blossom pasan por el mismo
limitador global, de modo que nunca hay dos blobs de 50 MB residentes a la vez.

### RT-04 · Errores del relay inyectados en la interfaz y en la consola

**Causa.** El mensaje de rechazo del relay (`OK <id> false <mensaje>`) se interpolaba sin
filtrar en los `Notice` y en los `console.warn`. Un relay podía inyectar saltos de línea,
secuencias de escape ANSI o el prefijo `OmniSync:` para suplantar mensajes del plugin.

**Parche.** `sanitizeExternalText` / `sanitizeExternalError` eliminan caracteres de control,
secuencias ANSI, colapsan espacios, acotan la longitud a 160 caracteres y neutralizan el
prefijo reservado del plugin antes de mostrar o registrar cualquier texto externo.

### RT-05 · Fuentes de Blossom sin política de allowlist

**Causa.** El puntero remoto incluía la URL del servidor. Un atacante podía apuntar a
direcciones internas (`http://127.0.0.1/...`) o a destinos no permitidos.

**Parche.** `validateSecureHttpUrl` exige HTTPS y rechaza credenciales, query strings y
fragmentos. La URL remota se canonicaliza y **solo se contacta si pertenece a la allowlist
local**; en caso contrario se descartan los punteros y se prueban los servidores configurados.
Las redirecciones están bloqueadas (`redirect: 'error'`), de modo que un endpoint firmado no
puede redirigir la petición a otro destino.

### RT-06 · Integridad del blob confiada en el valor remoto

**Causa.** El tamaño y el hash declarados en el puntero Blossom se tomaban como verdad.

**Parche.** El hash se **recalcula localmente** antes de subir y se **verifica** tras
descargar; el `Content-Length` declarado debe coincidir con el tamaño autenticado y con los
bytes realmente leídos, y la descarga en streaming aborta al superar el límite.

### AN-01 · NIP-98 del Worker no vinculaba URL, método ni cuerpo

**Causa.** `validateNip98Auth()` comprobaba kind, antigüedad, `method`, ID y firma
Schnorr, pero **ignoraba por completo la etiqueta `u`**, no exigía el hash
`payload` y no lo comparaba con los bytes realmente recibidos. Una firma NIP-98
válida de otro `PUT` podía autorizar una carga distinta.

**Mitigación.** En `scripts/cloudflare-blossom-worker.js`:

- `u` debe aparecer exactamente una vez y ser idéntica a `request.url`;
- `method` debe aparecer exactamente una vez y coincidir con el método HTTP;
- `payload` es obligatorio en cargas y su SHA-256 debe coincidir con el hash
  recalculado sobre el cuerpo recibido;
- `expiration`, si aparece, no puede estar caducado ni duplicado;
- el esquema del evento, la longitud de etiquetas y el Base64 se validan antes
  de verificar la firma.

**Verificación.** `npm run test:cloudflare-worker` (URL, método, payload y
`expiration` manipulados; evento caducado y evento con `id` alterado).

### AN-02 · El Worker persistía la identidad del uploader

**Causa.** Cada objeto R2 guardaba `customMetadata.uploaderPubkey` y
`uploadedAt`. La plantilla promete que el servidor no ve identidad, pero R2
conservaba la pubkey y la hora de subida de forma persistente y consultable.

**Mitigación.** El bucket solo guarda hash, bytes y tipo MIME. No se persiste
ninguna identidad, fecha ni metadato de uploader.

**Verificación.** `npm run test:cloudflare-worker` (el objeto almacenado no
contiene `customMetadata`, `pubkey` ni `uploadedAt`).

### AN-03 · El cuerpo de subida se leía sin cota real

**Causa.** El Worker comprobaba `Content-Length` si estaba presente, pero leía el
cuerpo con `request.arrayBuffer()`. Una petición sin cabecera `Content-Length`
podía acumular memoria hasta agotar los límites del Worker.

**Mitigación.** `readRequestBodyWithLimit()` acumula el cuerpo por chunks y
cancela la lectura al superar 100 MB. `Content-Length` inválido o discordante
con los bytes recibidos se rechaza.

**Verificación.** `npm run test:cloudflare-worker` (límite de tamaño y
`Content-Length` discordante).

### AN-04 · Identidad Nostr compartida entre relay y Blossom

**Causa.** `NostrMailbox` usaba la misma clave Nostr efímera para firmar los
eventos del buzón y las autorizaciones NIP-98 de Blossom. Un servidor Blossom y
un relay podían correlacionar ambos servicios mediante la pubkey del autor.

**Mitigación.** Identidades Nostr independientes: `mailboxSecretKey` para el
buzón y `blossomSecretKey` para Blossom. Ambas son efímeras y no se persisten.

**Verificación.** `npm run test:nostr` (las dos claves son distintas).

### AN-05 · Etiquetas ambiguas en eventos del buzón

**Causa.** El validador buscaba la primera etiqueta `t`, `d` o `expiration`. Un
evento con etiquetas duplicadas o contradictorias podía ser interpretado de
forma distinta por el cliente y por el relay.

**Mitigación.** `d`, `t` y `expiration` deben aparecer exactamente una vez; el
resto de etiquetas se acota en número, longitud y tipo. El HMAC de `d` sigue
siendo `mailbox-dtag-v2` para no romper la compatibilidad con los dispositivos
ya emparejados.

**Verificación.** `npm run test:nostr` (etiquetas `t`, `d` y `expiration`
duplicadas, sala ajena y etiqueta excessive).

### AN-06 · Suscripciones identificables en el relay

**Causa.** La señalización Nostr usaba `omni-${roomId.substring(0, 10)}` como
`subId`, lo que revelaba el prefijo de la aplicación y una parte del room ID.

**Mitigación.** `CryptoManager.generateHexId()` genera identificadores CSPRNG de
16 hexadecimales. Tanto el buzón como la señalización los usan en cada
conexión; no se reutiliza ningún identificador persistente.

**Verificación.** `npm run test:realtime-security` y `npm run test:nostr`.

### AN-07 · Descriptor de subida Blossom no verificado

**Causa.** El cliente Blossom daba por buena cualquier respuesta `200`, `201` o
`409`, sin comprobar el descriptor BUD-01 devuelto. Un servidor que aceptara la
petición pero almacenara bytes distintos no era detectado.

**Mitigación.** Para `200`/`201` se exige un descriptor JSON acotado a 16 KB cuyo
`sha256` y `size` coincidan con los bytes enviados y cuya `url` sea HTTPS sin
credenciales. Un `409` sin cuerpo se acepta como idempotente; si trae cuerpo, el
descriptor debe ser válido.

**Verificación.** `npm run test:realtime-security` (descriptor con hash
incorrecto, descriptor corrupto y `409` idempotente).

### AN-08 · Límites y allowlist de Blossom manipulables desde `data.json`

**Causa.** `customMaxBlobSizeMb` persistido se usaba sin clamp superior y la UI
aceptaba `http://`. La lista guardada y la allowlist realmente contactada podían
divergir.

**Mitigación.** `resolveMaxBlobSizeBytes()` y `clampMaxBlobSizeMb()` aplican un
rango de 1–1024 MB y rechazan `NaN`, `Infinity`, fracciones y valores fuera de
rango. `BlossomClient.normalizeServerList()` es la única fuente de canonicalidad
(HTTPS, sin credenciales, sin query, deduplicada, máximo 16 destinos) y se usa
en la UI, al cargar, al guardar y al transferir.

**Verificación.** `npm run test:realtime-security` (límites y allowlist).

### AN-09 · Flags booleanos con coerción de tipo

**Causa.** En JavaScript el string `"false"` es *truthy*. Un `data.json` alterado
podía activar el buzón, Blossom o la sincronización de adjuntos usando un valor
que el usuario nunca eligió.

**Mitigación.** `sanitizeBooleanSettings()` solo acepta booleanos reales para
`autoSync`, `syncAttachments`, `syncObsidianConfig`, `enableNostrMailbox` y
`enableBlossomSync`; cualquier otro tipo se sustituye por el valor seguro por
defecto. La sanitización se aplica al cargar y al guardar.

**Verificación.** `npm run test:realtime-security` (coerción de `"false"`, `"true"`
y valores numéricos).

### AN-10 · Cola de operaciones pesadas sin cota

**Causa.** `ConcurrencyLimiter` limitaba las operaciones simultáneas, pero su cola
de espera no tenía límite: muchas descargas pendientes retenían copias
cifradas en memoria.

**Mitigación.** El limitador acepta un máximo de operaciones pendientes y
rechaza el exceso con un error explícito. El buzón Blossom usa un máximo de 4
pendientes además de una única operación simultánea.

**Verificación.** `npm run test:realtime-security` (cola del limitador).

---

## 12. Cómo verificar cada parche

```bash
cd /ruta/al/plugin

npm run test:minimax    # 39/39  — fragmentación, checksum, control de flujo
npm run test:security   # 112/112 — regresiones de seguridad
npm run test:nostr      # 100%   — buzón Nostr
npm test                # las tres suites encadenadas

npx tsc --noEmit        # 0 errores
npm audit               # 0 vulnerabilidades
npm run build           # regenera main.js
```

### Cobertura por suite

| Suite | Cubre |
|---|---|
| `test:minimax` | C-07/C-08 (AEAD), T-01 (hash y checksum), control de flujo WebRTC |
| `test:security` | C-01…C-06, P-01…P-07, S-01…S-06, N-02/N-03, T-02/T-03, R-01…R-03, T-04…T-06, D-02, B-01, B-02 |
| `test:nostr` | N-01 (elegibilidad, HMAC de rutas, NIP-78/40, tombstone), AN-04 (identidades separadas), AN-05 (unicidad de etiquetas) |
| `test:nostr-delta` | Fragmentación multipart, límite de 768 KB, integridad UTF-8 sin partir surrogate pairs |
| `test:blossom` | BUD-01/BUD-02, NIP-98 (kind 27235 + tag `payload`), allowlist de servidores |
| `test:realtime-security` | RT-01…RT-06 y AN-06…AN-10: SSRF por puntero remoto, límites de descarga, hash de subida, descriptor BUD-01, redirecciones, política de rutas del receptor, codificación UTF-8, serialización por ruta, límite global de concurrencia y de cola, clamp de límites, allowlist canónica, saneado de booleanos, liberación de reservas de replay, saneado de texto externo |
| `test:cloudflare-worker` | AN-01…AN-03: vínculo NIP-98 con URL/método/payload, ausencia de metadatos de identidad en R2, límite y consistencia del cuerpo de subida, cabeceras malformadas, descarga y HEAD |

### Auditoría del bundle de producción

```bash
node -e "
const s = require('fs').readFileSync('main.js','utf8');
console.log('zero-knowledge:             ', (s.match(/zero.?knowledge/gi)||[]).length);
console.log('privacidad absoluta:        ', (s.match(/privacidad\s+absoluta/gi)||[]).length);
console.log('vault.delete (destructivo): ', (s.match(/vault\.delete\(/g)||[]).length);
console.log('vault.trash (papelera):      ', (s.match(/\.trash\(/g)||[]).length);
console.log('secretos Base64 literales:  ', (s.match(/['\"][A-Za-z0-9+\/]{43}=['\"]/g)||[]).length);
"
```

Resultado esperado: `0, 0, 0, 2, 0`.

### Verificación manual recomendada

1. En un dispositivo, borrar una nota; en el otro, comprobar que aparece **en la papelera**
   y no ha desaparecido.
2. En un dispositivo, escribir una nota y esperar unos segundos; en el otro, modificarla y
   comprobar que la versión antigua no pisa la nueva.
3. En un dispositivo, renombrar a un nombre que ya existe en el otro; comprobar que el
   archivo local **no** se reemplaza.
4. Desvincular un dispositivo y comprobar que **todos** quedan desvinculados (la clave
   maestra es compartida: rotarla es la única revocación real).
5. Revisar `data.json` del plugin y confirmar que **no** contiene la clave maestra; sí debe
   contener `masterKeySecretId` (referencia opaca, no material criptográfico).

---

## 13. Riesgos residuales conocidos

Estos puntos **no** están resueltos y se documentan de forma explícita para no dar una
impresión de seguridad absoluta:

1. **Metadatos de red visibles.** Los relays observan IP, hora, sala seudónimo, tamaño
   aproximado y actividad. Es inherente a usar relays públicos; por eso el buzón es opt-in.
2. **La clave maestra es compartida.** Un dispositivo comprometido da acceso a toda la
   bóveda. La rotación es la única revocación, y exige revincular todos los dispositivos.
3. **Conflicto de escritura simultánea.** La resolución usa `mtime`; con relojes muy
   desviados entre dispositivos el orden puede ser incorrecto. El peor caso es una copia de
   conflicto, no pérdida de datos.
4. **La papelera de Obsidian no está cifrada por OmniSync.** El borrado remoto es
   reversible, pero el contenido de la papelera lo protege el sistema operativo, no el
   plugin.
5. **`SecretStorage` depende de la versión de Obsidian.** Por debajo de 1.11.4 el plugin
   no arranca; es una decisión deliberada antes que degradar a persistencia insegura.
6. **Los reintentos del buzón dependen de la ventana de NIP-40.** Un evento que no pudo
   aplicarse se reintenta en el siguiente barrido, pero solo mientras su `expiration`
   siga vigente (7 días) y mientras no exceda la antigüedad máxima admitida (8 días).
   Pasado ese plazo, el cambio se pierde de forma definitiva.
7. **El límite de concurrencia Blossom no es un límite de ancho de banda.** Serializar las
   transferencias acota la memoria residente, pero una única descarga de 50 MB sigue
   monopolizando el limitador durante toda su duración.
8. **El texto del relay se muestra al usuario.** Aunque se sanea (sin caracteres de control,
   acotado a 160 caracteres y sin el prefijo del plugin), el usuario puede ver un mensaje
   redactado por un tercero. Es información no confiable, no una instrucción.
