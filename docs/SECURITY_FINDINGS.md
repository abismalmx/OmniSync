# Resumen público de hallazgos de seguridad — OmniSync

Este documento resume todos los hallazgos identificados en las auditorías de seguridad de OmniSync, junto con su severidad, el parche aplicado y el test de regresión. No contiene pruebas de concepto (PoC) ni copias de archivos originales; esos artefactos son privados.

Para más contexto sobre cada auditoría, ver [`TESTS_AND_AUDITS.md`](TESTS_AND_AUDITS.md).

---

## Estado actual (v1.0.3, 2026-10-27)

| Capa | Qué se hizo | Resultado |
|---|---|---|
| Auditorías dirigidas y cacerías de bugs | Auditoría inicial, anonimato/Blossom, Worker todo-en-uno, emparejamiento y la sincronización de doble vía (relay + P2P) | Todos los hallazgos corregidos salvo las decisiones de diseño listadas al final |
| Línea base con herramientas automáticas | Semgrep, CodeQL, gitleaks (árbol e historial), osv-scanner, npm audit, ESLint, tsc, Syft + Grype y toda la batería de pruebas, en un sandbox | Sin secretos, sin dependencias vulnerables, sin hallazgos reales en el código; un hallazgo bajo en el CI, corregido |
| **Verificación en vivo en Workers reales de Cloudflare** | Workers todo-en-uno desechables desplegados desde cero con la plantilla actual y probados de extremo a extremo con el propio código del plugin | Todo funciona como está diseñado: sincronización con el otro dispositivo apagado, entrega en vivo, reemplazo de versiones, borrados y adjuntos de hasta 95 MB verificados byte a byte |
| **Comprobación de cifrado y ofuscación** | Registros del servidor capturados mientras se sincronizaba | El servidor solo vio identificadores opacos y texto cifrado AES-256-GCM: sin rutas, nombres ni texto (detalles en [`TESTS_AND_AUDITS.md`](TESTS_AND_AUDITS.md)) |
| **Pruebas dinámicas (DAST)** | Fuzzer propio, nuclei, OWASP ZAP y testssl.sh, en contenedores contra un Worker desechable, más una pasada ligera en uno real | 0 fallos y 0 errores de servidor; un endurecimiento aplicado |

**No cubierto:** escaneos autenticados con la clave de un usuario real, teléfonos reales, Obsidian en sí y una revisión humana independiente del protocolo criptográfico.

---

## Auditorías anteriores al auditor automático (2026-10-24)

Estas tres auditorías se realizaron antes de los runs automáticos, con revisión dirigida, PoC ejecutados contra el código real y herramientas estáticas. Los informes completos están en los archivos `.md` enlazados.

### Auditoría inicial — [`AUDIT_REPORT.md`](AUDIT_REPORT.md) — 45 hallazgos, todos corregidos

**Herramientas:** ESLint (creado desde cero), Semgrep 455+322 reglas, Gitleaks, osv-scanner, npm audit, tsc.

Hallazgos seleccionados por severidad crítica:

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| C-01 | Crítica | Clave maestra de 256 bits no garantizada | Corregido |
| C-04 | Crítica | Prefijo HMAC distinto al crear vs. verificar (bypass de autenticación) | Corregido |
| P-01 | Crítica | Validadores de mensajes no conectados a los handlers (eran decorativos) | Corregido |
| P-02 | Crítica | Sin `messageId` ni guard de replay (replay ilimitado) | Corregido |
| P-06 | Crítica | Handshake unidireccional (sin contradesafío) | Corregido |
| S-01 | Crítica | Endpoint `ws://` sin TLS admitido | Corregido |
| T-01 | Crítica | Hash/checksum inválido no impedía escribir | Corregido |
| T-02 | Crítica | Tamaño y nº de fragmentos sin validar (OOM) | Corregido |
| R-01 | Crítica | Validador de rutas desconectado del handler (path traversal) | Corregido |
| R-02 | Crítica | `.obsidian/plugins` ejecutable sincronizable | Corregido |
| S-05 | Crítica | Clave maestra en `data.json` en texto plano | Corregido |
| T-04 | Crítica | Orden remota antigua pisaba trabajo reciente | Corregido |

