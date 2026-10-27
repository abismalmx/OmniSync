# Política de seguridad — OmniSync

## Versiones con soporte

OmniSync está en desarrollo activo. Se aplican correcciones de seguridad únicamente a la versión más reciente publicada.

## Estado de la verificación de seguridad

La seguridad de OmniSync se ha comprobado por capas, y los detalles son públicos:

- **Auditorías dirigidas y cacerías de bugs** del protocolo, el emparejamiento, el Worker y la lógica de sincronización. Todos los hallazgos están corregidos salvo unas pocas decisiones de diseño que se listan abiertamente.
- **Análisis automático** (Semgrep, CodeQL, gitleaks, escáneres de dependencias) sin secretos ni dependencias vulnerables.
- **Verificación en Workers reales de Cloudflare:** se probó la sincronización de extremo a extremo y se inspeccionaron los propios registros del servidor para confirmar que mensajes, notas y adjuntos viajan **cifrados (AES-256-GCM) y ofuscados** (identificadores opacos, sin rutas ni nombres). El servidor aún puede ver metadatos como los momentos y el tamaño aproximado.
- **Pruebas dinámicas (DAST)** con un fuzzer propio, nuclei, OWASP ZAP y testssl.sh: sin fallos ni errores de servidor.

Esto no sustituye una revisión humana independiente del protocolo criptográfico, y no ha cubierto escaneos autenticados con la clave de un usuario real ni dispositivos reales. Consulta [`docs/SECURITY_FINDINGS.md`](docs/SECURITY_FINDINGS.md) y [`docs/TESTS_AND_AUDITS.md`](docs/TESTS_AND_AUDITS.md).

## Cómo reportar una vulnerabilidad

**No abras un issue público si has encontrado una vulnerabilidad de seguridad.** La divulgación pública antes de que exista un parche disponible puede poner en riesgo a los usuarios actuales.

Envía un correo con el asunto `[OmniSync Security]` a:

**abismalmx.splurge748@8shield.net**

Incluye en el mensaje:

1. Descripción del problema y el impacto potencial.
2. Pasos para reproducirlo (con la entrada mínima que lo desencadena).
3. Versión del plugin afectada (la puedes ver en `manifest.json`).
4. Si tienes un parche propuesto, es bienvenido.

## Qué esperar

- Acuse de recibo en un plazo de **72 horas**.
- Evaluación del problema e indicación de si se considera una vulnerabilidad válida en un plazo de **7 días**.
- Corrección y publicación coordinadas. Se te mencionará en el changelog salvo que prefieras el anonimato.

## Alcance

El alcance de la política incluye:

- El código TypeScript del plugin (`src/`).
- El Worker de Cloudflare (`scripts/cloudflare-allinone/worker.js`).
- El protocolo de vinculación efímera y el flujo de pairing.

No está en el alcance de esta política:

- Vulnerabilidades en Obsidian, Cloudflare, Nostr o Blossom (repórtalas a sus respectivos mantenedores).
- Ataques que requieran acceso físico al dispositivo desbloqueado.
- Ingeniería social sobre el usuario (por ejemplo, convencerle de escanear un QR malicioso).

## Riesgos residuales conocidos y aceptados

Consulta la sección «Riesgos residuales aceptados» en [`docs/SECURITY_FINDINGS.md`](docs/SECURITY_FINDINGS.md).

---

*Este documento está disponible también en inglés: [`SECURITY.md`](SECURITY.md).*
