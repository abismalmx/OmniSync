# OmniSync All-in-One Cloudflare Worker

Servidor unificado para Cloudflare Workers en una única URL:
1. **Almacenamiento Blossom (R2)**: archivos de hasta 100 MB (blobs ya cifrados por el plugin).
2. **Señalización WebSocket (Durable Objects)**: punto de encuentro WebRTC con Hibernation API.

## Modelo de seguridad

El Worker es **privado y fail-closed**: sin la variable `ALLOWED_PUBKEYS` rechaza todo.

- Subidas (`PUT /upload`) y WebSocket exigen un evento NIP-98 firmado por una clave de `ALLOWED_PUBKEYS`.
- La firma queda ligada a la URL completa, al método, a la caducidad y, en las subidas, al SHA-256 del cuerpo (R2 lo verifica al guardar).
- Cada sala de señalización es un Durable Object distinto, con un máximo de 32 sockets, límite de tamaño y de ritmo de mensajes.
- Las descargas (`GET /<sha256>`) son públicas pero direccionadas por contenido, están cifradas de extremo a extremo y se sirven siempre como `application/octet-stream` con `nosniff`, CSP `sandbox` y `Content-Disposition: attachment`.
- El control anti-replay de eventos vive en memoria de cada isolate (best effort); la ligadura de payload/URL hace que una repetición solo pueda re-subir el mismo contenido.

`ALLOWED_PUBKEYS` es una lista de claves públicas hexadecimales (64 caracteres) separadas por comas o espacios.
El plugin la muestra en **Ajustes → Asistente de Cloudflare**; los comandos y archivos que copia ya la incluyen.

## Despliegue (bash/zsh)

```bash
npm install
npx wrangler r2 bucket create omnisync-blossom || true
# Edita wrangler.jsonc y sustituye __OMNISYNC_ALLOWED_PUBKEYS__ por tu clave pública
npx wrangler deploy
```

Wrangler imprimirá la URL (`https://omnisync-server.<tu-subdominio>.workers.dev`). Pégala en OmniSync (Ajustes → Asistente de Cloudflare → Todo-en-Uno).

## Desarrollo

`npm run test:cloudflare-allinone` en la raíz del plugin ejecuta la batería de pruebas, incluidos los casos negativos (clave no autorizada, cuerpo distinto, otro host, replay, sala ajena).