Listado completo (C-01…C-08, P-01…P-07, S-01…S-06, N-01…N-03, T-01…T-06, R-01…R-03, D-01…D-02) en [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md).

---

### Auditoría de anonimato y Blossom — [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md) — 10 hallazgos, todos corregidos

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| AN-01 | Crítica | NIP-98 sin vínculo con URL/método/cuerpo (firma válida no autorizaba la petición) | Corregido |
| AN-02 | Alta | Identidad del uploader persistida en R2 | Corregido |
| AN-03 | Alta | Cuerpo de subida leído sin cota real | Corregido |
| AN-04 | Alta | Misma pubkey para relay y Blossom (correlación de identidad) | Corregido |
| AN-05 | Media | Etiquetas `d`/`t`/`expiration` ambiguas | Corregido |
| AN-06 | Media | `subId` con prefijo y room ID visible (fingerprinting) | Corregido |
| AN-07 | Media | Descriptor de subida no verificado | Corregido |
| AN-08 | Media | Límites y allowlist manipulables desde `data.json` | Corregido |
| AN-09 | Media | `"false"` (string) en `data.json` activaba funciones booleanas | Corregido |
| AN-10 | Media | Cola de transferencias sin cota (DoS) | Corregido |

---

### Auditoría del Worker todo-en-uno — [`SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md) — 12 hallazgos, todos corregidos

**Herramientas:** lectura dirigida + PoC contra código real + mutation testing manual (8/8). Semgrep 167 reglas: 0. Gitleaks: 0.

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| AIO-01 | Crítica | Sin control de acceso al Worker (cualquier clave Nostr válida podía usarlo) | Corregido |
| AIO-02 | Crítica | Ligadura NIP-98 al cuerpo/host rota (regresión frente al worker anterior) | Corregido |
| AIO-03 | Alta | CPU por verificación Schnorr ~140–170 ms (BigInt afín, DoS) | Corregido |
| AIO-04 | Alta | Aislamiento de salas de señalización decorativo (filtro evadible) | Corregido |
| AIO-05 | Alta | Comando de despliegue en un clic roto (interpretación de shell, JSON inválido) | Corregido |
| AIO-06 | Media | Cabeceras de blobs servidos: `Content-Type` del atacante, sin `nosniff` | Corregido |
| AIO-07 | Media | Replay de señales WebRTC posible tras reinicio del plugin | Corregido |
| AIO-08 | Media | `wrangler ^3.114.0` en plantilla desplegable (8 vulnerabilidades, 7 altas) | Corregido |
| AIO-09 | Media | Bypass de política de rutas en Windows (alias 8.3, ADS, nombres reservados) | Corregido |
| AIO-10…12 | Baja | Hallazgos menores (ver informe) | Corregidos |

**Verificación final:** `tsc --noEmit` 0 · `npm run lint` 0 errores · Semgrep 0 · Gitleaks 0 · `npm test` EXIT 0 (402 aserciones en suites dedicadas).

---

## Hallazgos corregidos (auditor automático, 2026-10-26)

### SEC-01 — Artefacto de distribución desactualizado (Media)

- **Auditoría:** run `20261026-012049-5656`
- **Descripción:** `zip/OmnySync_stable/` contenía un build del 2026-10-24 mientras el código fuente era del 2026-10-25. El artefacto publicado no incluía las correcciones de privacidad del buzón Nostr (`mailbox-dtag-v2`), Blossom, parches delta ni snapshots cifrados.
- **Impacto concreto:** fuga de metadatos ante el relay (etiqueta `d` con prefijo `omnisync:` y `roomId` en claro); incompatibilidad silenciosa de buzón entre versiones.
- **Parche:** bundle reconstruido desde las fuentes actuales; `zip/OmnySync_stable/` y `.zip` regenerados.
- **Regresión:** `npm run test:distribution` (8 comprobaciones byte a byte). `npm run package:stable` garantiza reproducibilidad futura.

---

### SEC-02 — Sin comprobación de sincronía del artefacto (Baja)

- **Auditoría:** run `20261026-012049-5656`
- **Descripción:** no existía ningún test ni script que comparara `zip/OmnySync_stable/` con el build actual, de modo que la desincronía de SEC-01 podía repetirse en cada ciclo de release sin ningún fallo que lo detectara.
- **Parche:** `tests/test-distribution-artifact.ts` (nuevo) + `scripts/package-stable.mjs` + `npm run package:stable`.
- **Regresión:** `npm run test:distribution` (rojo con artefacto obsoleto, verde con el actual).

