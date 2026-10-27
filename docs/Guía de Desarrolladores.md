# Guía de Desarrolladores – OmniSync

## Propósito y arquitectura general
OmniSync es un plugin de **Obsidian** (escritorio y móvil) que sincroniza una bóveda entre dispositivos **sin servidor central**: los dispositivos se conectan por **WebRTC** (P2P) y todo el contenido se cifra de extremo a extremo con **AES-256-GCM**. Para encontrarse usan un servidor de señalización que puede ser un relay **Nostr** público (por defecto) o un **Cloudflare Worker** propio; los pares ausentes se atienden con un buzón en Nostr (notas pequeñas) y con **Blossom** (archivos grandes).

Licencia: [PolyForm Noncommercial 1.0.0](../LICENSE) (código público, uso no comercial libre). Ver «Contribuciones».

### Principios clave
| Principio | Descripción |
|---|---|
| **P2P primero** | Los datos viajan directamente entre pares (WebRTC DataChannel); el servidor de señalización solo coordina el encuentro. |
| **Cifrado de extremo a extremo** | Clave maestra por bóveda; contenido y rutas (ofuscadas con HMAC) cifrados antes de salir del dispositivo. |
| **Transporte desacoplado** | La identidad criptográfica es independiente del canal: WebRTC, buzón Nostr, Blossom y Worker son capas intercambiables. |
| **Desconfianza por defecto** | Todo mensaje de red se valida (tamaño, tipo, rutas, repetición) antes de tocar el disco. Los módulos `src/security/` concentran estas reglas. |
| **No destruir datos** | Los borrados remotos van a la papelera de Obsidian; los conflictos se fusionan (3 vías) en lugar de sobrescribir. |

## Estructura del código
```
src/
├─ main.ts                    # Plugin: ciclo de vida, ajustes, orquestación, vinculación
├─ types.ts                   # Tipos y constantes (servidores Blossom por defecto, etc.)
├─ crypto/crypto-manager.ts   # Derivación de claves, AES-256-GCM, HMAC de rutas
├─ network/
│   ├─ signaling-client.ts    # Cliente de señalización (Nostr / Worker)
│   ├─ webrtc-peer.ts         # Conexión P2P y canales de datos
│   ├─ nostr-mailbox.ts       # Buzón asíncrono cifrado (notas < 64 KB)
│   ├─ blossom-client.ts      # Almacenamiento de blobs (BUD-01/02, NIP-98)
│   ├─ blossom-providers.ts   # Servidores y límites por defecto
│   └─ pairing-channel.ts     # Transporte de la vinculación efímera
├─ sync/
│   ├─ vault-watcher.ts       # Detecta cambios en la bóveda
│   ├─ manifest-calc.ts       # Manifiestos / hashes para saber qué falta
│   ├─ file-transfer.ts       # Envío y recepción de archivos
│   ├─ delta-patch.ts         # Parches diferenciales
│   ├─ base-snapshot-store.ts # Versión base para la fusión
│   └─ diff-merge.ts          # Fusión de texto de tres vías
├─ collab/codemirror-collab.ts# Cursores y selecciones remotas (CodeMirror 6)
├─ security/                  # Validadores y protocolos (rutas, red, transferencias,
│                             #   anti-repetición, vinculación, NIP-98, etc.)
├─ ui/                        # Pestaña de ajustes, modal de vinculación, asistente de Cloudflare
├─ i18n/                      # Es, en, zh, ru
└─ templates/                 # Plantilla generada del Cloudflare Worker
scripts/cloudflare-allinone/  # Worker «todo en uno» (Durable Objects + R2/Blossom)
tests/                        # Suites de pruebas (ver «Desarrollo local»)
```

### Flujo de una edición
1. `vault-watcher` detecta el cambio y lo pasa por las políticas de `security/` (ruta válida, tamaño, tipo).
2. Si el par está conectado: se envía por WebRTC como parche (`delta-patch`) o archivo (`file-transfer`), siempre cifrado.
3. Si no está: notas pequeñas van al **buzón Nostr**; archivos grandes se suben a **Blossom** y se anuncia su hash.
4. El receptor valida, descifra y aplica. Si ambos lados editaron sin conexión, `diff-merge` combina usando la versión base de `base-snapshot-store`; los borrados remotos se mandan a la papelera de Obsidian.

