# Guía de Desarrolladores – OmniSync

Esta guía es para quien quiera **comprender el funcionamiento de OmniSync**. Explica cómo está organizado el plugin, cómo viaja un cambio de un dispositivo a otro, qué reglas de seguridad no se pueden romper, cómo probar y cómo publicar una versión.

- [1. Propósito y arquitectura](#1-propósito-y-arquitectura)
- [2. Primeros pasos](#2-primeros-pasos)
- [3. Estructura del código](#3-estructura-del-código)
- [4. Claves, salas e identidad](#4-claves-salas-e-identidad)
- [5. Cómo funciona la sincronización](#5-cómo-funciona-la-sincronización)
- [6. Recepción de cambios y política de conflictos](#6-recepción-de-cambios-y-política-de-conflictos)
- [7. Transportes en detalle](#7-transportes-en-detalle)
- [8. Emparejamiento efímero](#8-emparejamiento-efímero)
- [9. Ajustes y datos persistidos](#9-ajustes-y-datos-persistidos)
- [10. Reglas de seguridad (invariantes)](#10-reglas-de-seguridad-invariantes)
- [11. Pruebas](#11-pruebas)
- [12. Recetas: cambios habituales](#12-recetas-cambios-habituales)
- [13. Depuración](#13-depuración)
- [14. CI y dependencias](#14-ci-y-dependencias)
- [15. Versiones y publicación](#15-versiones-y-publicación)
- [16. Buenas prácticas y contribuciones](#16-buenas-prácticas-y-contribuciones)

**Apéndice (referencia extendida):**

- [A. Panorama de la arquitectura](#a-panorama-de-la-arquitectura)
- [B. Máquina de estados de `SyncState`](#b-máquina-de-estados-de-syncstate)
- [C. Secuencia de mensajes WebRTC](#c-secuencia-de-mensajes-webrtc)
- [D. Árbol de derivación de claves](#d-árbol-de-derivación-de-claves)
- [E. Flujo de resolución de conflictos](#e-flujo-de-resolución-de-conflictos)
- [F. Cómo escribir un transporte nuevo](#f-cómo-escribir-un-transporte-nuevo)
- [G. Cómo escribir una prueba](#g-cómo-escribir-una-prueba)
- [H. Rendimiento y límites operativos](#h-rendimiento-y-límites-operativos)
- [I. Interno del Worker de Cloudflare](#i-interno-del-worker-de-cloudflare)
- [J. Glosario](#j-glosario)
- [K. Invariantes de seguridad: por qué importa cada una](#k-invariantes-de-seguridad-por-qué-importa-cada-una)
- [L. Parches delta a fondo](#l-parches-delta-a-fondo)
- [M. Interoperabilidad con MySecret](#m-interoperabilidad-con-mysecret)
- [N. Ampliar la i18n: añadir un idioma](#n-ampliar-la-i18n-añadir-un-idioma)
- [O. Mapa del repositorio y archivos de referencia](#o-mapa-del-repositorio-y-archivos-de-referencia)
- [P. Recetas operativas y de diagnóstico](#p-recetas-operativas-y-de-diagnóstico)

---

## 1. Propósito y arquitectura

OmniSync es un plugin de **Obsidian** (escritorio y móvil) que sincroniza una bóveda entre dispositivos **sin servidor central propio**. Todo el contenido se cifra de extremo a extremo con **AES-256-GCM** antes de salir del dispositivo.

Tres transportes llevan los mismos mensajes cifrados:

| Transporte | Para qué se usa | ¿Requiere ambos dispositivos en línea? |
|---|---|---|
| **WebRTC DataChannel** (P2P) | Escritura en vivo, cursores, manifiestos y archivos de cualquier tamaño | Sí |
| **Buzón Nostr** (relay, kind 30078) | Notas escritas mientras el otro dispositivo está apagado o suspendido | No (el relay las guarda 7 días) |
| **Blossom** (servidores HTTP de blobs) | Archivos grandes y adjuntos, anunciados a través del buzón | No |

Los dispositivos se encuentran mediante un **servidor de señalización**: un relay Nostr público (por defecto) o un **Cloudflare Worker** propio. El Worker es opcional.

Licencia: [PolyForm Noncommercial 1.0.0](../LICENSE) (código disponible, gratis para uso no comercial). Ver [Contribuciones](#16-buenas-prácticas-y-contribuciones).

### Principios clave

| Principio | Descripción |
|---|---|
| **Tiempo real primero** | Cada edición se envía de inmediato; nada espera a una tarea periódica. |
| **Cifrado de extremo a extremo** | Un secreto maestro por bóveda. El contenido y las rutas se cifran (las rutas además se convierten en HMAC) antes de tocar cualquier red. |
| **Transporte desacoplado** | La identidad criptográfica no depende del canal. WebRTC, buzón Nostr, Blossom y Worker son capas intercambiables. |
| **Desconfianza por defecto** | Todo mensaje entrante se valida (tamaño, tipo, ruta, firma, antigüedad, repetición) antes de tocar el disco. Los relays y servidores de blobs no son de confianza. |
| **Preservación de datos** | Una versión local más nueva nunca se sobrescribe; los borrados remotos van a la papelera de Obsidian; las ediciones divergentes se fusionan a 3 vías o se guardan como copia de conflicto. |

---

## 2. Primeros pasos

**Requisitos:** Node.js 22.x (el que usa el CI), npm y Obsidian 1.11.4 o superior (`minAppVersion` en `manifest.json`).

```bash
git clone https://github.com/abismalmx/OmniSync.git
cd OmniSync
npm install
npm run dev        # compilación continua, con source maps en línea
npm run build      # compilación de producción -> main.js (minificado, sin source maps)
```

- El bundle lo genera `esbuild.config.mjs`: entrada `src/main.ts`, salida `main.js`, formato **CommonJS**, objetivo **ES2020**. `obsidian`, `electron`, `@codemirror/*` y los módulos integrados de Node son **externos** (los aporta Obsidian).
- TypeScript es **estricto** (`tsconfig.json`: `strict`, `noImplicitAny`, `strictNullChecks`).
- **Instalar en una bóveda de pruebas:** copia `main.js`, `manifest.json` y `styles.css` a `<bóveda>/.obsidian/plugins/omnisync/` y recarga Obsidian (o usa el plugin Hot Reload).
- **Consola:** `Ctrl+Shift+I` abre las herramientas de desarrollo de Obsidian. Los registros del buzón llevan el prefijo `[OmniSync Mailbox]`.

Antes de abrir un pull request ejecuta:

```bash
npm run typecheck && npm run lint && npm test
```

---

## 3. Estructura del código

```
src/
├─ main.ts                    # Ciclo de vida del plugin, red, orquestación de envío/recepción,
│                             #   colas y reintentos, emparejamiento, carga/guardado de ajustes
├─ types.ts                   # Tipos compartidos: ajustes, manifiestos, cargas del buzón, mensajes
├─ crypto/crypto-manager.ts   # Derivación de claves (PBKDF2), AES-256-GCM, HMAC, hashes
├─ network/
│   ├─ signaling-client.ts    # Señalización por Nostr (kind 25000) o WebSocket del Worker
│   ├─ webrtc-peer.ts         # RTCPeerConnection, DataChannel, apretón de manos HMAC mutuo
│   ├─ nostr-mailbox.ts       # Buzón cifrado asíncrono: publicar/consultar/suscripción en vivo,
│   │                         #   parches delta, adjuntos Blossom, reconexión
│   ├─ blossom-client.ts      # Subida/descarga de blobs (BUD-01/02, NIP-98)
│   ├─ blossom-providers.ts   # Servidores Blossom por defecto y límites de tamaño
│   └─ pairing-channel.ts     # Transporte del emparejamiento efímero (Nostr / Worker)
├─ sync/
│   ├─ vault-watcher.ts       # Eventos de la bóveda -> cambios con debounce (350 ms)
│   ├─ manifest-calc.ts       # Manifiestos y delta (qué subir/bajar/borrar)
│   ├─ file-transfer.ts       # Transferencia de archivos por trozos sobre el DataChannel
│   ├─ delta-patch.ts         # Parches de diff unificado (cálculo/aplicación, límites)
│   ├─ base-snapshot-store.ts # Versiones base cifradas para la fusión a 3 vías
│   └─ diff-merge.ts          # Fusión de texto a 3 vías con presupuesto de CPU
├─ collab/codemirror-collab.ts# Cursores y selecciones remotos (CodeMirror 6)
├─ security/                  # Validadores y políticas puras (sin E/S): ver tabla abajo
├─ ui/                        # Pestaña de ajustes, modal de emparejamiento, asistente Cloudflare, barra de estado
├─ i18n/                      # Traducciones: es, en, zh, ru (+ types.ts con la lista de claves)
└─ templates/                 # Plantillas generadas del Worker de Cloudflare (no editar a mano)
scripts/
├─ cloudflare-allinone/       # Worker todo en uno: señalización + Blossom (R2) + sala de emparejamiento
├─ package-stable.mjs         # Genera el paquete de distribución reproducible
└─ generate-cloudflare-templates.mjs
tests/                        # Suites de pruebas; obsidian-stub.ts reemplaza la API de Obsidian
zip/                          # Paquete de publicación generado (ver sección 15)
```

### `src/security/` de un vistazo

| Archivo | Responsabilidad |
|---|---|
| `vault-security.ts` | `validateVaultPath()`: la única puerta para rutas que se escriben en la bóveda (longitud, segmentos, salto de directorio, nombres reservados). |
| `protocol-security.ts` | Valida mensajes y señales WebRTC; `ReplayGuard` contra repeticiones. |
| `transfer-security.ts` | Límites de transferencias (tamaño, trozos, transferencias simultáneas, entradas de manifiesto). |
| `sync-policy.ts` | **Decisiones puras**: aplicar / omitir / conflicto para escrituras, borrados, renombrados y notas del buzón. |
| `network-security.ts` | Solo URLs `wss://` y `https://`, con comprobación de longitud y caracteres. |
| `settings-security.ts` | Sanea el contenido de `data.json` antes de usarlo. |
| `pairing.ts`, `pairing-session.ts` | Carga del emparejamiento y protocolo ECDH efímero. |
| `worker-auth.ts` | Autenticación NIP-98 para el Worker propio. |
| `mysecret-compat.ts` | Interoperabilidad con bóvedas cifradas por el plugin MySecret. |
| `concurrency-limiter.ts`, `path-operation-queue.ts` | Límites de concurrencia y serialización por ruta. |
| `external-text.ts` | Sanea el texto que llega de relays/servidores antes de mostrarlo. |

---

## 4. Claves, salas e identidad

Hay **un secreto maestro** por bóveda (el secreto de emparejamiento). Todo lo demás se deriva de él, con un contexto distinto para cada uso, de modo que la clave de un uso nunca pueda descifrar otro:

| Valor derivado | Contexto (sal) | Se usa para |
|---|---|---|
| Clave de la bóveda | `OmniSync-Salt-v1` | Mensajes del DataChannel WebRTC |
| Clave de señalización | `SIGNALING_KEY_CONTEXT` | Mensajes de señalización |
| Clave del buzón | `OmniSync-Mailbox-v1` | Cargas del buzón Nostr |
| Clave de Blossom | `BLOSSOM_KEY_CONTEXT` | Cifrado de los blobs |
| Clave de snapshots | `OmniSync-Snapshot-v1` | Versiones base locales |
| Clave de autenticación del Worker | `deriveWorkerAuthKey` | Identidad NIP-98 de tu Worker |

- Claves: **PBKDF2-SHA-256, 100 000 iteraciones**, AES-GCM de 256 bits, no extraíbles. Para cada cifrado se genera un IV aleatorio nuevo de 12 bytes.
- Los ids de sala (`signalingRoomId`, `mailboxRoomId`) se derivan con HMAC, así que el relay nunca ve el secreto real ni un nombre adivinable.
- La clave maestra vive en el `secretStorage` de Obsidian cuando está disponible y **nunca se escribe en `data.json`**.
- La etiqueta `d` de cada evento del buzón es un HMAC opaco de la ruta de la nota (`mailbox-dtag-v2`), así que el relay no puede conocer los nombres de archivo.
- Toda la derivación ocurre en `main.ts` → `deriveDomainKeys()`; los HMAC están en `crypto-manager.ts` (`computeHmacHex`).

---

## 5. Cómo funciona la sincronización

### 5.1 Modos de sincronización

El ajuste **Modo de sincronización** tiene dos valores (se guarda como el booleano `enableNostrMailbox`):

| Modo | Comportamiento |
|---|---|
| **Doble vía** (por defecto) | Cada edición va al buzón del relay **y**, si hay un par conectado, también por P2P. |
| **P2P puro** | No se crea el buzón: no hay consultas periódicas ni tráfico al relay. Ambos dispositivos deben estar en línea a la vez. |

El relay que se usa es `settings.signalingServer`, así que funciona igual con un relay Nostr público, tu propio Worker de Cloudflare o cualquier relay compatible.

### 5.2 Flujo de una edición local

1. `vault-watcher` recibe el evento de Obsidian, lo filtra con las políticas de `security/` y espera **350 ms** (debounce) para que una ráfaga de pulsaciones sea un solo cambio.
2. `main.ts` → `broadcastFileChange` encola el envío en `broadcastChain`, una cadena de promesas que **serializa todos los envíos**, de modo que una versión vieja nunca adelanta a una nueva.
3. `doBroadcastFileChange` ejecuta dos pasos independientes:
   - **P2P:** para cada par autenticado y conectado, `sendFileToPeer` (parche delta o transferencia de archivo). Si todos tienen éxito, se actualiza el snapshot base.
   - **Relay:** si existe el buzón, `publishToMailbox` publica siempre, haya o no pares conectados (un par «conectado» en un móvil suspendido puede no estar realmente vivo).
4. `publishToMailbox` elige la representación según tamaño y tipo:
   - texto ≤ **64 KB** → nota completa (`FULL_NOTE`);
   - texto mayor con snapshot base → parche de diff unificado, dividido en trozos (`DELTA_PATCH`/`DELTA_CHUNK`);
   - texto mayor sin base, o archivos binarios → subida a Blossom y publicación de un puntero (`BLOB_ATTACHMENT`). Si Blossom está desactivado, el usuario recibe un aviso breve indicando que la nota pesa más de 64 KB y que debe activar Blossom.
5. El resultado decide las colas (siguiente apartado).

### 5.3 Colas de entrega y reintentos

Existen dos colas persistidas que **no deben mezclarse**:

| Cola | Se guarda en | Significado |
|---|---|---|
| `pendingMailboxPaths` | `settings.pendingMailboxOut` | Ediciones locales que el **relay** no ha confirmado. Se reintentan hasta entregarse. |
| `pendingP2PPaths` | `settings.pendingP2PSync` | Rutas que deben reconciliarse **con un par** (también las marca el receptor ante «base no coincide» o «el parche falló»). |

Por qué están separadas: el receptor trata una ruta de `pendingP2PPaths` como «modificada localmente» (`applyMailboxNote` → `decideMailboxNote`). Marcar más rutas ahí provoca falsos conflictos; publicar desde esa cola podría subir una versión local vieja al relay.

Reglas de reintento (`schedulePendingRetry`): espera creciente **2 s → 5 s → 15 s → 60 s**; un disparador inmediato (reconexión, vuelve la red, la app pasa a primer plano) cancela la espera y reinicia la cuenta. `flushPendingToMailbox` pasa por `broadcastChain` y tiene una guarda contra reentrada (`pendingFlushRunning`).

### 5.4 Cuándo se vacía lo pendiente

- **App oculta** (`visibilitychange` → hidden): `vaultWatcher.flushPendingEdits()` envía las ediciones que aún están dentro del debounce de 350 ms y después se vacía la cola pendiente.
- **Descarga del plugin:** misma secuencia, esperando como máximo **3 s**, **antes** de destruir el buzón y cerrar el almacén de snapshots.
- **Arranque** (`onLayoutReady`): `queueUnsyncedLocalEdits()` busca archivos modificados desde la última consulta (menos un margen de 2 minutos) cuyo hash difiere del snapshot base y los encola, para que una edición que nunca llegó al relay no se pierda.

### 5.5 Traer cambios hechos mientras este dispositivo estaba apagado

Los sistemas móviles suspenden los WebSockets, así que el buzón también se **consulta**:

- en cada apertura del WebSocket (incluida la primera),
- cada **60 s** (`MAILBOX_POLL_INTERVAL_MS`),
- cuando la app vuelve a ser visible y cuando regresa la red (`online`),
- al arrancar (`pollMailboxOnStartup`).

`NostrMailbox.reconnectNow()` fuerza una conexión nueva. La espera de reconexión solo se reinicia si la conexión duró ≥ 10 s, de modo que un relay que acepta y cierra no puede crear un bucle de consultas.

### 5.6 Avisos de respaldo

Los avisos visibles sobre respaldos pasan por `noticeFallbackOnce`: como máximo **uno cada 10 minutos**, sin importar cuántas ediciones haya. No añadas un `new Notice(...)` directo en una ruta que se ejecute por cada edición.

---

## 6. Recepción de cambios y política de conflictos

Todas las decisiones son **funciones puras** en `src/security/sync-policy.ts`, lo que facilita probarlas:

| Función | Resultado |
|---|---|
| `decideRemoteWrite` | `apply` o `skip_newer_local` (una versión local estrictamente más nueva nunca se sobrescribe). |
| `decideRemoteDelete` | `trash`, `skip_newer_local` o `skip_missing`. Los borrados **siempre** usan la papelera de Obsidian. |
| `decideRemoteRename` | `rename` o un motivo `skip_*`; un destino existente nunca se sobrescribe. |
| `decideMailboxNote` | `apply`, `skip` o `conflict` para una nota llegada por el buzón. |

Reglas de `decideMailboxNote`: sin archivo local → aplicar; remota no más nueva → omitir; contenido idéntico → omitir; local modificado desde la última sincronización → **conflicto**; en otro caso aplicar.

Cómo se maneja una divergencia:
1. `diff-merge.ts` hace una **fusión a 3 vías** a nivel de carácter usando el snapshot base de `base-snapshot-store`. Tiene un presupuesto de CPU (`MAX_MERGE_COMPARISONS`).
2. Si no puede fusionar limpiamente, la versión local se conserva como `<nombre>.conflict-AAAA-MM-DD-HHMM.<ext>` y se escribe la remota.
3. Los borrados remotos se registran como **lápidas** (`settings.deletedPaths`) para que un manifiesto viejo no resucite un archivo borrado; las lápidas se podan con el tiempo.

Toda escritura entrante pasa por: `validateVaultPath` → límites de tamaño/tipo → checksum (SHA-256) → decisión → escritura con el `mtime` remoto. Al watcher se le indica que ignore el eco de esa escritura (`ignoreNextChange` con el hash esperado), pero **una edición real del usuario dentro de esa ventana sí se sincroniza**.

---

## 7. Transportes en detalle

> **OmniSync no es un backup.** Todos los transportes son buzones de tránsito: los avisos del buzón caducan en 7 días, los blobs de R2 en 10 y los blobs de Blossom público en ≈7 días según el servidor. Si un dispositivo no se conecta durante ese período y no hay sesión P2P directa, los cambios no llegan. Cada dispositivo es el único responsable de conservar su propia bóveda. Documéntalo en la UI y en las guías cuando el comportamiento del usuario dependa de que algo "esté guardado para siempre".

### 7.1 WebRTC (P2P)

- Los mensajes de señalización se cifran y se intercambian por el servidor de señalización; ICE usa servidores STUN públicos (Google por defecto).
- Al abrirse el canal, ambos lados hacen un **desafío HMAC mutuo** (`AUTH_CHALLENGE`, `AUTH_RESPONSE`, `AUTH_COMPLETE`). Un par cuenta como conectado solo cuando `isAuthenticated && isConnected`.
- Tipos de mensaje (`MessageType` en `types.ts`): `AUTH_*`, `MANIFEST_EXCHANGE`, `FILE_HEADER`, `FILE_CHUNK`, `FILE_COMPLETE`, `FILE_DELETE`, `FILE_RENAME`, `PRESENCE_CURSOR`, `LIVE_TEXT_DELTA`, `PING`, `PONG`.
- Al conectar, los pares intercambian **manifiestos** (`ManifestCalculator.computeDelta`) para calcular `toUpload`, `toDownload`, `conflicts`, `toDelete`.
- Los archivos se dividen en trozos (16–64 KB, 32 KB por defecto), con control de contrapresión (`DEFAULT_HIGH_WATER_MARK`), comprobaciones de integridad SHA-256 y límites (archivo máximo 128 MB, máximo 2 transferencias entrantes simultáneas, TTL de 5 minutos por transferencia).

### 7.2 Buzón Nostr

- Evento **kind 30078** (NIP-78, reemplazable parametrizado), con **expiración NIP-40 de 7 días**. Reemplazable significa que el relay conserva un evento por etiqueta `d`, así que solo se almacena la última versión de una nota.
- El contenido es el JSON `NostrMailboxNotePayload` cifrado con AES-GCM (`type`, `path`, `content`, `mtime`, `deviceId`, `sentAt`, hashes para deltas…). `sentAt` va ligado a `created_at`, de modo que un relay no puede volver a firmar un evento viejo como si fuera nuevo.
- Validación de cada evento: kind, id, pubkey, firma (`verifyEvent`), antigüedad (≤ 8 días), número y tamaño de etiquetas, descifrado AEAD, `validateVaultPath` y la etiqueta `d` recalculada desde la ruta.

| Límite | Valor |
|---|---|
| Nota completa (`MAX_MAILBOX_NOTE_SIZE`) | 64 KB |
| Contenido de un evento | 256 KB |
| Trozo delta / trozos por parche | 48 KB / 16 |
| Eventos por consulta | 500 |
| Extensiones elegibles | `md, markdown, txt, canvas, json, css` |
| Operaciones Blossom simultáneas | 1 en curso, 4 en cola |

### 7.3 Blossom

- Los servidores salen de `settings.blossomServers` (valores por defecto en `blossom-providers.ts`); puedes añadir los tuyos o un Cloudflare Worker con R2.
- La subida es `PUT /upload` con autorización **NIP-98** ligada a URL, método y hash del cuerpo. Las descargas se verifican recalculando el SHA-256.
- Requiere `enableBlossomSync` y un tamaño dentro del máximo configurado (`maxBlobSizePreset` / `customMaxBlobSizeMb`, de 1 MB a 1 GB; los servidores públicos suelen tener topes menores).
- El blob se cifra antes de subirse, así que los servidores solo ven bytes opacos.
- **Los ajustes son por dispositivo.** El dispositivo que recibe descarga solo de los servidores de **su propia** lista `blossomServers`; un servidor citado en el puntero del buzón que no esté en esa lista se ignora. Un segundo dispositivo necesita, por tanto, el mismo servidor Blossom configurado (y `enableBlossomSync` activado), o no encontrará el archivo.
- **Identidad estable solo para los Workers propios del usuario.** Las subidas se firman con la clave estable del Worker solo cuando el host del servidor está en `privateWorkerHosts`; cualquier otro servidor ve una clave efímera. Un Worker de solo Blossom debe registrarse, por tanto, como propio (el asistente lo hace), o su lista `ALLOWED_PUBKEYS` rechaza la subida.
- Plazos: subidas 45 s, descargas 30 s (`BlossomClient`). Verificado en vivo hasta 95 MB con una conexión rápida; un enlace móvil lento puede superarlos.
- **Retención.** Los eventos del buzón caducan a los 7 días (el Worker borra los caducados cada vez que se guarda o se consulta uno; verificado en vivo con vidas de 10 s y 60 s). Los blobs de R2 no caducan por sí solos, así que el comando de despliegue añade una regla de ciclo de vida de R2, `expire-blobs`, que borra los objetos a los 10 días: el puntero que referencia un blob dura 7 días, y un blob nunca se reutiliza entre recifrados porque cada cifrado usa un IV aleatorio. Para un cubo existente: `npx wrangler r2 bucket lifecycle add omnisync-blossom expire-blobs --expire-days 10 -y`, o R2 → cubo → Settings → Object lifecycle rules en el panel (así también se hace en el Worker de solo Blossom). **Pendiente de comprobar:** la regla está creada y Cloudflare la acepta, pero el borrado real de los archivos de R2 a los 10 días aún no se ha observado en vivo (Cloudflare lo ejecuta en segundo plano, normalmente en las 24 h posteriores a vencer, y su mínimo es 1 día).
- El tope del Worker todo-en-uno es de 100 MB por blob (`MAX_UPLOAD_SIZE_BYTES`); las subidas mayores reciben HTTP 413 y el plugin falla limpiamente.

### 7.4 Cloudflare Worker (opcional)

Hay dos plantillas de Worker, ambas generadas desde `scripts/` en `src/templates/cloudflare-worker-template.ts` (no edites ese archivo a mano):

| Plantilla | Contiene | ¿Necesita terminal? | ¿Buzón? |
|---|---|---|---|
| **Todo-en-uno** (`scripts/cloudflare-allinone/worker.js`) | Señalización, Blossom (R2), sala de emparejamiento, **buzón asíncrono** | Sí (`wrangler`) | Sí |
| **Solo Blossom** (`scripts/cloudflare-blossom-worker.js`) | Solo Blossom (R2) | No (se pega en el panel web) | **No**, a propósito; las notas usan el relay Nostr público |

El Worker todo-en-uno necesita tres enlaces y dos migraciones, declarados en `scripts/cloudflare-allinone/wrangler.jsonc` y en la plantilla que escribe el asistente:

| Enlace | Tipo | Se usa para |
|---|---|---|
| `SIGNALING_ROOM` | Durable Object `SignalingRoom` (migración `v1`) | Salas de señalización y emparejamiento |
| `MAILBOX_ROOM` | Durable Object `MailboxRoom` (migración `v2`, SQLite) | El buzón asíncrono: un relay estilo Nostr por sala |
| `MY_BUCKET` | Cubo R2 | Blobs de Blossom |
| `ALLOWED_PUBKEYS` | Variable de texto | Lista de claves públicas permitidas; sin ninguna el Worker rechaza todo (falla cerrado) |

Cómo se comporta:
- **Autorización:** cada WebSocket (`?room=`, `?mailbox=`, `?pair=`) y cada subida exige un evento NIP-98; la lista de permitidos se comprueba antes de cualquier trabajo con firmas. Las descargas (`GET /<sha256>`) son públicas pero solo sirven texto cifrado.
- **Página de estado** (`GET /`): JSON público con `services.{blossom,signaling,mailbox,auth}.status`. Los valores son `ready` o `missing_r2_binding`, `missing_do_binding`, `missing_allowed_pubkeys`. El plugin la lee para avisar de un Worker sin buzón, y el asistente la muestra en su tarjeta de estado.
- **Reglas del buzón:** solo kind 30078, un evento por `(pubkey, d)`, `expiration` obligatoria (≤ 7 días), `created_at` dentro de rango, exactamente una etiqueta `t` igual a la sala, firma verificada, límites de trama y de tamaño de sala, límite de ritmo por socket.
- **Encabezados de endurecimiento:** las respuestas JSON (estado y errores) envían `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`; los blobs se sirven como `application/octet-stream` con `nosniff`, una CSP de sandbox y `Content-Disposition: attachment`. El CORS es `*` a propósito: lo que protege las escrituras es la autorización, no el origen.
- La memoria **anti-repetición** es por instancia (mejor esfuerzo); las subidas se direccionan por contenido y son idempotentes, así que un evento repetido no tiene efecto.
- **`MAILBOX_DEBUG=1`** (variable de texto) hace que el buzón registre lo que el servidor recibe de cada evento guardado (id, clave pública, kind, etiquetas, tamaño, primeros 96 caracteres del texto cifrado). Úsala solo en un Worker desechable para verificar la ofuscación, y nunca la dejes activada en uno real.

**Desplegar y actualizar.** El asistente escribe los archivos (`package.json`, `wrangler.jsonc`, `worker.js`), ejecuta `npm install`, crea el cubo R2 y ejecuta `npx wrangler deploy`. Un Worker desplegado con una plantilla anterior **debe redesplegarse** para tener el buzón o el endurecimiento posterior. Volver a desplegar mantiene la misma URL; las variables definidas solo en el panel se reemplazan por las de `wrangler.jsonc`, salvo que pases `--keep-vars`.

---

## 8. Emparejamiento efímero

Archivos: `src/security/pairing-session.ts` (protocolo), `src/network/pairing-channel.ts` (transporte), `src/security/pairing.ts` (carga) y la rama `?pair=` en `scripts/cloudflare-allinone/worker.js`.

- QR = enlace `obsidian://omnisync-pair?data=<b64>` (`registerObsidianProtocolHandler` → `handlePairingLink`, **siempre pidiendo confirmación al usuario**). El código copiable `omnisync://pair2?data=` lleva la misma carga `{v:2, token, transport, server}`. Token: 128 bits, **TTL de 2 minutos**, un solo uso; el modal genera uno nuevo al expirar. La clave maestra nunca va en el QR.
- Sala = HMAC(token, "room"). Mensajes: `hello → offer → done`. ECDH P-256 efímero autenticado con un MAC con clave derivada del token; HKDF-SHA256 (sal = token, info que liga ambas claves públicas) → AES-256-GCM con AAD (tipo, sala, claves públicas). La carga sensible (clave maestra, sala, servidor) viaja solo dentro de `offer`.
- Un solo uso: `PairingHostSession` quema el token tras el primer `hello` válido; una bandera `busy` evita condiciones de carrera.
- Canal `nostr`: eventos kind 25000 etiquetados con `t`=sala, con firma, marca de tiempo y tamaño validados estrictamente. Canal `worker`: el anfitrión abre `/?pair=<sala>&auth=<NIP-98>`; el invitado entra sin autenticación solo si el anfitrión está presente (404/409 en caso contrario); Durable Object acotado a `pair:<sala>`, máximo 4 sockets, tramas de 16 KB.
- `pairNewDevice` pide confirmación si el servidor de señalización entrante difiere del activo y muestra el host de destino.

---

## 9. Ajustes y datos persistidos

Obsidian guarda los ajustes en `data.json`. Como ese archivo puede editarlo cualquier cosa con acceso al disco, es **entrada no confiable**: `loadSettings()` lo sanea (`sanitizeBooleanSettings`, `sanitizeBlossomSettings`, `sanitizeLanguageSettings`, `sanitizeTombstones` y `settings-security.ts`).

Campos principales (`PluginSettings` en `types.ts`):

| Campo | Propósito |
|---|---|
| `deviceId`, `deviceName`, `devicePlatform` | Identidad de este dispositivo. |
| `pairingSecret` / `masterKeySecretId` | Clave maestra en memoria; se persiste en `secretStorage`, no en `data.json`. |
| `roomId`, `signalingServer` | Sala y URL del relay/Worker (solo `wss://`). |
| `autoSync`, `syncAttachments`, `syncObsidianConfig` | Qué se vigila y se sincroniza. |
| `tidyAttachments` | Si `true` (por defecto), el plugin configura «Adjuntos» como carpeta de adjuntos y la oculta del explorador de archivos con un `<style>` propio (`applyAttachmentTidy`). Solo actúa si Obsidian expone `getConfig/setConfig`. El CSS es constante —sin datos externos— para evitar inyección. |
| `enableNostrMailbox` | Modo de sincronización: `true` = doble vía, `false` = P2P puro. |
| `enableBlossomSync`, `blossomServers`, `maxBlobSizePreset`, `customMaxBlobSizeMb` | Almacenamiento de archivos grandes. |
| `privateWorkerHosts` | Hosts que reciben autenticación NIP-98 para tu propio Worker. |
| `pairedDevices` | Lista de dispositivos emparejados. |
| `lastSyncTimestamp`, `lastMailboxFetchTimestamp` | Cursores de sincronización. |
| `pendingP2PSync`, `pendingMailboxOut` | Las dos colas persistidas (apartado 5.3). |
| `deletedPaths` | Lápidas. |

Reglas para cambiar el esquema:
- Añade el campo como **opcional**, con valor por defecto en `DEFAULT_SETTINGS`, y sanéalo al cargar. Nunca supongas su tipo.
- Mantén la compatibilidad hacia atrás: los usuarios actualizan sobre la marcha y conservan su `data.json` antiguo.
- Nunca guardes claves ni secretos ahí (invariante I6).
- Ejecuta `npm run test:security` después.

---

## 10. Reglas de seguridad (invariantes)

Deben cumplirse en todo cambio. Cada una tiene una prueba; romper una bloquea la publicación.

| # | Regla |
|---|---|
| I1 | Nada se escribe en la bóveda sin pasar por `validateVaultPath()` y la política de adjuntos. |
| I2 | Nada se escribe sin verificar la integridad (SHA-256 del archivo y de cada trozo). |
| I3 | Una versión local más nueva nunca se sobrescribe (`sync-policy.ts`). |
| I4 | Un borrado remoto va a la papelera (`vault.trash`), nunca destruye. |
| I5 | Todo mensaje se valida antes de tocar el navegador o el disco. |
| I6 | La clave maestra vive solo en `secretStorage`, nunca en `data.json`. |
| I7 | Un relay no puede deducir la ruta de un archivo: la etiqueta `d` es un HMAC opaco (64 hex) y no contiene el id de sala ni un prefijo de la aplicación. |
| I8 | El paquete publicado (`zip/OmnySync_stable/`) es idéntico byte a byte a un build nuevo de `src/main.ts` (`npm run test:distribution`). |

Modelo de amenazas en una línea: **los relays, los servidores de blobs y la red no son de confianza**; los dispositivos emparejados comparten el secreto y sí lo son. Consulta [`SECURITY_ES.md`](../SECURITY_ES.md) y [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md) para la política y el historial de auditorías.

El diseño se ha verificado por capas y los resultados son públicos: auditorías dirigidas, una línea base con herramientas automáticas, comprobaciones de extremo a extremo en Workers reales de Cloudflare (incluida la inspección de lo que recibe el servidor para confirmar que los datos van cifrados y ofuscados) y DAST en contenedores. Consulta las secciones 2.6 y 2.7 de [`TESTS_AND_AUDITS.md`](TESTS_AND_AUDITS.md) para el método y los límites de esa verificación.

---

## 11. Pruebas

Las pruebas corren en Node, no dentro de Obsidian. Cada suite es un archivo TypeScript en `tests/` que `esbuild` empaqueta con la API de Obsidian sustituida por `tests/obsidian-stub.ts` (mira cualquier script `test:*` de `package.json`).

```bash
npm test                  # todas las suites
npm run test:nostr        # una suite
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint (los errores rompen el CI; los avisos no)
```

| Suite | Qué cubre |
|---|---|
| `test:security`, `test:realtime-security` | Validadores, primitivas criptográficas, reglas del canal WebRTC. |
| `test:nostr`, `test:nostr-delta` | Cifrado del buzón, validación de eventos, parches delta. |
| `test:delta`, `test:base` | Motor de parches, almacén de snapshots base. |
| `test:blossom` | Subida/descarga, NIP-98, validación de hashes. |
| `test:mysecret` | Interoperabilidad con MySecret. |
| `test:pairing`, `test:pairing-channel` | Protocolo y canales de emparejamiento. |
| `test:cloudflare-*` | Worker: autenticación, salas, buzón. |
| `test:i18n` | Todas las claves presentes en los cuatro idiomas. |
| `test:core` | Integración del núcleo. |
| `test:bughunt`, `test:auditor` | Regresiones de bugs y hallazgos de auditoría corregidos. |
| `test:dual-path` | Relay + P2P: cola de reenvío, serialización, espera de reconexión, envío al cerrar, reconciliación al arrancar. |
| `test:distribution` | El paquete publicado es igual al build actual. |

**Consejos**
- `test:i18n` puede fallar con una configuración regional que no sea inglés: ejecútalo con `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.
- `test:distribution` necesita un paquete al día: ejecuta antes `npm run package:stable`.
- Para probar la lógica del plugin sin Obsidian, crea el plugin con `Object.create(OmniSyncPlugin.prototype)` y asigna solo los campos que el método necesita (bóveda, ajustes, un buzón simulado). `tests/test-dual-path-regression.ts` muestra el patrón, incluido un WebSocket falso para la reconexión y una bóveda falsa.
- Cada corrección de bug y cada validación nueva se entrega con una **prueba de regresión con entrada hostil**. Conviene comprobar que la prueba falla con el comportamiento antiguo (revierte la corrección y verifica que se pone en rojo).
- **Prueba en vivo contra un Worker real** (manual, no forma parte de `npm test`): `tests/live-worker-e2e.ts` usa el código del propio plugin con dos dispositivos simulados. `MODE=pubkey node …` imprime un secreto y la clave pública para el `ALLOWED_PUBKEYS` de un Worker desechable; `MODE=run SECRET=… WORKER=wss://host/ node …` publica desde el dispositivo A, consulta desde el B y comprueba la entrega en vivo, el reemplazo de versiones, los borrados y un adjunto Blossom. `MODE=blob` prueba adjuntos de 1 a 101 MB (descarga, descifrado y comparación byte a byte; el límite del Worker es 100 MB) y `MODE=blossom-only` prueba el Worker de solo Blossom. Para auditar lo que ve el servidor, despliega el Worker desechable con `MAILBOX_DEBUG=1` y ejecuta `wrangler tail`: cada evento guardado debe mostrar solo una etiqueta `d` de 64 hex, una `t` de 64 hex y contenido cifrado. `tests/live-worker-fuzz.ts` es un fuzzer DAST propio de la autorización NIP-98 y del WebSocket del buzón (tramas hostiles, eventos falsificados/caducados, ráfagas); ejecútalo contra un Worker desechable, idealmente dentro de un contenedor `podman` con límites de CPU y memoria. `tests/live-worker-auth.ts` comprueba, sin conocer el secreto, que un Worker real rechaza cualquier clave no autorizada. Despliega un Worker desechable para estas pruebas y bórralo (con su cubo R2) al terminar; nunca dejes `MAILBOX_DEBUG` activado en un Worker real.
- Lo que las pruebas **no** cubren: un Obsidian real, relays reales ni teléfonos reales. Comprueba a mano la suspensión/reanudación en móvil y los escenarios con el relay caído antes de publicar.

---

## 12. Recetas: cambios habituales

### Añadir un ajuste
1. Añade el campo (opcional) a `PluginSettings` en `types.ts` y un valor por defecto en `DEFAULT_SETTINGS`.
2. Sanéalo en `loadSettings()` (o en `settings-security.ts`).
3. Añade el control en `src/ui/settings-tab.ts`; llama a `saveSettings()` y, si la red depende de él, a `reconnectNetwork()`.
4. Añade los textos a `src/i18n/types.ts` y a los **cuatro** idiomas.
5. Añade una prueba en `test:security` o en una suite de regresión.

### Añadir un texto visible
Añade la clave a `src/i18n/types.ts` y a `es.ts`, `en.ts`, `zh.ts`, `ru.ts`; úsala con `t('grupo.clave', { vars })`. `test:i18n` falla si falta un idioma.

### Añadir un tipo de mensaje (WebRTC)
Añádelo a `MessageType`, amplía los validadores de `protocol-security.ts` (rechaza formas desconocidas), trátalo en `handleIncomingProtocolMessage` y añade pruebas con entradas hostiles.

### Añadir un transporte o backend
Debe (1) vivir en `src/network/`, (2) validar cada mensaje entrante mediante `src/security/` (nunca confíes en el canal), (3) incluir pruebas que rechacen entradas maliciosas y (4) exponer sus ajustes en `settings-tab.ts` con las cuatro traducciones.

### Cambiar el Worker
1. Edita `scripts/cloudflare-allinone/worker.js` (o el script de solo Blossom).
2. Ejecuta `npm run build:templates` (regenera `src/templates/cloudflare-worker-template.ts`); `test:cloudflare-allinone` falla si la copia embebida no está sincronizada.
3. Corre `test:cloudflare-worker`, `test:cloudflare-allinone` y `test:cloudflare-mailbox`.
4. Verifica en un Worker real: despliega uno **desechable** y ejecuta las comprobaciones en vivo (sección 11): `live-worker-e2e.ts`, `live-worker-auth.ts` y `live-worker-fuzz.ts`. Borra después el Worker y su cubo R2.
5. Anota en el CHANGELOG que los Workers existentes deben redesplegarse si el cambio les afecta.

---

## 13. Depuración

- **Una nota no llega:** revisa, en orden, el modo de sincronización (P2P puro nunca usa el relay), `settings.signalingServer`, la barra de estado y la consola en busca de mensajes `[OmniSync Mailbox]`. Una ruta atascada en `pendingMailboxOut` significa que el relay no la confirmó.
- **Funciona con un relay Nostr público pero no con tu Cloudflare Worker:** abre `https://<tu-worker>/` y mira `services.mailbox.status`. `missing_do_binding` significa que el Worker se desplegó sin el Durable Object `MAILBOX_ROOM` (plantilla antigua); redespliégalo con la actual (`wrangler.jsonc` declara ambos bindings y migraciones). El plugin avisa de esto al arrancar.
- **Un Cloudflare Worker rechaza tu dispositivo:** la clave de `ALLOWED_PUBKEYS` debe ser igual a `workerAuthPublicKeyHex` (el asistente la muestra). La página de estado indica `auth: missing_allowed_pubkeys` cuando la variable está vacía.
- **Faltan adjuntos en un dispositivo:** ese dispositivo no tiene un servidor Blossom configurado, o Blossom está desactivado ahí (los ajustes son por dispositivo), o el archivo supera su límite de tamaño.
- **Comprobar lo que ve un servidor:** despliega un Worker desechable con `MAILBOX_DEBUG=1` y ejecuta `wrangler tail`; los eventos guardados deben mostrar solo etiquetas `d` y `t` de 64 hex y texto cifrado.
- **Dispositivos con versiones distintas se ignoran el buzón:** el dominio de la etiqueta `d` cambió una vez (`mailbox-path-v1` → `mailbox-dtag-v2`). Actualiza ambos dispositivos.
- **Falsos conflictos:** mira `pendingP2PPaths`; entradas de más hacen que una nota parezca «modificada localmente».
- **El teléfono deja de recibir en segundo plano:** es lo esperado (el sistema suspende los sockets). Consulta al reanudar, con `online` y cada 60 s mientras está activo.
- **Una nota grande no sincroniza:** más de 64 KB sin Blossom y sin snapshot base solo viaja por P2P; activa Blossom.
- **Bóvedas MySecret:** mientras la bóveda está bloqueada no se lee ni se publica nada (falla cerrado).

---

## 14. CI y dependencias

`.github/workflows/ci.yml` corre en cada push y pull request (Node 22.x): `npm ci` → typecheck → lint → build → `npm test` → `npm run package:stable`, más un trabajo de CodeQL.

- Las acciones de terceros están **fijadas por SHA de commit**, con la versión en un comentario al final (`# v4`). Para actualizar una, resuelve la etiqueta nueva a su commit (`git ls-remote https://github.com/<propietario>/<repo>.git refs/tags/<etiqueta>`) y reemplaza el SHA; Dependabot puede abrir estas actualizaciones.
- `.github/dependabot.yml` revisa npm y GitHub Actions cada semana, agrupa las actualizaciones y usa un **cooldown de 7 días**, para que una versión recién publicada (posiblemente maliciosa) no se proponga de inmediato.
- `npm run audit` ejecuta typecheck, lint y los escaneos de dependencias/secretos/estático (`audit:deps` osv-scanner, `audit:secrets` gitleaks, `audit:static` semgrep) si esas herramientas están instaladas.

---

## 15. Versiones y publicación

Sigue el **versionado semántico** (`MAYOR.MENOR.PARCHE`).

1. Sube la versión en `manifest.json`, `package.json` y `package-lock.json` (deben coincidir).
2. Añade una entrada a `CHANGELOG.md`.
3. `npm run typecheck && npm run lint && npm test`.
4. `npm run package:stable`: compila y escribe `zip/OmnySync_stable/` (`main.js`, `manifest.json`, `styles.css`) y `zip/OmnySync_stable.zip`. Haz commit del resultado para que `test:distribution` pase.
5. Crea una Release en GitHub cuyo **tag sea igual a la versión, sin `v`** (p. ej. `1.0.1`), y adjunta `main.js`, `manifest.json` y `styles.css`. Obsidian y BRAT instalan desde esos archivos.

---

## 16. Buenas prácticas y contribuciones

- Valida **toda** entrada no confiable: rutas, tamaños, tipos de carga, firmas, marcas de tiempo. Añade una prueba de regresión con entrada hostil por cada comprobación nueva.
- Nada de `Math.random` ni criptografía casera para secretos: usa `crypto-manager` y `crypto.subtle` nativo.
- Todo texto de la interfaz pasa por i18n (`es`, `en`, `zh`, `ru`) y debe pasar `test:i18n`.
- Acota la concurrencia y la CPU en todo lo que alimente la red (`concurrency-limiter`, presupuesto de fusión).
- Nunca mezcles las dos colas, nunca publiques desde `pendingP2PPaths` y nunca saltes `broadcastChain` para enviar.
- Actualiza la documentación cuando cambies la arquitectura: esta guía y [`TESTS_AND_AUDITS.md`](TESTS_AND_AUDITS.md).
- El proyecto se publica bajo PolyForm Noncommercial 1.0.0. Al contribuir aceptas que tu aporte se distribuya con la misma licencia; abre un issue antes de cambios grandes.
- Para reportar una vulnerabilidad, sigue [`SECURITY_ES.md`](../SECURITY_ES.md) en lugar de abrir un issue público.

---

# Apéndice: Referencia extendida

> Las secciones siguientes amplían la guía anterior con diagramas, análisis a fondo y material de referencia. Todos los valores numéricos y nombres de símbolos citados aquí están verificados contra el código fuente (`src/`, `scripts/`, `tests/`); cuando un valor depende de una constante, se indica su nombre para que puedas localizarlo con `grep`.

## A. Panorama de la arquitectura

### A.1 Ruta de escritura local

```text
+-------------------+
| Edición local     |
+---------+---------+
          |
          v
+---------+------------------+
| VaultWatcher             |
| debounce de 350 ms      |
+---------+------------------+
          |
          v
+---------+------------------+
| broadcastChain           |
| cola de promesas        |
| serializada             |
+---------+--------+---------+
          |        |        |
          |        |        +----------------------+
          |        |                               |
          |        |                               v
          |        |                 +-------------+--------------+
          |        |                 | BlossomClient.upload       |
          |        |                 | PUT /upload (NIP-98)      |
          |        |                 +-------------+--------------+
          |        |                               |
          |        |                               v
          |        |                         +-----+--------+
          |        |                         | Servidor     |
          |        |                         | Blossom      |
          |        |                         +-----+--------+
          |        |
          |        +-------------------------------+
          |                                        |
          v                                        v
+---------+------------------+       +-------------+--------------+
| sendFileToPeer           |       | publishToMailbox          |
+-------------+--------------+       +-------------+--------------+
              |                                    |
              v                                    v
   +----------+-----------+          +-------------+--------------+
   | Delta o archivo      |          | FULL_NOTE                 |
   | completo            |          | DELTA_PATCH               |
   +----------+-----------+          | BLOB_ATTACHMENT           |
              |                      +-------------+--------------+
              |                                    |
              v                                    v
   +----------+-----------+          +-------------+--------------+
   | WebRTC DataChannel   |          | Relay Nostr               |
   | peer autenticado     |          | kind 30078                |
   +----------+-----------+          +-------------+--------------+
              |                                    |
              +----------------+-------------------+
                               |
                               v
                         +-----+--------+
                         | Peer remoto |
                         +-------------+
```

### A.2 Ruta de recepción

```text
+---------------------------+       +---------------------------+
| Relay Nostr              |       | Servidor Blossom          |
| WebSocket / sondeo       |       | descarga de adjuntos      |
+-------------+-------------+       +-------------+--------------+
              |                                   |
              |             +---------------------+
              |             |
              +------------>|
                           v
                  +--------+---------+
                  | decryptPayload   |
                  +--------+---------+
                           |
                           v
                  +--------+---------+
                  | validateVaultPath |
                  +--------+---------+
                           |
                           v
                  +--------+---------+
                  | sync-policy.ts   |
                  | decisión         |
                  +--------+---------+
                           |
                           v
                  +------------------+
                  | Escritura en la  |
                  | bóveda           |
                  +------------------+
```

### A.3 Quién hace qué (tabla de responsabilidades)

| Capa | Archivo(s) | Responsabilidad | No debe hacer |
|---|---|---|---|
| Observación | `src/sync/vault-watcher.ts` | Escuchar eventos del FS, agrupar con debounce, evitar ecos | Decidir nada criptográfico |
| Orquestación | `src/main.ts` | Ciclo de vida, colas, reintentos, emparejamiento, ajustes | Cifrar o descifrar directamente |
| Criptografía | `src/crypto/crypto-manager.ts` | Derivación de claves, AES-GCM, HMAC, SHA-256 | Tocar la red o el disco |
| Red P2P | `src/network/webrtc-peer.ts` | `RTCPeerConnection`, DataChannel, apretón de manos HMAC | Confiar en el canal sin validar el mensaje |
| Red asíncrona | `src/network/nostr-mailbox.ts` | Publicar/consultar buzón, parches delta, adjuntos Blossom | Confiar en el relay |
| Objetos grandes | `src/network/blossom-client.ts` | Subida/descarga de blobs (BUD-01/02, NIP-98) | Guardar la clave en disco |
| Validación | `src/security/*.ts` | Validación pura y sin efectos | Hacer E/S (no leen disco ni red) |
| Política | `src/security/sync-policy.ts` | Decisiones puras aplicar/omitir/conflicto | Escribir en la bóveda |
| UI | `src/ui/*.ts` | Ajustes, modales, barra de estado | Acceder a la red directamente |

> **Regla de oro de la arquitectura:** `src/security/` contiene funciones **puras**. Si una función de `src/security/` leyera el disco, usara la red o dependiera de `Date.now()` de forma no controlable, sería más difícil de probar y rompería la separación que hace que el proyecto sea auditable.

## B. Máquina de estados de `SyncState`

El tipo `SyncState` (`src/types.ts`) define seis estados. La máquina completa, tal como la implementa `main.ts`:

```text
SyncState = disconnected | signaling | connecting | connected | syncing | error


[disconnected] -- signalingClient.connect() ---------------------> [signaling]

[signaling]    -- AUTH_COMPLETE recibido; comienza ICE ---------> [connecting]

[connecting]   -- ICE conectado ----------------------------------> [connected]

[connected]    -- arranca la sincronización; manifiesto/archivos -> [syncing]

[syncing]      -- sincronización completa; FILE_COMPLETE --------> [connected]


[signaling]    -- error de red/señalización/autenticación -------> [error]

[connecting]   -- error de ICE/red/DataChannel -------------------> [error]

[connected]    -- error de red/WebRTC ----------------------------> [error]

[syncing]      -- error de red/transferencia de archivo ----------> [error]


[error]        -- retry/reconnect llama a connect() --------------> [signaling]


[signaling]    -- disconnect() o cierre limpio -------------------> [disconnected]

[connecting]   -- disconnect() o cierre limpio -------------------> [disconnected]

[connected]    -- disconnect() -----------------------------------> [disconnected]

[syncing]      -- disconnect()/abort -----------------------------> [disconnected]

[error]        -- disconnect()/shutdown --------------------------> [disconnected]
```

### B.1 Reglas de la máquina

| Regla | Detalle |
|---|---|
| Un peer cuenta como **conectado** solo con `isAuthenticated && isConnected` | Un DataChannel abierto sin `AUTH_COMPLETE` no sirve para enviar datos de archivo. |
| `connected` ≠ `syncing` | `connected` es el estado estable; `syncing` es transitorio durante un intercambio de manifiesto o una transferencia. |
| El error es **recuperable** | Desde `error` siempre se reintenta con `connect()`; no hay un estado terminal de fallo. |
| `disconnect()` siempre es seguro | Se puede llamar desde cualquier estado y siempre lleva a `disconnected`. |

## C. Secuencia de mensajes WebRTC

```text
Dispositivo A                  Señalización / Auth                  Dispositivo B
    |                                   |                                |
    |---- connect() ------------------>|                                |
    |<--- AUTH_CHALLENGE --------------|                                |
    |---- AUTH_RESPONSE -------------->|                                |
    |<--- AUTH_COMPLETE --------------|                                |
    |                                   |<--------- connect() ----------|
    |                                   |-------- AUTH_CHALLENGE ------>|
    |                                   |<------- AUTH_RESPONSE --------|
    |                                   |-------- AUTH_COMPLETE ------->|
    |                                   |                                |
    |---- oferta SDP + ICE ----------->|------------------------------>|
    |<--- respuesta SDP + ICE --------|------------------------------>|
    |                                   |                                |
    |======= DataChannel abierto (autenticado) ======================|

    |---- MANIFEST_EXCHANGE ---------->|  (manifiestos de ambas partes)|
    |<--- MANIFEST_EXCHANGE -----------|                                |
    |                                    |                              |
    |---- FILE_HEADER ---------------->|  (ruta, tamaño, hash, trozos) |
    |---- FILE_CHUNK (xN) ----------->|  (Base64, con checksum)       |
    |---- FILE_COMPLETE ------------->|  (cierre y verificación)      |
    |<--- FILE_HEADER -----------------|                                |
    |<--- FILE_CHUNK (xN) -----------|                                |
    |<--- FILE_COMPLETE -------------|                                |
    |                                    |                              |
    |---- FILE_DELETE ---------------->|  (borrado remoto)            |
    |---- FILE_RENAME ---------------->|  (renombrado remoto)         |
    |---- PRESENCE_CURSOR ------------>|  (cursor remoto, opcional)   |
    |---- LIVE_TEXT_DELTA ------------>|  (edición en vivo, opcional)  |
    |                                    |                              |
    |<--- PING -----------------------|                                |
    |---- PONG ----------------------->|                                |
```

### C.1 Tipos de mensaje

Definidos en `MessageType` (`src/types.ts`):

| Tipo | Dirección | Contenido |
|---|---|---|
| `AUTH_CHALLENGE` | → | Desafío aleatorio para autenticar al par |
| `AUTH_RESPONSE` | → | HMAC del desafío con la clave compartida |
| `AUTH_COMPLETE` | → | Confirmación de que la autenticación mutua terminó |
| `MANIFEST_EXCHANGE` | ↔ | Manifiesto de archivos con `mtime`, `size` y `hash` |
| `FILE_HEADER` | → | Cabecera de una transferencia (ruta, tamaño, trozos, hash) |
| `FILE_CHUNK` | → | Fragmento de archivo en Base64 |
| `FILE_COMPLETE` | → | Cierre de la transferencia y verificación de integridad |
| `FILE_DELETE` | → | Borrado remoto (se aplica a la papelera) |
| `FILE_RENAME` | → | Renombrado remoto |
| `PRESENCE_CURSOR` | ↔ | Posición del cursor y selección del par |
| `LIVE_TEXT_DELTA` | ↔ | Fragmento de edición en vivo (CodeMirror) |
| `PING` / `PONG` | ↔ | Keepalive y comprobación de latencia |

> Añadir un tipo nuevo exige ampliar **las tres** capas: el union `MessageType`, los validadores de `src/security/protocol-security.ts` (que rechazan formas desconocidas) y el manejador `handleIncomingProtocolMessage` en `main.ts`. Olvidar el validador es un fallo de seguridad, no una mera falta de funcionalidad.

### C.2 Límites del protocolo de señalización y WebRTC

Todas estas constantes viven en `src/security/protocol-security.ts` y `src/network/signaling-client.ts`:

| Constante | Valor | Qué protege |
|---|---|---|
| `MAX_ENCRYPTED_MESSAGE_BYTES` | 512 KB | Tope de un mensaje cifrado recibido |
| `MAX_SIGNAL_LENGTH` | 128 KB | Tope de una señal (SDP/ICE) |
| `MAX_ICE_CANDIDATE_LENGTH` | 16 KB | Tope de un candidato ICE |
| `MAX_PENDING_ICE_CANDIDATES` | 100 | Candidatos ICE en cola antes de descartar |
| `MAX_PROTOCOL_MESSAGE_AGE_MS` | 10 min | Antigüedad máxima de un mensaje de protocolo |
| `MAX_PROTOCOL_CLOCK_SKEW_MS` | 5 min | Desfase tolerado entre relojes |
| `MAX_SIGNALING_FRAME_LENGTH` | 512 KB | Tope de un frame WebSocket de señalización |
| `MAX_NOSTR_SIGNAL_AGE_SECONDS` | 600 s | Antigüedad de una señal de Nostr |
| `MAX_SIGNALING_EVENT_TAGS` | 16 | Etiquetas por evento de señalización |
| `MAX_SIGNALING_TAG_PARAMETERS` | 8 | Parámetros por etiqueta |
| `MAX_SIGNALING_TAG_VALUE_LENGTH` | 1024 | Longitud de un valor de etiqueta |

La clase `ReplayGuard` (mismo archivo) recuerda los `messageId` ya vistos para que un relay no pueda reenviar un mensaje antiguo como si fuera nuevo.

## D. Árbol de derivación de claves

```text
                 Secreto maestro de vinculación
                 (32 bytes, Base64 canónico, 44 caracteres)
                          |
                          |
    +---------------------+---------------------+
    |                     |                     |
    |  PBKDF2-SHA-256     |  PBKDF2-SHA-256     |  PBKDF2-SHA-256
    |  100 000 iteraciones |  100 000 iteraciones |  100 000 iteraciones
    |  salt:              |  salt:              |  salt:
    |  OmniSync-Salt-v1   |  OmniSync-Signaling-v1| OmniSync-Mailbox-v1
    v                     v                     v
+---------+        +---------+           +---------+
| vaultKey|        | signalingKey|        | mailboxKey|
+---------+        +---------+           +---------+
    |                     |                     |
    |  Cifrado de         |  Cifrado de         |  Cifrado de
    |  mensajes WebRTC    |  señalización       |  cargas del buzón
    |                     |                     |
    +---------------------+---------------------+
                          |
             +------------+------------+
             |                         |
   PBKDF2 (BLOSSOM_KEY_CONTEXT)  PBKDF2 (SNAPSHOT_KEY_CONTEXT)
             |                         |
             v                         v
      +-------------+           +----------------+
      | blossomKey  |           | snapshotKey    |
      +-------------+           +----------------+
             |                         |
             v                         v
    Cifrado de blobs         Cifrado de snapshots
    antes de subir           base locales (IndexedDB)

    +-------------------------------------------+
    | deriveWorkerAuthKey (worker-auth.ts)     |
    |   identidad NIP-98 para tu propio Worker  |
    +-------------------------------------------+


IDENTIFICADORES DERIVADOS

secreto -- HMAC(secreto, "room", "signaling-room-v1") --> signalingRoomId
secreto -- HMAC(secreto, "room", "mailbox-room-v1")   --> mailboxRoomId
ruta    -- HMAC(ruta, "mailbox-dtag-v2")              --> mailboxDTag
```

### D.1 Constantes de derivación

Todas están en `src/crypto/crypto-manager.ts`, salvo la del snapshot:

| Constante | Valor | Uso |
|---|---|---|
| `PAIRING_SECRET_BYTES` | `32` | Longitud exacta del secreto maestro (256 bits) |
| `PAIRING_SECRET_BASE64_LENGTH` | `44` | Longitud de la codificación Base64 canónica |
| `VAULT_KEY_CONTEXT` | `OmniSync-Salt-v1` | Derivación de la clave de bóveda |
| `SIGNALING_KEY_CONTEXT` | `OmniSync-Signaling-v1` | Derivación de la clave de señalización |
| `MAILBOX_KEY_CONTEXT` | `OmniSync-Mailbox-v1` | Derivación de la clave del buzón |
| `BLOSSOM_KEY_CONTEXT` | `OmniSync-Blossom-v1` | Derivación de la clave de blobs |
| `SNAPSHOT_KEY_CONTEXT` (`base-snapshot-store.ts`) | `OmniSync-Snapshot-v1` | Cifrado de snapshots base locales |
| `MAX_ENCRYPTED_PAYLOAD_BYTES` | 768 KB | Tope del plaintext que se puede cifrar |

> **Por qué importan los contextos:** cada uso tiene su propio *salt*, de modo que la misma clave maestra produce claves AES distintas. Una clave nunca se reutiliza para dos dominios, así que una fuga en un canal no compromete los demás.

### D.2 Identificadores derivados

| Identificador | Cómo se deriva | Para qué |
|---|---|---|
| `signalingRoomId` | `computeHmacHex('room', secreto, 'signaling-room-v1')` | Nombre del canal WebSocket de señalización |
| `mailboxRoomId` | `computeHmacHex('room', secreto, 'mailbox-room-v1')` | Selector de los eventos del buzón |
| `mailboxDTag` | `computeHmacHex(ruta, secreto, 'mailbox-dtag-v2')` | Etiqueta `d` opaca de cada evento |
| `roomId` (legado) | `SHA-256(secreto)[0..16]` en hex | Identificador heredado, solo para validar payloads v1 |

> Los tres identificadores son **independientes**: el mismo secreto produce tres salidas distintas, de modo que un relay que ve la etiqueta `d` no puede correlacionarla con la sala.

### D.3 Reglas de la derivación

1. `deriveAesKey()` usa **PBKDF2-SHA-256 con 100 000 iteraciones** y produce claves AES-GCM de 256 bits **no exportables** (`extractable: false`).
2. Cada cifrado genera un **IV aleatorio de 12 bytes** nuevo (`crypto.getRandomValues`). Reutilizar un IV con la misma clave rompe el GCM por completo.
3. `requirePairingSecret()` valida que el secreto sea exactamente de 256 bits y con Base64 **canónico** (sin espacios ni saltos de línea).
4. El código HMAC usa prefijos de dominio (`OmniSync-HMAC-v1\0<dominio>\0<dato>` y `OmniSync-Auth-v1\0<desafío>`), de modo que la misma clave nunca produce la misma etiqueta en contextos distintos.
5. La verificación de firmas usa `crypto.subtle.verify`, que compara el MAC **resistente a fugas por tiempo**.

## E. Flujo de resolución de conflictos

### E.1 `decideMailboxNote` (nota del buzón)

La decisión se toma en `src/security/sync-policy.ts` y es una función *pura*, sin efectos:

```text
+-----------------------------------+
| Entrada                           |
| nota remota: ruta, mtime,         |
| contenido, deviceId               |
| estado local                      |
+-----------------+-----------------+
                  |
                  v
         +--------+---------+
         | ¿Existe el       |
         | archivo local?   |
         +--------+---------+
              |       |
          no  |       | sí
              |       v
              |  +--------+------------------+
              |  | noteMtime <= localMtime?  |
              |  +--------+------------------+
              |       |                |
              |   sí |                | no
              |       v                v
              |  +--------+      +--------+------------------+
              |  | SKIP   |      | ¿Contenido idéntico?     |
              |  +--------+      +--------+------------------+
              |                          |                |
              |                      sí |                | no
              |                          v                v
              |                     +--------+      +--------+------------------+
              |                     | SKIP   |      | ¿Ruta en                |
              |                     +--------+      | pendingP2PSync?         |
              |                                          +--------+------------------+
              |                                                   |                |
              |                                              sí |                | no
              |                                                   v                v
              |                                        +--------+---------+  +--------+-------+
              |                                        | Fusión a 3 vías |  | APPLY remoto   |
              |                                        | diff-merge.ts   |  +----------------+
              |                                        | presupuesto:    |
              |                                        | MAX_MERGE_     |
              |                                        | COMPARISONS    |
              |                                        +--------+---------+
              |                                                   |
              |                                                   v
              |                                        +--------+---------+
              |                                        | ¿Fusión limpia? |
              |                                        +--------+---------+
              |                                                   |
              |                                              sí |                | no
              |                                                   v                v
              |                                        +--------+---------+  +--------+---------+
              |                                        | APPLY fusionado   |  | Copia de conflicto |
              |                                        +-------------------+  | <nombre>.conflict- |
              |                                                                | YYYY-MM-DD-HHMM   |
              |                                                                +-------------------+
```

Las cuatro decisiones puras de `sync-policy.ts` son:

| Función | Valores devueltos | Regla |
|---|---|---|
| `decideRemoteWrite(localMtime, remoteMtime)` | `apply`, `skip_newer_local`, `skip_folder` | Si el local es **estrictamente** más reciente, no se sobrescribe. |
| `decideRemoteDelete(localMtime, remoteMtime)` | `trash`, `skip_newer_local`, `skip_missing` | El borrado **siempre** va a la papelera; nunca es destructivo. |
| `decideRemoteRename(localMtime, remoteMtime, destinoExiste)` | `rename`, `skip_newer_local`, `skip_destination_exists`, `skip_missing` | Nunca se sobrescribe un destino existente. |
| `decideMailboxNote(...)` | `apply`, `skip`, `conflict` | Reglas detallada arriba. |

### E.2 Fusión a 3 vías

1. `src/sync/diff-merge.ts` (`DiffMergeEngine`) hace la fusión **a nivel de carácter**, usando el snapshot base de `src/sync/base-snapshot-store.ts` como ancestro.
2. La fusión tiene un **presupuesto de CPU**: `MAX_MERGE_COMPARISONS = 20 000 000` comparaciones. Si se supera, la fusión se aborta y se cae al caso de conflicto.
3. Si la fusión no es limpia, la versión local se guarda como `<nombre>.conflict-YYYY-MM-DD-HHMM.<ext>` y se escribe la remota. **Ninguna de las dos se pierde.**
4. Los borrados remotos se registran como **lápidas** en `settings.deletedPaths` para que un manifiesto obsoleto no resucite el archivo.

### E.3 Tombstones (lápidas)

| Constante | Valor | Ubicación |
|---|---|---|
| `TOMBSTONE_MAX_AGE_MS` | 30 días | `src/main.ts` |
| `TOMBSTONE_MAX_ENTRIES` | 5 000 | `src/main.ts` |

Una lápida registra `ruta → { mtime, deletedAt }`. Sirve para dos cosas: propagar borrados hechos mientras el otro dispositivo estaba apagado, y evitar que un manifiesto antiguo resucite un archivo borrado. Se podan por edad y por número de entradas.

### E.4 El eco de la escritura

Cuando OmniSync escribe un archivo recibido, avisa al watcher para que ignore **ese** cambio y no lo reenvíe. El watcher se sincroniza con el **hash esperado** (`ignoreNextChange`), no con una marca de tiempo: si el usuario edita realmente el archivo dentro de esa ventana, la edición **sí** se sincroniza. Ignorar por tiempo perdería trabajo del usuario.

## F. Cómo escribir un transporte nuevo

Un «transporte» es cualquier vía por la que viajan mensajes OmniSync: hoy WebRTC (P2P), el buzón Nostr y Blossom. Si añades uno, estas son las reglas que el proyecto ya aplica y que tú debes respetar.

### F.1 Las cinco obligaciones

| # | Obligación | Dónde se cumple |
|---|---|---|
| 1 | Vivir en `src/network/` | Ningún transporte fuera de esa carpeta |
| 2 | **Validar cada mensaje entrante** con `src/security/` antes de tocar nada | El canal no es confiable aunque use TLS |
| 3 | **No degradar a texto plano** nunca | Un fallo de cifrado es un fallo, no un «enviar sin cifrar» |
| 4 | Incluir pruebas que **rechacen entradas maliciosas** | `tests/test-<transporte>.ts` |
| 5 | Exponer su configuración en `src/ui/settings-tab.ts` con las **cuatro** traducciones | `es`, `en`, `zh`, `ru` |

### F.2 Forma de la interfaz

El proyecto **no** tiene una interfaz `Transport` genérica: cada transporte es una clase concreta con su propia forma, porque sus ciclos de vida y sus capacidades son muy distintos (WebRTC es bidireccional y en vivo; el buzón es asíncrono y unidireccional; Blossom solo mueve blobs). Si añades uno, sigue el patrón de `NostrMailbox` o `BlossomClient`:

```ts
export class MiTransporte {
  // Estado propio
  private conectado = false;

  constructor(/* dependencias explícitas */) {}

  /** Arranca la conexión. Lanza si no puede. */
  public async connect(): Promise<void> {}

  /** Cierra y libera todos los recursos (listeners, timers, sockets). */
  public async disconnect(): Promise<void> {}

  /** Publica un mensaje. Lanza si el mensaje no es válido. */
  public async send(mensaje: unknown): Promise<void> {}

  /** Estado observable para la barra de estado y los ajustes. */
  public getEstado(): SyncState { /* ... */ }
}
```

### F.3 Inyección de la criptografía

El transporte **no** deriva claves por su cuenta. Recibe la clave ya derivada desde `main.ts` (`deriveDomainKeys()`), de modo que cada dominio tiene su contexto y su clave:

```ts
// En main.ts, no en el transporte:
const mailboxKey = await this.cryptoManager.deriveAesKey(secreto, MAILBOX_KEY_CONTEXT);
this.nostrMailbox = new NostrMailbox(this.cryptoManager, mailboxKey, ...);
```

Para el cifrado simétrico, la API de `CryptoManager` es:

```ts
encrypt(datos: unknown, clave: CryptoKey): Promise<EncryptedMessagePayload>
decrypt<T>(carga: unknown, clave: CryptoKey, comoTexto?: boolean): Promise<T>
encryptBinary(datos: Uint8Array, clave: CryptoKey): Promise<Uint8Array>
```

El payload cifrado tiene siempre la forma `{ v, iv, ct }` (Base64 canónico). Si necesitas *authenticated context* (datos adicionales que van cifrados pero que no se deben revelar), usa el campo `additionalData` de AES-GCM en `crypto.subtle` — nunca concatenes campos a mano en el plaintext.

### F.4 Validar antes de procesar

El patrón obligatorio, tal como aparece en `src/security/protocol-security.ts` y `transfer-security.ts`:

```ts
export function validateMiPayload(value: unknown): asserts value is MiPayload {
  if (!isPlainObject(value)) {
    throw new SecurityValidationError('Payload con formato inválido.');
  }
  if (typeof value.path !== 'string') {
    throw new SecurityValidationError('La ruta del payload es inválida.');
  }
  // La ruta SIEMPRE pasa por el validador único de la bóveda:
  const ruta = validateVaultPath(value.path, policy);
  if (ruta !== value.path) {
    throw new SecurityValidationError('La ruta del payload no está normalizada.');
  }
}
```

Reglas invariables:

1. Valida la **envoltura** (tipo, ids, antigüedad) **antes** de descifrar o deserializar.
2. Valida el **contenido descifrado** con un esquema versionado. Como el proyecto no usa Zod, el patrón es `asserts value is T` sobre funciones de `src/security/`.
3. Rechaza campos desconocidos. Un mensaje con una forma no prevista se rechaza, no se ignora en silencio.
4. Un mensaje inválido **no termina el transporte**: se registra un diagnóstico conciso, se incrementa un contador de error y se sigue.
5. **Nunca** registres el contenido del mensaje ni credenciales en los logs. Usa `sanitizeExternalError()` / `sanitizeExternalText()` de `src/security/external-text.ts`, que además recortan a 160 caracteres (`MAX_EXTERNAL_TEXT_LENGTH`) y eliminan secuencias ANSI.

### F.5 Limitar el consumo

Todo lo que venga de la red debe tener un tope explícito:

| Tope | Constante existente |
|---|---|
| Tamaño de mensaje cifrado | `MAX_ENCRYPTED_MESSAGE_BYTES` (512 KB) |
| Tamaño de archivo | `MAX_TRANSFER_FILE_SIZE` (128 MiB) |
| Fragmentos por transferencia | `MAX_TRANSFER_CHUNKS` (8192) |
| Transferencias entrantes simultáneas | `MAX_ACTIVE_INCOMING_TRANSFERS` (2) |
| Entradas de un manifiesto | `MAX_MANIFEST_ENTRIES` (100 000) |
| Operaciones Blossom simultáneas | `MAX_CONCURRENT_BLOSSOM_OPERATIONS` (1) + `MAX_PENDING_BLOSSOM_OPERATIONS` (4) |

Usa `ConcurrencyLimiter` (`src/security/concurrency-limiter.ts`) para limitar trabajo concurrente y `PathOperationQueue` (`src/security/path-operation-queue.ts`) para serializar operaciones sobre la misma ruta.

### F.6 Integrarlo en los ajustes

1. Añade el campo a `OmniSyncSettings` en `src/types.ts` como **opcional**, con su valor por defecto en `DEFAULT_SETTINGS` (`src/main.ts`).
2. Sanéalo en la carga: `sanitizeBooleanSettings()`, `sanitizeBlossomSettings()`, `sanitizeLanguageSettings()`, `sanitizeTombstones()`.
3. Añade el control visual en `src/ui/settings-tab.ts` y llama a `saveSettings()`; si la red depende de él, llama a `reconnectNetwork()`.
4. Añade los textos a `src/i18n/types.ts` y a los **cuatro** idiomas (`es`, `en`, `zh`, `ru`). `npm run test:i18n` falla si falta alguno.

### F.7 Las pruebas

Coloca las pruebas en `tests/test-<transporte>.ts` y síguelas con el patrón de `test-nostr-mailbox.ts`:

```bash
npm run test:security && npm run test:<transporte>
```

La prueba debe cubrir, como mínimo:

- Conexión, desconexión, envío y recepción correctos.
- Rechazo de la **clave incorrecta** (integridad AEAD).
- Rechazo de **ciphertext manipulado** (un byte cambiado).
- Rechazo de **payload malformado**, sobredimensionado y de versión no soportada.
- Rechazo de **mensajes duplicados o repetidos** (`ReplayGuard`).
- **Limpieza de recursos**: timers, listeners, sockets y `AbortController` liberados al desconectar.
- Valores por defecto, persistencia y migración de los ajustes.

Usa servicios de red y de cifrado simulados. Añade **una** prueba de integración de bucle local (loopback) que recorra el camino completo `frame → descifrar → validar → despachar`. Las pruebas **no** deben requerir red externa ni contener credenciales reales.

## G. Cómo escribir una prueba

Las pruebas de OmniSync se ejecutan en **Node puro**, no dentro de Obsidian. Así son rápidas, deterministas y no dependen de una bóveda, un editor o una conexión de red reales.

### G.1 El entorno de pruebas

El archivo `tests/obsidian-stub.ts` proporciona un sustituto mínimo de la API de Obsidian. El proyecto **no** usa el runner de pruebas de Node: cada suite es un script autónomo que se compila con `esbuild` y se ejecuta con `node`.

Así se declara una suite en `package.json`:

```json
"test:mi-suite": "esbuild tests/test-mi-suite.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/test-mi-suite.mjs --alias:obsidian=./tests/obsidian-stub.ts --external:@codemirror/state --external:@codemirror/view --log-level=warning && node node_modules/.cache/test-mi-suite.mjs"
```

Las piezas del comando:

| Parte | Para qué sirve |
|---|---|
| `--bundle` | Empaqueta tus imports y los del proyecto en un solo `.mjs` |
| `--platform=node --format=esm` | Ejecutable en Node, sin `require` |
| `--alias:obsidian=./tests/obsidian-stub.ts` | **Redirige** el import de `obsidian` al stub |
| `--external:@codemirror/state` / `--view` | Los deja fuera del bundle (Obsidian los aporta en runtime) |
| `--outfile=node_modules/.cache/...` | Escribe en la caché, no en el repositorio |

Añade la suite a la cadena `test` de `package.json` para que `npm test` la ejecute.

### G.2 Qué contiene el stub

`tests/obsidian-stub.ts` exporta versiones ligeras de lo que el plugin usa: `normalizePath`, `TFile`, `TFolder`, `TAbstractFile`, `Vault`, `App`, `Plugin`, `Modal`, `PluginSettingTab`, `Setting`, `Notice`, `MarkdownView`, `Component`, `ItemView`, `TextComponent`, `ButtonComponent`, `ToggleComponent`, `DropdownComponent`, `addIcon`, `setIcon` y `normalize`.

> **Mantén el stub pequeño.** Añade una API solo cuando una prueba la necesite, y haz que cada sustituto se comporte de forma predecible: por ejemplo, `loadData()` devuelve `{}` y `saveData()` guarda su argumento para poder inspeccionarlo.

### G.3 Crear instancias del plugin

**No** construyas el plugin de forma normal con `new OmniSyncPlugin(app, manifest)`: el constructor base de Obsidian espera una aplicación viva. Crea la instancia desde el prototipo e inicializa solo los campos que la prueba necesite:

```ts
const plugin = Object.create(OmniSyncPlugin.prototype) as OmniSyncPlugin;
```

Esto conserva todos los métodos pero evita el constructor. Usa `Object.assign` o asignaciones directas para configurar `settings`, estado, callbacks y fábricas de dependencias. **No** llames a `onload()` salvo que la prueba sea de integración y el stub cubra todo lo que ese método necesita.

### G.4 Pruebas de regresión de seguridad

Trata lo que llega del servidor como entrada no confiable, **aunque** llegue por un WebSocket autenticado. Una prueba de regresión debe conservar el fallo original como un caso **estrecho y repetible**.

Casos límite útiles:

- Valores vacíos, ausentes o con tipo incorrecto.
- `"."`, `".."`, rutas absolutas y recorridos `../`.
- Bytes NUL, caracteres de control, Unicode malformado y colisiones de normalización.
- JSON malformado, claves duplicadas, campos ausentes y cargas sobredimensionadas.
- Tokens de autenticación ausentes, vacíos, malformados o manipulados.
- Rutas que apuntan a `.obsidian/plugins`, `.git` o `.trash`.
- Nombres reservados de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`, `LPT1`).

Afirma que la entrada inválida se rechaza **antes** de cualquier operación de archivo, red o persistencia. Comprueba también que los mensajes de error y los logs no exponen credenciales ni contenido de la bóveda. Una prueba **dirigida por tabla** es útil cuando varias entradas deben producir el mismo resultado.

### G.5 El patrón de WebSocket falso

Las pruebas de reconexión **nunca** deben contactar con un servidor real. `tests/test-dual-path-regression.ts` muestra el patrón:

```ts
class FakeWebSocket extends EventTarget {
  readyState = 0; // CONNECTING
  sent: string[] = [];

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    super();
  }
  // ... open(), send(), close() simulados
}
```

El falso debe registrar la URL, los frames enviados, el estado de preparación y los eventos de ciclo de vida, y debe permitir simular explícitamente `open`, `message`, `error`, cierre limpio y cierre anormal (por ejemplo, código `1006`).

Usa temporizadores falsos o un retardo de reconexión de cero para probar el backoff sin esperar en tiempo real. La prueba debe confirmar **ambos** casos: que se crea un socket nuevo tras una desconexión inesperada, y que un cierre normal **no** provoca una reconexión no deseada.

### G.6 Cómo se demuestra una corrección

Preferencia del proyecto: **demostrar que la prueba falla contra el código antiguo**. Revierte el arreglo, ejecuta la prueba y comprueba que se pone roja; restaura el arreglo y comprueba que se pone verde. Una prueba que nunca se ha visto fallar no demuestra nada.

```bash
npm run typecheck && npm run lint && npm test
```

### G.7 Errores frecuentes

| Síntoma | Causa habitual |
|---|---|
| `Cannot find module 'obsidian'` | Falta `--alias:obsidian=./tests/obsidian-stub.ts` en el script de la suite |
| `ERR_MODULE_NOT_FOUND` con `@codemirror/*` | Falta `--external:@codemirror/state --external:@codemirror/view` |
| `test:i18n` falla en un equipo con otro `locale` | Ejecuta con `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run test:i18n` |
| `test:distribution` falla | El paquete publicado está desactualizado: ejecuta `npm run package:stable` |
| La prueba se cuelga | Falta limpiar un timer o un listener: revisa `disconnect()`/`onunload()` |

## H. Rendimiento y límites operativos

### H.1 Tiempos y ventanas

| Constante | Valor | Ubicación | Para qué |
|---|---|---|---|
| Debounce del watcher | 350 ms | `src/sync/vault-watcher.ts` | Agrupa una ráfaga de pulsaciones en un solo cambio |
| `MAILBOX_POLL_INTERVAL_MS` | 60 s | `src/main.ts` | Sondeo periódico del buzón mientras la app está activa |
| `FALLBACK_NOTICE_COOLDOWN_MS` | 10 min | `src/main.ts` | Como máximo un aviso de respaldo por cada 10 minutos |
| `SNAPSHOT_PRUNE_INTERVAL_MS` | 10 min | `src/main.ts` | Poda periódica de snapshots base |
| `TOMBSTONE_MAX_AGE_MS` | 30 días | `src/main.ts` | Vida máxima de una lápida |
| `INCOMING_TRANSFER_TTL_MS` | 5 min | `src/sync/file-transfer.ts` | Tiempo máximo de inactividad de una transferencia entrante |
| `DRAIN_TIMEOUT_MS` | 30 s | `src/sync/file-transfer.ts` | Espera máxima a que se vacíe el búfer de salida |
| `MAX_LIVE_MULTIPART_AGE_MS` | 5 min | `src/network/nostr-mailbox.ts` | Antigüedad de un grupo multipart en curso |
| `PAIRING_TOKEN_TTL_MS` | 2 min | `src/security/pairing-session.ts` | Vigencia del código de emparejamiento |
| `WORKER_AUTH_EXPIRATION_SECONDS` | 90 s | `src/security/worker-auth.ts` | Vigencia del evento NIP-98 |

### H.2 El backoff de reintentos

Los pendientes del buzón se reintentan con una escalera fija de retardos (`schedulePendingRetry` en `src/main.ts`):

```text
2 s  ->  5 s  ->  15 s  ->  60 s  ->  60 s  ->  ...
```

Al llegar al último escalón, el retardo se mantiene en 60 s. Un disparo **inmediato** (reconexión, evento `online`, vuelta al primer plano) reinicia la cuenta atrás a 0 y pone el temporizador a 0 ms.

El backoff de reconexión del relay tiene una regla adicional importante: **solo se reinicia tras una conexión que haya durado ≥ 10 s**. Así, un relay que acepta la conexión y la cierra inmediatamente no puede provocar un bucle de sondeos.

### H.3 La serialización de `broadcastChain`

`broadcastChain` es una **cadena de promesas**: cada envío se encadena al anterior, de modo que las ediciones se transmiten **en orden de mutación**. Esto garantiza que una versión antigua de un archivo nunca se emite después de una versión más nueva y la «pisa» en el receptor.

Regla: **todo** envío debe pasar por `broadcastChain`. No envíes directamente desde el watcher ni desde un callback de la UI; ahí solo se encola el trabajo.

```ts
// Correcto
const run = this.broadcastChain.then(() => this.doBroadcastFileChange(path, entry, data));
this.broadcastChain = run.catch(() => {});

// Incorrecto: se salta la serialización
await this.doBroadcastFileChange(path, entry, data);
```

### H.4 Tamaño de fragmento y contrapresión del DataChannel

| Constante | Valor | Razón |
|---|---|---|
| `MIN_CHUNK_SIZE` | 16 KB | Fragmento mínimo admitido |
| `CHUNK_SIZE` | 32 KB | Valor por defecto |
| `MAX_CHUNK_SIZE` | 64 KB | Fragmento máximo admitido |
| `DEFAULT_HIGH_WATER_MARK` | 1 MiB | Marca de agua superior del búfer de salida |

El fragmento viaja codificado en **Base64 dentro de un envelope JSON**, lo que añade aproximadamente un **+33 %** de tamaño. Por eso el valor por defecto es 32 KB: el mensaje real queda muy por debajo del límite SCTP de 64 KB.

Cuando `bufferedAmount` del `RTCDataChannel` supera `DEFAULT_HIGH_WATER_MARK`, el emisor **espera** al evento `bufferedamountlow` antes de encolar el siguiente fragmento. Sin esto, un archivo grande saturaría el canal y bloquearía a los demás mensajes.

### H.5 Presupuesto de CPU de la fusión

`MAX_MERGE_COMPARISONS = 20 000 000` comparaciones (`src/sync/diff-merge.ts`). Es un presupuesto, no un límite de resultado: si la fusión a 3 vías lo supera, se aborta y se genera una copia de conflicto. Un presupuesto es preferible a un tiempo de espera, porque bloquea el hilo principal de la UI.

### H.6 Presupuesto del motor de diff

`src/sync/delta-patch.ts` implementa el algoritmo de Myers (O(ND)) con dos topes:

| Constante | Valor | Qué acota |
|---|---|---|
| `MAX_MYERS_DIFFERENCE` | 4 000 | La distancia máxima `D` del diff |
| `MAX_MYERS_TRACE_CELLS` | 16 Mi celdas | La memoria de la traza de Myers |
| `MAX_PATCH_LENGTH` | 4 MiB | Longitud de un parche que se acepta aplicar |
| `MAX_PATCH_HUNKS` | 10 000 | Bloques por parche |
| `MAX_PATCH_HUNK_LINES` | 20 000 | Líneas por bloque |
| `MAX_CONTEXT_LINES` | 100 | Líneas de contexto admitidas |

### H.7 Tiempos de espera de Blossom

| Operación | Tiempo de espera |
|---|---|
| Subida | 45 s |
| Descarga | 30 s |

Se han verificado subidas en vivo de hasta 95 MB en una conexión rápida. Una red móvil lenta puede superarlos: por eso los tiempos de espera son generosos y los errores se reportan de forma limpia en lugar de bloquear la cola.

### H.8 Retención

| Dato | Retención |
|---|---|
| Eventos del buzón (NIP-40) | 7 días (`MAILBOX_EXPIRATION_SECONDS`) |
| Blobs en R2 | 10 días (regla de ciclo de vida `expire-blobs`) |
| Blobs en servidores Blossom públicos | ≈ 7 días, según el servidor |

> **OmniSync no es una copia de seguridad.** Todos los transportes son buzones de tránsito. Si un dispositivo no se conecta dentro de esa ventana y nunca hubo una sesión P2P directa, los cambios no llegarán. Cada dispositivo es responsable de su propia bóveda.

## I. Interno del Worker de Cloudflare

El Worker todo en uno vive en `scripts/cloudflare-allinone/worker.js` y lo configuran `scripts/cloudflare-allinone/wrangler.jsonc` y `package.json`.

### I.1 Los dos Durable Objects

| Clase | Migración | Función |
|---|---|---|
| `SignalingRoom` | `v1` (`new_sqlite_classes`) | Conexiones WebSocket de señalización y emparejamiento |
| `MailboxRoom` | `v2` (`new_sqlite_classes`) | Un DO por sala de buzón; guarda los eventos kind-30078 |

`SignalingRoom` usa la **API de Hibernation** de Durable Objects: las conexiones en espera no consumen CPU mientras están inactivas y se reanudan cuando llega un mensaje.

Las migraciones están declaradas en `wrangler.jsonc`:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["SignalingRoom"] },
  { "tag": "v2", "new_sqlite_classes": ["MailboxRoom"] }
]
```

> **Un Worker desplegado con una plantilla antigua debe redesplegarse.** Si falta el binding `MAILBOX_ROOM`, la página de estado lo indica como `missing_do_binding`.

### I.2 Almacenamiento del `MailboxRoom`

- Los eventos se indexan por la pareja **`(pubkey, d_tag)`**, de modo que hay como máximo un evento por archivo y por dispositivo dentro de una sala.
- El esquema SQLite incluye una columna **`expiration`**. Cada consulta la comprueba y las filas caducadas se eliminan de forma perezosa.
- Antes de almacenar un evento, su etiqueta **`t`** debe coincidir exactamente con el nombre de la sala. Esto impide que un evento destinado a una sala sea aceptado por otra.

### I.3 Límites del Worker

Todas estas constantes están en `worker.js`:

| Constante | Valor | Qué protege |
|---|---|---|
| `MAX_UPLOAD_SIZE_BYTES` | 100 MB | Tope de un blob subido (responde HTTP 413) |
| `MAX_SOCKETS_PER_ROOM` | 32 | Conexiones simultáneas por sala de señalización |
| `MAX_SOCKETS_PER_PAIR_ROOM` | 4 | Conexiones por sala de emparejamiento |
| `MAX_PAIR_MESSAGE_BYTES` | 16 KB | Tamaño de un frame de emparejamiento |
| `MAX_SIGNALING_MESSAGE_BYTES` | 512 KB | Tamaño de un frame de señalización |
| `RATE_LIMIT_WINDOW_MS` | 10 s | Ventana del limitador de tasa |
| `RATE_LIMIT_MAX_MESSAGES` | 120 | Mensajes por socket y ventana (señalización) |
| `MAILBOX_RATE_LIMIT_MAX_MESSAGES` | 240 | Mensajes por socket y ventana (buzón) |
| `MAX_ALLOWED_PUBKEYS` | 32 | Claves públicas admitidas en `ALLOWED_PUBKEYS` |
| `MAX_NIP98_AUTH_HEADER_LENGTH` | 32 KB | Tope de la cabecera `Authorization` |
| `MAX_NIP98_EVENT_BYTES` | 16 KB | Tamaño del evento NIP-98 |
| `NIP98_EVENT_WINDOW_SECONDS` | 120 s | Ventana de validez temporal del evento NIP-98 |
| `REPLAY_TTL_MS` | 5 min | Vida de una entrada del registro anti-replay |
| `MAX_REPLAY_ENTRIES` | 10 000 | Tamaño del registro anti-replay |
| `MAILBOX_MAX_TTL_SECONDS` | 7 días + 60 s | TTL máximo aceptado en un evento de buzón |
| `MAILBOX_MAX_AGE_SECONDS` | 8 días | Antigüedad máxima de un evento de buzón |
| `MAX_MAILBOX_EVENTS_PER_ROOM` | 2 000 | Eventos almacenados por sala |
| `MAX_MAILBOX_BYTES_PER_ROOM` | 96 MiB | Bytes almacenados por sala |
| `MAX_MAILBOX_SOCKETS` | 16 | Conexiones simultáneas al buzón |
| `MAX_MAILBOX_SUBSCRIPTIONS_PER_SOCKET` | 4 | Suscripciones por socket |
| `MAX_MAILBOX_RESULTS` | 500 | Resultados por consulta |

### I.4 El flujo de autorización NIP-98

1. El cliente crea un evento Nostr de **kind 27235** (`WORKER_AUTH_KIND`), con etiquetas `url` y `method`, y —cuando aplica— una etiqueta `payload` con el hash SHA-256 del cuerpo.
2. El evento se firma con la clave de autenticación del Worker. Los Workers propios usan una **identidad estable**; los servidores públicos, una clave efímera.
3. El cliente envía el evento en Base64 en la cabecera `Authorization: Nostr <base64(event)>`.
4. El Worker decodifica, verifica la firma Nostr, comprueba que la pubkey esté en `ALLOWED_PUBKEYS`, verifica que `url` y `method` coincidan con la petición y comprueba que el timestamp sea reciente.

> Si `ALLOWED_PUBKEYS` está vacía, el Worker responde **HTTP 503** y rechaza todas las autorizaciones. La página de estado lo muestra como `auth: missing_allowed_pubkeys`.

### I.5 El endpoint de estado

`GET /` devuelve un JSON con el estado de cada servicio:

```json
{
  "services": {
    "blossom":   { "status": "ready" },
    "signaling": { "status": "ready" },
    "mailbox":   { "status": "ready" },
    "auth":      { "status": "ready" }
  }
}
```

Estados posibles:

| Estado | Significado | Acción |
|---|---|---|
| `ready` | El binding o la configuración existe y funciona | — |
| `missing_r2_binding` | El bucket R2 no está enlazado | Revisa `r2_buckets` en `wrangler.jsonc` y redespliega |
| `missing_do_binding` | Falta el binding del Durable Object | **Redespliega** con la plantilla actual |
| `missing_allowed_pubkeys` | `ALLOWED_PUBKEYS` está vacía | Copia la clave que muestra el asistente |

### I.6 El flujo de despliegue

El asistente de la interfaz (`src/ui/cloudflare-worker-modal.ts`) genera un comando de una sola línea a partir de las plantillas embebidas en `src/templates/cloudflare-worker-template.ts`. El comando:

1. Crea el directorio `omnisync-server` y entra en él.
2. Escribe `package.json`, `wrangler.jsonc` y `worker.js` con heredocs de delimitador entrecomillado (`<<'OMNISYNC_EOF'`), de modo que bash no interprete backticks, `${}` ni `$`.
3. Ejecuta `npm install`.
4. Crea el bucket R2 `omnisync-blossom` (el error se ignora si ya existe).
5. Añade la regla de ciclo de vida `expire-blobs` con 10 días (también se ignora el error si ya existe).
6. Ejecuta `npx wrangler deploy`.

> Las plantillas son **generadas**: `npm run build:templates` regenera `src/templates/cloudflare-worker-template.ts` a partir de `scripts/`. `test:cloudflare-allinone` falla si la copia embebida no está sincronizada con los archivos fuente. **No edites `src/templates/cloudflare-worker-template.ts` a mano.**

### I.7 Blossom: identidad estable frente a efímera

La clave con la que se firma una subida **solo es estable** si el host del servidor figura en `settings.privateWorkerHosts`. Cualquier otro servidor ve una clave efímera. Esto tiene una consecuencia operativa importante: un Worker **solo-Blossom** debe registrarse como propio (lo hace el asistente), o su lista `ALLOWED_PUBKEYS` rechazará las subidas.

## J. Glosario

- **bóveda (vault)** — La carpeta de Obsidian que OmniSync sincroniza. Sus archivos y su estructura de directorios forman el contenido que viaja entre los dispositivos.

- **sala (room)** — Identificador pseudónimo derivado con HMAC, usado como nombre del canal WebSocket y como selector del buzón. Nunca expone el secreto maestro de la bóveda.

- **buzón (mailbox)** — Canal de relay Nostr para la entrega asíncrona mediante eventos kind-30078. Permite que los cambios lleguen a dispositivos que estaban apagados cuando se hicieron.

- **relay** — Servidor WebSocket de Nostr que guarda y reenvía eventos a los suscriptores. OmniSync trata la infraestructura de relays como no confiable y usa mecanismos como los ids de mensaje y las comprobaciones de caducidad para limitar la repetición y la entrega obsoleta.

- **emparejamiento (pairing)** — Protocolo efímero ECDH por el que dos dispositivos establecen una clave compartida. La clave maestra **nunca viaja en el QR**: el QR lleva un token de un solo uso que solo autentica el intercambio.

- **token de emparejamiento** — 128 bits aleatorios (`PAIRING_TOKEN_BYTES = 16`), de un solo uso y con caducidad de 2 minutos. Autoriza un único intercambio ECDH.

- **clave maestra (pairing secret)** — Secreto de 256 bits que comparten los dispositivos emparejados. De él se derivan todas las claves de dominio y los identificadores de sala. Es lo único que hay que transferir al otro dispositivo.

- **secretStorage** — API de Obsidian para guardar secretos en el almacén seguro del sistema operativo. La clave maestra vive aquí, **nunca** en `data.json`.

- **snapshot base** — La versión más reciente de un archivo conocida como común a los dispositivos participantes. Sirve como ancestro en una fusión a 3 vías y como base para construir o aplicar un parche delta. Se guarda cifrada con AES-256-GCM en IndexedDB.

- **parche delta (delta patch)** — Representación en formato unified diff de un cambio, dividida en fragmentos para transferirse de forma eficiente. Enviar un parche por el buzón evita resubir el archivo entero cuando solo cambió una parte.

- **lápida (tombstone)** — Registro de un borrado (`ruta → { mtime, deletedAt }`) que impide que un manifiesto obsoleto resucite un archivo eliminado.

- **manifiesto** — Mapa de los archivos de una bóveda con `mtime`, `size` y `hash` SHA-256 de cada uno. Se intercambia al conectar para calcular qué subir, qué bajar y qué está en conflicto.

- **delta de manifiesto** — El resultado de comparar dos manifiestos: `toUpload`, `toDownload`, `conflicts` y `toDelete` (`ManifestDelta`).

- **conflicto** — Estado en el que la versión local y la remota han cambiado ambas desde la última sincronización. Se resuelve con fusión a 3 vías o, si no es posible, guardando una copia de conflicto.

- **copia de conflicto** — Archivo `<nombre>.conflict-YYYY-MM-DD-HHMM.<ext>` que preserva la versión local cuando la fusión no puede resolverse.

- **NIP-98** — Especificación Nostr para autorizar peticiones HTTP con un evento firmado usado como credencial. OmniSync usa eventos kind 27235 con la cabecera `Authorization: Nostr <base64(event)>`, opcionalmente vinculando el cuerpo con un hash SHA-256 en la etiqueta `payload`.

- **NIP-40** — Especificación Nostr que define la etiqueta `expiration` y su semántica de timestamp Unix. Los relays deben borrar los eventos caducados, y el almacenamiento de buzón de OmniSync también comprueba la caducidad en cada lectura y escritura.

- **NIP-78** — Define el kind 30078, evento parametrizado y reemplazable, usado para los mensajes del buzón de OmniSync. Dentro de una sala, la pareja `pubkey` + `d_tag` identifica al dispositivo y al archivo que representa el evento.

- **BUD-01/02** — Especificaciones del protocolo Blossom que definen la subida y la descarga de blobs. BUD-01 cubre `PUT /upload`; BUD-02, la recuperación direccionada por contenido mediante `GET /<sha256>`.

- **kind 30078** — El kind de evento reemplazable parametrizado (NIP-78) usado por OmniSync para el buzón.

- **broadcastChain** — Una única cadena de promesas que serializa todos los envíos salientes en orden de mutación. Impide que una versión antigua de un archivo se difunda después de una más nueva y la adelante.

- **modo de doble vía (dual-path)** — Modo en el que cada edición se envía por el buzón del relay y, si hay un par conectado, también directamente por P2P. El buzón es el respaldo asíncrono cuando no hay par disponible en el momento de editar.

- **modo P2P puro (pure P2P)** — Modo que no usa el buzón del relay. Ambos dispositivos deben estar en línea y conectados a la vez, porque no hay cola de entrega por relay.

- **pendingMailboxOut** — Cola persistida de rutas cuya entrega por relay no ha sido confirmada. Se reintentan con backoff exponencial hasta que la entrega funcione o la entrada se resuelva.

- **pendingP2PSync** — Cola persistida de rutas que requieren reconciliación completa con un par. Se añade una entrada cuando el snapshot base esperado no coincide o cuando falla la aplicación de un parche delta.

- **ReplayGuard** — Conjunto en memoria de ids de mensaje ya observados, para reconocer entregas duplicadas. Evita que un relay reenvíe un mensaje ya procesado como si fuera una actualización nueva.

- **evento reemplazable** — Como los eventos 30078 son reemplazables, el relay guarda **un solo evento por etiqueta `d`**. Solo se conserva la última versión de cada nota.

- **debounce** — Agrupación temporal de eventos de archivo. OmniSync espera 350 ms tras la última modificación antes de actuar, de modo que una ráfaga de pulsaciones se convierte en un solo cambio y un solo envío.

## K. Invariantes de seguridad: por qué importa cada una

Las ocho invariantes de la sección 10 tienen una justificación concreta. Esta sección explica **qué rompería** cada una y **dónde** se comprueba.

### K.1 I1 — Validar la ruta de la bóveda antes de cada escritura

Toda ruta derivada de un evento de relay debe pasar por `validateVaultPath()` antes de llegar al sistema de archivos.

- **Recorrido de directorios:** se rechazan rutas que escapan de la bóveda mediante `..`, rutas absolutas o codificaciones equivalentes. Impide que un evento manipulado apunte a `../../.bashrc`.
- **Nombres reservados:** se rechazan los nombres de dispositivo de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`), incluidos los que siguen siendo reservados tras añadir una extensión. Evita escrituras sobre dispositivos especiales en lugar de archivos normales.
- **Alias 8.3 de NTFS:** `canonicalSegment()` normaliza los puntos y espacios finales, y `SHORT_NAME_ALIAS` (`~\d`) rechaza el alias corto de un directorio bloqueado (por ejemplo `PLUGIN~1`).
- **Inyección por enlaces simbólicos:** se valida el destino canónico y se comprueba que siga dentro de la bóveda, incluso si un componente es un enlace simbólico. Un relay no debe poder redirigir una ruta aparentemente relativa hacia fuera de la bóveda.
- **Nombres de `Object.prototype`:** `__proto__`, `constructor`, `prototype`, etc. se rechazan como segmentos, para que una ruta maliciosa no pueda contaminar un manifiesto.
- **Directorios protegidos:** `.trash` y `.git` se rechazan siempre; `.obsidian/plugins` se rechaza siempre; y `.obsidian` requiere que `syncObsidianConfig` esté activo.

**La validación debe ocurrir inmediatamente antes de cada escritura**, porque una ruta que era segura cuando se recibió puede dejar de serlo más tarde.

En `src/security/vault-security.ts`:

| Constante | Valor |
|---|---|
| `MAX_VAULT_PATH_LENGTH` | 1024 |
| `MAX_VAULT_PATH_SEGMENTS` | 100 |
| `MAX_VAULT_PATH_SEGMENT_LENGTH` | 255 |

### K.2 I2 — Aplicar comprobaciones SHA-256 a cada archivo y fragmento

Cada archivo y cada fragmento multipart debe coincidir con su digest SHA-256 esperado antes de que OmniSync lo acepte o lo aplique.

Esto impide que un relay o un servidor de blobs sustituyan datos sutilmente corruptos, incluidos datos que aún son estructuralmente válidos o que descifran bien pero representan el contenido equivocado. El digest ata los bytes aceptados al contenido publicado originalmente, de modo que una discrepancia provoca rechazo, reensamblado o resincronización en lugar de corrupción silenciosa.

### K.3 I3 — No sobrescribir nunca un archivo local más nuevo

Antes de aplicar contenido remoto, OmniSync debe determinar si el archivo local ha avanzado más allá de la versión que representa la actualización entrante.

Esto impide que una copia obsoleta cacheada por un relay sobrescriba ediciones hechas mientras el dispositivo estaba sin conexión. Una versión local más reciente se conserva y, cuando hace falta, se fusiona con la remota en lugar de ser reemplazada por una más antigua.

La implementación está en `decideRemoteWrite`, `decideRemoteDelete` y `decideRemoteRename` (`src/security/sync-policy.ts`).

### K.4 I4 — Enviar los borrados remotos a la papelera, nunca destruirlos

Un borrado recibido de otro dispositivo emparejado debe mover el archivo a la papelera de la bóveda en lugar de eliminarlo de forma permanente.

Esto limita el daño de un dispositivo emparejado comprometido: un atacante puede quitar contenido de la bóveda activa, pero no puede hacerlo irrecuperable. El archivo sigue disponible para restauración y análisis forense.

### K.5 I5 — Validar los datos del relay antes de cualquier operación

Los eventos de relay son entrada no confiable. Sus esquemas, tipos de campo, tamaños, rutas y demás valores acotados deben validarse antes de que los datos los use el navegador o se escriban en disco.

- **Contaminación de prototipo:** se rechazan nombres de propiedad peligrosos como `__proto__`, `constructor` y `prototype`, y se evitan los patrones de fusión insegura de objetos. `isPlainObject()` comprueba además que el prototipo sea `Object.prototype` o `null`.
- **ReDoS:** la validación debe ser acotada y segura ante patrones atacantes.
- **Inyección de JSON:** se parsea y valida el dato estructurado en lugar de interpolar contenido crudo en JSON, HTML o expresiones ejecutables.

La validación «fail-closed» impide que contenido malicioso alcance APIs sensibles del navegador o del sistema de archivos.

### K.6 I6 — Guardar la clave maestra en `secretStorage`, nunca en `data.json`

La clave maestra de la bóveda debe guardarse mediante `secretStorage` de Obsidian, que se apoya en las instalaciones de credenciales seguras del sistema operativo cuando están disponibles.

Mantenerla fuera de `data.json` evita la divulgación a través de:

- La sincronización de la bóveda a otro dispositivo.
- Commits de Git y su historial.
- Copias de seguridad en la nube de `.obsidian/plugins/omnisync/data.json`.
- Compartir o empaquetar por error el directorio de datos del plugin.

`data.json` puede contener configuración ordinaria, pero **nunca** la clave maestra ni ningún valor suficiente para derivarla.

En la práctica, `saveSettings()` de `src/main.ts` hace exactamente esto:

```ts
this.app.secretStorage.setSecret(this.settings.masterKeySecretId, this.settings.pairingSecret);

const persisted: Partial<OmniSyncSettings> = { ...this.settings };
// La clave maestra y el identificador derivado nunca se guardan en data.json.
delete persisted.pairingSecret;
delete persisted.roomId;
await this.saveData(persisted);
```

### K.7 I7 — Usar una etiqueta `d` opaca basada en HMAC

La etiqueta `d` expuesta al relay debe ser un HMAC con clave, opaco, no un nombre de archivo codificado, una ruta ni un identificador reversible.

Esto impide que el operador del relay aprenda:

- Los nombres de los archivos sincronizados.
- Su estructura de directorios.
- Qué rutas reales de la bóveda corresponden a las etiquetas `d` observadas.

La misma ruta produce una etiqueta opaca estable entre eventos, lo que permite correlacionar sin revelar el nombre. El relay todavía puede observar metadatos de tráfico como frecuencia, momento y tamaño de las cargas: la etiqueta `d` protege la **confidencialidad de las rutas**, no todos los metadatos.

### K.8 I8 — Publicar exactamente el paquete recién compilado

El paquete publicado debe generarse a partir del árbol de fuentes auditado actual, en una compilación limpia. No se deben publicar artefactos compilados antiguos ni suministrados aparte.

Esto evita un ataque de cadena de suministro en el que el código fuente y las pruebas benignos parecen correctos mientras un bundle JavaScript precompilado contiene código malicioso. Compilar y publicar el artefacto exacto a partir del fuente revisado garantiza que el código que instala el usuario es el código que se auditó.

`npm run test:distribution` (`tests/test-distribution-artifact.ts`) comprueba que `zip/OmnySync_stable/` es **byte a byte idéntico** a una compilación fresca de `src/main.ts`.

## L. Parches delta a fondo

### L.1 La elección en `publishToMailbox`

`publishToMailbox` (`src/main.ts`) elige entre **tres** formas de publicación.

#### 1. `FULL_NOTE`

Un archivo de texto cuyo tamaño no supera `MAX_MAILBOX_NOTE_SIZE` (64 KB) se publica como `FULL_NOTE`. Su contenido es el texto completo, así que el receptor no necesita snapshot base ni metadatos de parche.

#### 2. `DELTA_PATCH`

Un archivo de texto de más de 64 KB puede publicarse como delta cuando se cumplen **todas** estas condiciones:

- Existe un snapshot base para la ruta.
- Se puede calcular un diff unificado contra ese snapshot.
- El diff serializado cabe en los límites multipart: como máximo **16** fragmentos (`MAX_DELTA_CHUNKS`), de **48 KB** cada uno (`DELTA_CHUNK_SIZE`).

La publicación consiste en una descripción `DELTA_PATCH` y uno o más eventos `DELTA_CHUNK`. Los metadatos del fragmento incluyen:

| Campo | Para qué sirve |
|---|---|
| `patchId` | Identificador del grupo de fragmentos |
| `chunkIndex` | Índice del fragmento (base 0) |
| `totalChunks` | Número total de fragmentos |
| `baseHash` | Identifica el snapshot exacto del que se generó el parche |
| `targetHash` | Identifica el contenido que debe existir tras aplicar el parche |

`baseHash` permite al receptor saber **sobre qué** se calculó el diff; `targetHash` le permite verificar el resultado. Si el `baseHash` no coincide con el snapshot local, el receptor **no** intenta aplicar el parche: en su lugar, la ruta entra en `pendingP2PSync` para una reconciliación completa.

#### 3. `BLOB_ATTACHMENT`

La vía de blob se usa cuando:

- El archivo es binario.
- No existe snapshot base para un archivo que lo necesitaría.
- El diff generado es demasiado grande para los límites de fragmentos.
- Blossom está activo, en cuyo caso se prefiere el transporte de blob al de nota o delta.

OmniSync sube el blob **cifrado** y publica un `BLOB_ATTACHMENT` con:

| Campo | Contenido |
|---|---|
| `blobSha256` | Hash SHA-256 del blob cifrado almacenado en el servidor Blossom |
| `blobSize` | Tamaño del blob cifrado en bytes (incluye IV y etiqueta AES-GCM) |
| `blobServer` | URL del servidor Blossom donde se depositó el blob |

### L.2 Los límites del canal

| Constante | Valor | Nota |
|---|---|---|
| `MAX_MAILBOX_NOTE_SIZE` | 64 KB | Límite de una nota completa |
| `MAX_MAILBOX_EVENT_CONTENT_LENGTH` | 256 KB | Límite del contenido de un evento |
| `DELTA_CHUNK_SIZE` | 48 KB | Tamaño de un fragmento de parche |
| `MAX_DELTA_CHUNKS` | 16 | Fragmentos máximos por parche |
| `MAX_DELTA_TOTAL_SIZE` | 16 × (48 KB − 3) | Tope total de un parche multipart |
| `MAX_LIVE_MULTIPART_GROUPS` | 16 | Grupos multipart simultáneos |
| `MAX_LIVE_MULTIPART_BYTES` | = `MAX_DELTA_TOTAL_SIZE` | Bytes máximos en grupos en curso |
| `MAX_PATCH_ID_LENGTH` | 128 | Longitud del `patchId` |
| `MAX_LIVE_MULTIPART_AGE_MS` | 5 min | Antigüedad de un grupo en curso |
| `MAX_MAILBOX_EVENTS_PER_FETCH` | 500 | Eventos por consulta |

El `− 3` de `MAX_DELTA_TOTAL_SIZE` reserva margen para no partir un punto de código UTF-8 en un fragmento.

### L.3 Por qué el parche antes que el blob

Para un archivo grande que cambia poco, el parche delta es mucho más pequeño que el blob completo, y un parche **no depende de Blossom**: viaja por el propio relay Nostr. Esto significa que un archivo grande sigue sincronizándose en modo P2P puro, sin ningún servidor de blobs configurado. La contrapartida es que **requiere** un snapshot base coherente en el receptor.

### L.4 Extensiones elegibles para el buzón

```ts
export const ELIGIBLE_MAILBOX_EXTENSIONS = /\.(md|markdown|txt|canvas|json|css)$/i;
```

Solo los archivos con estas extensiones viajan por el buzón como texto. Los binarios (imágenes, PDF, audio) van por Blossom.

## M. Interoperabilidad con MySecret

OmniSync puede operar en una bóveda que use el plugin MySecret de Obsidian, pero **no** evita, desbloquea ni gestiona el cifrado de MySecret. MySecret sigue siendo la autoridad sobre el estado de cifrado de la bóveda. OmniSync nunca solicita ni almacena la contraseña de MySecret.

La implementación está en `src/security/mysecret-compat.ts`.

### M.1 Detección del estado de bloqueo

Antes de preparar una publicación —y de nuevo antes de confirmarla— OmniSync comprueba el estado de bloqueo que reporta MySecret. Una bóveda se considera publicable **solo** cuando MySecret informa explícitamente que está desbloqueada y lista.

OmniSync **no** infiere la preparación a partir de si un archivo Markdown concreto resulta legible, porque eso puede producir una vista inconsistente durante el arranque, el apagado o una transición de desbloqueo.

Si MySecret está instalado pero su estado **no puede determinarse** —por ejemplo, mientras el plugin aún se está cargando— OmniSync trata la bóveda como **bloqueada**.

### M.2 Comportamiento «fail closed»

Cuando la bóveda está bloqueada, o su estado es incierto, OmniSync **no publica nada**:

- No envía archivos añadidos, modificados ni eliminados.
- No vacía la cola de cambios pendientes.
- No toca el estado remoto existente.

Este comportamiento «todo o nada» evita además que una bóveda bloqueada parezca ante el remoto como si sus archivos se hubieran eliminado.

### M.3 Por qué el descifrado parcial es peligroso

Una operación de desbloqueo o bloqueo puede producir un estado mixto: algunos archivos descifrados, otros aún cifrados, y contenido en caché que difiere de lo que hay en disco. Publicar ese estado podría:

- Exponer en claro contenido que debía permanecer protegido.
- Sobrescribir contenido remoto válido con ciphertext.
- Propagar un snapshot inconsistente de la bóveda.

El cifrado en el destino de la sincronización no puede deshacer un contenido que ya se publicó mal.

### M.4 El flujo normal con la bóveda desbloqueada

Una vez que MySecret informa de que la bóveda está desbloqueada, OmniSync reanuda su flujo normal:

1. Observa los cambios de la bóveda.
2. Construye el conjunto de publicación.
3. Sube la representación actual de la bóveda.
4. Registra el resultado.

Si MySecret bloquea la bóveda **durante** una publicación, OmniSync aborta antes de confirmar y no publica ninguna carga parcial. La bóveda puede reanudar la sincronización cuando MySecret informe de nuevo que está desbloqueada.

### M.5 Blindaje de contenido

MySecret puede proteger el contenido de un archivo con un sobre blindado. `src/security/mysecret-compat.ts` reconoce el formato por sus marcadores (`MYSECRET_ARMORED_START` / `MYSECRET_ARMORED_END`). Cuando OmniSync encuentra un archivo blindado:

- No intenta descifrarlo.
- Lo trata como contenido no publicable en claro.
- Si el usuario ha configurado el plugin, `repairDoubleEncryptedNotes()` permite reparar notas que quedaron doblemente cifradas.

> **Consecuencia práctica para el desarrollo:** si añades un camino de escritura que lea contenido de la bóveda, asegúrate de que pase por `MySecretCompat` para no publicar texto en claro que el usuario creía protegido.

## N. Ampliar la i18n: añadir un idioma

El ejemplo añade francés (`fr`). Sigue las convenciones reales del proyecto, que tienen su propia forma.

### N.1 La estructura actual

| Elemento | Ubicación | Contenido |
|---|---|---|
| Opción de idioma | `src/types.ts` | `LanguageOption = 'auto' \| 'en' \| 'es' \| 'ru' \| 'zh'` |
| Idiomas soportados | `src/i18n/types.ts` | `SupportedLanguage = 'en' \| 'es' \| 'ru' \| 'zh'` |
| Esquema | `src/i18n/types.ts` | `TranslationSchema` con todos los grupos de claves |
| Diccionarios | `src/i18n/locales/{en,es,ru,zh}.ts` | Un objeto exportado por idioma |
| Motor | `src/i18n/index.ts` | `LOCALES`, `t()`, `detectObsidianLocale()`, `resolveEffectiveLanguage()` |
| Selector | `src/ui/settings-tab.ts` | Las opciones del desplegable de idioma |
| Prueba | `tests/test-i18n.ts` | Comprueba que las claves coincidan en los cuatro idiomas |

### N.2 Añadir el idioma, paso a paso

**1. Amplía los dos tipos en `src/types.ts` y `src/i18n/types.ts`.**

```ts
// src/types.ts
export type LanguageOption = 'auto' | 'en' | 'es' | 'fr' | 'ru' | 'zh';

// src/i18n/types.ts
export type SupportedLanguage = 'en' | 'es' | 'fr' | 'ru' | 'zh';
```

**2. Crea el diccionario `src/i18n/locales/fr.ts`.**

Copia `src/i18n/locales/en.ts` y tradúcelo. Mantén **idéntica** la estructura de claves, los objetos anidados, las variables de interpolación (`{name}`, `{count}`) y los marcadores de posición. Traduce los **valores**, nunca renombres ni elimines claves.

```ts
export const fr = {
  settings: {
    language: 'Langue',
    // ...
  },
};
```

**3. Añade el nombre del idioma a todos los diccionarios.**

La clave debe ser **idéntica** en todos los idiomas; solo cambia el valor:

```ts
// src/i18n/locales/en.ts
language: { french: 'French' },
// src/i18n/locales/fr.ts
language: { french: 'Français' },
```

Así el selector de idioma funciona en cualquier idioma de interfaz.

**4. Registra el locale en `src/i18n/index.ts`.**

```ts
import { fr } from './locales/fr';

const LOCALES: Record<SupportedLanguage, TranslationSchema> = {
  en, es, fr, ru, zh,
};
```

Y actualiza `resolveEffectiveLanguage()` para que reconozca el prefijo:

```ts
if (option === 'es' || option === 'en' || option === 'fr' || option === 'ru' || option === 'zh') {
  return option;
}
```

**5. Añade la opción al desplegable de `src/ui/settings-tab.ts`.**

```ts
{ value: 'fr', label: t('language.french') },
```

**6. Valida.**

```bash
npm run test:i18n
```

La prueba falla si a un idioma le falta una clave o si tiene una clave de más. Corrige todas las diferencias antes de confirmar.

**7. Si Node se queja del locale**, reintenta con:

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run test:i18n
```

### N.3 Cómo funciona el motor de traducción

| Aspecto | Comportamiento |
|---|---|
| Detección automática | `detectObsidianLocale()` mira `localStorage.language` de Obsidian, luego `moment.locale()`, luego `navigator.language`. Si todo falla, devuelve `en`. |
| Cadena de repliegue | idioma actual → `en` → `es` → la propia clave de ruta |
| Interpolación | `t('grupo.clave', { name: 'X' })` sustituye `{name}` |
| Seguridad del prototipo | `getNestedValue()` usa `Object.getOwnPropertyDescriptor` y rechaza `__proto__`, `constructor` y `prototype` en cada segmento de la ruta. Las propiedades heredadas nunca se leen y los *getters* del prototipo no se ejecutan. |
| Proveedores Blossom | `getLocalizedBlossomProviderInfo()` solo acepta proveedores conocidos y usa `hasOwnProperty` |

> El último punto no es un detalle: sin `getOwnPropertyDescriptor`, una clave de traducción procedente de la interfaz podría alcanzar la cadena de prototipos. La prueba `test:i18n` no lo cubre, pero `test:security` sí comprueba el comportamiento del motor.

## O. Mapa del repositorio y archivos de referencia

### O.1 El árbol completo

```text
OmniSync/
├─ main.js                     # Bundle generado (se publica; NO se edita)
├─ manifest.json               # Metadatos del plugin; la versión va aquí
├─ styles.css                  # Estilos del plugin
├─ package.json                # Dependencias y scripts (incluye todas las suites)
├─ package-lock.json
├─ tsconfig.json               # TypeScript estricto, target ES2020
├─ esbuild.config.mjs          # Configuración del bundle (CommonJS, ES2020)
├─ eslint.config.mjs           # ESLint plano + eslint-plugin-security
├─ .semgrepignore              # Excluye src/i18n/locales (falso positivo conocido)
├─ .gitignore
├─ CHANGELOG.md
├─ LICENSE                     # PolyForm Noncommercial 1.0.0
├─ README.md / README.es.md
├─ PROTOCOL_WHITEPAPER.md
├─ OmniSync_for_Obsidian.pdf
├─ assets/                     # Iconos y banner (varios tamaños y formatos)
├─ docs/
│  ├─ Developer_Guide_EN.md     # Esta guía, versión inglesa
│  ├─ Guía de Desarrolladores.md # Esta guía, versión española
│  ├─ User_Guide_EN.md / Guía de Usuario.md
│  ├─ COMPARISON_EN.md / COMPARATIVA_es.md
│  ├─ PROTOCOL_WHITEPAPER.md
│  ├─ TESTS_AND_AUDITS.md / TESTS_AND_AUDITS_EN.md
│  ├─ audits/                  # Informes de auditoría de seguridad
│  └─ plans/                   # Planes de diseño
├─ src/
│  ├─ main.ts                  # Orquestador (2593 líneas): el corazón del plugin
│  ├─ types.ts                 # Tipos compartidos
│  ├─ crypto/crypto-manager.ts
│  ├─ network/                 # webrtc-peer, nostr-mailbox, blossom-client,
│  │                           # blossom-providers, signaling-client, pairing-channel
│  ├─ sync/                    # vault-watcher, manifest-calc, file-transfer,
│  │                           # delta-patch, base-snapshot-store, diff-merge
│  ├─ security/                # 13 módulos de validación y política (puros)
│  ├─ collab/codemirror-collab.ts
│  ├─ ui/                      # settings-tab, pairing-modal, cloudflare-worker-modal,
│  │                           # status-bar, icons
│  ├─ i18n/                    # index.ts, types.ts, locales/{en,es,ru,zh}.ts
│  └─ templates/cloudflare-worker-template.ts  # GENERADO, no editar
├─ scripts/
│  ├─ cloudflare-allinone/     # worker.js, wrangler.jsonc, package.json
│  ├─ cloudflare-blossom-worker.js
│  ├─ generate-cloudflare-templates.mjs
│  ├─ package-stable.mjs       # Genera zip/OmnySync_stable/
│  └─ sync-to-github.sh        # Copia el código fuente a Github/
├─ tests/                      # Suites + stubs + pruebas en vivo
└─ zip/                        # Paquete de publicación generado
```

### O.2 Los módulos de `src/security/` en detalle

| Archivo | Líneas | Responsabilidad | Exportaciones clave |
|---|---|---|---|
| `vault-security.ts` | 207 | Puerta única de rutas | `validateVaultPath`, `isAllowedVaultPath`, `isPlainObject`, `decodeCanonicalBase64`, `SecurityValidationError` |
| `protocol-security.ts` | 287 | Validación de mensajes y señales | `validateBaseProtocolMessage`, `validateAuthChallengePayload`, `validateAuthResponsePayload`, `validatePresencePayload`, `validateWebRtcSignal`, `ReplayGuard` |
| `transfer-security.ts` | 220 | Límites de transferencias y manifiestos | `validateFileHeader`, `validateFileChunk`, `validateFileDeletePayload`, `validateFileRenamePayload`, `validateRemoteManifest` |
| `sync-policy.ts` | 99 | Decisiones puras de conflicto | `decideRemoteWrite`, `decideRemoteDelete`, `decideRemoteRename`, `decideMailboxNote` |
| `network-security.ts` | 90 | URLs seguras | `validateSecureWebSocketUrl`, `validateSecureHttpUrl` |
| `worker-auth.ts` | 157 | Identidad NIP-98 del Worker | `deriveWorkerAuthKey`, `workerAuthPublicKey`, `normalizeWorkerHosts`, `isPrivateWorkerUrl`, `buildAuthenticatedSignalingUrl` |
| `settings-security.ts` | 46 | Saneado de booleanos | `sanitizeBooleanSettings`, `coerceBoolean` |
| `external-text.ts` | 97 | Saneado de texto externo | `sanitizeExternalText`, `sanitizeExternalError`, `warnExternal` |
| `pairing-session.ts` | 407 | Protocolo de emparejamiento efímero | `generatePairingToken`, `derivePairingRoom`, `PAIRING_LINK_PREFIX` |
| `pairing.ts` | 123 | Payload de emparejamiento v1 | `encodePairingPayload`, `decodePairingPayload` |
| `mysecret-compat.ts` | 438 | Interoperabilidad con MySecret | `MySecretCompat` |
| `concurrency-limiter.ts` | 64 | Límite de concurrencia | `ConcurrencyLimiter` |
| `path-operation-queue.ts` | 40 | Serialización por ruta | `PathOperationQueue` |
| `attachment-tidy.ts` | 24 | Carpeta de adjuntos oculta | `planAttachmentTidy`, `TIDY_ATTACHMENT_CSS` |

### O.3 Los archivos más grandes de `src/`

| Archivo | Líneas | Nota |
|---|---|---|
| `src/main.ts` | 2 593 | El orquestador. Si buscas un comportamiento, empieza aquí. |
| `src/network/nostr-mailbox.ts` | 1 608 | El buzón: publicación, consulta, delta, Blossom, reconexión. |
| `src/ui/cloudflare-worker-modal.ts` | 737 | El asistente de despliegue del Worker. |
| `src/sync/file-transfer.ts` | 709 | Transferencia de archivos por trozos. |
| `src/sync/delta-patch.ts` | 593 | Motor de diff (Myers) y parches unificados. |
| `src/ui/settings-tab.ts` | 522 | La pestaña de ajustes. |
| `src/collab/codemirror-collab.ts` | 521 | Cursores y selecciones remotas. |
| `src/network/blossom-client.ts` | 484 | Subida/descarga de blobs. |
| `src/ui/pairing-modal.ts` | 467 | El modal de emparejamiento. |
| `src/network/webrtc-peer.ts` | 447 | El peer WebRTC. |
| `src/network/signaling-client.ts` | 441 | Señalización por Nostr o WebSocket. |
| `src/crypto/crypto-manager.ts` | 431 | Todo lo criptográfico. |
| `src/sync/base-snapshot-store.ts` | 354 | Snapshots base cifrados en IndexedDB. |

### O.4 Documentos que debes leer según el cambio

| Si cambias… | Lee y actualiza |
|---|---|
| La arquitectura o los transportes | Esta guía, sección 3 y apéndice A |
| Los límites criptográficos | Sección 4 y apéndice D |
| La política de conflictos | Sección 6 y apéndice E |
| Los validadores de entrada | Sección 10 y apéndice K |
| El protocolo de red | `docs/PROTOCOL_WHITEPAPER.md` |
| Las pruebas o la cobertura | `docs/TESTS_AND_AUDITS.md` |
| El Worker de Cloudflare | Sección 7.4 y apéndice I |
| Los textos de la interfaz | `src/i18n/types.ts` y los cuatro diccionarios |

### O.5 El mirror `Github/`

`Github/` es un **espejo** del repositorio público: contiene `src/`, `tests/`, `scripts/`, `package.json`, `manifest.json`, `styles.css`, la CI (`.github/workflows/ci.yml` y `dependabot.yml`), `README.md`/`README.es.md` y `docs/`.

`npm run sync:github` sincroniza el código fuente con `rsync --delete`. **No** toca `README*`, `SECURITY*`, `CHANGELOG*`, `docs/`, `LICENSE` ni `assets/`, porque esos son curados a mano.

> **Al terminar un cambio en la documentación:** si modificas `docs/Developer_Guide_EN.md` o `docs/Guía de Desarrolladores.md`, copia también la versión correspondiente a `Github/docs/`. El script `sync:github` **no** lo hace por ti.

## P. Recetas operativas y de diagnóstico

### P.1 Referencia rápida de comandos

| Quiero… | Comando |
|---|---|
| Compilar en modo desarrollo (watch) | `npm run dev` |
| Compilar para producción | `npm run build` |
| Comprobar tipos | `npm run typecheck` |
| Comprobar estilo | `npm run lint` (o `npm run lint:fix`) |
| Correr todas las pruebas | `npm test` |
| Correr una suite | `npm run test:<nombre>` |
| Empaquetar para publicar | `npm run package:stable` |
| Regenerar las plantillas del Worker | `npm run build:templates` |
| Auditar dependencias, secretos y estático | `npm run audit` |
| Sincronizar el espejo `Github/` | `npm run sync:github` |

### P.2 Catálogo de suites de prueba

| Script | Archivo de prueba | Qué cubre |
|---|---|---|
| `test:security` | `tests/test-security.ts` | Validadores, primitivas criptográficas, reglas del canal WebRTC (1 341 líneas) |
| `test:realtime-security` | `tests/test-realtime-security.ts` | Seguridad del camino en tiempo real (633 líneas) |
| `test:nostr` | `tests/test-nostr-mailbox.ts` | Cifrado del buzón, validación de eventos |
| `test:nostr-delta` | `tests/test-nostr-delta-mailbox.ts` | Parches delta por el buzón |
| `test:delta` | `tests/test-delta-patch.ts` | Motor de parches (cálculo y aplicación) |
| `test:base` | `tests/test-base-snapshot-store.ts` | Almacén de snapshots base |
| `test:blossom` | `tests/test-blossom.ts` | Subida/descarga, NIP-98, validación de hashes |
| `test:mysecret` | `tests/test-mysecret-compat.ts` | Interoperabilidad con MySecret |
| `test:pairing` | `tests/test-pairing-session.ts` | Protocolo de emparejamiento |
| `test:pairing-channel` | `tests/test-pairing-channel.ts` | Canales de emparejamiento |
| `test:cloudflare-worker` | `tests/test-cloudflare-worker.ts` | Auth, salas y buzón del Worker |
| `test:cloudflare-allinone` | `tests/test-cloudflare-allinone-worker.ts` | El Worker todo en uno y sus plantillas |
| `test:cloudflare-mailbox` | `tests/test-cloudflare-mailbox.ts` | El buzón sobre Durable Objects |
| `test:i18n` | `tests/test-i18n.ts` | Que todas las claves existan en los cuatro idiomas |
| `test:core` | `tests/test-omnisync.mjs` | Integración del núcleo |
| `test:dual-path` | `tests/test-dual-path-regression.ts` | Cola de reenvío, serialización, backoff, volcado al cerrar, reconciliación de arranque |
| `test:bughunt` | `tests/test-bughunt-regression.ts` | Regresiones de bugs ya corregidos |
| `test:auditor` | `tests/test-auditor-regression.ts` | Regresiones de hallazgos de auditoría |
| `test:attachment-tidy` | `tests/test-attachment-tidy.ts` | Plan de carpeta de adjuntos |
| `test:attachment-tidy-runtime` | `tests/test-attachment-tidy-runtime.ts` | El mismo plan en runtime |
| `test:distribution` | `tests/test-distribution-artifact.ts` | El paquete publicado es idéntico a la compilación actual |
| `test:minimax` | `tests/verify-minimax.ts` | Verificación global de invariantes |

Además hay **pruebas en vivo** contra un Worker real desplegado (no forman parte de `npm test` porque necesitan red y un Worker desechable):

| Archivo | Qué hace |
|---|---|
| `tests/live-worker-e2e.ts` | Extremo a extremo contra un Worker real |
| `tests/live-worker-auth.ts` | Autorización NIP-98 contra un Worker real |
| `tests/live-worker-expiry.ts` | Caducidad de eventos en el Worker |
| `tests/live-worker-fuzz.ts` | Entradas hostiles contra un Worker real |

### P.3 Diagnóstico por síntoma

| Síntoma | Dónde mirar primero |
|---|---|
| Una nota no llega | Modo de sincronización (P2P puro no usa el relay) → `settings.signalingServer` → barra de estado → consola con `[OmniSync Mailbox]` |
| Una ruta atascada en `pendingMailboxOut` | El relay no confirmó la publicación |
| Falla con un relay público pero funciona con tu Worker | `https://<tu-worker>/` → `services.mailbox.status`; `missing_do_binding` = plantilla antigua |
| El Worker rechaza tu dispositivo | `ALLOWED_PUBKEYS` debe ser igual a `workerAuthPublicKeyHex`; `missing_allowed_pubkeys` = variable vacía |
| Faltan adjuntos en un dispositivo | Ese dispositivo no tiene servidor Blossom, tiene Blossom desactivado, o el archivo supera su límite |
| Falsos conflictos | `pendingP2PSync` con entradas de más hace que una nota parezca «modificada localmente» |
| El móvil deja de recibir en segundo plano | Es lo esperado (el sistema suspende los sockets). Consulta al reanudar, con `online` y cada 60 s mientras está activo |
| Una nota grande no sincroniza | Más de 64 KB sin Blossom y sin snapshot base solo viaja por P2P; activa Blossom |
| El teléfono y el escritorio se ignoran | El dominio de la etiqueta `d` cambió una vez (`mailbox-path-v1` → `mailbox-dtag-v2`); actualiza ambos |
| Bóveda MySecret | Mientras está bloqueada no se lee ni se publica nada (fail closed) |

### P.4 Prefijos de registro en la consola

Los mensajes del plugin en la consola de Obsidian (`Ctrl+Shift+I`) llevan estos prefijos:

| Prefijo | Origen |
|---|---|
| `[OmniSync Mailbox]` | Buzón Nostr: publicación, consulta, errores de reenvío y descarga |
| `[OmniSync WebRTC]` | Canal P2P: mensajes descartados, errores de ICE |
| `[OmniSync Signaling]` | Señalización: errores de WebSocket y de envío de señales |
| `[OmniSync Nostr]` | Eventos Nostr efímeros |
| `[OmniSync VaultWatcher]` | Lectura de archivos modificados |
| `[OmniSync MySecretCompat]` | Descifrado de texto blindado |

> **Regla de logs:** nunca registres el contenido de un mensaje, una ruta de archivo ni una credencial. Usa `sanitizeExternalError()` / `warnExternal()` de `src/security/external-text.ts`.

### P.5 Comprobaciones antes de publicar una versión

```bash
# 1. Todo debe pasar en verde
npm run typecheck && npm run lint && npm test

# 2. El paquete debe regenerarse y subirse al repositorio
npm run package:stable

# 3. Las plantillas del Worker deben estar sincronizadas
npm run build:templates && npm run test:cloudflare-allinone

# 4. La versión debe coincidir en los tres sitios
node -e "const p=require('./package.json'),m=require('./manifest.json');console.log(p.version,m.version)"

# 5. El CHANGELOG debe tener la entrada de esta versión
```

### P.6 Cómo leer la barra de estado

`src/ui/status-bar.ts` muestra un icono y un texto que dependen de `SyncState` y del número de pares:

| Estado | Indicación |
|---|---|
| `disconnected` | Sin conexión |
| `signaling` | Conectando al servidor de señalización |
| `connecting` | Negociando ICE |
| `connected` | Conectado, listo para sincronizar |
| `syncing` | Sincronizando ahora mismo |
| `error` | Error; hay que reintentar |

El icono tiene un `aria-label` traducible (`statusBar.tooltipDefault`) y es **interactivo**: un clic abre la acción principal según el estado.