---

### SEC-03 — TTL del ReplayGuard menor que la validez efectiva del mensaje (Baja)

- **Auditoría:** run `20261026-032150-10258`
- **Descripción:** el TTL por defecto del `ReplayGuard` era 10 min, menor que la validez efectiva de los mensajes (hasta 15 min con desfase permitido), lo que dejaba una ventana de replay de 5 min.
- **Parche:** `protocol-security.ts`: TTL del ReplayGuard = `MAX_PROTOCOL_MESSAGE_AGE_MS + MAX_PROTOCOL_CLOCK_SKEW_MS` (15 min).
- **Regresión:** `npm run test:auditor`.

---

### H1 — Uso único violable por carrera (Baja–Media)

- **Auditoría:** run `20261026-145714-16806` (vinculación efímera)
- **Descripción:** dos mensajes `hello` válidos simultáneos podían pasar la comprobación de `consumed` antes de que se marcara, porque había un `await` entre la comprobación y la marca. Ambos recibían la clave maestra.
- **Condición:** requería conocer el token (128 bits) y enviar dos `hello` exactamente a la vez.
- **Parche:** flag `busy` en `PairingHostSession.handleHello` (`src/security/pairing-session.ts`).
- **Regresión:** `npm run test:pairing` (13 casos, incluido el de carrera).

---

### H2 — Sala `?pair=` del Worker sin autenticación del anfitrión (Media)

- **Auditoría:** run `20261026-145714-16806`
- **Descripción:** cualquier cliente en internet podía abrir WebSockets a salas arbitrarias de 64 hex y crear Durable Objects, lo que generaba consumo en la cuenta Cloudflare del usuario sin exponer datos.
- **Parche:** el anfitrión debe autenticarse con NIP-98 (rol `host`, fijado por el Worker, no forjable por query); el invitado solo puede unirse si ya hay un anfitrión (404 si no; 409 si ya hay uno).
- **Regresión:** `npm run test:cloudflare-allinone` Test 7b.

---

### H3 — QR ajeno podía sustituir la clave sin mostrar el servidor de destino (Media, ingeniería social)

- **Auditoría:** run `20261026-145714-16806`
- **Descripción:** un QR generado por un atacante hacía que la víctima adoptara la clave maestra, `server` y `privateWorker` elegidos por el atacante. La confirmación no mostraba el host de destino (ver también SEC-14, que amplía esta corrección al flujo del enlace profundo).
- **Parche:** `pairNewDevice` muestra el servidor antes de adoptar una clave nueva cuando difiere del actual.
- **Regresión:** `npm run test:auditor` (contratos i18n en 4 idiomas).

---

### N1 — Worker reenviaba `kind`/`role` suministrados por el cliente (Baja)

- **Auditoría:** run `20261026-151238-24575`
- **Descripción:** la ruta normal del Worker reenviaba al Durable Object los campos `kind` y `role` tal como los enviaba el cliente autorizado, lo que le permitía manipular sus propios límites de sala.
- **Parche:** `kind` y `role` eliminados de los datos que el Worker reenvía al DO.
- **Regresión:** `npm run test:cloudflare-allinone`.

---

### N2 — `deviceId` duplicado podía renombrar un dispositivo ya vinculado (Baja)

- **Auditoría:** run `20261026-151238-24575`
- **Descripción:** quien poseyera el token podía enviar un `deviceId` ya vinculado durante el proceso de vinculación, lo que renombraba/reetiquetaba ese dispositivo en el anfitrión.
- **Parche:** si el `deviceId` ya existe, la sesión solo refresca su estado; no permite renombrar.
- **Regresión:** `npm run test:pairing`.

---

### B1 — Canal huérfano tras `startInvite` solapado (Media)

- **Auditoría:** run `20261026-150816-20845` (bug_hunter)
- **Descripción:** llamar a `startInvite` dos veces (cambiar canal o regenerar QR mientras el primero aún abre, o cerrar el modal) dejaba el canal anterior abierto hasta 5 min y sus callbacks podían marcar como caducada la nueva invitación.
- **Parche:** contador `inviteGen` en `pairing-modal.ts`; el handle tardío se cancela si `inviteGen` ya cambió.
- **Regresión:** `npm run test:bughunt`.