## Vinculación efímera
Archivos: `src/security/pairing-session.ts` (protocolo), `src/network/pairing-channel.ts` (transporte), `src/security/pairing.ts` (payload), rama `?pair=` de `scripts/cloudflare-allinone/worker.js`.
- QR = enlace `obsidian://omnisync-pair?data=<b64>` (manejador `registerObsidianProtocolHandler` → `handlePairingLink`, siempre con `confirm`); el código copiable `omnisync://pair2?data=` lleva el mismo contenido: `{v:2, token, transport, server}`; token de 128 bits, TTL 2 min desde que el QR está visible (el modal regenera uno nuevo al caducar), un solo uso. Sin clave maestra.
- Sala = HMAC(token,"room"). Mensajes `hello → offer → done`. ECDH P-256 efímero autenticado con MAC keyed por el token; HKDF-SHA256 (salt=token, info con ambas públicas) → AES-256-GCM con AAD (tipo, sala, públicas). El payload (clave maestra, sala, servidor) viaja solo en el `offer`.
- Un solo uso: `PairingHostSession` consume el código tras el primer `hello` válido; el indicador `busy` evita que dos `hello` simultáneos pasen (hallazgo H1).
- Canal `nostr`: eventos kind 25000 con tag `t`=sala, firma/edad/tamaño verificados. Canal `worker`: el anfitrión abre `/?pair=<sala>&auth=<NIP-98>` (el rol `host` lo fija el Worker); el invitado se une sin auth solo si hay anfitrión (404/409 en otro caso); DO en espacio `pair:<sala>`, 4 sockets, 16 KB.
- `pairNewDevice` pide confirmación si el servidor recibido difiere del actual (H3).
- Tras cambiar el Worker: `npm run build:templates` y redesplegar.

## Configuración
Los ajustes los guarda Obsidian (`data.json` del plugin) y se validan en `src/security/settings-security.ts` antes de usarse. La clave maestra se almacena con `secretStorage` cuando está disponible. Cualquier cambio de esquema debe mantener la migración de valores antiguos y pasar `npm run test:security`.

Cambios en el Worker: edita `scripts/cloudflare-allinone/worker.js`, ejecuta `npm run build:templates` (regenera `src/templates/cloudflare-worker-template.ts`) y redespliega.

## Desarrollo local
1. **Clona** el repositorio e instala dependencias:
   ```bash
   git clone https://github.com/abismalmx/OmniSync.git
   cd OmniSync
   npm install
   ```
2. **Compila**:
   ```bash
   npm run dev      # compilación continua
   npm run build    # producción: genera main.js
   ```
3. **Instala en una bóveda de pruebas**: copia `main.js`, `manifest.json` y `styles.css` a `<bóveda>/.obsidian/plugins/omnisync/`.
4. **Pruebas y calidad**:
   ```bash
   npm test                 # suite completa
   npm run test:pairing     # una suite concreta (ver package.json)
   npm run typecheck && npm run lint
   ```
   Si `test:i18n` falla con un locale en español, ejecútalo con `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. `test:distribution` exige que `zip/OmnySync_stable` esté al día (`npm run package:stable`).
5. **Depuración**: consola de desarrollador de Obsidian (`Ctrl+Shift+I`).

## Añadir un canal o backend
La lógica de red está desacoplada: un nuevo transporte debe (1) vivir en `src/network/`, (2) pasar sus mensajes por los validadores de `src/security/` (nunca confiar en el canal), (3) tener tests de seguridad y de rechazo de entradas hostiles, y (4) exponerse en `src/ui/settings-tab.ts` con textos en los cuatro idiomas (`src/i18n/`).

## Buenas prácticas
- Valida **todo** dato externo antes de usarlo: rutas, tamaños, tipos, firmas, antigüedad. Añade un test de entrada hostil por cada validación nueva.
- No uses `Math.random` ni cripto casera para secretos: reutiliza `crypto-manager` y las primitivas de `crypto.subtle`.
- Los textos de usuario van siempre por i18n (es/en/zh/ru) y se comprueban con `test:i18n`.
- Limita concurrencia y presupuesto de CPU en las rutas que procesan datos de red (`concurrency-limiter`, presupuesto de la fusión).
- Documenta el protocolo cuando lo cambies: ver `PROTOCOL_WHITEPAPER.md` y `TESTS_AND_AUDITS.md`.

## Publicación y versionado
- **Semantic Versioning** (`MAJOR.MINOR.PATCH`); mantén `manifest.json` y `package.json` sincronizados.
- Cada release de GitHub debe adjuntar **`main.js`, `manifest.json` y `styles.css`** (es lo que Obsidian descarga). Crea un *tag* con el número de versión.
- Directorio de plugins de la comunidad: sigue la guía oficial de Obsidian (PR a `obsidian-releases` con `id`, `name`, `author`, `description`, `repo`).

## Contribuciones y licencia
El código se publica bajo la [PolyForm Noncommercial License 1.0.0](../LICENSE): puedes leerlo, modificarlo y compartirlo con fines no comerciales. Para uso comercial se necesita un acuerdo con el autor. Abre un *issue* antes de cambios grandes; los *pull requests* deben pasar `npm test`, `npm run typecheck` y `npm run lint`.
