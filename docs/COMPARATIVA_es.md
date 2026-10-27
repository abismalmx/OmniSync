# Comparativa Técnica y de Arquitectura: OmniSync vs Alternativas de Sincronización en Obsidian

Este documento ofrece un desglose objetivo, técnico y arquitectónico entre **OmniSync** y las soluciones más empleadas en el ecosistema de Obsidian: **Obsidian Sync (Oficial)**, **Remotely Save** (S3/WebDAV/Dropbox/OneDrive), **Self-hosted LiveSync** (CouchDB) y **Git / Obsidian Git**.

---

## 1. Matriz Comparativa General

| Criterio / Característica | **OmniSync** | **Obsidian Sync (Oficial)** | **Remotely Save** | **Self-hosted LiveSync** | **Git / Obsidian Git** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Modelo de Red** | **P2P Híbrido** (WebRTC directo + Mailbox/Relay cifrado) | Servidor Centralizado (Infraestructura de Obsidian) | Cliente-Servidor (Nube de terceros / Storage) | Cliente-Servidor (CouchDB / Cloudant) | Servidor Centralizado (GitHub / GitLab / Gitea) |
| **Cifrado E2EE** | **AES-256-GCM** nativo de extremo a extremo + HMAC de rutas | AES-256 (E2EE opcional con clave de bóveda) | Cifrado OpenSSL / Restic opcional según backend | Cifrado de extremo a extremo nativo (E2EE) | **No** (archivos visibles en texto plano en el repo remoto) |
| **Colaboración en Tiempo Real** | **Sí** (CodeMirror 6, cursores y selecciones remotas en vivo) | No (sincronización tras guardado/delay) | No (sincronización periódica por archivo) | **Sí** (sincronización reactiva por eventos CouchDB) | No (sincronización por commits/pull/push manual o periódico) |
| **Resolución de Conflictos** | **Fusión 3-Vías** a nivel de carácter + base snapshot | Duplicado de archivo en conflicto (`.sync-conflict`) | Duplicado de archivo o sobreescritura (LWW) | Fusión a nivel de chunk / registro | Conflictos de merge de Git (manual, requiere resolver marcas) |
| **Dependencia de Servidores Propios** | **Cero obligatoria** (Relays públicos Nostr o Worker Serverless Cloudflare gratis) | Cero (gestionado por Obsidian) | Cero si se usa Dropbox/S3 comercial, alta si se usa WebDAV propio | **Alta** (requiere mantener contenedor Docker CouchDB / VPS) | Media (cuenta en GitHub o servidor Git propio) |
| **Soporte Móvil (iOS / Android)** | **Completo y sin fricción** (Vinculación instantánea por código QR) | Nativo e integrado | Bueno (dependiente de API móvil) | Completo pero configuración compleja en móvil | **Problemático** (iOS requiere apps de terceros como Working Copy / límites de memoria) |
| **Coste Económico** | **100% Gratuito y Libre** (Nivel gratuito de Cloudflare / Nostr) | Pago mensual recurrente ($4–$10/mes por bóveda) | Gratuito + coste de almacenamiento en la nube | Gratuito + coste de hosting VPS ($3–$6/mes) | Gratuito (GitHub) o coste de hosting |
| **Privacidad & Metadatos** | **Máxima**: Rutas ofuscadas (HMAC), sin cuentas, sin correos, sin logs centrales | Alta (si se activa E2EE), pero la cuenta está ligada a un correo | Depende del proveedor (Dropbox/Google indexan metadatos y cuentas) | Máxima si el servidor es tuyo; nula si es un Cloudant público | Mínima (tu historial y commits están ligados a una cuenta de Git) |
| **Soporte de Archivos Grandes (Binarios)** | **Optimizado** (Blossom BUD-01/02 direccionado por hash SHA-256) | Límite por plan (hasta 100 MB–200 MB por archivo) | Limitado por la velocidad de subida del storage | Límite por tamaño de base de datos CouchDB (degradación con binarios) | **Malo** (Git no está diseñado para binarios grandes; requiere Git LFS) |

---

## 2. Puntos Fuertes Destacados de OmniSync