---

### B2 — Socket del invitado no se cerraba en error; `complete()` mal tolerante (Media)

- **Auditoría:** run `20261026-150816-20845`
- **Descripción:** en caso de error, el socket del invitado no se cerraba. Además, si `complete()` fallaba tras adoptar la clave, `pairNewDevice` devolvía `false` aunque la clave ya se hubiera sustituido.
- **Parche:** `abort()` en el bloque `catch` de `pairNewDevice`; fallo de `complete()` solo muestra un aviso (no revierte la clave adoptada).
- **Regresión:** `npm run test:bughunt`.

---

### B3 — Modal conservaba QR de invitación anterior tras vincular (Baja)

- **Auditoría:** run `20261026-150816-20845`
- **Descripción:** tras completar la vinculación como invitado, el modal seguía mostrando el QR de la invitación anterior.
- **Parche:** el modal reinicia la invitación al completar el flujo de invitado.
- **Regresión:** `npm run test:bughunt`.

---

### B4 — Invitado esperaba 30 s si el canal se cerraba; error en `buildHello` sin capturar (Baja)

- **Auditoría:** run `20261026-150816-20845`
- **Descripción:** si el canal se cerraba mientras el invitado esperaba, permanecía en espera hasta 30 s. Los errores de `buildHello` no se capturaban.
- **Parche:** cierre rápido del invitado al cerrar el canal; captura de errores en `buildHello`.
- **Regresión:** `npm run test:pairing-channel` (test nuevo, 5/5).

---

### B5 — Plataforma del invitado fijada después de notificar a la UI (Baja)

- **Auditoría:** run `20261026-150816-20845`
- **Descripción:** en el anfitrión, la plataforma del invitado se asignaba después de notificar a la UI, lo que causaba un icono incorrecto un instante.
- **Parche:** la plataforma se fija antes de la notificación.
- **Regresión:** `npm run test:pairing`.

---

### SEC-12 — `wrangler` (devDep del Worker) con DoS en el parser EventSource de `undici` (Baja)

- **Auditoría:** run `20261026-155140-28734`
- **Descripción:** `wrangler 4.152.0` (dependencia de desarrollo del Worker) arrastraba `undici` con vulnerabilidades de DoS por memoria sin límite en el parser EventSource y bypass SRI. Solo afectaba a la máquina del desarrollador (no al bundle de producción ni a los usuarios del plugin).
- **Parche:** `wrangler` actualizado a `4.153.0`; lockfile regenerado en sandbox; plantilla embebida regenerada con `npm run build:templates`.
- **Regresión:** `npm run test:cloudflare-allinone` Test 8 (plantilla sincronizada).

---

### SEC-13 — `pairNewDevice` no era reentrante (Baja)

- **Auditoría:** run `20261026-155140-28734`
- **Descripción:** el enlace `obsidian://omnisync-pair` y el botón «Vincular» del modal podían ejecutarse concurrentemente, entrelazando la escritura de `pairingSecret`, `roomId` y claves derivadas.
- **Parche:** guarda `pairingInFlight` en `pairNewDevice` (liberada en `finally`); aviso `pairingInProgress` en i18n en 4 idiomas.
- **Regresión:** `npm run test:auditor` (contrato de `main.ts`; verificado rojo→verde quitando la guarda).

---

### SEC-14 — `deepLinkConfirm` no mostraba el host de destino (Baja)

- **Auditoría:** run `20261026-155140-28734`
- **Descripción:** el invitado se conectaba a `invite.server` antes de mostrar el host en la confirmación. Un QR ajeno revelaba la IP del usuario a un servidor arbitrario sin que el usuario pudiera ver el destino.
- **Parche:** `deepLinkConfirm` muestra `{server}` del payload antes de conectar; i18n actualizado en 4 idiomas.
- **Regresión:** `npm run test:auditor` (4 idiomas incluyen `{server}`).

---

### R1 — UI colapsaba «Avanzado» al renovar el QR (Baja)

