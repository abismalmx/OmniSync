# Tests y auditorías de seguridad — OmniSync

Este documento lista todos los **scripts de test reales** del proyecto y todas las **auditorías de seguridad** realizadas con herramientas deterministas. Solo contiene información verificable.

---

## 1. Suite de tests

### 1.1. Scripts disponibles

Todos los scripts se ejecutan con `npm test` (suite completa) o individualmente:

| Script | Archivo de tests | Descripción |
|---|---|---|
| `npm run test:minimax` | `tests/verify-minimax.ts` | Verifica el tamaño máximo del bundle (límite Obsidian). |
| `npm run test:security` | `tests/test-security.ts` | Primitivas criptográficas, validadores de ruta y protocolo. |
| `npm run test:nostr` | `tests/test-nostr-mailbox.ts` | Cifrado/descifrado del buzón Nostr, validación de eventos kind 30078. |
| `npm run test:mysecret` | `tests/test-mysecret-compat.ts` | Interoperabilidad con el formato MySecret. |
| `npm run test:delta` | `tests/test-delta-patch.ts` | Parches delta binarios y reconciliación de conflictos. |
| `npm run test:base` | `tests/test-base-snapshot-store.ts` | Almacén de snapshots cifrado. |
| `npm run test:nostr-delta` | `tests/test-nostr-delta-mailbox.ts` | Buzón con parches delta comprimidos. |
| `npm run test:blossom` | `tests/test-blossom.ts` | Subida/bajada Blossom, NIP-98, validación de hash SHA-256. |
| `npm run test:realtime-security` | `tests/test-realtime-security.ts` | Seguridad del canal WebRTC en tiempo real. |
| `npm run test:cloudflare-worker` | `tests/test-cloudflare-worker.ts` | Worker Blossom-only (cloudflare-blossom-worker.js). |
| `npm run test:cloudflare-allinone` | `tests/test-cloudflare-allinone-worker.ts` | Worker todo-en-uno: NIP-98, sala `?pair=`, plantilla embebida sincronizada (Test 8). |
| `npm run test:i18n` | `tests/test-i18n.ts` | Todas las claves i18n presentes en los 4 idiomas. Usar `LANG=en_US.UTF-8`. |
| `npm run test:pairing` | `tests/test-pairing-session.ts` | Sesión de vinculación efímera: 13 casos (flujo, uso único, caducidad, carreras, replay). |
| `npm run test:pairing-channel` | `tests/test-pairing-channel.ts` | Canal de vinculación: 7 casos (Nostr y Worker simulados). |
| `npm run test:core` | `tests/test-omnisync.mjs` | Pruebas de integración del núcleo del plugin. |
| `npm run test:bughunt` | `tests/test-bughunt-regression.ts` | Tests de regresión de bugs encontrados en las cazas de bugs. |
| `npm run test:auditor` | `tests/test-auditor-regression.ts` | Tests de regresión de hallazgos de auditoría (SEC-01…SEC-14, contratos de `main.ts` en 4 idiomas). |
| `npm run test:dual-path` | `tests/test-dual-path-regression.ts` | Sincronización de doble vía (relay + P2P): cola de reenvío, serialización, espera de reconexión, envío al cerrar y reconciliación al arrancar y detección de Worker sin buzón (8 casos). |
| `npm run test:distribution` | `tests/test-distribution-artifact.ts` | Verifica que `zip/OmnySync_stable/` es idéntico byte a byte al build actual (8 comprobaciones). |

### 1.2. Comprobaciones manuales en vivo (Workers reales, fuera de `npm test`)

Se ejecutan contra un Worker de Cloudflare **desechable**, desplegado con la plantilla actual (nunca el servidor de un usuario real), y necesitan red. Conviene correrlas dentro de un contenedor con límites de recursos. Método y resultados: secciones 2.6 y 2.7.

