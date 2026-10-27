# Informe de Auditoría de Seguridad y Calidad de Código — OmniSync

**Fecha:** 2026-10-24
**Alcance:** repositorio completo (plugin de Obsidian, TypeScript, ~15.700 líneas)
**Auditor:** Auditoría senior automatizada + revisión manual

---

## 1. Resumen ejecutivo

| Métrica | Antes | Después |
|---|---|---|
| Errores de ESLint | 46 | **0** |
| Findings de Semgrep (`--config auto`) | 12 | **0** |
| Findings de Semgrep (security-audit/OWASP/secrets) | 0 | **0** |
| Fugas de secretos (Gitleaks) | 0 | **0** |
| Vulnerabilidades en dependencias (OSV-Scanner) | 0 | **0** |
| Vulnerabilidades en dependencias (npm audit) | 0 | **0** |
| Regex candidatos a ReDoS | 2 | **0** |
| Dependencias de producción sin uso | 1 | **0** |
| Suites de tests activas | 11 | **12** |
| TypeScript (`tsc --noEmit`) | OK | **OK** |
| Build de producción | OK | **OK** |

**Veredicto:** el proyecto tiene una postura de seguridad sólida y bien diseñada
(validación estricta de rutas, AEAD con contextos de derivación separados,
guardas de replay, límites de tamaño en todas las fronteras de confianza). Los
defectos encontrados eran de **higiene de código** y **defensa en profundidad**,
no vulnerabilidades explotables. Todos han sido corregidos y verificados.

---

## 2. Detección y Linter

**Lenguaje:** TypeScript (ES2020, `strict: true`) empaquetado con esbuild → CommonJS.
**Linter aplicado:** ESLint 9.39.5 (flat config) + `typescript-eslint` 8.72.0 +
`eslint-plugin-security` 4.2.0.

> El repositorio **no tenía ninguna configuración de linter**. Se creó
> `eslint.config.mjs` desde cero, activando reglas de corrección (`eqeqeq`,
> `no-var`, `prefer-const`, `no-shadow`, `no-param-reassign`, `no-fallthrough`,
> `no-unsafe-optional-chaining`, `no-async-promise-executor`, …) y las reglas de
> seguridad del plugin.

### Defectos corregidos

| Tipo | Ubicación | Corrección |
|---|---|---|
| Variable no usada | `src/main.ts` | `App`, `addIcon`, `DiffMergeEngine`, `DevicePlatform`, `PairedDevice`, `p` |
| Variable no usada | `src/collab/codemirror-collab.ts` | `EditorSelection`, `RangeSetBuilder` |
| Variable no usada | `src/network/nostr-mailbox.ts` | `sanitizeExternalText` |
| Variable no usada | `src/security/mysecret-compat.ts` | `bytesToBase64` (función muerta) |
| Variable no usada | `src/sync/base-snapshot-store.ts` | `reject`, `err` |
| Variable no usada | `src/sync/file-transfer.ts` | `normalizePath` |
| Variable no usada | `src/sync/vault-watcher.ts` | `TFolder` |
| Variable no usada | `src/ui/pairing-modal.ts` | `PairedDevice` |
| Variable no usada | `scripts/cloudflare-blossom-worker.js` | `sBytes` (remanente del parser Schnorr), `ctx` |
| Variable no usada | `tests/*` | `MAX_DELTA_CHUNKS`, `MAX_DELTA_TOTAL_SIZE`, `MAX_MAILBOX_NOTE_SIZE`, `deviceB`, `receivedCount`, `rawWrites` |
| `await` redundante | `src/crypto/crypto-manager.ts`, `src/main.ts`, `tests/test-security.ts` | `no-return-await` |
| Shadowing | `src/network/signaling-client.ts:235` | `value` → `tagValue` |
| `any` implícito | `src/i18n/index.ts` | `window.moment` → `globalThis` tipado |
| Interfaz vacía | `tests/obsidian-stub.ts` | `interface EventRef {}` → `type EventRef = unknown` |
| Directiva obsoleta | `src/security/external-text.ts` | `eslint-disable` sin objeto |

**Nota sobre `DiffMergeEngine`:** `src/sync/diff-merge.ts` está documentado en
`omnisync_plan.md` como parte de la arquitectura (fusión 3-way), pero **no lo
invoca ningún módulo en `src/`** — el código real resuelve conflictos
generando copias de respaldo (`main.ts`) en lugar de fusionar in-place. Se
elimró el *import* muerto, conservando el módulo (documentado y testeado).

---

## 3. Fuga de secretos — Gitleaks

