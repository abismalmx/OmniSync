# Auditoría de Seguridad — Worker Todo-en-Uno (Blossom R2 + Señalización WebSocket)

> Documento técnico de la tercera revisión de seguridad de OmniSync, centrada en la
> implementación nueva del **Worker Todo-en-Uno de Cloudflare** (`scripts/cloudflare-allinone/`)
> y en el asistente que lo despliega y configura desde el plugin.
>
> **Alcance:** `scripts/cloudflare-allinone/worker.js`, `scripts/cloudflare-allinone/wrangler.jsonc`,
> `scripts/cloudflare-allinone/package.json`, `scripts/cloudflare-blossom-worker.js`,
> `scripts/generate-cloudflare-templates.mjs`, `src/templates/cloudflare-worker-template.ts`,
> `src/ui/cloudflare-worker-modal.ts`, `src/security/worker-auth.ts` (nuevo),
> `src/network/signaling-client.ts`, `src/network/blossom-client.ts`, `src/network/nostr-mailbox.ts`,
> `src/security/vault-security.ts`, `src/sync/manifest-calc.ts`, `src/main.ts`, i18n y sus pruebas.
>
> **Resultado:** 12 hallazgos (`AIO-01`…`AIO-12`) corregidos y cubiertos con regresiones,
> incluida una batería de **mutation testing** manual sobre el Worker (8/8 mutaciones detectadas).
> `npx tsc --noEmit` 0 errores · `npm test` EXIT 0 (402 aserciones en las suites dedicadas) ·
> `npm run build` limpio · `npm run lint` 0 errores · Semgrep (167 reglas) 0 hallazgos ·
> Gitleaks 0 fugas.
>
> Este documento complementa a [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) y a
> [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](./SECURITY_AUDIT_ANONYMITY_BLOSSOM.md), que cubren
> el plugin base y la revisión anterior de anonimato/Blossom.

---

## Índice