### 1. Descentralización sin Servidores Dedicados (Cero Mantenimiento)
* **El problema de las alternativas:** *Self-hosted LiveSync* exige desplegar y parchar un contenedor Docker de CouchDB, configurar certificados SSL/TLS y pagar un VPS mensual. Si el VPS se apaga, pierdes la sincronización.
* **La ventaja de OmniSync:** Emplea arquitectura Serverless y P2P:
  - Cuando los dispositivos están en la misma red o en línea simultáneamente, intercambian datos **directamente vía WebRTC** (sin pasar por ningún intermediario).
  - Para sincronización asíncrona cuando un dispositivo está apagado, utiliza relés públicos de Nostr o un **Cloudflare Worker autodesplegable en 1 clic** (que entra con holgura en el plan gratuito de 100,000 peticiones diarias de Cloudflare, sin coste alguno).

### 2. Vinculación Instantánea por Código QR (Sin Cuentas ni Contraseñas)
* **El problema de las alternativas:** Configurar WebDAV, claves API de S3 o tokens de GitHub en Obsidian para iOS y Android es tedioso, propenso a errores tipográficos y expone tokens de acceso de larga duración.
* **La ventaja de OmniSync:**
  - El anfitrión genera un código QR efímero en la pantalla.
  - El teléfono escanea el QR.
  - Se realiza un intercambio criptográfico **ECDH P-256** con secreto compartido temporal de un solo uso (TTL de 2 minutos).
  - Las claves se transfieren cifradas y el token se destruye al instante. Sin nombres de usuario, sin contraseñas y sin emails registrados en ninguna base de datos.

### 3. Edición Colaborativa en Vivo (Estilo Google Docs / Figma)
* **El problema de las alternativas:** La mayoría de plugins de sincronización trabajan a nivel de archivo completo: si dos dispositivos editan la misma nota al mismo tiempo, el resultado habitual es un archivo duplicado `conflicto_2026-10-26.md` o la pérdida de las últimas líneas de uno de los dispositivos.
* **La ventaja de OmniSync:** Integra un módulo directo con el motor del editor (**CodeMirror 6**):
  - Muestra cursores remotos con colores diferenciados y selecciones en vivo.
  - Las ediciones remotas se propagan y aplican carácter a carácter.
  - Si los cambios ocurren sin conexión, el algoritmo de **fusión de tres vías (3-way text merge)** reconcilia ambos bloques de texto usando el *snapshot* base previo.

### 4. Privacidad Extrema: Ofuscación Criptográfica de Rutas (HMAC)
* **El problema de las alternativas:** Aunque otros plugins cifren el contenido de los archivos, los nombres y rutas de las carpetas a menudo se transmiten en texto claro (`/Salud/Psicologia/Notas_Privadas.md`), permitiendo al relay o proveedor de almacenamiento deducir la estructura y temática de tu vida o trabajo.
* **La ventaja de OmniSync:**
  - Las rutas relativas de los archivos se convierten en un HMAC determinista mediante la clave maestra de la bóveda (`hmac("Salud/Notas.md") → a8f3...`).
  - Para cualquier intermediario, el tráfico y las notas solo existen como hashes anónimos de tamaño fijo con payload AES-256-GCM.

### 5. Respeto Estricto de Datos (Basurero Seguro)
* Cuando un dispositivo remoto elimina un archivo, OmniSync **nunca ejecuta un borrado destructivo permanente en disco**: envía el archivo a la Papelera nativa de Obsidian (`.trash`). Si un archivo se borra por error en otro dispositivo, siempre es recuperable localmente.

---

## 3. Resumen Técnico para la Toma de Decisiones

| Si tu prioridad absoluta es... | La solución recomendada es... | Por qué |
| :--- | :--- | :--- |
| **Privacidad total, P2P directo, sin cuotas y con tiempo real** | **OmniSync** | No depende de servidores propios, ofrece colaboración en vivo real y vinculación instantánea sin registros. |
| Cero configuración técnica y presupuesto mensual disponible | **Obsidian Sync Oficial** | Integración nativa dentro de Obsidian mantenida por el equipo fundador a cambio de una suscripción. |
| Control absoluto de infraestructura tradicional en tu propio homelab | **Self-hosted LiveSync** | Si ya cuentas con un cluster Docker/Kubernetes con CouchDB configurado. |
| Control de versiones formal con ramas y revisiones de código | **Obsidian Git** | Si tu objetivo principal es auditar líneas concretas de código o documentación técnica mediante `git log`. |
