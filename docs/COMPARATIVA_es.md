# Comparativa Técnica y de Arquitectura: OmniSync vs Alternativas de Sincronización en Obsidian

Este documento ofrece un desglose objetivo, técnico y arquitectónico entre **OmniSync** y las soluciones más empleadas en el ecosistema de Obsidian: **Obsidian Sync (Oficial)**, **Remotely Save** (S3/WebDAV/Dropbox/OneDrive), **Self-hosted LiveSync** (CouchDB) y **Git / Obsidian Git**.

---

## 1. Matriz Comparativa General

| Criterio / Característica | 🔮 **OmniSync** | 💎 **Obsidian Sync (Oficial)** | ☁️ **Remotely Save** | 🗄️ **Self-hosted LiveSync** | 🐙 **Git / Obsidian Git** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| 🌐 **Modelo de Red** | ⚡ **P2P Híbrido**<br>*(WebRTC directo + Mailbox/Relay cifrado)* | 🏢 Servidor Centralizado<br>*(Nube de Obsidian)* | ☁️ Cliente-Servidor<br>*(Dropbox / S3 / OneDrive)* | 🖥️ Cliente-Servidor<br>*(CouchDB / Docker)* | 🐙 Servidor Git Central<br>*(GitHub / GitLab)* |
| 🔐 **Cifrado E2EE** | 🛡️ **AES-256-GCM Nativo**<br>+ HMAC en rutas | 🔒 AES-256<br>*(E2EE opcional con clave)* | 🔑 Opcional<br>*(OpenSSL/Restic según backend)* | 🛡️ E2EE Nativo | ❌ **Sin Cifrado**<br>*(Texto plano en repositorio)* |
| 👥 **Colaboración en Tiempo Real** | ✨ **Sí (En Vivo)**<br>*(Cursores y selecciones en vivo)* | ❌ No<br>*(Sincroniza al guardar/cerrar)* | ❌ No<br>*(Sincronización por polling)* | ⚡ **Sí**<br>*(Eventos reactivos CouchDB)* | ❌ No<br>*(Por commits y push manual)* |
| 🔀 **Resolución de Conflictos** | 🧠 **Fusión 3-Vías Inteligente**<br>*(Carácter a carácter sin duplicar)* | ⚠️ Archivo Duplicado<br>*(`.sync-conflict`)* | ⚠️ Archivo Duplicado<br>*(O sobreescritura LWW)* | 🧩 Fusión por Chunks<br>*(A nivel de registro)* | 🛑 Conflictos de Git<br>*(Marcadores manuales `<<<<`)* |
| ⚙️ **Mantenimiento de Servidor** | 🟢 **0% Requerido**<br>*(Worker Serverless gratis o Nostr)* | 🟢 0% Requerido<br>*(Gestionado por Obsidian)* | 🟡 0% con S3/Dropbox<br>*(Alto si usas WebDAV propio)* | 🔴 **Muy Alto**<br>*(VPS + Docker + certificados SSL)* | 🟡 Medio<br>*(Cuenta Git o servidor propio)* |
| 📱 **Experiencia Móvil (iOS/Android)** | 📲 **Instantánea (QR 2 seg)**<br>*(Sin logins ni configuraciones)* | ✅ Nativa e integrada | 🟡 Buena<br>*(Limitada por background en iOS)* | ⚠️ Configuración Compleja<br>*(Difícil de configurar en móvil)* | 🔴 **Problemática**<br>*(Requiere apps como Working Copy)* |
| 💰 **Coste Económico** | 🎁 **100% Gratis y Libre**<br>*(Sin suscripciones)* | 💳 $4 a $10 / mes<br>*(Suscripción por bóveda)* | 🟡 Gratis plugin<br>*(+ coste de almacenamiento)* | 🟡 Gratis plugin<br>*(+ $3–$6/mes de VPS)* | 🟢 Gratuito en GitHub<br>*(O coste de hosting)* |
| 🕵️‍♂️ **Privacidad de Metadatos** | 🥷 **Máxima Cero-Conocimiento**<br>*(Rutas ofuscadas, sin cuentas)* | 🔒 Alta con E2EE<br>*(Cuenta vinculada a tu email)* | ⚠️ Metadatos expuestos<br>*(Proveedor ve nombres de archivo)* | 🛡️ Alta si el VPS es tuyo<br>*(Nula en nubes públicas)* | ⚠️ Historial público/privado<br>*(Commits ligados a usuario)* |
| 📦 **Archivos Grandes (Binarios)** | 🚀 **Optimizado (Blossom)**<br>*(BUD-01/02 por SHA-256)* | ⚠️ Límites por plan<br>*(100 MB–200 MB por archivo)* | ⏱️ Lento<br>*(Depende del storage)* | ⚠️ Degradación en BD<br>*(CouchDB sufre con binarios)* | ❌ **No recomendado**<br>*(Requiere Git LFS)* |

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