1. [Resumen ejecutivo](#1e-resumen-ejecutivo)
2. [Metodología](#2-metodología)
3. [Tabla de hallazgos y parches](#3-tabla-de-hallazgos-y-parches)
4. [Control de acceso al Worker (AIO-01)](#4-control-de-acceso-al-worker-aio-01)
5. [Ligadura de la firma NIP-98 (AIO-02)](#5-ligadura-de-la-firma-nip-98-aio-02)
6. [Coste de CPU de la verificación Schnorr (AIO-03)](#6-coste-de-cpu-de-la-verificación-schnorr-aio-03)
7. [Aislamiento de salas de señalización (AIO-04)](#7-aislamiento-de-salas-de-señalización-aio-04)
8. [Comando de despliegue en un clic (AIO-05)](#8-comando-de-despliegue-en-un-clic-aio-05)
9. [Cabeceras de contenido servido (AIO-06)](#9-cabeceras-de-contenido-servido-aio-06)
10. [Replay de señales WebRTC (AIO-07)](#10-replay-de-señales-webrtc-aio-07)
11. [Dependencias del Worker desplegable (AIO-08)](#11-dependencias-del-worker-desplegable-aio-08)
12. [Bypass de la política de rutas en Windows (AIO-09)](#12-bypass-de-la-política-de-rutas-en-windows-aio-09)
13. [Identidad estable de acceso al Worker (nuevo mecanismo)](#13-identidad-estable-de-acceso-al-worker-nuevo-mecanismo)
14. [Hallazgos menores (AIO-10, AIO-11, AIO-12)](#14-hallazgos-menores-aio-10-aio-11-aio-12)
15. [Mutation testing del Worker](#15-mutation-testing-del-worker)
16. [Verificación final](#16-verificación-final)
17. [Limitaciones y trabajo pendiente](#17-limitaciones-y-trabajo-pendiente)

---

## 1. Resumen ejecutivo

| Métrica | Antes | Después |
|---|---|---|
| Control de acceso al Worker | Ninguno (cualquier clave Nostr válida) | Allowlist `ALLOWED_PUBKEYS`, fail-closed |
| Ligadura NIP-98 al cuerpo/host | Rota (regresión frente al worker anterior) | Restaurada y reforzada (+ `nonce`, + replay) |
| CPU por verificación Schnorr | ~140–170 ms (BigInt afín) | ~4–6 ms (`@noble/curves` / Jacobiano) |
| Aislamiento de salas de señalización | Decorativo (DO global, filtro evadible) | Sala HMAC autenticada, límites de aforo/ritmo/tamaño |
| Comando de despliegue de 1 clic | Roto (interpretación de shell, JSON inválido) | Verificado con ejecución real en sandbox |
| Cabeceras de blobs servidos | `Content-Type` del atacante, sin `nosniff` | `application/octet-stream` forzado + `nosniff` + CSP + `Content-Disposition` |
| Replay de señales WebRTC | Posible tras reinicio del plugin | Ventana temporal en cada señal interna |
| `wrangler` en la plantilla desplegable | `^3.114.0` (8 vulnerabilidades, 7 altas) | `^4.0.0` |
| Bypass de política de rutas (Windows) | `plugins.`, `.git.`, `CON.md`, alias 8.3, ADS | Bloqueados |
| `npx tsc --noEmit` | OK | OK |
| `npm run lint` | 0 errores, 127 avisos | 0 errores, 131 avisos (nuevo código, mismos falsos positivos) |
| Semgrep (167 reglas) | 0 hallazgos | 0 hallazgos |
| Gitleaks | 0 fugas | 0 fugas |
| `npm test` | 13 suites en verde (solo casos felices) | 13 suites en verde + ~140 aserciones negativas nuevas |

**Veredicto:** la implementación del Worker Todo-en-Uno tenía fallos de diseño graves
—sin control de acceso, con una regresión criptográfica y con un flujo de despliegue
roto— que ninguna herramienta automática (Semgrep, ESLint, Gitleaks, `npm audit`, los
13 suites de tests existentes) detectó, porque todas verifican forma y no comportamiento
adversarial. Se confirmaron con PoCs ejecutados contra el código real (no simulado) y se
corrigieron con pruebas negativas y, para el Worker, con mutation testing manual.

---

## 2. Metodología

1. **Lectura dirigida** del Worker nuevo, el modal, las plantillas embebidas y los puntos
   de confianza del plugin (recepción de mensajes WebRTC, escritura en el Vault, persistencia
   de secretos).
2. **Herramientas deterministas:** `tsc --noEmit`, ESLint (`eslint-plugin-security`), Semgrep
   (`p/javascript`, `p/typescript`, `p/security-audit`, 167 reglas), Gitleaks, `npm audit`
   (del plugin y del proyecto desplegable generado por la plantilla).
3. **PoCs ejecutables contra el código real.** En vez de razonar en abstracto, cada hipótesis
   se verificó invocando `worker.fetch(...)` y `SignalingRoom` reales (vía el stub
   `tests/cloudflare-workers-stub.ts` que ya usa el proyecto) con R2 y Durable Objects
   simulados, y el `BlossomClient` real del plugin contra el Worker.
4. **Reproducción del flujo de usuario.** El comando de despliegue de un clic se ejecutó
   literalmente en un directorio temporal aislado del repositorio.
5. **Mutation testing manual del Worker** tras el parche: se desactivó cada control uno a
   uno (comparar hash, ligar URL, verificar firma, replay, comparar sala, cabeceras,
   autenticar WebSocket) y se confirmó que la suite de regresión falla en cada caso.
6. **Benchmark de CPU** de la verificación Schnorr antes/después, en Node, como
   aproximación (no exacta, pero representativa) del coste en el runtime de Workers.

---

## 3. Tabla de hallazgos y parches

| ID | Severidad | Hallazgo | Archivo principal | Estado |
|---|---|---|---|---|
| AIO-01 | **Alta** | El Worker "privado" no tenía control de acceso | `scripts/cloudflare-allinone/worker.js` | Corregido |
| AIO-02 | **Alta** | La firma NIP-98 no quedaba ligada al cuerpo ni al host (regresión) | `scripts/cloudflare-allinone/worker.js` | Corregido |
| AIO-03 | **Alta** | La verificación Schnorr costaba ~140–170 ms de CPU por petición | `scripts/cloudflare-allinone/worker.js`, `scripts/cloudflare-blossom-worker.js` | Corregido |
| AIO-04 | **Alta** | El relay de señalización no aislaba salas y era abusable | `scripts/cloudflare-allinone/worker.js`, `src/network/signaling-client.ts` | Corregido |
| AIO-05 | **Alta** | El comando de despliegue de 1 clic estaba roto y era peligroso | `src/templates/cloudflare-worker-template.ts`, `scripts/generate-cloudflare-templates.mjs` | Corregido |
| AIO-06 | Media | Contenido servido con `Content-Type` del atacante, sin `nosniff` | `scripts/cloudflare-allinone/worker.js`, `scripts/cloudflare-blossom-worker.js` | Corregido |
| AIO-07 | Media | Las señales de señalización eran reproducibles tras reinicio | `src/network/signaling-client.ts` | Corregido |
| AIO-08 | Media | La plantilla instalaba `wrangler@3.x`, con 8 vulnerabilidades | `scripts/cloudflare-allinone/package.json` | Corregido |
| AIO-09 | Media | Bypass de la política de rutas del Vault en Windows | `src/security/vault-security.ts` | Corregido |
| AIO-10 | Baja | `/list` era código muerto con lógica incorrecta | `scripts/cloudflare-allinone/worker.js` | Eliminado |
| AIO-11 | Baja | Claves heredadas de `Object.prototype` en `computeDelta` | `src/sync/manifest-calc.ts` | Corregido |
| AIO-12 | Info | Textos de privacidad sobreprometían respecto al diseño real | i18n (`es`, `en`, `ru`, `zh`) | Corregido |

---

## 4. Control de acceso al Worker (AIO-01)

**Antes:** `verifyNip98(request, 'upload')` validaba que la firma Schnorr fuera matemáticamente
correcta, pero no comprobaba *quién* firmaba. Cualquier par de claves Nostr generado al vuelo
podía subir blobs al R2 del usuario y abrir el WebSocket de señalización sin credencial alguna.
La única protección era que la URL del Worker no fuera adivinada.

**PoC (antes del parche):** con una clave aleatoria se subió 1&nbsp;KB de datos y el Worker
respondió `200`.

**Parche:** `getAllowedPubkeys(env)` lee la variable de texto `ALLOWED_PUBKEYS` (lista de
claves hex de 64 caracteres separadas por comas o espacios, máx. 32). Si no hay ninguna clave
válida configurada, **todo** se rechaza con `503` (fail-closed): no hay modo "abierto por
defecto". Con claves configuradas, cualquier evento firmado por una clave fuera de la lista
se rechaza con `403`, **antes** de la verificación Schnorr (ver AIO-03) y sin tocar R2.

```js
// scripts/cloudflare-allinone/worker.js
const allowed = getAllowedPubkeys(ctx.env);
if (!allowed) return { ok: false, status: 503, error: 'Servidor sin configurar: define ALLOWED_PUBKEYS' };
// ... validaciones de formato baratas ...
if (!allowed.has(event.pubkey)) return fail('Clave no autorizada', 403);
// ... solo entonces: comparación de URL, replay, Schnorr ...
```

El mismo control se añadió al `fetch` de WebSocket: sin `?room=` + `?auth=` válidos y firmados
por una clave autorizada, el Worker nunca llega a invocar al Durable Object.

**Regresión:** `tests/test-cloudflare-allinone-worker.ts` (Test 3) prueba que una clave válida
pero ajena recibe `403` y no produce ninguna escritura en R2 (`bucket.putCalls` no cambia), y
que `ALLOWED_PUBKEYS` ausente, vacía o con solo valores inválidos cierra el servidor con `503`.
`tests/test-cloudflare-worker.ts` (Test 12–13) cubre el mismo control en el worker
"solo Blossom" del panel web.

---

## 5. Ligadura de la firma NIP-98 (AIO-02)

El worker Todo-en-Uno era una **reescritura**, no una copia, del worker "solo Blossom"
anterior (`scripts/cloudflare-blossom-worker.js`), y en la reescritura se perdieron
comprobaciones que el worker anterior sí tenía:

- `verifyNip98(request, 'upload')` nunca recibía el hash esperado, así que la etiqueta `x`
  firmada no se comparaba contra el cuerpo recibido.
- La comparación de la etiqueta `u` usaba solo `pathname`, no la URL completa (host incluido).
- No había ningún mecanismo anti-replay.

**PoC (antes del parche):** con el mismo token firmado, un cuerpo HTML distinto del firmado
se aceptó con `200`; el mismo token firmado para `host-A` se aceptó también en `host-B`.

**Parche:** se restauró y se reforzó la ligadura completa:

1. `u` se compara como **URL absoluta** (`new URL(eventUrl).href !== new URL(ctx.expectedUrl).href`),
   incluyendo host, ruta y query string.
2. `method` debe coincidir con el método HTTP real.
3. En subidas, la etiqueta `payload` (SHA-256 del cuerpo) es obligatoria, y **R2 mismo** la
   verifica al guardar (`env.MY_BUCKET.put(sha256Hex, request.body, { sha256: sha256Hex, ... })`),
   de modo que el cuerpo nunca se acumula en memoria del isolate antes de comprobarse.
4. Se añadió una etiqueta `nonce` aleatoria en el cliente (`BlossomClient.createNip98AuthHeader`
   y `worker-auth.ts`) y una caché anti-replay en el Worker (`seenEventIds`, TTL 5 min,
   máx. 10 000 entradas) que marca cada `event.id` válido como usado.
5. `expiration` sigue siendo obligatoria y se verifica contra el reloj del Worker.

```js
// scripts/cloudflare-allinone/worker.js (verifyNip98, extracto)
if (seenEventIds.has(event.id)) return fail('Evento ya utilizado');
// ...
if (bytesToHex(digest) !== event.id) return fail('El id del evento no coincide con su contenido');
let validSig = false;
try { validSig = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey)); } catch {}
if (!validSig) return fail('Firma Schnorr inválida');
seenEventIds.set(event.id, nowMs + REPLAY_TTL_MS);
```

**Regresión:** `tests/test-cloudflare-allinone-worker.ts` (Test 4) prueba de forma aislada
cada ligadura rota (otro host, otra ruta, con query, otro método, sin `payload`, caducada,
antigua, firma alterada, esquema incorrecto, token ilegible) y el replay del mismo evento
válido. `tests/test-cloudflare-worker.ts` cubre el mismo conjunto para el worker
"solo Blossom".

---

## 6. Coste de CPU de la verificación Schnorr (AIO-03)

Ambos workers verificaban BIP-340 con aritmética de curva propia en coordenadas afines
(una inversión modular por cada suma de puntos). Medido en Node/V8, una verificación
completa costaba **~140–170 ms de CPU**, incluida la petición con firma inválida (el coste
no cambiaba con una clave desconocida, porque la comprobación de credencial no existía:
ver AIO-01). El plan gratuito de Cloudflare Workers limita la CPU por petición a 10 ms, así
que las subidas legítimas probablemente fallaban en producción con el error 1102
("Worker exceeded CPU time limit"), contradiciendo la promesa de "costo cero" del asistente.

**Parche:**

- **Worker Todo-en-Uno:** se sustituyó la aritmética propia por `@noble/curves/secp256k1`
  (`schnorr.verify`), ya usada transitivamente por `nostr-tools` y por tanto sin coste nuevo
  de dependencias de confianza.
- **Worker "solo Blossom" (panel web, sin `npm install`):** como ese worker se pega a mano en
  el editor de Cloudflare y no puede traer dependencias, se mantuvo la implementación propia
  pero se reescribió la suma/duplicación de puntos en **coordenadas Jacobianas**
  (`jacAdd`/`jacDouble`/`jacToAffine`), que hace una sola inversión modular al final en vez
  de una por cada operación de punto.
- En ambos, el control de acceso (AIO-01) se evalúa **antes** de cualquier paso criptográfico,
  así que una clave no autorizada no paga ni siquiera ese coste reducido.

**Medición tras el parche** (PoC en Node, mediana de 15 peticiones completas, incluye
`fetch`/`Request`/JSON además de la criptografía):

| Worker | Mediana | Mejor caso |
|---|---|---|
| Todo-en-Uno (`@noble/curves`) | ~4.5 ms | ~3.3 ms |
| Solo Blossom (Jacobiano) | ~6.1 ms | ~4.8 ms |

Reducción de ~30×. Es una medición en Node, no en el runtime real de `workerd`; sirve como
cota relativa, no como garantía exacta de que nunca se alcanzarán los 10 ms bajo carga.

**Regresión:** no se afirma un límite de tiempo en la suite (sería frágil en CI), pero
`tests/test-cloudflare-allinone-worker.ts` y `tests/test-cloudflare-worker.ts` ejercitan
`schnorr.verify`/la curva Jacobiana en cada caso positivo y negativo, de modo que cualquier
regresión de correctud (no de rendimiento) se detecta.

---

## 7. Aislamiento de salas de señalización (AIO-04)

Antes del parche:

- El cliente (`SignalingClient`) conectaba a `wss://host` **sin** `?roomId=`, así que todos
  los dispositivos y bóvedas de todos los usuarios de un mismo Worker caían en el mismo
  Durable Object (`omnisync-global`).
- El filtro de reenvío en `SignalingRoom.webSocketMessage` dejaba pasar un mensaje hacia un
  socket que **no** tuviera `roomId` asignado todavía, y un mensaje **sin** `roomId` se
  reenviaba a todos los sockets conectados, sea cual sea su sala.
- Cualquier `?roomId=` arbitrario (sin autenticación) creaba un Durable Object nuevo, sin
  límite de longitud, de sockets por sala, de tamaño de mensaje ni de ritmo.

**PoC (antes del parche):** un socket que nunca mandó nada ("pasivo") recibió mensajes de
dos salas distintas (`roomA`, `roomB`); un `roomId` de 5000 caracteres creó un Durable Object
sin fricción.

**Parche:**

1. El cliente ahora conecta usando `buildAuthenticatedSignalingUrl(serverUrl, room, workerAuthKey)`
   (ver §13), que fija `?room=<sala HMAC de 256 bits>&auth=<token NIP-98 de un solo uso>` en
   la URL, en vez de conectar "a pelo".
2. El Worker valida el token NIP-98 (ligado a host+ruta+`room`, caducidad y clave autorizada)
   **antes** del `Upgrade`, y reenvía al Durable Object únicamente el parámetro `room` (el
   `auth` se elimina de la URL reenviada, para que ni siquiera llegue al DO).
3. El Durable Object fija la sala en `server.serializeAttachment({ room })` al aceptar el
   socket, y en `webSocketMessage` **exige** que el sobre declare exactamente esa sala
   (`data.roomId !== room` descarta el mensaje); ya no hay ruta en la que "sin sala asignada"
   signifique "recibe todo".
4. Límites añadidos: 32 sockets por sala (`MAX_SOCKETS_PER_ROOM`), 512 KB por mensaje
   (`MAX_SIGNALING_MESSAGE_BYTES`), 120 mensajes cada 10 s por socket
   (`RATE_LIMIT_MAX_MESSAGES`/`RATE_LIMIT_WINDOW_MS`).

```js
// scripts/cloudflare-allinone/worker.js (SignalingRoom.webSocketMessage, extracto)
const meta = ws.deserializeAttachment?.();
const room = meta && typeof meta.room === 'string' ? meta.room : null;
if (!room || !isPlainObject(data) || data.roomId !== room) return;
```

**Regresión:** `tests/test-cloudflare-allinone-worker.ts` (Tests 6–7) prueba que un intento
de `Upgrade` sin token, con sala inválida, con clave ajena, con token firmado para otra sala
u otro host no crea ningún Durable Object (`requestedRooms.length === 0`); que el token no se
reenvía al DO; que un mensaje sin `roomId`, con sala ajena, no-JSON o no-objeto nunca se
retransmite; que un socket sin sala autenticada no reenvía nada; y que exceder tamaño, ritmo o
aforo cierra el socket o rechaza la conexión.

---

## 8. Comando de despliegue en un clic (AIO-05)

El botón "Copiar comando de despliegue" copiaba `CLOUDFLARE_ONELINER_DEPLOY_COMMAND`, una
cadena de 22 KB generada a mano que incrustaba el contenido completo de los tres archivos
dentro de `echo "..."`. Ejecutado literalmente en una terminal bash/zsh:

- Los backticks y `${...}` dentro del `echo` se interpretaban como sustitución de comandos
  (bash intentó ejecutar fragmentos del propio `worker.js`, como `${url.origin}/${sha256Hex}`).
- Los `\n` quedaban literales y `$schema` se expandía a vacío, así que ni `package.json` ni
  `wrangler.jsonc` resultaban JSON válido.
- El modal mostraba un comando corto y de aspecto inocuo
  (`mkdir -p omnisync-server && cd omnisync-server && npx wrangler deploy`), pero copiaba al
  portapapeles un texto completamente distinto que el usuario no podía inspeccionar antes de
  pegarlo en su terminal.

**PoC (antes del parche):** ejecutar el comando generado, sin el paso final de red, en un
directorio temporal no creó ningún archivo; bash emitió errores de sustitución de comandos.

**Parche:** se creó `scripts/generate-cloudflare-templates.mjs` (`npm run build:templates`),
que construye el one-liner con **heredocs de delimitador entrecomillado**
(`cat > archivo <<'OMNISYNC_EOF'` … `OMNISYNC_EOF`), forma en la que bash **no** interpreta
backticks, `$()`, `${}` ni variables dentro del cuerpo: el contenido de cada archivo llega
intacto. El script también verifica que ningún archivo contenga una línea igual al delimitador
(lo que rompería el heredoc) y falla en tiempo de generación si ocurriera. El modal ahora
muestra en un bloque desplazable (`<pre class="omnisync-cf-code-container is-scrollable">`)
exactamente el texto que el botón copia — ya no hay divergencia entre lo visible y lo copiado.

**Verificación:** el comando generado se ejecutó literalmente (sin el paso `wrangler deploy`,
que requiere red y una cuenta de Cloudflare) en un directorio temporal aislado del repositorio;
los tres archivos resultantes son **idénticos byte a byte** a los archivos fuente en
`scripts/cloudflare-allinone/`.

**Regresión:** `tests/test-cloudflare-allinone-worker.ts` (Test 8) comprueba que las
plantillas embebidas en `src/templates/cloudflare-worker-template.ts` coinciden exactamente
con los archivos fuente (detecta si alguien edita el worker y olvida regenerar la plantilla),
que `wrangler.jsonc` no fija una versión `^3.x` de wrangler, y que el one-liner usa el
delimitador `<<'OMNISYNC_EOF'` y no un `echo "..."` que reintroduciría el problema.

---

## 9. Cabeceras de contenido servido (AIO-06)

Un blob descargado se servía con el `Content-Type` **declarado por quien lo subió** y sin
`X-Content-Type-Options`, `Content-Security-Policy` ni `Content-Disposition`. Un atacante con
acceso de subida (ver AIO-01) podía alojar, por ejemplo, `text/html` bajo el dominio
`*.workers.dev` del usuario, abriendo una vía de phishing/XSS reflejado desde un origen de
apariencia legítima.

**Parche:** toda respuesta de blob (`GET`/`HEAD /:sha256`) fuerza
`Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: attachment` y
`Cross-Origin-Resource-Policy: cross-origin`, sin importar lo que declare el metadato
almacenado. El `Content-Type` del cliente tampoco se persiste ya en R2 al subir.

**Regresión:** `tests/test-cloudflare-allinone-worker.ts` (Test 2) y
`tests/test-cloudflare-worker.ts` (caso 11) comprueban las cuatro cabeceras en `GET` y `HEAD`,
incluso cuando el objeto simulado en R2 declara `text/html` en sus metadatos (para probar que
el Worker ignora ese valor y no solo que nunca lo guardó).

---

## 10. Replay de señales WebRTC (AIO-07)

`InnerSignal` (el mensaje cifrado que viaja dentro del sobre de señalización) no llevaba
ninguna marca de tiempo. El único control de repetición era `ReplayGuard`, que vive en
memoria y se vacía al reiniciar el plugin o tras expirar su ventana de 10 minutos. Una señal
de "join"/oferta capturada por un relé podía reproducirse pasado ese tiempo o tras un reinicio
del dispositivo, sin que ningún control adicional lo impidiera.

**Parche:** cada `InnerSignal` incluye ahora `timestamp: Date.now()` al cifrarse
(`sendEncrypted`), y `handleInnerSignal` descarta cualquier señal cuyo timestamp no esté
dentro de la misma ventana que ya usa el protocolo WebRTC
(`MAX_PROTOCOL_MESSAGE_AGE_MS` = 10 min hacia atrás, `MAX_PROTOCOL_CLOCK_SKEW_MS` = 5 min
hacia delante), reutilizando las constantes ya definidas en `protocol-security.ts` para no
introducir una segunda política de ventanas temporales.

**Regresión:** `tests/test-security.ts` (`testWorkerIdentityAndSignals`) construye cuatro
señales de `join` — reciente, antigua, del futuro y sin timestamp — y comprueba que solo la
reciente dispara `onPeerJoined`.

---

## 11. Dependencias del Worker desplegable (AIO-08)

`scripts/cloudflare-allinone/package.json` fijaba `"wrangler": "^3.114.0"`. Al resolver ese
rango (`npm install --package-lock-only` en un proyecto limpio), `npm audit` reportó
**8 vulnerabilidades (1 moderada, 7 altas)** arrastradas por `wrangler@3.114.17`: `ws`
(divulgación de memoria sin inicializar / DoS por fragmentos), `sharp` (CVEs de `libvips`,
`libheif`, `librsvg`), `zod` (agotamiento de memoria) y `esbuild` (servidor de desarrollo
expuesto). Estas dependencias no corren en el Worker en producción (son herramientas de
`wrangler` en la máquina del usuario), pero sí se ejecutan localmente cuando el usuario sigue
las instrucciones del asistente.

**Parche:** se fijó `"wrangler": "^4.0.0"` en `scripts/cloudflare-allinone/package.json` y en
la plantilla regenerada.

---

## 12. Bypass de la política de rutas en Windows (AIO-09)

`validateVaultPath` bloqueaba `.git`, `.trash` y `.obsidian/plugins` por **comparación exacta
de string** contra el segmento normalizado. En Windows, el sistema de archivos:

- elimina los puntos y espacios finales de un nombre (`"plugins."` y `"plugins "` se resuelven
  al mismo directorio que `"plugins"`);
- no distingue mayúsculas/minúsculas;
- expone alias cortos 8.3 (`PLUGIN~1`) que pueden referirse a un directorio de nombre largo;
- trata `:` como separador de flujo alternativo NTFS (`nota.md:script.js`);
- reserva nombres de dispositivo (`CON`, `NUL`, `LPT1`, …) sin importar la extensión.

**PoC (antes del parche):** contra el validador real, con `syncObsidianConfig` activo,
pasaban como válidas rutas como `.obsidian/plugins./evil/main.js`, `.obsidian./plugins/evil/main.js`,
`.git./hooks/pre-commit`, `.git /hooks/pre-commit`, `notes/a.md:evil.js`, `notes/CON.md` y
`.obsidian/PLUGIN~1/evil/main.js` — todas ellas resolverían, en Windows, a un recurso que la
política pretende bloquear. El impacto concreto (ejecución de un plugin de Obsidian escrito
por un peer emparejado, o acceso al repositorio Git) no se verificó en un Obsidian real sobre
Windows; se verificó únicamente a nivel del validador de rutas.

**Parche:** se añadieron en `src/security/vault-security.ts`:

- `canonicalSegment()`: recorta puntos/espacios finales y pasa a minúsculas antes de comparar
  contra `.git`, `.trash`, `plugins` y los nombres de archivo de configuración bloqueados.
- Rechazo explícito de segmentos que terminen en `.`/espacio, que contengan
  `<>:"|?*`, que coincidan con un nombre reservado de Windows (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1-9`, `LPT1-9`, con o sin extensión), o que contengan un alias corto 8.3 (`~N`) cuando la
  ruta empieza por un directorio oculto.
- `PROTOTYPE_PROPERTY_NAMES` ampliado más allá de `__proto__`/`constructor`/`prototype` (ver
  también AIO-11).

**Regresión:** `tests/test-security.ts` (`testPlatformPathHardening`) prueba cada variante por
separado y, por simetría, confirma que nombres legítimos parecidos (`Mi nota.md`,
`notas/a~1.md`, `Console.md`, un snippet CSS real) siguen permitidos — es decir, que el
endurecimiento no introdujo falsos positivos groseros.

---

## 13. Identidad estable de acceso al Worker (nuevo mecanismo)

El control de acceso de AIO-01 necesita que todos los dispositivos emparejados compartan
**la misma** clave pública para poder listarla en `ALLOWED_PUBKEYS`. Antes del parche, cada
cliente (`SignalingClient`, `NostrMailbox`) generaba una clave Nostr **aleatoria por sesión**
(`generateSecretKey()`), lo que es correcto para no ser correlacionable frente a relays
públicos, pero incompatible con una allowlist frente a un servidor propio.

Se añadió `src/security/worker-auth.ts`, que deriva una identidad **determinista** a partir
del secreto de emparejamiento ya existente, mediante HMAC con un dominio propio
(`worker-auth-v1`, independiente de los dominios de cifrado ya usados:
`OmniSync-Salt-v1`, `OmniSync-Signaling-v1`, `OmniSync-Mailbox-v1`, `OmniSync-Blossom-v1`), y
reintenta hasta 8 veces si el escalar resultante cae fuera del rango válido de secp256k1
(probabilidad ~2⁻¹²⁸ por intento, por rigor más que por necesidad práctica).

Puntos de diseño deliberados:

- **Nunca se usa por defecto.** `isPrivateWorkerUrl(url, privateWorkerHosts)` decide, host por
  host, si corresponde presentar la identidad estable; con cualquier servidor no marcado
  explícitamente como propio (relays públicos, Blossom públicos) se sigue usando una clave
  efímera no correlacionable, igual que antes del parche.
- `privateWorkerHosts` se rellena automáticamente al guardar desde el asistente
  (`CloudflareWorkerModal.rememberPrivateHost`), nunca por el usuario tecleando un host a
  mano sin pasar por el asistente.
- `detectProtocol()` en `SignalingClient` considera que un host con identidad de Worker
  propio **nunca** es un relay Nostr (evita que un Worker cuyo nombre de dominio contenga
  casualmente la palabra "nostr" se trate con el protocolo equivocado).
- El buzón Nostr (`NostrMailbox`) se desactiva explícitamente cuando `signalingServer` es un
  Worker propio (`signalingIsPrivateWorker` en `main.ts`): un Worker no es un relay persistente
  y, sin este guardado, el buzón entraría en un bucle de reconexión rechazada.
- Cada token de acceso (`buildAuthenticatedSignalingUrl`) es de un solo uso: lleva `nonce` y
  caducidad corta (90 s), y el Worker lo marca como usado tras aceptarlo.

**Regresión:** `tests/test-security.ts` (`testWorkerIdentityAndSignals`) comprueba que la
derivación es determinista para el mismo secreto, distinta para secretos distintos, que la
clave pública resultante no coincide ni con la sala de señalización ni con ningún prefijo
observable de la clave de vault, y ejercita `normalizeWorkerHost`/`normalizeWorkerHosts`/
`isPrivateWorkerUrl`. `tests/test-cloudflare-allinone-worker.ts` (Test 5) prueba de extremo a
extremo que `BlossomClient.uploadBlob` con la identidad estable sube correctamente contra el
Worker real, y que con una clave efímera (comportamiento de un servidor no marcado como propio)
la misma subida es rechazada por el control de acceso.

---

## 14. Hallazgos menores (AIO-10, AIO-11, AIO-12)

**AIO-10 — `/list` muerto y lógico-incorrecto.** El endpoint `GET /list/<pubkey>` buscaba
objetos bajo el prefijo `blobs/<pubkey>/`, pero los blobs se almacenan en la raíz del bucket
(`env.MY_BUCKET.put(sha256Hex, ...)`), así que el endpoint **siempre** devolvía una lista
vacía; además no comprobaba que `pubkey` coincidiera con el firmante autenticado. Ningún
cliente del plugin lo invoca. Se eliminó por completo en vez de arreglarlo, al no tener uso
real. `tests/test-cloudflare-allinone-worker.ts` (Test 9) confirma que la ruta ya no existe
(`404`).

**AIO-11 — Claves heredadas de `Object.prototype` en el cálculo de manifiestos.**
`validateRemoteManifest` solo rechazaba `__proto__`, `prototype` y `constructor` como clave
de ruta; un manifiesto remoto con una entrada llamada `toString` o `valueOf` pasaba la
validación y, al indexar `localFiles[path]`/`remoteFiles[path]` en `ManifestCalculator`, el
acceso devolvía la función heredada del prototipo en vez de `undefined`, lo que podía producir
una decisión de sincronización espuria. Se corrigió en dos capas: `PROTOTYPE_PROPERTY_NAMES`
(lista ampliada de nombres reservados en `vault-security.ts`) y, además, `computeDelta` ahora
usa `Object.prototype.hasOwnProperty.call(files, key)` explícitamente, en vez de indexación
directa, como defensa en profundidad. `tests/test-security.ts` prueba, con mutation testing
manual (revertir el `hasOwnProperty.call` a indexación directa), que la regresión se detecta
en `toUpload`, `toDownload`, `conflicts` **y** `toDelete`.

**AIO-12 — Textos de privacidad sobreprometían respecto al diseño real.** `manifest.json`
afirmaba "Sin servidores de terceros ni almacenamiento en la nube" y el banner del asistente
decía "Máxima privacidad... costo cero" sin matices, cuando el plugin usa STUN público de
Google (expone la IP del dispositivo a un tercero), relays Nostr y, opcionalmente, Cloudflare.
Se corrigió la descripción de `manifest.json` y los textos del banner en los cuatro idiomas
para describir con precisión qué es privado (el contenido, cifrado de extremo a extremo; el
Worker, de uso exclusivo del propietario de la clave) y qué no lo es por diseño (metadatos de
red visibles a STUN/relays).

---

## 15. Mutation testing del Worker

Tras completar el parche, se desactivó manualmente, una a la vez, cada control de seguridad
del Worker Todo-en-Uno y se ejecutó `npm run test:cloudflare-allinone` contra cada versión
mutada, restaurando el archivo original entre cada prueba:

| Control desactivado | Resultado esperado | Resultado obtenido |
|---|---|---|
| Comprobación de `ALLOWED_PUBKEYS` | Debe fallar un test | ✅ Detectada |
| Comparación de URL firmada | Debe fallar un test | ✅ Detectada |
| Verificación de `sha256` al guardar en R2 | Debe fallar un test | ✅ Detectada |
| Caché anti-replay de eventos | Debe fallar un test | ✅ Detectada |
| Verificación de firma Schnorr | Debe fallar un test | ✅ Detectada (tras corregir un test que reutilizaba un evento ya marcado como usado, lo que enmascaraba esta mutación concreta detrás de AIO-02) |
| Comparación de `roomId` en `SignalingRoom` | Debe fallar un test | ✅ Detectada |
| Cabecera `X-Content-Type-Options: nosniff` | Debe fallar un test | ✅ Detectada |
| Verificación NIP-98 antes del `Upgrade` de WebSocket | Debe fallar un test | ✅ Detectada |

8 de 8 mutaciones detectadas. La única que sobrevivió en el primer intento no era un hueco en
el parche sino un defecto del propio test (reutilizaba un evento `nonce`-único ya consumido
por una aserción anterior, así que el rechazo seguía ocurriendo, pero por la razón equivocada:
replay en vez de firma inválida); se corrigió generando un evento fresco para ese caso
concreto y se confirmó que, con el fix del test, la mutación de la firma sí se detecta.

---

## 16. Verificación final

```
npx tsc --noEmit -p tsconfig.json        → sin errores
npm run lint                              → 0 errores, 131 avisos (mismos falsos positivos preexistentes de eslint-plugin-security)
npm run build                             → OK (main.js regenerado, 629 014 bytes)
npm test                                  → EXIT 0, todas las suites en verde:
                                             - test:cloudflare-allinone → 9 bloques, incluida la prueba de deriva de plantillas
                                             - test:cloudflare-worker   → 13 casos, incluidos los 2 nuevos de control de acceso
                                             - test:security            → 167 aserciones (antes 128; +39 nuevas de rutas/identidad/señales)
                                             - resto de suites preexistentes (minimax, nostr, mysecret, delta, base, nostr-delta,
                                               blossom, realtime-security, i18n, core) sin cambios de comportamiento
semgrep (167 reglas, p/javascript+typescript+security-audit)  → 0 hallazgos
gitleaks --no-git                         → no leaks found
npm audit (plugin)                        → 0 vulnerabilidades
npm audit (scripts/cloudflare-allinone, tras el bump a wrangler ^4) → pendiente de confirmación con `npm install` real (ver §17)
```

---

## 17. Limitaciones y trabajo pendiente

- **No se desplegó ningún Worker real en Cloudflare.** Todas las verificaciones corren contra
  el handler `fetch`/`SignalingRoom` reales, pero con R2 y Durable Objects **simulados** en
  Node (vía `tests/cloudflare-workers-stub.ts`). El comportamiento bajo el runtime real de
  `workerd` (límites de CPU exactos, semántica de Hibernation API, latencia de red) no se
  verificó en producción.
- **No se probó en Windows ni dentro de Obsidian.** El bypass de AIO-09 y su corrección se
  verificaron únicamente contra la función `validateVaultPath` en Node; no se confirmó el
  comportamiento del sistema de archivos de Windows ni de la API de Vault de Obsidian con
  esos nombres de archivo concretos.
- **`@noble/curves` no está declarado como dependencia directa del plugin.** Llega de forma
  transitiva a través de `nostr-tools`, de la que ya depende el proyecto; los tests del Worker
  lo importan directamente. Se recomienda declararlo en `package.json`
  (`dependencies` o `devDependencies`, según uso) y regenerar `package-lock.json`, para no
  depender implícitamente de que `nostr-tools` siga arrastrándolo en versiones futuras.
- **`npm audit` del proyecto `scripts/cloudflare-allinone` tras el bump a `wrangler@^4`** no
  se volvió a ejecutar con una instalación real completa (requiere red); se verificó antes del
  parche que `^3.114.0` tenía 8 vulnerabilidades, y se aplicó el cambio de versión mínima, pero
  no se confirmó el árbol de dependencias resultante de `^4.0.0`.
- **`zip/OmnySync_stable`** sigue conteniendo un bundle anterior a esta auditoría y a la
  anterior ([`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](./SECURITY_AUDIT_ANONYMITY_BLOSSOM.md));
  no se ha regenerado como parte de este trabajo.
- **El STUN público de Google** (`stun.l.google.com` y variantes, en
  `src/network/webrtc-peer.ts`) sigue siendo el valor por defecto y expone la IP del
  dispositivo a un tercero durante el intercambio ICE; esto es una propiedad conocida de WebRTC
  y queda fuera del alcance de esta revisión, que se centró en el Worker nuevo.
- Las mediciones de CPU de la verificación Schnorr (§6) se tomaron en Node/V8 como
  aproximación; no reflejan necesariamente el coste exacto bajo `workerd`.