| Herramienta | Comando | Qué comprueba |
|---|---|---|
| `tests/live-worker-e2e.ts` | `MODE=run` | Sincronización de extremo a extremo por el buzón: publicar con el otro dispositivo apagado, recibir después, entrega en vivo, reemplazo de versiones, borrados y adjunto Blossom. |
| | `MODE=blob` | Adjuntos de 1 a 101 MB: descarga, descifrado y comparación byte a byte; rechazo limpio por encima del límite de 100 MB. |
| | `MODE=blossom-only` | El Worker de solo Blossom: subida con la clave del usuario, descarga, y rechazo si el Worker no está registrado como propio. |
| `tests/live-worker-auth.ts` | `WORKER=…` | Sin conocer el secreto, toda petición sin autorización o con una clave no permitida se rechaza. |
| `tests/live-worker-expiry.ts` | `SECRET=… WORKER=…` | Caducidad del buzón: los eventos con vida de 10 s, 60 s y 7 días desaparecen a su hora; una caducidad ya vencida se rechaza; los archivos de Blossom no caducan por sí solos (de ahí la regla de ciclo de vida de R2). |
| `tests/live-worker-fuzz.ts` | `SECRET=… WORKER=…` | Fuzzer estilo DAST: autorización NIP-98 hostil, abuso de rutas y métodos, y el WebSocket del buzón (tramas basura, eventos falsificados o caducados, tramas enormes, límites de suscripciones, ráfagas). 63 comprobaciones, sin errores 5xx. |

Para verificar lo que puede ver un servidor, despliega el Worker desechable con `MAILBOX_DEBUG=1`, ejecuta `wrangler tail` y comprueba que los eventos guardados muestran solo identificadores opacos y texto cifrado. Nunca dejes `MAILBOX_DEBUG` activado en un Worker real.

### 1.3. Comandos adicionales

```bash
npm run typecheck      # tsc --noEmit, 0 errores
npm run lint           # ESLint, 0 errores
npm run audit:deps     # osv-scanner sobre package-lock.json
npm run audit:secrets  # gitleaks sobre el árbol
npm run audit:static   # semgrep scan
npm run package:stable # build + empaquetado reproducible de zip/OmnySync_stable/
```

### 1.4. Nota sobre test:i18n

