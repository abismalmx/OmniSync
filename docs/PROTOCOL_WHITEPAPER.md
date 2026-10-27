# OmniSync Protocol Specification & Extensibility Whitepaper
**Arquitectura de Transporte Descentralizado Zero-Knowledge: Más allá de la sincronización de archivos**

---

## 1. Resumen Ejecutivo y Tesis Arquitectónica

El protocolo subyacente desarrollado en OmniSync resuelve uno de los problemas fundamentales de la computación moderna: **el intercambio de datos y sincronización de estado en tiempo real y asíncrono entre dispositivos heterogéneos, sin servidores centrales propios, con tolerancia total a NATs/firewalls, cero conocimiento (Zero-Knowledge E2EE) y coste de infraestructura prácticamente nulo.**

El protocolo se apoya en una pila híbrida de tres capas ortogonales:
1. **Capa Efímera Ultrarrápida (WebRTC DataChannel):** Transporte directo P2P de latencia sub-20ms para presencia interactiva, streaming continuo y difusión de estado en caliente.
2. **Capa de Tránsito Asíncrono Ciego (Nostr NIP-44 + HMAC Ephemeral Mailbox):** Red de almacenamiento y reenvío (*Store & Forward*) sin censura, descentralizada y anónima para dispositivos fuera de línea o tras NATs simétricos corporativos.
3. **Capa de Contenido Pesado (Blossom BUD-01/02 + NIP-98):** Servidores de almacenamiento de blobs binarios direccionados por hash criptográfico (SHA-256) con autenticación sin estado y cifrado de cliente AES-256-GCM.

Al desacoplar la **identidad criptográfica** (claves efímeras y HMACs) del **transporte físico** (WebSockets públicos de Nostr y canales WebRTC), el protocolo se convierte en un **motor de consenso e intercambio de estado de propósito general**.

Este documento detalla rigurosamente las aplicaciones e implementaciones industriales y de software libre que esta arquitectura puede sustentar mucho más allá de una bóveda de Obsidian.

---

## 2. Topología y Primitivas del Protocolo OmniSync

```
+-----------------------------------------------------------------------------------+
|                           CAPA DE APLICACIÓN (Cualquier App)                      |
|  (Gestor de Claves, Vector Clocks, CRDTs, Replicación de DB, Streams Binarios)    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                        MOTOR CRIPTOGRÁFICO ZERO-KNOWLEDGE                          |
|   - Derivación PBKDF2-SHA256 (256-bit Key Material)                              |
|   - Cifrado autenticado simétrico AES-256-GCM con Nonces de 96 bits               |
|   - NIP-44 v2 XChaCha20-Poly1305 para eventos de señalización y mensajes cortos   |
|   - Direccionamiento ciego: HMAC-SHA256('mailbox-dtag-v2') para tags #d de Nostr   |
|   - ReplayGuard + ConcurrencyLimiter (Deduplicación e Idempotencia Atómica)       |
+-----------------------------------------------------------------------------------+
                     /                                           \
                    v                                             v
+---------------------------------------+     +-------------------------------------+
|        TRANSPORTE EN LÍNEA            |     |        TRANSPORTE ASÍNCRONO         |
|   - WebRTC DataChannel (SCTP/UDP)     |     |   - Nostr Relays (WebSockets)       |
|   - STUN NAT Traversal / ICE          |     |   - Store & Forward Buzón Ciego     |
|   - Sub-20ms Latencia                 |     |   - Fallback offline transparente   |
+---------------------------------------+     +-------------------------------------+
                                                              | (Para > 64 KB)
                                                              v
                                              +-------------------------------------+
                                              |       BLOB STORAGE (Blossom)        |
                                              |   - BUD-01 / BUD-02 (PUT/GET SHA256)|
                                              |   - NIP-98 Auth Header (Kind 27235) |
                                              |   - Cifrado Binario AES-GCM Cliente |
                                              +-------------------------------------+
```

---

## 3. Implementaciones Industriales y Casos de Uso Avanzados

### Caso 1: Gestores de Contraseñas y Bóvedas de Identidad Descentralizadas (Alternativa a Bitwarden / 1Password)

* **El Problema Actual:** Bitwarden, 1Password y Dashlane requieren bases de datos en la nube centralizada de la empresa. Un fallo de infraestructura, una orden judicial o una brecha de seguridad compromete la disponibilidad y expone metadatos de acceso de millones de usuarios.
* **Implementación con OmniSync:**
  * **Estructura de Datos:** Cada entrada de credencial es un registro JSON cifrado con una clave derivada de la contraseña maestra del usuario.
  * **Sincronización:** Cuando el usuario añade o modifica una contraseña en su teléfono, se emite un delta cifrado. Si la laptop está abierta en la misma red o en otra ciudad, la contraseña se actualiza en 15ms vía WebRTC. Si la laptop está apagada, el cambio espera en un relay de Nostr como un evento efímero indistinguible de tráfico aleatorio.
  * **Ventaja Competitiva:** Bóvedas de contraseñas 100% privadas, sin servidores que mantener, sin costo mensual de suscripción y con respaldo local en múltiples dispositivos.

