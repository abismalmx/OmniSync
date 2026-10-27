# Changelog — OmniSync

Todos los cambios notables de este proyecto se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).

---

## [1.0.4] — 2026-10-27

### Corregido

- **Ajuste «Ordenar los adjuntos»:** cuatro bugs detectados en la revisión de bugs y corregidos: (1) el CSS interpolaba la ruta de adjuntos en el selector; ahora es constante, sin datos externos; (2) si la versión de Obsidian no ofrece el ajuste de carpeta, ya no se oculta nada; (3) la comprobación del buzón del Worker no reintentaba tras un error HTTP transitorio (por ejemplo 503); (4) el ajuste `tidyAttachments` no pasaba por el saneado de booleanos de `data.json` como los demás.
- **Paso manual del asistente (Windows):** el paso 2 del asistente de Cloudflare solo traía los tres archivos; ahora incluye los comandos para crear el cubo R2 y la regla de 10 días en los 4 idiomas.
- **Paquete de distribución en CI:** la carpeta `zip/` no se incluía en el commit, lo que hacía fallar las pruebas de artefacto en CI; corregido.

### Añadido

- **Prueba de regresión `test:attachment-tidy-runtime`:** ejerce el ajuste «Ordenar los adjuntos» sobre el plugin real con DOM y vault simulados; cubre configurar, ocultar, apagar, volver a encender, carpeta propia del usuario y versión de Obsidian sin la API.

---

## [1.0.3] — 2026-10-27

### Corregido

- **Cloudflare Worker sin buzón:** un Worker desplegado con una plantilla antigua no tenía el buzón (`MAILBOX_ROOM`): la señalización P2P funcionaba pero las notas nunca se guardaban y el fallo era silencioso, por lo que nada llegaba si el otro dispositivo estaba apagado. El plugin ahora lo detecta al arrancar y avisa que hay que redesplegar el Worker con la plantilla actual.
- **Retención de archivos en Cloudflare:** los avisos del buzón caducan a los 7 días (verificado en vivo con caducidades de 10 s y 60 s), pero los archivos de Blossom en R2 no caducaban y se acumulaban hasta llenar los 10 GB gratuitos. El comando del asistente ahora crea una regla de R2 que borra los archivos a los 10 días (7 del aviso más margen). Quien ya tenga un servidor: `npx wrangler r2 bucket lifecycle add omnisync-blossom expire-blobs --expire-days 10 -y`, o desde el panel de Cloudflare (R2 → tu cubo → Settings → Object lifecycle rules). Prueba nueva en vivo: `tests/live-worker-expiry.ts`. **Pendiente de comprobar:** la regla está creada y Cloudflare la acepta, pero el borrado real de los archivos de R2 a los 10 días aún no se ha observado en vivo (Cloudflare lo ejecuta en segundo plano, normalmente en las 24 h posteriores a vencer, y su mínimo es 1 día).
- **Asistente de Cloudflare:** la tarjeta de estado también comprueba que el Worker tenga el buzón y lo marca como error si falta.

### Añadido

- **Adjuntos ordenados (ajuste «Ordenar los adjuntos», activo por defecto):** al pegar una imagen, Obsidian la guarda como archivo suelto en la raíz de la bóveda. Ahora el plugin, si no elegiste ya otra carpeta de adjuntos, configura «Adjuntos» como destino de los nuevos y la oculta del explorador de archivos con un estilo propio. Las imágenes siguen viéndose en las notas y se sincronizan igual. No se usa una carpeta con punto (`.adjuntos`) porque Obsidian no indexa esas carpetas y las imágenes dejarían de mostrarse. Tras auditarlo: el CSS es constante (sin interpolar rutas), solo se oculta la carpeta propia y nunca si contiene notas; el asistente avisa de que el cubo R2 debe ser exclusivo de OmniSync. Tras una revisión de bugs: si esta versión de Obsidian no ofrece el ajuste de carpeta de adjuntos no se oculta nada, y el paso manual del asistente (Windows) ahora incluye crear el cubo y la regla de 10 días, que antes solo traía el comando de una línea.
- **Prueba de extremo a extremo contra un Worker real** (`tests/live-worker-e2e.ts`, manual, fuera de `npm test`): un dispositivo publica con el otro apagado y el segundo lo recibe al conectar; entrega en vivo, reemplazo de versiones, borrado y adjuntos Blossom (subida, descarga, descifrado y comparación byte a byte, hasta 95 MB), Worker de solo Blossom, y comprobación de que el servidor solo ve etiquetas opacas y contenido cifrado. Verificada con Workers desplegados desde cero con la plantilla actual.
- **Endurecimiento del Worker:** las respuestas JSON (estado y errores) envían `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`. Un Worker con plantilla anterior debe redesplegarse para tenerlo.
- **Pruebas dinámicas (DAST):** fuzzer propio de la autorización NIP-98 y del WebSocket del buzón (`tests/live-worker-fuzz.ts`, manual), más nuclei, OWASP ZAP y testssl.sh en contenedores, contra un Worker desechable y una pasada ligera contra uno real. Sin fallos ni errores 5xx.
- **Comprobación de acceso** (`tests/live-worker-auth.ts`, manual): contra un Worker real y sin conocer su secreto, comprueba que todo lo que no sea la clave autorizada se rechaza (buzón, señalización, subida).

