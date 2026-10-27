<div align="center">
  <img src="assets/omnisync-banner-opt.png" alt="OmniSync" width="400" />
</div>

# OmniSync

> **Tus notas de Obsidian, siempre al día en todos tus dispositivos. Gratis, privadas y sin cuentas.**

[English](README.md) | **Español** | [Guía de Usuario](docs/Guía%20de%20Usuario.md) | [Guía de Desarrolladores](docs/Guía%20de%20Desarrolladores.md)

![Licencia](https://img.shields.io/badge/licencia-PolyForm%20Noncommercial%201.0.0-blue)
![Cifrado](https://img.shields.io/badge/cifrado-AES--256--GCM%20extremo%20a%20extremo-green)
![Plataformas](https://img.shields.io/badge/Obsidian-escritorio%20y%20m%C3%B3vil-7c3aed)

Escribes en tu PC y la nota aparece en tu móvil. Sin suscripción, sin registrarte en ningún servicio y sin que nadie, ni siquiera el servidor que ayuda a conectarlos, pueda leer lo que escribes.

---

## ¿Qué problema resuelve?

Sincronizar Obsidian entre dispositivos suele obligarte a elegir:

| Opción habitual | El inconveniente |
|---|---|
| Servicio oficial de Obsidian | Suscripción mensual |
| Carpeta en la nube (Dropbox, Drive…) | Tus notas viven en servidores ajenos y es fácil acabar con archivos duplicados o en conflicto |
| Montar tu propio servidor | Tiempo, conocimientos técnicos y mantenimiento |

OmniSync ofrece otro camino: **tus dispositivos hablan directamente entre ellos**.

## Cómo funciona (sin tecnicismos)

- **Una llamada directa, no una centralita.** Tus dispositivos se conectan de tú a tú (técnicamente, *P2P*). Es como una llamada entre dos teléfonos en vez de dejar mensajes en una oficina de correos.
- **Una caja fuerte para cada nota.** Todo se cifra *antes* de salir de tu dispositivo (*cifrado de extremo a extremo*, AES-256). Quien transporta el mensaje solo ve una caja cerrada; la llave está únicamente en tus dispositivos.
- **Un punto de encuentro, no un intermediario.** Para que dos dispositivos se encuentren hace falta un lugar donde coincidir, como una cafetería donde quedáis. Por defecto se usa **Nostr**, una red pública y abierta que nadie controla y que no cuesta nada. Si prefieres tu propio local, puedes desplegar un **Cloudflare Worker** gratuito con un asistente guiado. Una vez conectados, las notas no pasan por ahí.
- **Si el otro dispositivo está apagado, no pasa nada.** Los cambios pequeños quedan en un buzón cifrado y se recogen cuando vuelve a conectarse. Los archivos grandes (imágenes, PDF, audio) viajan por **Blossom**, una red de almacenamiento donde el nombre de cada archivo es su huella digital, así que no se puede alterar sin que se note.

## Qué incluye

- **Sincronización en tiempo real** entre cualquier número de dispositivos, en escritorio y móvil.
- **Cifrado de extremo a extremo** (AES-256-GCM). No hay cuentas, ni correo, ni contraseñas que recordar.
- **Vincular con un QR**: escaneas con la cámara de tu móvil, confirmas y listo. El QR sirve **una sola vez** y **caduca a los 2 minutos**; la clave no va dentro del QR (se negocia de forma cifrada al escanear).
- **Edición simultánea**: ves los cursores de tus otros dispositivos sobre la nota abierta.
- **Fusión inteligente de conflictos**: si editaste la misma nota sin conexión en dos sitios, se combinan los cambios en lugar de pisarse.
- **Sin pérdidas por accidente**: lo que se borra en otro dispositivo va a la **papelera de Obsidian**, nunca se destruye sin más.
- **Archivos adjuntos y apariencia** (opcional): imágenes, PDF, audio, temas y *snippets* CSS.
- **Control total**: puedes revocar un dispositivo regenerando la clave maestra.
- **Cuatro idiomas**: español, inglés, chino y ruso.

## Instalación

> OmniSync está en proceso de validación para el directorio de plugins de la comunidad de Obsidian. Mientras tanto, instálalo a mano:

1. Descarga `main.js`, `manifest.json` y `styles.css` de la [última versión](https://github.com/abismalmx/OmniSync/releases).
2. Crea la carpeta `.obsidian/plugins/omnisync/` dentro de tu bóveda y copia ahí los tres archivos.
3. En Obsidian: **Ajustes → Plugins de la comunidad** → activa **OmniSync**.
4. Abre **Ajustes → OmniSync → Asistente de Vinculación** para conectar tu segundo dispositivo.

La guía completa, con capturas de cada paso, está en la [Guía de Usuario](docs/Guía%20de%20Usuario.md).

## Privacidad y transparencia

Preferimos ser claros a sonar perfectos:

- **Qué ve la red:** el contenido de tus notas y los nombres de tus archivos están cifrados. Un relay de Nostr sí puede ver tu dirección IP, que existe una sala con un nombre seudónimo, la hora y el tamaño aproximado de los mensajes. Si eso te importa, usa tu propio Worker.
- **Cifrado de extremo a extremo (AES-GCM):** tus notas se cifran de extremo a extremo con AES-256-GCM.
- **Un QR es como una llave de hotel:** solo escanea códigos que hayas generado tú, en el momento. Un QR fotografiado o caducado no sirve; uno recién generado, sí, durante sus 2 minutos.

## Licencia: código público, uso libre para fines no comerciales

OmniSync se publica bajo la **[PolyForm Noncommercial License 1.0.0](LICENSE)**, una licencia estándar y revisada por abogados.

**Puedes, sin pedir permiso:**
- Usarlo gratis para tus notas personales, estudio, hobbies o investigación.
- Leer, estudiar, modificar y compartir el código con fines no comerciales.
- Usarlo en organizaciones sin ánimo de lucro, instituciones educativas, entidades públicas y gubernamentales.

**No puedes, sin acuerdo previo con el autor:**
- Venderlo, ofrecerlo como servicio de pago o integrarlo en un producto comercial.
- Usarlo dentro de una empresa con fines de lucro.

Para uso comercial, licencias o dudas, contacta al autor: [abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net) | [github.com/abismalmx](https://github.com/abismalmx).

> **Nota:** como restringe el uso comercial, esta licencia es *de código disponible* y no cumple la definición formal de «open source» de la OSI. El código está completo y público; lo que se reserva el autor es el uso comercial.

## Desarrollo y contribuciones

```bash
npm install
npm run build        # genera main.js
npm test             # suite completa
npm run typecheck && npm run lint
```

Las contribuciones son bienvenidas: abre un *issue* o un *pull request*. Más detalles en la [Guía de Desarrolladores](docs/Guía%20de%20Desarrolladores.md).

---

Creado por **abismalmx**. Si OmniSync te ahorra una suscripción, cuéntaselo a alguien que use Obsidian.