---

### Caso 2: Portapapeles Universal Seguro Multiplataforma (KDE Connect / Apple Universal Clipboard sin restricciones de SO)

* **El Problema Actual:** Copiar texto o imágenes en una Mac y pegarlos en un iPhone funciona bien (ecosistema cerrado Apple), pero falla entre Linux, Windows, Android e iOS. Herramientas de terceros como KDE Connect exigen estar en la misma subred Wi-Fi y no funcionan si estás en 4G/5G.
* **Implementación con OmniSync:**
  * **Daemon Ligero en Background:** Un proceso en segundo plano en Rust o Go que monitorea el portapapeles del sistema operativo (`xclip`, `wl-clipboard`, Windows Clipboard API, Android Service).
  * **Transporte Híbrido:**
    * Si copias texto o una imagen pequeña (<64 KB): Se cifra y se envía vía Nostr + WebRTC instantáneamente a todos los dispositivos emparejados.
    * Si copias un archivo pesado, una captura 4K o un archivo PDF: Se sube cifrado con AES-GCM al almacenamiento Blossom y se notifica el hash SHA-256 en el canal efímero.
  * **Resultado:** Copias en tu PC Linux en tu oficina y pegas en tu teléfono Android en la calle mediante 5G sin tocar ningún servidor central ni configurar DNS dinámico.

---

### Caso 3: Replicación de Bases de Datos Local-First Embebidas (SQLite / DuckDB / PGlite)

* **El Problema Actual:** Las aplicaciones web modernas dependen de APIs REST hacia servidores centralizados de base de datos (PostgreSQL, Supabase, Firebase). Si el usuario no tiene conexión, la app se congela o pierde funcionalidad.
* **Implementación con OmniSync:**
  * **Base de Datos en el Cliente:** Cada cliente ejecuta una instancia embebida de SQLite o PGlite (PostgreSQL compilado a WebAssembly).
  * **Capa de Replicación:** Cada transacción `INSERT`, `UPDATE` o `DELETE` genera un registro en el WAL (*Write-Ahead Log*) o una mutación lógica basada en CRDT (*Conflict-free Replicated Data Type*).
  * **Distribución:** Las mutaciones del WAL se empaquetan en transacciones cifradas distribuidas por WebRTC (si los nodos están activos) o depositadas en los relays de Nostr con deduplicación por hash causal.
  * **Aplicaciones Directas:** CRMs para agentes de ventas en campo, sistemas de inventario en almacenes rurales, apps médicas de historiales clínicos que deben operar 100% offline pero sincronizarse automáticamente al conectar.

---

### Caso 4: Sincronización de Sesiones de Terminal y Entornos de Desarrollo (Dotfiles & Workspace Sync)

* **El Problema Actual:** Los desarrolladores usan múltiples máquinas (laptop personal, PC de escritorio, servidor remoto, devcontainer). Mantener sincronizados los `.bashrc`, configuraciones de Neovim/VSCode, historial de comandos de zsh y claves SSH exige hacer `git push/pull` constantemente.
* **Implementación con OmniSync:**
  * **CLI Daemon (`omnisync-cli`):** Un binario único compilado para Linux/macOS/Windows que vigila carpetas seleccionadas (`~/.config`, `~/.ssh/config`, `~/.zsh_history`).
  * **Sincronización Silenciosa:** Cada comando ejecutado en la terminal o cada configuración editada en Neovim se propaga a los demás terminales en caliente.
  * **Compartición de Sesiones Terminal P2P:** El canal de WebRTC DataChannel puede transmitir directamente una pseudoterminal (PTY) interactiva cifrada punto a punto para soporte técnico o emparejamiento de código (*Pair Programming* remoto) sin configurar puertos ni usar túneles centralizados tipo Ngrok.

---

### Caso 5: Mensajería P2P Autohospedada Efímera con Almacenamiento Masivo (Alternativa a Signal / Telegram)

* **El Problema Actual:** Signal requiere registrar tu número de teléfono y sus servidores centrales conocen tus metadatos de conexión (cuándo te conectas, IP de origen, con quién hablas). Telegram almacena las conversaciones por defecto en sus servidores sin cifrado E2E completo.
* **Implementación con OmniSync:**
  * **Identidad Descentralizada:** Cada usuario genera un par de claves secp256k1 efímeras. No hay números de teléfono, correos ni cuentas.
  * **Chat en Vivo:** WebRTC para llamadas de voz/video y chat instantáneo en vivo sin intermediarios.
  * **Mensajes Fuera de Línea:** Nostr Relay como buzón ciego con NIP-44 v2. El relay solo ve hashes de 64 caracteres en el tag `#d` generados con HMAC-SHA256, sin saber quién es el remitente ni quién es el destinatario.
  * **Multimedia Pesada (Audios, Videos, Archivos):** Blossom BUD-01/02 cifrado. Los archivos se borran automáticamente tras expiración de retención o se almacenan en el Cloudflare R2 privado de los participantes.

