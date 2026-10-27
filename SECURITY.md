# Política de seguridad — OmniSync

## Versiones con soporte

OmniSync está en desarrollo activo. Se aplican correcciones de seguridad únicamente a la versión más reciente publicada.

## Cómo reportar una vulnerabilidad

**No abras un issue público si has encontrado una vulnerabilidad de seguridad.** El disclosure público antes de que exista un parche disponible puede poner en riesgo a los usuarios actuales.

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

*Este documento está disponible también en inglés: [`SECURITY_EN.md`](SECURITY_EN.md).*
