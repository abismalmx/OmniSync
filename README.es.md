<div align="center">
  <img src="assets/omnisync-banner-opt.png" alt="OmniSync" width="400" />
</div>

[English](README.md) | **Español** • **Documentación:** [Guía de Usuario (ES)](docs/Guía%20de%20Usuario.md) / [EN](docs/User_Guide_EN.md) | [Guía de Desarrolladores (ES)](docs/Guía%20de%20Desarrolladores.md) / [EN](docs/Developer_Guide_EN.md) | [Comparativa (ES)](docs/COMPARATIVA_es.md) / [EN](docs/COMPARISON_EN.md)

![Licencia](https://img.shields.io/badge/licencia-PolyForm%20Noncommercial%201.0.0-blue)
![Cifrado](https://img.shields.io/badge/cifrado-AES--256--GCM%20extremo%20a%20extremo-green)
![Plataformas](https://img.shields.io/badge/Obsidian-escritorio%20y%20m%C3%B3vil-7c3aed)

---

Todas las soluciones de sync para Obsidian te obligan a elegir entre tres males: pagar el servicio oficial, confiarle tus notas a Dropbox, o montar tu propio servidor. OmniSync se salta esa disyuntiva.

**Tus dispositivos se sincronizan directamente entre ellos. Ninguna nube guarda tus notas. No existe ninguna cuenta que hackear.**

Ese es el cambio: en vez de pasar tu bóveda por un servidor, OmniSync convierte tus dispositivos en pares. La nota sale de tu laptop ya cifrada, viaja de punto a punto, y llega a tu móvil. El relay que los ayuda a encontrarse nunca ve nada legible — solo una caja cerrada que pasa de largo.

## Por qué es diferente

**P2P de verdad, no "nube auto-hospedada".** Otros plugins reemplazan Dropbox con tu propio servidor. OmniSync reemplaza el servidor con una conexión directa. La diferencia importa: nada se almacena en tránsito, nada se acumula en ningún lado, no hay base de datos que respaldar ni perder.

**Vinculación por QR.** Abres el asistente en tu laptop, escaneas el código con la cámara de tu móvil, confirmas en ambos lados. Listo — claves criptográficas intercambiadas, nunca escritas en ningún lado, caducadas dos minutos después de escanear. Sin usuarios, sin contraseñas, sin correo.

**Asíncrono por diseño.** Tu móvil no necesita estar en línea cuando editas en el escritorio. Los cambios esperan en un buzón cifrado (un Cloudflare Worker que despliegas en un clic, o un relay público de Nostr) y sincronizan en el momento en que el dispositivo despierta. Blossom se encarga de los archivos grandes — imágenes, PDFs, audio — donde cada archivo se direcciona por su propio hash, así que la manipulación es estructuralmente imposible.

**Tiempo real encima de todo.** Cuando ambos dispositivos están en línea y la misma nota está abierta, ves el cursor del otro dispositivo moviéndose. Las ediciones se fusionan a nivel de carácter; dos personas escribiendo en el mismo párrafo sin conexión obtienen ambas versiones reconciliadas, no una pisando a la otra.

**Nada sale como texto plano.** AES-256-GCM, de extremo a extremo. El servidor ve texto cifrado y tamaños aproximados de mensajes. Si incluso eso te preocupa, un asistente despliega tu propio Worker en minutos y el relay público nunca se usa.

## Instalación

> OmniSync está en proceso de validación para el directorio de plugins de la comunidad de Obsidian. Por ahora, instálalo a mano:

1. Descarga `main.js`, `manifest.json` y `styles.css` de la [última versión](https://github.com/abismalmx/OmniSync/releases).
2. Crea `.obsidian/plugins/omnisync/` dentro de tu bóveda y copia los tres archivos ahí.
3. En Obsidian: **Ajustes → Plugins de la comunidad** → activa **OmniSync**.
4. Abre **Ajustes → OmniSync → Asistente de Vinculación** para conectar tu primer par de dispositivos.

Guía completa en la [Guía de Usuario](docs/Guía%20de%20Usuario.md).

## Limitaciones honestas

- Un relay de Nostr ve tu IP, que existe una sesión cifrada y los tamaños de los mensajes. Usa tu propio Worker si eso te importa.
- Revocar un dispositivo requiere regenerar la clave maestra y volver a vincular todos los demás. Es un tradeoff intencional por no tener ninguna autoridad central a quien pedirle permiso.
- Actualmente en revisión por parte de Obsidian — todavía no se puede instalar con un clic desde el directorio de plugins.

## Licencia

**[PolyForm Noncommercial 1.0.0](LICENSE)** — gratis para uso personal, estudio, organizaciones sin fines de lucro e investigación. El uso comercial requiere un acuerdo aparte: [abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)

## Build

```bash
npm install
npm run build
npm test
```

---

Hecho por **abismalmx**. Si te ahorra una suscripción, cuéntaselo a alguien.