---

### Caso 6: IoT y Domótica Segura sin Nube (Alternativa a Home Assistant Cloud / Nabu Casa)

* **El Problema Actual:** Para controlar los dispositivos inteligentes de tu hogar (cámaras de seguridad, luces, cerraduras) desde fuera de casa, necesitas abrir puertos en el router (peligro crítico de seguridad) o pagar una suscripción a un servicio en la nube que actúa como intermediario.
* **Implementación con OmniSync:**
  * **Nodo Doméstico (Raspberry Pi / Home Server):** Corre el cliente OmniSync conectado a la red local de domótica.
  * **Cliente Móvil (Tu Teléfono):** Se comunica con el nodo doméstico directamente por WebRTC cuando estás fuera de casa.
  * **NAT Traversal sin Apertura de Puertos:** Gracias a los servidores STUN y al fallback de señalización en Nostr, el teléfono puede enviar comandos criptográficamente firmados a la cerradura inteligente o solicitar el stream de video de una cámara de seguridad directamente por WebRTC P2P a través de cualquier red celular 4G/5G, sin exponer puertos a internet y sin que Amazon o Google espíen los eventos del hogar.

---

## 4. Comparativa de Arquitectura: OmniSync vs. Soluciones Tradicionales

| Característica | Nube Tradicional (AWS / Firebase) | Git Centralizado (GitHub / GitLab) | CouchDB / LiveSync | P2P Puro (Syncthing) | **Protocolo OmniSync** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Costo de Servidores** | Alto (Mensual por usuario) | Medio / Requiere cuenta | Requiere VPS propio | Cero | **Cero (Relays y Workers gratuitos)** |
| **Tiempo Real en Vivo** | Sí (WebSockets centralizados) | No (Manual push/pull) | Parcial (Polling / Replicación) | Lento (Escaneo periódico) | **Extremo (<20ms WebRTC)** |
| **Sincronización Offline** | No (Falla sin internet) | Sí (Commit local) | Compleja | No (Requiere ambos nodos vivos) | **Total (Buzón Nostr Store & Forward)** |
| **Archivos Pesados (>100MB)** | Costoso por ancho de banda | Pésimo (Git LFS complejo) | Muy limitado (Satura DB) | Bueno | **Excelente (Blossom BUD-01/02)** |
| **Privacidad de Metadatos** | Nula (El host ve IPs y datos) | Nula (GitHub ve commits) | Media (El VPS ve accesos) | Alta | **Máxima (Zero-Knowledge + Blind HMAC #d tags)** |
| **Facilidad de Emparejamiento** | Registro con Email/Password | SSH Keys / Tokens PAT | Configurar URLs y Auth | Código alfanumérico complejo | **1-Click (QR Code con Secreto Criptográfico)** |

---

## 5. Especificación de Extensiones Futuras del Motor

Para evolucionar este protocolo a un estándar de la industria, las siguientes capas son directamente implementables sobre la base de código actual:

1. **Capa CRDT de Fusión de Texto (Integration Vector):**
   * Sustituir el motor de comparación LWW (*Last-Write-Wins*) por una implementación ligera de **Yjs** o **Automerge** sobre el DataChannel de WebRTC en `src/sync/sync-engine.ts`, garantizando que dos modificaciones concurrentes al mismo archivo se integren sin generar archivos de conflicto.
2. **Abstracción de Biblioteca (`@omnisync/core`):**
   * Desacoplar `src/crypto/crypto-manager.ts`, `src/network/nostr-mailbox.ts` y `src/network/blossom-client.ts` en un paquete agnóstico de Node.js, navegadores y React Native, permitiendo que cualquier desarrollador construya apps de notas, gestores de contraseñas o chats con 5 líneas de código.
3. **Soporte de Topología Mesh Multi-Peer:**
   * Ampliar la señalización WebRTC para coordinar múltiples conexiones P2P simultáneas entre más de dos dispositivos utilizando una red de malla descentralizada.

---

## 6. Conclusión

OmniSync trasciende el caso de uso de Obsidian. Lo que se ha diseñado e implementado en este repositorio es un **sistema operativo de sincronización distribuida para la era post-nube centralizada**. Devuelve la soberanía de los datos al usuario en su totalidad, garantizando velocidad de milisegundos en tiempo real, resiliencia asíncrona permanente y privacidad matemática infranqueable.
