# Roadmap — OmniSync

Ideas y mejoras identificadas que requieren decisiones de diseño o trabajo de protocolo significativo. No son compromisos; son candidatos evaluados para versiones futuras.

---

## Identidad por dispositivo con revocación individual

**Contexto:** actualmente todos los dispositivos vinculados comparten la misma identidad Nostr (misma clave pública). Si un dispositivo se pierde o se compromete, revocar su acceso requiere cambiar la clave maestra de todos los dispositivos.

**Propuesta:** cada dispositivo genera su propio keypair Nostr. El anfitrión mantiene una lista de pubkeys autorizados. Revocar un dispositivo elimina solo su pubkey de la lista sin afectar a los demás.

**Alcance del cambio:** afectaría el protocolo de vinculación (pairing), `nostr-mailbox.ts`, `signaling-client.ts`, `blossom-client.ts`, el Worker (allowlist dinámica), y requeriría una migración para vaults ya vinculados. Equivale a una versión 2.0 del protocolo.

**Estado:** pospuesto hasta tener feedback de uso real sobre si la revocación individual es una necesidad frecuente.

---

## Número de secuencia en eventos Nostr (resistencia a replay/rollback)

**Contexto:** los eventos Nostr se re-firman al reenviar. Un relay malicioso podría reordenar o "resucitar" eventos viejos porque el cifrado AES-256-GCM no incluye datos adicionales autenticados (AAD) que aten cada mensaje a su posición en la secuencia.

**Propuesta:** incluir un contador de sesión o número de secuencia monotónico en el AAD del cifrado GCM. Esto haría que un evento de la posición N no sea válido si se entrega como posición M.

**Alcance del cambio:** cambia el formato de los eventos cifrados, rompiendo compatibilidad con vaults existentes. Requiere una migración limpia o un campo de versión de protocolo.

**Estado:** pospuesto a v1.1 para no romper compatibilidad en la primera versión pública.

---

*Última actualización: 2026-10-26.*