- **Auditoría:** run `20261026-152037-17189`
- **Descripción:** al regenerarse el QR cada 2 min, la tarjeta de invitación se repintaba y colapsaba la sección «Avanzado», ocultando el QR heredado de clave permanente que el usuario estaba mirando.
- **Parche:** se conserva el estado abierto (`legacyOpen`) al regenerar la tarjeta.
- **Regresión:** test visual (no automatizable en Node sin Obsidian).

---

### BUG-L1 — 2 errores `no-shadow` que romperían lint en CI (Informativo)

- **Auditoría:** run `20261026-155140-28734`
- **Descripción:** `pairing-modal.ts:391` (variable `parent` que hacía sombra al parámetro del constructor) y `tests/test-cloudflare-allinone-worker.ts:456` (variable `room`).
- **Parche:** `parent` → `container` (con comprobación de nulo); `room` → `pairDoRoom`.
- **Regresión:** `eslint src tests scripts --quiet`: 0 errores.

---

## Hallazgos corregidos (revisión de la doble vía, 2026-10-27, v1.0.1)

Auditoría acotada del código de sincronización de doble vía (relay + P2P). Regresión: `npm run test:dual-path`.

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| A-01 | Media | El reintento podía publicar versiones locales viejas al relay y pisar una más nueva para los dispositivos que sincronizan después. | Corregido |
| A-02 | Baja–Media | La cola de reenvío no estaba serializada con los envíos normales (carrera que podía publicar contenido viejo al final). | Corregido |
| A-03 | Baja | Un relay que acepta y cierra la conexión provocaba un bucle de reconexión y consultas (carga al relay, batería). | Corregido |
| A-04 | Baja | Al descargar el plugin no se esperaba el reenvío pendiente antes de cerrar el buzón. | Corregido |
| A-05 | Info | En modo doble vía cada edición también va al relay (contenido cifrado AES-GCM, etiqueta `d` opaca), por lo que el relay ve frecuencia y tamaño de ediciones. El modo «P2P puro» evita relays. | Aceptado |
| A-06 | Info | Reintento indefinido (1 evento/min/archivo) si un archivo nunca se puede publicar. | Aceptado |
| A-07 | Info | La reconciliación al arrancar y el envío al cerrar solo encolan/envían rutas de la bóveda ya validadas; se omiten con la bóveda bloqueada. | Aceptado |

---

## Hallazgos corregidos (línea base completa y verificación en vivo, 2026-10-27, v1.0.3)

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| L-01 | Baja | El CI usaba GitHub Actions por etiqueta mutable y Dependabot no tenía cooldown (endurecimiento de la cadena de suministro). | Corregido: acciones fijadas por SHA de commit; cooldown de 7 días en Dependabot |
| B-08 | Alta para usuarios del todo-en-uno | Un Worker desplegado con una plantilla antigua no tenía buzón: la señalización P2P funcionaba pero las notas nunca se guardaban, así que nada llegaba con el otro dispositivo apagado. El fallo era silencioso. | Corregido: el plugin lo detecta al arrancar y en el asistente de Cloudflare y pide redesplegar; la plantilla actual despliega el buzón. Verificado en Workers reales |
| W-03 | Baja | El ajuste «Ordenar los adjuntos» interpolaba la ruta de adjuntos en un selector CSS: una ruta con saltos de línea (por ejemplo, venida de `.obsidian` sincronizado por un dispositivo autenticado) podía inyectar reglas CSS; además ocultaba cualquier carpeta de adjuntos elegida por el usuario y una carpeta «Adjuntos» con notas. | Corregido: el CSS es constante, solo se oculta la carpeta propia «Adjuntos» y solo si no contiene notas. Prueba `test:attachment-tidy` |
| W-04 | Informativa | La regla de ciclo de vida de R2 (10 días) afecta a todo el cubo: si alguien reutiliza un cubo llamado `omnisync-blossom` que guarde otros archivos, se borrarían. | Documentado: el asistente avisa de que el cubo debe ser exclusivo de OmniSync |
| W-02 | Baja | Los archivos guardados en el cubo R2 del Worker (Blossom) nunca caducaban, así que el almacenamiento y las versiones viejas de adjuntos se acumulaban hasta llenar la cuota gratuita. Los eventos del buzón ya caducaban a los 7 días. | Corregido: el comando de despliegue añade una regla de ciclo de vida de R2 que borra los archivos a los 10 días (los 7 del aviso del buzón más un margen). Los servidores existentes la añaden con un solo comando. Caducidad del buzón verificada en vivo con vidas de 10 s y 60 s. **Pendiente de comprobar:** la regla está creada y Cloudflare la acepta, pero el borrado real de los archivos de R2 a los 10 días aún no se ha observado en vivo (Cloudflare lo ejecuta en segundo plano, normalmente en las 24 h posteriores a vencer, y su mínimo es 1 día). |
| W-01 | Baja | Las respuestas JSON del Worker (página de estado y errores) no enviaban `X-Content-Type-Options: nosniff` ni `Cache-Control: no-store`. | Corregido en el Worker y su plantilla embebida; verificado en vivo. Un Worker desplegado con una plantilla anterior debe redesplegarse |