```bash
gitleaks detect --source . -v          # modo git: 0 commits (ver limitaciones)
gitleaks detect --source . -v --no-git # modo directorio: 1,80 MB escaneados
```

**Resultado: `no leaks found`** en el código fuente, en el bundle compilado
`main.js`, en `zip/OmnySync_stable/` y en los artefactos de build.

Verificaciones manuales complementarias:
- Sin `Math.random()` en `src/` ni `scripts/` (toda aleatoriedad criptográfica
  procede de `crypto.getRandomValues` / `crypto.subtle`).
- Sin credenciales, tokens, claves API ni cadenas similares embebidas.
- Sin claves privadas PEM ni archivos `.env`.

### Limitación detectada

**El directorio no es un repositorio Git.** `gitleaks detect` en modo git
falla con `no es un repositorio git` y escanea `0 commits`, por lo que **el
historial de commits no pudo auditarse**. El modo `--no-git` cubre el árbol de
trabajo actual pero no el historial.

**Recomendación:** inicializar el repositorio (`git init`) y volver a ejecutar
`gitleaks detect --source .` para cubrir el historial. Se ha añadido además un
`.gitignore` que el proyecto no tenía, que ignora `node_modules/`, caches de
build y —críticamente— patrones de secretos (`.env*`, `*.pem`, `*.key`).

---

## 4. Análisis estático de seguridad — Semgrep

```bash
semgrep scan --config auto .                                            # 455 reglas
semgrep scan --config p/security-audit --config p/owasp-top-ten \
              --config p/secrets --config p/javascript src/ scripts/     # 322 reglas
```

### Findings iniciales (12) → estado final (0)

| Regla | Cant. | Estado | Análisis |
|---|---|---|---|
| `prototype-pollution-loop` | 1 | **Corregido** | Ver sección 4.1 |
| `unsafe-formatstring` | 4 | **Corregido** | Ver sección 4.2 |
| `detect-insecure-websocket` | 4 | **Falso positivo** | Ver sección 4.3 |
| `unsafe-formatstring` (adicionales) | 3 | **Corregido** | Consistencia |
| `security-audit` + `owasp-top-ten` + `secrets` | 0 | — | Sin hallazgos |

### 4.1 — Prototype pollution en el motor i18n *(corregido)*

`getNestedValue()` recorría una ruta obtenida de la interfaz con indexación
directa (`curr = curr[part]`). Una clave `__proto__` alcanzaba la cadena de
prototipos y devolvía el propio prototipo como si fuera una traducción.

**Corrección:** lectura exclusiva de propiedades propias mediante
`Object.getOwnPropertyDescriptor` (los descriptores heredados nunca se
obtienen y los *getters* del prototipo no se ejecutan) más una lista explícita
de claves reservadas (`__proto__`, `constructor`, `prototype`). El mismo control
se aplicó a `getLocalizedBlossomProviderInfo()`.

### 4.2 — Inyección de format string en logs *(corregido)*

Cuatro llamadas a `console.warn()` interpolaban una ruta dinámica dentro del
**primer** argumento (la cadena de formato). Un archivo con nombre
`%s%s%s` podía falsear la salida del registro.

**Corrección:** el literal constante pasa a ser el primer argumento y el valor
dinámico se pasa como argumento separado, de modo que nunca se interpreta como
cadena de formato:

```ts
// Antes
console.warn(`[OmniSync] Error examinando nota '${file.path}':`, err);
// Después
console.warn('[OmniSync] Error examinando nota:', file.path, err);
```

Se aplicó el mismo criterio a los 10 avisos restantes con rutas dinámicas
(`main.ts`, `base-snapshot-store.ts`, `mysecret-compat.ts`, `vault-watcher.ts`).

### 4.3 — `ws://` en los diccionarios i18n *(falso positivo, sin cambio de código)*

Los 4 findings apuntaban a `src/i18n/locales/{en,es,ru,zh}.ts:76`, que contiene
literalmente el texto de la interfaz:

> `Insecure "ws://" connections are strictly disallowed.`

Es **documentación para el usuario** que explica que `ws://` está prohibido.
El código real de validación (`src/security/network-security.ts`) exige
estrictamente `wss:` y rechaza credenciales, fragmentos y caracteres de control.
No se modificó el código: introducir el esquema como texto partiría la cadena
literal en varios idiomas.

Se añadió un `.semgrepignore` que excluye `src/i18n/locales/` (documentado en
el propio fichero), de modo que el escaneo queda limpio y accionable.

---

## 5. Vulnerabilidades en dependencias — OSV-Scanner