---

## [1.0.1] — 2026-10-27

### Corregido

- **Sincronización con el dispositivo apagado:** las notas escritas mientras el otro dispositivo estaba apagado ahora llegan al reencender, vía el relay (Cloudflare, Worker propio u otro relay Nostr). Se consulta al abrir la conexión, cada 60 s, al volver a primer plano y al recuperar red.
- **Doble vía inmediata:** cada edición se publica al relay (si el buzón está activo) y por P2P si hay un par conectado. Ya no depende de que el par esté realmente vivo.
- **Reintento con espera creciente** (2 / 5 / 15 / 60 s), persistente entre reinicios, que se vacía al ocultar o cerrar la app.
- **Ediciones al cerrar:** una edición dentro de los 350 ms previos al cierre ya no se pierde, y al arrancar se envían al relay las ediciones locales que nunca llegaron.
- **Avisos:** los avisos de «sincronización P2P» se limitan a uno cada 10 minutos y su texto es más claro. Una nota de más de 64 KB sin Blossom activo muestra un aviso breve que indica activar Blossom.
- Reenvíos que podían subir una versión local vieja al relay, reconexiones en bucle contra relays inestables y cierre que destruía el buzón antes de entregar.

### Añadido

- **Modo de sincronización** en ajustes: «Doble vía» (relay + P2P) o «P2P puro» (sin relays).
- Suite `test:dual-path` con regresiones de la doble vía.

---

## [1.0.0] — 2026-10-26

Primera versión pública.

### Añadido

- **Sincronización P2P en tiempo real** vía WebRTC DataChannel con cifrado E2E (AES-256-GCM).
- **Buzón asíncrono Nostr** (kind 30078) con parches delta comprimidos para sincronización entre sesiones.
- **Blossom** (BUD-01/02): transferencia de archivos adjuntos con hash SHA-256 y autenticación NIP-98.
- **Vinculación efímera por QR**: protocolo ECDH P-256 + HKDF-SHA256 + AES-256-GCM con token de 16 bytes, TTL 2 min, un solo uso, renovación automática del QR.
- **Deep link** `obsidian://omnisync-pair` para vincular desde otro dispositivo; muestra el servidor de destino antes de confirmar.
- **Worker todo-en-uno** para Cloudflare (señalización Nostr + almacenamiento Blossom + sala de vinculación `?pair=`) con acceso restringido por allowlist (`ALLOWED_PUBKEYS`) y verificación Schnorr optimizada (~4–6 ms con `@noble/curves`).
- **Snapshots cifrados** con almacén de base y parches delta binarios.
- **Interfaz de vinculación**: modal con QR, cuenta atrás de 2 min, selector de canal (Nostr / Worker), sección «Avanzado» con QR permanente legacy.
- **Lista de dispositivos** vinculados con plataforma, nombre y opción de desvinculación.
- **i18n** en 4 idiomas: español, inglés, francés, alemán.
- **Licencia PolyForm Noncommercial 1.0.0** (uso comercial requiere permiso del autor).

### Seguridad

- 6 rondas de auditoría de seguridad (2026-10-24 y 2026-10-26): 45 + 10 + 12 + 17 hallazgos identificados, todos corregidos antes del lanzamiento. Ver [`docs/SECURITY_FINDINGS.md`](docs/SECURITY_FINDINGS.md).
- Hallazgos corregidos incluyen: validadores desconectados de sus handlers, HMAC con prefijo inconsistente, nonces con `Math.random()`, clave maestra en `data.json`, handshake unidireccional, NIP-98 sin vínculo URL/método/cuerpo, acceso al Worker sin control, condición de carrera en uso único del token, falta de confirmación del servidor en deep link, y más.
- ReplayGuard TTL ajustado a `MAX_AGE + MAX_CLOCK_SKEW` para eliminar ventana de replay.
- Guarda `pairingInFlight` para evitar reentrada concurrente en `pairNewDevice`.
- Tests de regresión para todos los hallazgos (`npm run test:auditor`, `npm run test:pairing`, `npm run test:bughunt`).

### Infraestructura de tests

- 18 suites de test (typecheck, lint, crypto, Nostr, Blossom, WebRTC, Worker, pairing 13/13, pairing-channel 7/7, distribución 8/8, auditor, bughunt, i18n, core).
- `npm run package:stable`: build + empaquetado reproducible con verificación byte a byte.
- Todas las auditorías corren en sandbox Podman (red `none`); el código del proyecto nunca se ejecuta en el host.

---

*Para reportar una vulnerabilidad, consulta [SECURITY_ES.md](SECURITY_ES.md).*
