# Changelog — OmniSync

Todos los cambios notables de este proyecto se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).

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

*Para reportar una vulnerabilidad, consulta [SECURITY.md](SECURITY.md).*