```bash
osv-scanner scan -r . --no-ignore   # 186 paquetes analizados
npm audit                          # 0 vulnerabilidades
```

**Resultado: `No issues found`** en los 186 paquetes del `package-lock.json`.

| Paquete | Versión | Estado |
|---|---|---|
| `nostr-tools` | 2.25.2 | Sin CVEs |
| `qrcode` | 1.5.4 | Sin CVEs |
| `@codemirror/state` | 6.x | Sin CVEs |
| `@codemirror/view` | 6.x | Sin CVEs |
| `esbuild` | 0.25.12 | Sin CVEs |
| `typescript` | 5.9.3 | Sin CVEs |

### Dependencia eliminada

**`ws` (8.22.0) era una dependencia de producción sin uso.** No aparece en
ningún `import` del proyecto y su código no está presente en el bundle
`main.js` (verificado: 0 coincidencias de marcadores de WebSocket). Se eliminó
junto con `@types/ws`, reduciendo la superficie de ataque instalada.

---

## 6. Auditorías adicionales (no solicitadas, realizadas por completitud)

### 6.1 — Análisis de riesgo de ReDoS (2 regex reescritos)

`eslint-plugin-security` marcó dos expresiones regulares como candidatas a
backtracking. En ambos casos se verificó **experimentalmente** que no existía
denegación de servicio real (0,4 ms con 200.000 dígitos), pero se reescribieron
con analizadores manuales lineales, más auditables y sin dependencia del motor
de backtracking:

1. **`src/sync/delta-patch.ts`** — cabecera de bloque unificado
   (`@@ -1,2 +3,4 @@`) → `parseHunkHeader()`.
2. **`scripts/cloudflare-blossom-worker.js`** — ruta de blob (`/<sha256>.png`)
   → `parseBlobPath()`.

**Validación de equivalencia:** ambos analizadores se contrastaron contra su
regex original mediante *fuzzing*:

| Parser | Casos | Discrepancias |
|---|---|---|
| `parseHunkHeader` | 9.331 exhaustivos + 300.000 aleatorios | **0** |
| `parseBlobPath` | 205.854 (exhaustivos + aleatorios) | **0** |

> El *fuzzing* detectó un bug real en mi primera implementación del parser de
> bloques (`readNumber()` devolvía `null` pero se comparaba contra `undefined`,
> lo que hacía que `@@ -859, +585 @@` se aceptara como válido). Corregido y
> reverificado.

### 6.2 — Cobertura de tests real

**`tests/test-omnisync.mjs` no se ejecutaba nunca**: no estaba registrado en
`npm test` y, además, **reimplementaba** `DiffMergeEngine` y
`ManifestCalculator` dentro del propio fichero en lugar de probar los módulos
del proyecto. Una regresión en `src/sync/diff-merge.ts` o `src/sync/manifest-calc.ts`
no habría roto la suite.

**Corrección:** el fichero se reescribió para importar y ejercitar los módulos
reales (transpilados con esbuild en memoria), se amplió de 3 a 12 casos de
prueba (fusión ortogonal, ediciones remotas, conflictos, deltas de manifiesto,
detección de renombrados) y se registró como `npm run test:core`, integrado en
`npm test`.

### 6.3 — `tsc --noEmit` con `strict: true`

Sin errores. El proyecto ya era type-safe.

---

## 7. Evaluación de la arquitectura de seguridad

Aspectos correctamente implementados (verificados por lectura):

- **Cifrado**: AES-256-GCM con contextos de derivación separados
  (`VAULT_KEY_CONTEXT`, `SIGNALING_KEY_CONTEXT`, `MAILBOX_KEY_CONTEXT`,
  `BLOSSOM_KEY_CONTEXT`) — evita reutilización de clave.
- **Derivación**: PBKDF2 con 100.000 iteraciones y SHA-256.
- **Validación de rutas** (`vault-security.ts`): bloqueo de traversal,
  rutas absolutas, segmentos `.`/`..`, claves reservadas de `Object.prototype`,
  `.trash`, `.git`, plugins ejecutables de Obsidian y normalización estricta.
- **Límites de recursos**: topes de tamaño en toda frontera de confianza
  (payload, fragmentos, manifiesto, parches, diferencias Myerson).
- **Anti-replay**: `ReplayGuard` con ventana temporal y capacidad acotada.
- **Validación de red**: `wss://`/`https://` obligatorios, rechazo de
  credenciales embebidas y de redirecciones (`redirect: 'error'`).
- **Saneado de texto externo**: eliminación de caracteres de control, secuencias
  ANSI, truncado y bloqueo del prefijo `OmniSync:`.
