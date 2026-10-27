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