Regresión: `npm run test:dual-path` (incluye la detección de Worker sin buzón), las suites `test:cloudflare-*` y las comprobaciones manuales en vivo `tests/live-worker-e2e.ts`, `tests/live-worker-auth.ts` y `tests/live-worker-fuzz.ts`.

---

*Comprobación en vivo de lo que ve el servidor (datos cifrados y ofuscados): ver [`TESTS_AND_AUDITS.md`](TESTS_AND_AUDITS.md).*

---

## Riesgos residuales aceptados

Estos riesgos fueron identificados, evaluados y aceptados explícitamente por diseño:

| Riesgo | Mitigación existente |
|---|---|
| QR fotografiado usable dentro de su ventana de 2 min | TTL corto, uso único, lista de dispositivos vinculados (revisar y desvincular si se detecta algo anómalo) |
| QR hostil que el usuario escanea y confirma | El usuario ve la clave y el servidor de destino antes de confirmar (H3/SEC-14) |
| Peticiones anónimas a `?pair=` instancian un Durable Object vacío (coste mínimo antes del 404) | Añadir rate limiting de Cloudflare en el Worker propio |
| El token de vinculación pasa por el portapapeles al copiar la invitación | El token caduca en 2 min y es de un solo uso |
| CORS permisivo (`Access-Control-Allow-Origin: *`) en el Worker | Intencional: el plugin se ejecuta desde el origen de Obsidian y Blossom lo espera. Toda escritura y WebSocket exige autorización NIP-98, y todo lo que se puede leer está cifrado de extremo a extremo |
| El servidor puede observar metadatos: cuándo ocurren los cambios, su tamaño aproximado y número, y la sala pseudónima del buzón | El contenido, las rutas y los nombres van cifrados o convertidos en hash. No se añadió relleno ni tráfico señuelo, para mantener la sincronización rápida. El modo «P2P puro» evita los relays por completo |
| La memoria anti-repetición del Worker es por instancia (mejor esfuerzo) | Las subidas se direccionan por contenido y son idempotentes, así que un evento NIP-98 repetido no tiene efecto |
| El borde de Cloudflare aún ofrece TLS 1.0/1.1 en `workers.dev` | Es un ajuste de Cloudflare, no del plugin; además toda la carga va cifrada de extremo a extremo |

## Hallazgos no resueltos (requieren decisión de diseño)

| ID | Sev. | Descripción |
|---|---|---|
| SEC-04 | Baja | ReplayGuard se llena antes de autenticar (evicción con 50k eventos firmados) |
| SEC-05 | Media | Sobrescritura sin copia de conflicto para archivos no-.md sin base local |
| SEC-06 | Baja | Worker: `u` de `/upload` ignora query (NIP-98); anti-replay con TOCTOU y por isolate |
| SEC-07 | Baja–Media | Worker sin lockfile propio (`@noble/curves ^2`, `wrangler ^4`) |
| SEC-08 | Baja | DoS CPU/memoria: `threeWayMerge`, Myers diff, WS sin límite de tasa |
| SEC-09 | Baja–Media | Identidad compartida, sin revocación por dispositivo |
| SEC-10 | Baja | Eventos Nostr re-firmados (rollback/resurrección) sin AAD |

Estos hallazgos requieren una decisión de diseño antes de parchear. No se han corregido sin consultar al autor.

---

*Para reportar una nueva vulnerabilidad, ver [`SECURITY_ES.md`](../SECURITY_ES.md).*

*Última actualización: 2026-10-27.*