`npm run test:i18n` puede fallar si el entorno tiene configuración regional en español. Solución:

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run test:i18n
```

---

## 2. Auditorías de seguridad

Las auditorías se realizaron localmente con herramientas deterministas. Los informes completos con evidencias y PoC están en [`docs/AUDIT_REPORT.md`](AUDIT_REPORT.md), [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md), [`docs/SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md), [`docs/SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md) y los runs privados del auditor. El resumen de hallazgos y parches está en [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md).

---

### 2.0. Auditoría inicial — `AUDIT_REPORT.md` (2026-10-24)

**Alcance:** repositorio completo (~15.700 líneas TypeScript). **Herramientas:** ESLint (configuración creada desde cero), Semgrep (`--config auto` 455 reglas + p/security-audit/owasp/secrets 322 reglas), Gitleaks, osv-scanner, npm audit, tsc.

| Herramienta | Antes | Después |
|---|---|---|
| ESLint errores | 46 | 0 |
| Semgrep hallazgos | 12 | 0 |
| Secretos (Gitleaks) | 0 | 0 |
| Dependencias vulnerables (OSV/npm audit) | 0 | 0 |
| Regex candidatos a ReDoS | 2 | 0 |

**Hallazgos corregidos (45):** C-01…C-08 (criptografía), P-01…P-07 (protocolo/WebRTC), S-01…S-06 (señalización/persistencia), N-01…N-03 (Nostr), T-01…T-06 (transferencias/temporal), R-01…R-03 (rutas), D-01…D-02 (documentación), AN-01…AN-10 (anonimato/Blossom). Incluyendo fallos críticos: validadores desconectados de los handlers, HMAC con prefijo inconsistente, `Math.random()` para nonces, clave maestra en `data.json`, borrado remoto destructivo, `ws://` admitido, handshake unidireccional. Detalle en [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) y [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md).

---

### 2.0.b. Auditoría de anonimato y Blossom — `SECURITY_AUDIT_ANONYMITY_BLOSSOM.md` (2026-10-24)

**Alcance:** Worker Blossom, `blossom-client.ts`, `nostr-mailbox.ts`, `signaling-client.ts`, `settings-security.ts`. Sin herramientas SAST adicionales (revisión dirigida + tests).

**Hallazgos (AN-01…AN-10):** todos corregidos. Los más graves: AN-01 (NIP-98 sin vínculo con URL/método/cuerpo — la firma era válida pero no autorizaba la petición específica), AN-04 (misma pubkey para relay y Blossom). Detalle en [`SECURITY_AUDIT_ANONYMITY_BLOSSOM.md`](SECURITY_AUDIT_ANONYMITY_BLOSSOM.md).

---

### 2.0.c. Auditoría del Worker todo-en-uno — `SECURITY_AUDIT_ALLINONE_WORKER.md` (2026-10-24)

**Alcance:** `scripts/cloudflare-allinone/worker.js`, modal de despliegue, plantillas embebidas. **Herramientas:** lectura dirigida + PoC ejecutados contra el código real + mutation testing manual (8/8 mutaciones detectadas). Semgrep 167 reglas: 0 hallazgos. Gitleaks: 0.

| Métrica | Antes | Después |
|---|---|---|
| Control de acceso al Worker | Ninguno (cualquier clave Nostr válida) | Allowlist `ALLOWED_PUBKEYS`, fail-closed |
| Ligadura NIP-98 al cuerpo/host | Rota (regresión) | Restaurada y reforzada |
| CPU por verificación Schnorr | ~140–170 ms | ~4–6 ms (`@noble/curves`) |
| `wrangler` en plantilla desplegable | `^3.114.0` (8 vulnerabilidades) | `^4.0.0` |
| Suite completa | 13 suites verde | 13 suites + ~140 aserciones negativas nuevas |

**Hallazgos (AIO-01…AIO-12):** todos corregidos. El más grave: AIO-01 (ningún control de acceso — cualquier clave Nostr válida podía usar el Worker). Detalle en [`SECURITY_AUDIT_ALLINONE_WORKER.md`](SECURITY_AUDIT_ALLINONE_WORKER.md).

---

### 2.1. Línea base completa — run `20261026-012049-5656`

**Fecha:** 2026-10-26 · **Herramientas:** Semgrep (reglas propias + p/security-audit/owasp/js/ts), CodeQL JS/TS `security-extended`, gitleaks, osv-scanner, npm audit, ESLint + plugin-security, tsc, SBOM (syft) + grype, suite completa de tests en sandbox.

| Herramienta | Resultado bruto | Triado |
|---|---|---|
| Semgrep | 3 alertas (2 info, 1 warning) | 0 vulnerabilidades (FP documentados) |
| CodeQL | 2 hallazgos | 0 en `src/`; 2 FP descartados (ver informe) |
| gitleaks | 0 | — |
| osv-scanner / npm audit | 0 | — |
| grype | varios | Go stdlib del binario esbuild: no alcanzable |
| Suite de tests | 13 suites | Todas pasan en sandbox |

**Hallazgos:** SEC-01 (Media, artefacto de distribución desactualizado) y SEC-02 (Baja, ausencia de comprobación de sincronía). Ambos corregidos con test de regresión. Detalle en [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md).

---

### 2.2. Línea base completa — run `20261026-032150-10258`

**Fecha:** 2026-10-26 · **Herramientas:** igual que 2.1, más 3 especialistas + 1 defensor independiente.

| ID | Severidad | Estado |
|---|---|---|
| SEC-01 | Media | corregido (anterior) |
| SEC-02 | Baja–Media (disponibilidad) | corregido |
| SEC-03 | Baja | corregido |
| SEC-04–SEC-12 | Baja–Media | requieren decisión o sin PoC local |
| SEC-11 | Informativa | CodeQL `js/incomplete-url-substring-sanitization`; FP (solo cambia framing, no es barrera de seguridad) |

No ejecutado: DAST, fuzzing, reconocimiento remoto.

---

### 2.3. Auditorías de lectura dirigida — vinculación efímera

#### Run `20261026-145714-16806` — primera revisión de pairing

Alcance: `pairing-session.ts`, `pairing-channel.ts`, rama `?pair=` del Worker, `main.ts`, `pairing-modal.ts`. Sin Semgrep/CodeQL/DAST.

| ID | Sev. | Estado |
|---|---|---|
| H1 | Baja–Media | Corregido (flag `busy` en `handleHello`, test de regresión rojo→verde) |
| H2 | Media | Corregido (sala `?pair=` exige NIP-98 del anfitrión; Test 7b del Worker) |
| H3 | Media (ingeniería social) | Corregido (confirmación con servidor antes de adoptar clave) |
| H4 | Baja | Aceptado por diseño (TTL 2 min, un solo uso, lista de dispositivos) |
| H5 | Info | Sin acción |

#### Run `20261026-151238-24575` — revisión final (parches bug_hunter verificados)

H1/H2/H3 vigentes. Hallazgos nuevos N1 y N2 (Baja) corregidos (Worker: eliminación de `kind`/`role` suministrados por el cliente; id duplicado solo refresca estado). Residuales aceptados documentados en [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md).

#### Run `20261026-152037-17189` — TTL de 2 min y renovación del QR

H1/H2/H3 vigentes. Carreras expiración/hello verificadas sin fuga de clave. Hallazgo R1 (Baja, UI colapsaba «Avanzado» al renovar QR) corregido. Residuales aceptados sin cambio.

---

### 2.4. Cazas de bugs — vinculación efímera

Cinco sesiones de `bug_hunter` sobre la nueva vinculación. La más relevante:

#### Run `20261026-150816-20845`

Alcance: `pairing-session.ts`, `pairing-channel.ts`, `main.ts`, `pairing-modal.ts`, Worker, `settings-tab.ts`. Sin Obsidian ni dispositivos reales.

| ID | Sev. | Estado |
|---|---|---|
| B1 | Media | Corregido (contador `inviteGen`; canal huérfano cancelado) |
| B2 | Media | Corregido (abort en catch; fallo de `complete()` solo avisa) |
| B3 | Baja | Corregido (modal reinicia la invitación tras vincular) |
| B4 | Baja | Corregido + test nuevo |
| B5 | Baja | Corregido |

---

### 2.5. Línea base completa final — run `20261026-155140-28734`

**Fecha:** 2026-10-26 · **Motivo:** los cuatro runs anteriores sobre pairing eran solo lectura + tests; esta pasa por herramientas deterministas completas sobre el código definitivo (incluyendo el enlace `obsidian://omnisync-pair`).

**Herramientas:** Semgrep (p/security-audit + p/secrets + p/owasp-top-ten + p/javascript + p/nodejs + p/typescript + reglas propias), CodeQL JS/TS `security-extended`, gitleaks, osv-scanner, npm audit (raíz y componente Worker), ESLint + plugin-security, tsc, SBOM (syft) + grype, suite completa de tests.

| Herramienta | Bruto | Triado |
|---|---|---|
| Semgrep | 6 (2 WARNING, 4 INFO) | 0 vulnerabilidades (FP documentados) |
| CodeQL | 1 | FP en `tests/`; 0 en `src/` |
| gitleaks | 0 | — |
| osv-scanner / npm audit raíz | 0 | — |
| npm audit Worker (`devDependencies`) | 3 (1 high, 2 moderate) | Solo `devDependencies`; producción 0 → SEC-12 |
| grype | 120 | Go stdlib del binario esbuild: no alcanzable |
| ESLint errores | 2 (`no-shadow`) | En pairing-modal + test → BUG-L1 |
| tsc | 0 errores | — |
| Suite de tests | Todas las suites | Todo verde (pairing 13/13, pairing-channel 7/7, Worker, auditor, bughunt, distribución) |

**Revisión dirigida del enlace `obsidian://omnisync-pair`:** validación de longitud, base64, JSON y URL antes de cualquier efecto; siempre pide confirmación; sin hallazgo en la entrada.

| ID | Sev. | Descripción | Estado |
|---|---|---|---|
| SEC-12 | Baja | `wrangler` (devDep del Worker) arrastraba `undici` con DoS en EventSource; solo afecta a la máquina del desarrollador | Corregido (wrangler 4.153.0; npm audit Worker: 0) |
| SEC-13 | Baja | `pairNewDevice` no era reentrante: dos llamadas simultáneas podían entrelazar escritura de claves | Corregido (guarda `pairingInFlight`; aviso i18n en 4 idiomas) |
| SEC-14 | Baja | `deepLinkConfirm` no mostraba el host de destino antes de conectar | Corregido (`{server}` visible en confirmación; i18n en 4 idiomas) |
| BUG-L1 | Info | 2 errores `no-shadow` que romperían `npm run lint` en CI | Corregido |

**Hallazgos previos H1–H4, N1–N2, B1–B5, SEC-11, R1 y correcciones de auditorías anteriores:** todos los tests de regresión pasan en esta ejecución (pairing 13/13, pairing-channel 7/7, Worker, auditor, bughunt).

**Verificación final (sandbox Podman, red none):** `tsc --noEmit`: 0 · `eslint src tests scripts --quiet`: 0 · `npm test`: salida 0. Bundle reconstruido, `zip/OmnySync_stable` regenerado, `Github/` sincronizada.

---

### 2.6. Verificación en vivo contra Workers reales — lo que el servidor realmente ve (2026-10-27)

Para comprobar en infraestructura real, y no solo en pruebas unitarias, que los datos salen del dispositivo **cifrados y ofuscados a la vez**, se desplegó desde cero un Worker todo-en-uno desechable con la plantilla actual y se probó con el propio código del plugin (`tests/live-worker-e2e.ts`, manual, fuera de `npm test`). El Worker se arrancó con su interruptor integrado `MAILBOX_DEBUG`, que registra lo que el servidor recibe de cada evento guardado, y se capturaron los registros mientras dos dispositivos simulados sincronizaban. Después se borró el Worker.

**Qué se ejercitó:** publicar una nota con el otro dispositivo apagado y recibirla después; reemplazo de versiones de una nota; borrados; entrega en vivo; adjuntos por Blossom de 1 MB a 95 MB (descarga, descifrado y comparación byte a byte, y rechazo limpio por encima del límite de 100 MB); y el Worker de solo Blossom.

**Lo que el servidor vio en cada evento guardado:**

| Campo | Observado |
|---|---|
| Etiqueta `d` (identidad de la nota) | Un HMAC opaco de 64 hexadecimales. Sin ruta ni nombre de archivo. |
| Etiqueta `t` (sala del buzón) | Un valor opaco de 64 hexadecimales derivado del secreto. Sin nombres. |
| Etiqueta `expiration` | Una marca de tiempo (los eventos caducan a los 7 días). |
| Contenido | Solo texto cifrado AES-256-GCM (`{"v":…,"iv":…,"ct":…}`). |
| Blobs en el almacenamiento | Bytes opacos, cifrados antes de subirse. |

Al buscar en los registros capturados del servidor las rutas, nombres, extensiones y texto de las notas de prueba, **no apareció nada**.

También se comprobó el **control de acceso** contra un Worker real sin conocer su secreto (`tests/live-worker-auth.ts`): el buzón, la señalización y las subidas rechazan las peticiones sin autorización o con una clave que no está en la lista de permitidos.

**Lo que el servidor sí puede observar:** cuándo ocurren los cambios, su tamaño aproximado, el número de eventos y la clave pública que los firma. No se añadió relleno (padding) ni tráfico señuelo a propósito, para que la sincronización en tiempo real sea lo más rápida posible. El modo P2P puro evita los relays por completo.

En este repositorio no se guarda nada sensible de estas pruebas: ni claves, ni URLs, ni identificadores de cuenta. Para repetir la comprobación, consulta el punto «Prueba en vivo contra un Worker real» de la [Guía de Desarrolladores](Gu%C3%ADa%20de%20Desarrolladores.md#11-pruebas).

---

### 2.7. Pruebas dinámicas (DAST) contra un Worker real (2026-10-27)

Se atacó el servidor en funcionamiento, desde contenedores (`podman`, con límites de memoria y CPU y sin privilegios extra), contra un Worker todo-en-uno **desechable** desplegado con la plantilla actual. Después se repitió una pasada más ligera y pasiva contra el servidor real, a pocas peticiones por segundo, para confirmar que ambos se comportan igual.

| Herramienta | Alcance | Resultado |
|---|---|---|
| Fuzzer propio (`tests/live-worker-fuzz.ts`) | Autorización NIP-98 (caducada, del futuro, repetida, URL/método/kind distintos, etiquetas duplicadas o excesivas, claves falsas, cuerpo que no coincide con el hash firmado), abuso de rutas y métodos, y el WebSocket del buzón (tramas basura, eventos inválidos/falsificados/caducados, tramas enormes, límites de suscripciones, ráfaga de 400 tramas) | 63 comprobaciones, **0 fallos, 0 errores de servidor (5xx)**. Tras el abuso el buzón siguió atendiendo a la clave legítima. |
| nuclei (4.780 peticiones, 1.783 plantillas: exposición, malas configuraciones, CORS, tokens, takeover, redirecciones, tecnología) | Superficie HTTP | Sin vulnerabilidades. Solo notas informativas/bajas sobre el borde de Cloudflare (WAF detectado, TLS 1.0/1.1 ofrecidos por Cloudflare). |
| OWASP ZAP baseline | Cabeceras HTTP y comprobaciones pasivas | 63 reglas superadas, **0 fallos**. |
| testssl.sh | TLS | TLS 1.2/1.3 con cifrados fuertes y secreto perfecto hacia adelante. TLS 1.0/1.1 siguen ofrecidos por el borde de Cloudflare para `workers.dev`; es un ajuste de Cloudflare, no del plugin. |

**Corregido:** las respuestas JSON del Worker (página de estado y errores) ahora envían `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`. Un Worker desplegado con una plantilla anterior debe redesplegarse para tenerlo.

**Aceptado:** el CORS permisivo (`Access-Control-Allow-Origin: *`) es intencional: el plugin se ejecuta desde el origen de Obsidian y Blossom lo espera. La protección viene de la autorización NIP-98 en cada escritura y WebSocket, y de que todo lo que se puede leer está cifrado de extremo a extremo. HSTS lo cubre la lista de precarga del dominio `.dev`. La memoria anti-repetición del Worker es por instancia (mejor esfuerzo), por lo que un evento NIP-98 repetido puede aceptarse ocasionalmente de nuevo; las subidas se direccionan por contenido y son idempotentes, así que no tiene efecto.

**No cubierto:** escaneos autenticados con la clave de un usuario real (solo el Worker desechable, cuya clave controlan las pruebas), ni Obsidian ni dispositivos reales.

---

## 3. Cobertura honesta

Lo que estas auditorías **no** cubren:

- Se ejecutó DAST contra un Worker desechable y, de forma ligera, contra uno real (sección 2.7). No cubierto: escaneos autenticados con la clave de un usuario real, dispositivos reales ni Obsidian en sí.
- Sin fuzzing de entradas en producción.
- Sin pruebas en dispositivos o relays reales (cámara → `obsidian://`, WebRTC real, Nostr relay en producción).
- Sin revisión humana independiente del protocolo criptográfico (ECDH P-256 + HKDF-SHA256 + AES-256-GCM).

---

*Última actualización: 2026-10-27.*