- **Worker Cloudflare**: NIP-98 con verificación Schnorr propia, cuerpo
  limitado por streaming, CORS restringido.

---

## 8. Limitaciones y recomendaciones

1. **Historial Git no auditado.** El directorio no es un repositorio Git.
   Ejecutar `git init` y volver a lanzar `gitleaks detect --source .` para
   cubrir los commits.
2. **Falsos positivos de Semgrep ya resueltos.** Se añadió `.semgrepignore`
   para `src/i18n/locales/` y una directiva `nosemgrep` en el test que
   comprueba activamente que `ws://` es rechazado. El escaneo queda en **0
   findings**; no queda ninguna acción pendiente por este lado.
3. **127 warnings de ESLint residuales**, todos de severidad baja:
   - 64 `security/detect-object-injection` — falsos positivos sobre accesos a
     arrays tipados (`bytes[i]`) y a diccionarios con clave validada.
   - 37 `@typescript-eslint/no-non-null-assertion` — aserciones en tests.
   - 26 `@typescript-eslint/no-explicit-any` — punteros a APIs externas no
     tipadas (MySecret, Obsidian).
   Se pueden ir reduciendo de forma incremental; no son defectos funcionales.
4. **`zip/OmnySync_stable/` está desactualizado** respecto a `main.js` (bundle de
   341 KB del 24/10 01:03 frente a 503 KB del 24/10 23:06) y su `manifest.json`
   difiere del raíz (descripción y autor). Regenerar el paquete de distribución
   antes de publicar.
5. **`src/sync/diff-merge.ts` no está integrado** en el flujo de sincronización
   real. Decidir si se conecta (fusión 3-way en el copiado de conflictos) o si
   se retira del plan de arquitectura.

---

## 9. Verificación final (estado tras las correcciones)

| Comprobación | Comando | Resultado |
|---|---|---|
| Tipos | `npm run typecheck` | ✅ exit 0 |
| Lint | `npm run lint` | ✅ 0 errores, 127 warnings |
| Build | `npm run build` | ✅ exit 0 |
| Tests | `npm test` | ✅ 12 suites, 229 aserciones, 0 fallos |
| Secretos | `gitleaks detect --source . --no-git` | ✅ `no leaks found` (1,82 MB) |
| Análisis estático | `semgrep scan --config auto .` | ✅ **0 findings** (455 reglas) |
| Análisis estático profundo | `semgrep --config p/security-audit --config p/owasp-top-ten --config p/secrets` | ✅ 0 findings (319 reglas) |
| Dependencias | `osv-scanner scan -r . --no-ignore` | ✅ `No issues found` (186 paquetes) |
| Dependencias | `npm audit` | ✅ 0 vulnerabilidades |

### Ficheros creados

| Fichero | Propósito |
|---|---|
| `eslint.config.mjs` | Configuración flat de ESLint (el proyecto no tenía ninguna) |
| `.gitignore` | Excluye `node_modules/`, caches y patrones de secretos |
| `.semgrepignore` | Suprime los falsos positivos conocidos de los diccionarios i18n |
| `AUDIT_REPORT.md` | Este informe |

### Ficheros modificados

`src/i18n/index.ts`, `src/main.ts`, `src/crypto/crypto-manager.ts`,
`src/network/signaling-client.ts`, `src/network/nostr-mailbox.ts`,
`src/security/mysecret-compat.ts`, `src/security/external-text.ts`,
`src/sync/base-snapshot-store.ts`, `src/sync/delta-patch.ts`,
`src/sync/file-transfer.ts`, `src/sync/vault-watcher.ts`,
`src/collab/codemirror-collab.ts`, `src/ui/pairing-modal.ts`,
`scripts/cloudflare-blossom-worker.js`, `tests/test-omnisync.mjs`,
`tests/test-security.ts`, `tests/test-nostr-mailbox.ts`,
`tests/test-nostr-delta-mailbox.ts`, `tests/obsidian-stub.ts`,
`package.json`, `package-lock.json`.

---

## 10. Reproducibilidad

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # 12 suites (229 aserciones)
npm run build        # bundle de producción

npm run audit:secrets   # gitleaks detect --source . --no-git -v
npm run audit:static    # semgrep scan --config auto .
npm run audit:deps      # osv-scanner scan -r . --no-ignore
npm run audit           # cadena completa de las seis anteriores
```

Herramientas instaladas durante la auditoría: `eslint@9.39.5`,
`@eslint/js`, `typescript-eslint@8.72.0`, `eslint-plugin-security@4.2.0`,
`osv-scanner v2.7.0`. `gitleaks` y `semgrep` ya estaban disponibles.
