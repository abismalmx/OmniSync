# Guía de Usuario – OmniSync

OmniSync mantiene tus notas de Obsidian iguales en todos tus dispositivos, en tiempo real, gratis y de forma privada. Esta guía está escrita para personas, no para ingenieros: cuando aparece un término técnico, lo explicamos con una comparación.

> **Esta guía es para ti, no para el código fuente.** No necesitas saber nada de programación. Si alguna parte te resulta complicada, el [resumen de 60 segundos](#resumen-de-60-segundos) y la sección de [problemas comunes](#12-problemas-comunes) suelen resolver el 90 % de los casos. Si prefieres el inglés, está en [User_Guide_EN.md](User_Guide_EN.md).

## Resumen de 60 segundos

Si solo vas a leer un trozo, lee este.

| Quiero… | Lo que hago |
|---|---|
| **Empezar** | Instalo el plugin ([sección 4](#4-instalación)) y vinculo el segundo dispositivo con el QR ([sección 5](#5-primeros-pasos-vincular-tus-dispositivos)). Ya está. |
| **Entender qué es esto** | Mis dispositivos se hablan directamente, con las notas cifradas dentro. Ningún servidor lee mis notas. ([sección 2](#2-cómo-funciona-omnisync-paso-a-paso)) |
| **Saber si es seguro** | Sí: cifrado de extremo a extremo, sin cuentas, sin contraseñas, sin servidor que guarde mis notas. ([sección 8](#8-privacidad-qué-se-ve-y-qué-no)) |
| **Que funcione con el móvil apagado** | Activo el modo **Doble vía** ([sección 3.1](#31-los-dos-ajustes-que-importan)). Sin esto, el otro dispositivo debe estar encendido. |
| **Entender una nota que no llega** | Miro la [tabla de mensajes](#10-qué-significan-los-mensajes). Dice exactamente qué hacer. |
| **Recuperar algo que borré** | No se borra: va a la papelera de Obsidian. ([sección 9](#9-gestionar-tus-dispositivos)) |
| **Perdí un dispositivo** | Regenero la clave maestra. ([sección 9](#9-gestionar-tus-dispositivos)) |

## Índice

- [Resumen de 60 segundos](#resumen-de-60-segundos)
- [1. La idea en un minuto](#1-la-idea-en-un-minuto)
- [2. Cómo funciona OmniSync, paso a paso](#2-cómo-funciona-omnisync-paso-a-paso)
- [3. Elegir cómo viajan tus notas](#3-elegir-cómo-viajan-tus-notas)
- [4. Instalación](#4-instalación)
- [5. Primeros pasos: vincular tus dispositivos](#5-primeros-pasos-vincular-tus-dispositivos)
- [6. La interfaz: dónde está cada cosa](#6-la-interfaz-dónde-está-cada-cosa)
- [7. Qué se sincroniza](#7-qué-se-sincroniza)
- [8. Privacidad: qué se ve y qué no](#8-privacidad-qué-se-ve-y-qué-no)
- [9. Gestionar tus dispositivos](#9-gestionar-tus-dispositivos)
- [10. Qué significan los mensajes](#10-qué-significan-los-mensajes)
- [11. Preguntas frecuentes](#11-preguntas-frecuentes)
- [12. Problemas comunes](#12-problemas-comunes)
- [13. Licencia](#13-licencia)

> **Nota sobre las secciones 3 y 4:** la instalación y la configuración son la parte que más se busca. Si vienes porque algo no funciona, ve directo a [12. Problemas comunes](#12-problemas-comunes).

## 1. La idea en un minuto

Imagina que cada nota es una carta. Con un servicio de nube tradicional, la dejas en una oficina de correos ajena y esperas que nadie la abra. Con OmniSync, **tus propios dispositivos se pasan la carta entre ellos**, siempre dentro de una caja cerrada cuya llave solo tienes tú.

| Quieres… | OmniSync te da… |
|---|---|
| No pagar una suscripción | Sincronización gratuita |
| Que nadie lea tus notas | Cifrado de extremo a extremo |
| No crear cuentas | Vinculas con un QR; no hay correo ni contraseña |
| Que los cambios lleguen ya | Tiempo real entre dispositivos |
| Que tu teléfono se ponga al día tras estar apagado | Un buzón que guarda tus cambios hasta que el otro dispositivo vuelve |

### 1.1 Lo que OmniSync **no** es

Estas confusiones son las más habituales, así que conviene despejarlas desde el principio:

| No es… | Por qué |
|---|---|
| **Una copia de seguridad (backup)** | Un backup guarda tus notas *para el futuro*. OmniSync las mueve *de ahora a hoy*: su buzón solo retiene cambios **7 días**. Si quieres ambas cosas, úsalo junto a iCloud, Dropbox o un disco externo. ([sección 2.3.1](#omnisync-no-es-un-backup)) |
| **Una carpeta en la nube** | No hay carpeta «OmniSync» en tu Drive ni en tu iCloud. Tus notas siguen siendo archivos normales en tu bóveda local; solo se copian entre tus dispositivos mientras están conectados. |
| **Un servicio de cuentas** | No hay registro, ni correo, ni contraseña, ni «olvidé mi contraseña». La llave la tienes tú y solo tú. |
| **Algo que intrigue al servidor** | Aunque pasa por un servidor, ese servidor solo recibe bloques revueltos que no puede abrir. ([sección 8](#8-privacidad-qué-se-ve-y-qué-no)) |

### 1.2 Un día normal con OmniSync

Para que veas el ritmo real antes de los detalles:

1. **Mañana.** Escribes en el portátil. Tras una fracción de segundo sin teclear, la nota ya está cifrada y en camino.
2. **En el tren.** El móvil estaba en modo avión. Al subir en el tren, el móvil busca el buzón y trae lo que se quedó atrás.
3. **Mediodía.** Abres la misma nota en el portátil y en la tablet. Ves el cursor del otro dispositivo moverse sobre el texto.
4. **Tarde.** Borras una nota en el móvil. En el portátil **no desaparece**: se va a la papelera de Obsidian, por si el borrado fue un error.
5. **Noche.** Cierras Obsidian. OmniSync manda primero lo que faltaba y luego se apaga. Nada se queda a medias en tu disco.

## 2. Cómo funciona OmniSync, paso a paso

### 2.1 Las palabras clave

Cada término técnico que aparece en esta guía está aquí, traducido al lenguaje de todos los días.

#### Lo básico: la red

| Concepto | Qué significa | Comparación |
|---|---|---|
| **P2P** (de igual a igual) | Tus dispositivos se conectan directamente entre sí | Una llamada entre dos personas, sin centralita |
| **Punto de encuentro (señalización)** | Un lugar donde tus dispositivos se encuentran | Una cafetería donde quedan; la cafetería no participa en la conversación |
| **Relay / Nostr** | Una red pública y abierta que OmniSync puede usar como punto de encuentro **y buzón** | Un tablón de anuncios público: lo que dejas ahí está en clave |
| **Cloudflare Worker** (opcional) | Tu propio punto de encuentro y buzón privados, en tu cuenta gratuita de Cloudflare | Tu propia cafetería privada con buzón |
| **Cifrado de extremo a extremo (AES-256)** | El contenido se revuelve antes de salir de tu dispositivo y solo se desrevuelve en los tuyos | Una caja cerrada: el mensajero la lleva pero no puede abrirla |
| **Clave maestra** | El secreto que comparten tus dispositivos | La llave de tu casa: quien la tiene, entra |
| **HMAC / ofuscación de rutas** | Los nombres de tus archivos se cambian por códigos ilegibles en camino | Poner tu nombre real en un sobre con un pseudónimo: el cartero solo ve el pseudónimo |

#### Lo que transporta tus cosas

| Concepto | Qué significa | Comparación |
|---|---|---|
| **Buzón** | Cambios pequeños que esperan, cifrados, hasta que el otro dispositivo se conecta | Una carta esperando en el buzón hasta que llegas a casa |
| **Parche rápido (delta)** | En vez de enviar la nota entera, se envía solo el trozo que cambiaste | En vez de reenviar el libro entero, te mando solo la página que corregiste |
| **Fusión a tres vías** | Si los dos dispositivos editaron lo mismo sin conexión, OmniSync los une solo | Como cuando Google Docs reconcilia a dos personas que escriben a la vez |
| **Instantánea base** | Una copia cifrada de cómo estaba tu nota la última vez que todo cuadró | El borrador anterior: con las dos versiones y la base, se puede reconstruir qué cambió |
| **Blossom** | Almacenamiento para archivos grandes (imágenes, PDF, audio) | Un guardarropa: cada abrigo se identifica por su huella, así que un cambiazo se notaría |
| **Papelera segura** | Cuando borras en un dispositivo, en los otros va a la papelera de Obsidian | En vez de quemar la carta, se archiva por si te arrepientes |
| **Sala anónima** | Un código que identifica a tu grupo de dispositivos sin revelar tu clave | Un número de隧el en una estación: solo los que lo saben se encuentran |

#### Los límites que conviene conocer de antemano

| Concepto | Qué significa | Comparación |
|---|---|---|
| **64 KB** | Tamaño máximo de una nota que puede viajar por el buzón | Una carta que cabe en el buzón; lo que no cabe, va por otro camino |
| **7 días** | Cuánto aguanta un cambio esperando en el buzón | El plazo para recoger un paquete en una oficina |
| **10 días** | Cuánto se guarda un archivo grande en tu propio Cloudflare | El plazo de prueba de una tienda: luego se limpia solo |
| **Sin conexión** | OmniSync sigue funcionando: guarda lo pendiente y lo reintenta solo | Un atasco en la red: se guarda y sale solo |

### 2.2 Qué pasa cuando escribes una nota

1. **Escribes.** Tras una fracción de segundo sin teclear, OmniSync nota el cambio.
2. **Cierra la nota.** El texto se cifra en tu dispositivo y el nombre del archivo se convierte en un código ilegible.
3. **Envía el cambio.** Por una vía o por dos, según el modo que hayas elegido en los ajustes:
   - **Directamente** a tu otro dispositivo, si está encendido, así que aparece casi al instante. (Esto siempre pasa.)
   - **A tu buzón**, para que esté ahí aunque el otro dispositivo esté apagado. (Esto solo pasa en el modo **Doble vía**.)
4. **El otro dispositivo la abre.** Comprueba que la nota es genuina, la descifra con la clave compartida y la escribe en tu bóveda.

Si en ese momento no se puede llegar al buzón (por ejemplo, sin señal), OmniSync **deja el cambio en una lista de espera y lo reintenta solo** (a los 2, 5 y 15 segundos, y luego cada 60). Esa lista sobrevive al cierre de Obsidian, así que no se pierde nada.

> **¿Por qué el cambio no aparece al instante en el otro dispositivo?** Aunque el otro equipo esté encendido, hay dos motivos habituales: (1) estás en modo **P2P puro** y no hay conexión directa abierta en ese momento; (2) estás detrás de una red que bloquea la conexión entre dispositivos (una red corporativa o un wifi con «clientes aislados»). Si el otro equipo está en la misma red wifi y tampoco llega, mira el [apartado 12.1](#121-las-notas-no-llegan).

### 2.3 Qué pasa si tu otro dispositivo estaba apagado

Escribes en el teléfono con el ordenador apagado. El cambio va al buzón. Más tarde abres Obsidian en el ordenador: OmniSync **consulta el buzón enseguida** y trae el cambio. En el teléfono también lo consulta cada minuto con la app abierta, al volver a ella y cuando regresa la conexión, porque los teléfonos duermen las conexiones en segundo plano para ahorrar batería.

<a id="omnisync-no-es-un-backup"></a>

### 2.3.1 ⚠️ OmniSync no es un backup

OmniSync es un **buzón de tránsito**, no un almacén permanente. Esto significa:

- El aviso del buzón que anuncia un cambio **caduca a los 7 días**. Pasado ese tiempo, el otro dispositivo ya no puede recibirlo por esa vía (aunque sí por P2P si ambos coinciden en línea).
- Los archivos grandes en tu servidor Cloudflare (R2) **se borran a los 10 días** por diseño (para que no llenes tu cuota gratuita).
- Los archivos grandes en relays públicos de Blossom **se borran en torno a los 7 días**, según la política de cada servidor.
- Si un dispositivo no se conecta durante más de 7 días y nunca hubo una sesión P2P directa, **los cambios de ese período no llegarán**.

**Lo que OmniSync sí garantiza:** que las notas que ya tienes en cada dispositivo están en tu bóveda local de Obsidian. Si quieres una copia de seguridad real (que tus notas «estén a salvo dentro de un mes pase lo que pase»), usa una solución de backup aparte: iCloud, Dropbox, una copia manual en un disco externo, o el plugin de Obsidian Sync. OmniSync y un backup se complementan bien: uno sincroniza en tiempo real, el otro guarda histórico.

### 2.4 Qué pasa si cierras la app justo después de escribir

Cuando sales o cierras Obsidian, OmniSync **envía primero lo que quedaba pendiente** (incluso el último segundo de escritura) y después se cierra. Al volver a arrancar también busca cambios que nunca llegaron a salir del dispositivo y los envía.

### 2.5 Si dos dispositivos editan la misma nota sin conexión

OmniSync une ambas versiones automáticamente, incluso dentro del mismo párrafo (una «fusión a tres vías», como Google Docs reconciliando a dos personas). Si no puede unirlas sin adivinar, conserva **las dos**: escribe la versión del otro dispositivo y guarda la tuya al lado, como una copia con un nombre del estilo `nota.conflict-2026-10-27-1530.md`. Nada se sobrescribe en silencio.

### 2.6 Si borras una nota

En tus otros dispositivos va a la **papelera de Obsidian**, nunca se destruye. Puedes recuperarla.

### 2.7 Edición en vivo

Si abres la misma nota en dos dispositivos a la vez, ves el cursor y la selección del otro sobre el texto.

## 3. Elegir cómo viajan tus notas

Todo esto se cambia en *Ajustes → Plugins de la comunidad → OmniSync → Ajustes* (o *Ajustes → OmniSync* si usas la versión con ajustes integrados).

### 3.1 Los dos ajustes que importan

Si solo vas a tocar dos cosas, que sean estas:

| Ajuste | Qué hace | Por qué te importa |
|---|---|---|
| **Modo de sincronización** | Decide si tus cambios también se guardan en un buzón | Es lo que decide si las notas llegan a un dispositivo **apagado**. |
| **Almacenamiento Blossom** | Activa el envío de imágenes, PDF, audios y notas muy extensas | Sin esto, los archivos multimedia solo viajan si ambos equipos están encendidos a la vez. |

#### Modo de sincronización

| Modo | Qué hace | Elígelo si… |
|---|---|---|
| **Doble vía (P2P + relay)** | Envía cada cambio directamente **y** a tu buzón | Quieres que funcione aunque tu otro dispositivo esté apagado (lo que quiere la mayoría) |
| **P2P puro (sin relays)** | Solo conexión directa; no se usa buzón (el punto de encuentro sigue sirviendo para que tus dispositivos se encuentren) | No quieres ningún servidor de por medio y tus dos dispositivos suelen estar encendidos a la vez |

> **Importante:** OmniSync arranca en **P2P puro**, así que en una instalación recién hecha las notas **solo** viajan cuando el otro dispositivo está encendido. Si quieres el comportamiento «mis notas llegan siempre», cambia a **Doble vía** en el desplegable «Modo de sincronización». Es un cambio de un clic y no requiere reconfigurar nada más.

### 3.2 Dónde vive tu buzón

El buzón es la «caja de cartas» que usa el modo Doble vía. Tienes tres opciones:

| Opción | Coste | Configuración | Notas |
|---|---|---|---|
| **Red pública Nostr** (predeterminada) | Gratis | Ninguna | Funciona al momento. El contenido va cifrado, pero un relay público puede ver cuándo sincronizas y más o menos qué tamaño tienen los cambios. |
| **Tu propio Cloudflare Worker, Todo-en-Uno** (recomendado si quieres más privacidad) | Gratis para uso personal | Un comando, guiado por un asistente | Tu servidor privado para el punto de encuentro, el buzón **y** los archivos grandes. Solo tu clave puede usarlo. |
| **Cloudflare, solo Blossom** | Gratis | Solo web, sin terminal | Guarda **únicamente archivos grandes**. Tus notas siguen yendo por la red pública Nostr. **No tiene buzón.** |

Para montar tu propio servidor: *Ajustes → OmniSync → Red y Servidores de Señalización P2P → Desplegar Servidor Privado Todo-en-Uno → Configurar Servidor Cloudflare*. El asistente te da un comando para copiar y muestra una tarjeta de estado que confirma que todo está listo, incluido el buzón.

> **Importante:** si montaste tu servidor de Cloudflare hace tiempo, **vuelve a desplegarlo con el comando actual del asistente**. Los servidores antiguos no tienen buzón, así que las notas no llegarían mientras el otro dispositivo está apagado. OmniSync te avisa cuando detecta esto.

### 3.3 Archivos grandes: Blossom

Las imágenes, PDF, audio y las notas de más de 64 KB (cuando no pueden viajar directamente) usan **Blossom**.
- Activa la opción de Blossom y elige un **límite por archivo** (perfiles para servidores públicos, 100 MB para tu propio servidor de Cloudflare, o el valor que quieras).
- **Hazlo en cada dispositivo.** Estos ajustes son por dispositivo: tu teléfono también necesita tu servidor Blossom en su lista; si no, no encontrará los archivos.
- Los archivos se cifran antes de subirse, así que el almacenamiento solo guarda bytes ilegibles.
- **El almacenamiento se limpia solo.** En tu propio servidor de Cloudflare, los archivos subidos se borran automáticamente a los 10 días, así que el espacio gratuito nunca se llena (el aviso del buzón que apunta a un archivo dura 7 días). Si montaste tu servidor antes de que existiera esta regla, añádela una vez: panel de Cloudflare → R2 → tu cubo → Settings → Object lifecycle rules → borrar objetos a los 10 días.
- **Las imágenes pegadas quedan ordenadas.** Obsidian guarda una imagen pegada como un archivo aparte. Por defecto OmniSync manda los adjuntos nuevos a una carpeta `Adjuntos` y la oculta del explorador de archivos; las imágenes se siguen viendo en tus notas y se sincronizan igual. Se puede desactivar en los ajustes («Ordenar los adjuntos»). No se usa una carpeta con punto porque Obsidian las ignora y las imágenes dejarían de mostrarse.
- Un archivo muy grande con una conexión móvil lenta puede agotar el tiempo (las subidas tienen 45 segundos y las descargas 30). Deja los archivos más pesados para cuando tengas Wi-Fi.

> **Privacidad de Blossom:** el servidor ve tu dirección IP, el tamaño cifrado, la huella (hash) del archivo y la fecha de la subida. **No** ve el nombre, la ruta, la extensión ni el contenido en claro.

### 3.4 Guía completa de todos los ajustes

Aquí está cada opción de la pantalla de ajustes, en el orden en que aparece. La columna «Cuándo tocarlo» te dice si es algo que configuras una vez o algo que rara vez necesitarás cambiar.

#### Automatización y flujo de trabajo

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Sincronización Automática en Tiempo Real** | Al abrir Obsidian, OmniSync se conecta solo y vigila tus archivos | Déjalo **encendido**. Si lo apagas, OmniSync queda desconectado hasta que pulses sincronizar a mano. |
| **Asistente de Vinculación y Código QR** | Abre la ventana para conectar dispositivos nuevos | Úsalo cada vez que añadas un dispositivo. |

#### Identidad de este dispositivo

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Nombre de este Dispositivo** | Cómo aparecerá este equipo en la lista de tus otros dispositivos («Laptop Personal», «Celular»…) | Ponle un nombre reconocible la primera vez. Así sabrás de un vistazo qué equipo es cuál. |
| **Tipo de Dispositivo** | *Computadora* o *Móvil*. Adapta iconos y la interfaz visual | OmniSync ya lo detecta solo. Cámbialo solo si te equivocó. |

#### Contenido y alcance de la sincronización

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Sincronizar Archivos Adjuntos** | Transfiere fotos, capturas, PDF, audios y otros archivos multimedia | Actívalo si quieres tus imágenes también en el móvil. Si lo apagas, solo viajan las notas de texto (`.md`, `.canvas`). |
| **Sincronizar Configuración Visual de Obsidian** | Mantiene sincronizados tus temas y fragmentos CSS | Actívalo si quieres que la bóveda se vea igual en todos tus equipos. Los plugins ejecutables (`.js`) y las cachés **nunca** se sincronizan, por seguridad. |
| **Ordenar los adjuntos** | Manda las imágenes pegadas a una carpeta `Adjuntos` y la oculta del explorador | Activo por defecto. Cámbialo solo si ya usas tu propia carpeta de adjuntos. |
| **Modo de sincronización** | *Doble vía* o *P2P puro* | El ajuste más importante. Ver [3.1](#31-los-dos-ajustes-que-importan). |
| **Almacenamiento de Archivos Grandes y Multimedia (Red Blossom)** | Activa el envío de archivos grandes por servidores Blossom | Actívalo si sincronizas imágenes o archivos pesados. Ver [3.3](#33-archivos-grandes-blossom). |
| **Servidores Blossom** | La lista de servidores donde se guardan los archivos grandes | Solo si usas los públicos por defecto. Puedes añadir los tuyos, uno por línea. Si el primero falla, OmniSync prueba los siguientes. |
| **Límite Máximo por Archivo** | El tamaño máximo que permites subir (25 / 50 / 100 MB o un valor libre) | Déjalo en el perfil recomendado para tu servidor. El plugin detecta el tipo de servidor y te lo sugiere. |

#### Red y servidores de señalización P2P

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Servidor de Señalización (Punto de Encuentro P2P)** | El lugar donde tus dispositivos se encuentran para hablar | Déjalo en *Nostr Nos.lol* (el de arriba del desplegable) si todo va bien. Cambiarlo no es algo que hagas a menudo. |
| **Dirección WebSocket del Servidor** | La dirección concreta (`wss://…`) | Solo si usas un servidor propio. Debe empezar obligatoriamente por `wss://` (con candado): las conexiones inseguras `ws://` no se admiten. |
| **Desplegar Servidor Privado Todo-en-Uno** | El asistente para montar tu propio servidor en Cloudflare | Opcional. Ver [3.2](#32-dónde-vive-tu-buzón). |

#### Seguridad, criptografía y recuperación

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Identificador Anónimo de Sala de Conexión** | El código con el que tus dispositivos se encuentran sin revelar tu clave | Solo informativo. No lo cambies: se deriva de tu clave maestra. |
| **Protección contra Pérdida de Notas Borradas** | Las notas borradas en otro dispositivo van a la papelera de Obsidian | Siempre activa. No hay nada que tocar. |
| **Restablecer y Regenerar Clave Maestra** | Crea una clave nueva y desconecta todos los dispositivos | Solo si perdiste un dispositivo o ves uno desconocido. Ver [sección 9](#9-gestionar-tus-dispositivos). |

#### Idioma

| Ajuste | Qué hace | Cuándo tocarlo |
|---|---|---|
| **Idioma de la Interfaz** | El idioma de los menús y mensajes de OmniSync | *Automático* sigue el idioma de Obsidian. También hay English, Español, Русский y 简体中文. |

> **Un ajuste por dispositivo.** Todo lo de esta pantalla se guarda **en cada equipo por separado**. Si cambias el modo a Doble vía en el portátil, el móvil sigue con el suyo hasta que lo cambies allí también. Es el error más común: «¡pero yo lo tenía activado!».


## 4. Instalación

> OmniSync está en proceso de validación para el directorio oficial de plugins de la comunidad. Cuando lo aprueben, bastará con buscarlo en Obsidian. Mientras tanto, se instala a mano.

### 4.1 Qué necesitas antes de empezar

| Requisito | Detalle |
|---|---|
| **Obsidian 1.11.4 o superior** | Es obligatorio: las versiones anteriores no tienen el almacén seguro donde OmniSync guarda tu clave maestra. Si tu Obsidian es más antiguo, actualízalo primero. |
| **Los 3 archivos del plugin** | `main.js`, `manifest.json` y `styles.css`. Los tres van juntos, en la misma carpeta. |
| **Internet** | Solo para la primera conexión entre dispositivos. Después, tu contenido va directo de un equipo al otro. |
| **Una bóveda** | La carpeta donde guardas tus notas. En el móvil también sirve la bóveda sincronizada por tu cuenta de Obsidian, si la usas. |

### 4.2 Instalación en computadora (Windows, macOS, Linux)

1. **Descarga los tres archivos** desde la [página de Releases](https://github.com/abismalmx/OmniSync/releases) de la última versión.
2. **Crea la carpeta del plugin.** En tu bóveda, entra en la carpeta `.obsidian` (en Linux y macOS puede estar oculta: pulsa `Ctrl+Shift+.` o `Cmd+Shift+.` para verla). Dentro, entra en `plugins` y crea una carpeta llamada `omnisync`.
3. **Copia los tres archivos** dentro de `omnisync`. Te quedarás con esto:
   ```
   TuBóveda/
   └── .obsidian/
       └── plugins/
           └── omnisync/
               ├── main.js
               ├── manifest.json
               └── styles.css
   ```
4. **Reinicia Obsidian** y ve a *Ajustes → Plugins de la comunidad*. Busca **OmniSync** y actívalo (el interruptor de la izquierda).
5. **Verifica que está activo.** En la barra inferior derecha de Obsidian debe aparecer `OmniSync (Desconectado)`. Si no aparece, revisa el punto 12.4.

### 4.3 Instalación en móvil (Android, iOS)

El proceso es el mismo, pero la forma de mover los archivos cambia según la plataforma:

| Plataforma | Dónde poner los archivos |
|---|---|
| **Android** | Usa tu explorador de archivos o la app *Files* de Samsung. La bóveda suele estar en `/sdcard/Documents/Obsidian` o en la carpeta de Obsidian que tú hayas elegido. |
| **iOS** | Usa la app *Archivos* de Apple. Necesitas conectarte primero a la bóveda desde Obsidian (una vez) para que aparezca en *Archivos → «On My iPhone»*. |

Luego, los mismos pasos 4 y 5: reinicia Obsidian y activa el plugin en *Ajustes → Plugins de la comunidad*.

> **Atajo en iOS:** si prefieres, puedes usar la app oficial **Obsidian Sync** (o iCloud) solo para distribuir la *carpeta* del plugin, sin sincronizar tus notas. Es una forma cómoda de instalar sin cables. Tus notas, eso sí, siguen siendo responsabilidad de OmniSync.

### 4.4 Verificar que todo funciona

Después de activar el plugin, comprueba estas tres cosas:

| Comprobación | Cómo se ve | Si falla |
|---|---|---|
| **El plugin está activo** | Abajo a la derecha aparece `OmniSync (Desconectado)` o `OmniSync (1)` | [12.4](#124-el-plugin-no-aparece-en-la-barra) |
| **Se generó tu clave** | En *Ajustes → OmniSync → Seguridad* hay un «Identificador Anónimo de Sala de Conexión» con un código | [12.5](#125-no-se-ve-el-código-de-sala) |
| **Puedes abrir el asistente** | El icono de OmniSync en la barra lateral izquierda abre la ventana de vinculación | [12.6](#126-no-me-deja-abrir-el-asistente-de-vinculación) |

### 4.5 Actualizar el plugin

1. Descarga los tres archivos de la versión nueva.
2. Sustituye los antiguos en `.obsidian/plugins/omnisync/`.
3. Reinicia Obsidian.

> **Importante:** mantén **todos tus dispositivos en la misma versión**. Si uno va por delante y otro por detrás, pueden no entenderse al negociar la conexión. Cuando actualices, actualiza todos en la misma tarde.

### 4.6 Desinstalar

1. En *Ajustes → Plugins de la comunidad*, desactiva OmniSync.
2. Borra la carpeta `.obsidian/plugins/omnisync/`.
3. Tus notas **no se tocan**: siguen ahí, exactamente donde estaban. OmniSync solo añadía copias entre dispositivos, nunca modificaba tus archivos en tu disco.

> **Aviso:** si desinstalas en un solo dispositivo y luego lo reinstalas, ese equipo generará una clave nueva y quedará desvinculado de los demás. Tendrás que volver a vincularlo con un QR.


## 5. Primeros pasos: vincular tus dispositivos

Vincular presenta tus dispositivos entre sí para que compartan la clave. Se hace una vez por dispositivo.

### 5.1 Vincular con un QR

1. En el dispositivo **que ya está configurado**, abre *Ajustes → OmniSync → Asistente de Vinculación y Código QR*. Aparece un **código QR** con una cuenta atrás («Caduca en …»).
2. En el **dispositivo nuevo**, abre la cámara del sistema y apúntala al QR. Se abre Obsidian y OmniSync te pide **confirmar** la vinculación.
3. Lee el aviso con atención. Te dirá **a qué servidor** se va a conectar el dispositivo nuevo. Si no es el tuyo, **cancela**.
4. Acepta. El dispositivo nuevo aparece en *Dispositivos Vinculados a esta Bóveda* en pocos segundos (hay un botón ⟳ para refrescar).

Ambos dispositivos deben estar en línea durante este paso.

**Por qué es seguro (la tarjeta de hotel):**
- El QR funciona **una sola vez** y **caduca a los 2 minutos**. Al caducar se genera uno nuevo automáticamente mientras el asistente sigue abierto.
- La clave maestra **no va dentro del QR**. Se envía cifrada, y solo después de que el dispositivo nuevo presente el código. Una foto del QR, caducado o ya usado, no sirve de nada.
- Siempre se te pide confirmar. Cualquier página web podría intentar abrir un enlace de OmniSync, así que **acepta solo si acabas de escanear tu propio QR**.

### 5.2 Alternativa: copiar el código

Si la cámara no abre Obsidian, usa **Copiar Clave Secreta de Vinculación** en el asistente y pégala en *Vincular Dispositivo Ahora* en el dispositivo nuevo. Es el último recurso porque el código pasa por el portapapeles (que otras apps pueden leer); caduca en los mismos 2 minutos.

### 5.3 El asistente de vinculación, por partes

La ventana del asistente tiene tres bloques. Merece la pena saber qué es cada uno:

| Bloque | Qué es | Qué haces con él |
|---|---|---|
| **Paso 1: Código QR y Clave** | El QR que escanea el otro dispositivo, y el botón para copiar la clave | Lo enseñas en pantalla para que el otro equipo la lea |
| **Paso 2: Conectar con otro Dispositivo** | El campo donde pegas una clave que te hayan pasado | Solo si el otro dispositivo ya tenía OmniSync y te manda su clave |
| **Paso 3: Dispositivos Vinculados** | La lista de tus equipos, con su estado en línea y la última sincronización | Para comprobar que todo está bien y para desvincular |

### 5.4 Cosas a tener en cuenta

- **Vincular reemplaza la clave maestra del dispositivo nuevo** por la tuya. Si ese dispositivo ya tenía otra, se te avisa antes.
- Si el QR trae un **servidor distinto del tuyo**, OmniSync muestra la dirección y te pide confirmar. **Confirma solo si la reconoces.**
- **Escanea solo QR que hayas generado tú.** Quien escanea el QR de otra persona puede acabar entregando su clave y su servidor.
- Tras vincular, revisa la lista de dispositivos. Si ves uno que no reconoces, **desvincúlalo y regenera la clave maestra** (ver [sección 9](#9-gestionar-tus-dispositivos)).
- Si usas tu propio servidor de Cloudflare, la vinculación también necesita que esté actualizado. El asistente muestra el comando que registra tu clave.
- **Un dispositivo puede vincularse con otro sin pasar por un QR**, si copias la clave a mano. Funciona igual.

### 5.5 Comprobar que la vinculación funcionó

| Comprobación | Dónde se ve | Lo que ves |
|---|---|---|
| **El otro equipo está en la lista** | Paso 3 del asistente | Su nombre y el estado «En línea» |
| **La barra de estado se actualiza** | Abajo a la derecha | Pasa de `OmniSync (Desconectado)` a `OmniSync (1)` (el número es la cantidad de equipos conectados) |
| **Una prueba real** | Cualquier nota | Escribe una línea nueva y mírala aparecer en el otro equipo en menos de un segundo |

> **Si el número sigue en 0 o el otro equipo no aparece**, ve al [apartado 12.1](#121-las-notas-no-llegan). El motivo más común no es OmniSync, sino que los dos equipos están en redes distintas que se bloquean entre sí.


## 6. La interfaz: dónde está cada cosa

OmniSync se apoya en las piezas que ya conoces de Obsidian. No hay una pantalla nueva que aprender.

### 6.1 La barra de estado (abajo a la derecha)

Es el indicador más importante. Dice en qué estado está la sincronización:

| Lo que ves | Qué significa | ¿Necesitas hacer algo? |
|---|---|---|
| `OmniSync (Desconectado)` | El plugin está activo pero todavía no hay ningún otro equipo conectado. Es el estado normal si aún no has vinculado nada. | Solo si ya has vinculado y debería estar conectado. |
| `OmniSync (1)` | Hay **1** dispositivo conectado y sincronizando en tiempo real. El número es la cantidad de equipos conectados ahora mismo. | No. Todo bien. |
| `OmniSync (2)` | Hay **2** dispositivos conectados (tú cuentas como uno). | No. Todo bien. |
| `Conectando...` | Está buscando a tus otros dispositivos por el punto de encuentro. | Espera unos segundos. |
| `Sincronizando...` | Está moviendo datos ahora mismo. | No. |
| `Error de sincronización` | Algo falló. | Mira el aviso que apareció y la [tabla de mensajes](#10-qué-significan-los-mensajes). |
| `🔒 MySecret bloqueado` | Usas el plugin MySecret y tu bóveda está bloqueada. OmniSync no puede leer tus notas hasta que la desbloquees. | Desbloquea MySecret. La sincronización se reanuda sola. |

**Clic en la barra de estado** = se abre el asistente de vinculación. Es la forma más rápida de llegar a él.

### 6.2 El icono en la barra lateral

En la barra de herramientas de la izquierda hay un icono con el emblema de OmniSync. Al pulsarlo se abre **el mismo asistente de vinculación**.

### 6.3 Los comandos de Obsidian

OmniSync añade tres comandos a la paleta de Obsidian. Ábrela con `Ctrl+P` (o `Cmd+P`) y escribe «OmniSync»:

| Comando | Para qué sirve |
|---|---|
| **OmniSync: Abrir asistente de vinculación (Código QR)** | Abre la ventana del QR y la lista de dispositivos. |
| **OmniSync: Forzar sincronización completa de la bóveda ahora** | Revisa todo tu contenido y lo sincroniza, aunque no haya cambios recientes. Útil si sospechas que algo se quedó atrás. |
| **OmniSync: Reparar notas con conflicto de cifrado (Integración MySecret)** | Solo si usas MySecret. Repara notas que quedaron con doble cifrado tras un bloqueo. |

### 6.4 La ventana del asistente de vinculación

Es la pantalla central de OmniSync. Está descrita en detalle en la [sección 5.3](#53-el-asistente-de-vinculación-por-partes), pero en resumen:

- **Arriba:** el QR y el botón para copiar la clave.
- **En medio:** el campo para pegar una clave que te hayan pasado.
- **Abajo:** la lista de dispositivos vinculados, con su estado, su última sincronización y los botones para desvincular o forzar una sincronización.

### 6.5 Los ajustes

Están en *Ajustes → Plugins de la comunidad → OmniSync → Ajustes*. La lista completa está en la [sección 3.4](#34-guía-completa-de-todos-los-ajustes).

---

## 7. Qué se sincroniza

Se configura en *Ajustes → OmniSync → Contenido y Alcance de la Sincronización*:

- **Notas** (siempre): archivos `.md`, `.markdown`, `.txt`, `.canvas`, `.json` y `.css`.
- **Adjuntos**: imágenes, PDF, audio, etc. (*Sincronizar Archivos Adjuntos*, opcional).
- **Apariencia de Obsidian**: temas y fragmentos CSS (*Sincronizar Configuración Visual de Obsidian*, opcional). Los plugins ejecutables y las cachés **no** se sincronizan, por seguridad y compatibilidad entre sistemas.

Y el interruptor **Sincronización Automática en Tiempo Real** activa o desactiva todo.

### 7.1 Qué pasa con cada tipo de archivo

| Tipo | Viaja por | Notas |
|---|---|---|
| `.md`, `.markdown`, `.txt` | P2P directo y buzón | Hasta 64 KB por el buzón; por encima, necesita Blossom |
| `.canvas` (tableros) | P2P directo y buzón | Un tablero es un archivo JSON: puede pesar bastante |
| `.json`, `.css` | P2P directo y buzón | Casi siempre de la carpeta `.obsidian` |
| Imágenes, PDF, audio, vídeo | Blossom (si está activo) o P2P directo | El límite por archivo depende del servidor que uses |
| La **papelera** de Obsidian (`.trash`) | ❌ No viaja | Es local de cada equipo |

### 7.2 Qué NO se sincroniza (y por qué)

| No viaja | Por qué |
|---|---|
| **Plugins de Obsidian** (`.js`) | Ejecutar código de otro equipo es un riesgo de seguridad. Se instalan a mano en cada dispositivo. |
| **Cachés y datos de sesión** | No aportan nada y generan conflictos. |
| **El historial de versiones** de Obsidian | Cada equipo gestiona el suyo. |
| **La papelera** | Es una red de seguridad local: si una nota se borró en un equipo, en los demás se puede restaurar, pero la papelera en sí no se replica. |

---

## 8. Privacidad: qué se ve y qué no

**Todo lo importante va cifrado.** El texto de tus notas, tus adjuntos y los **nombres de archivos y carpetas** viajan cifrados (AES-256-GCM). Nadie por el camino puede leerlos sin tu clave. Los nombres se convierten en códigos ilegibles, así que un servidor ni siquiera puede saber cómo se llaman tus notas.

**Qué se comprobó.** El equipo de OmniSync desplegó servidores reales de Cloudflare, sincronizó notas y adjuntos a través de ellos e **inspeccionó lo que recibía el propio servidor**. Solo vio códigos de aspecto aleatorio y datos revueltos: ni nombres de archivo, ni rutas, ni texto. Los adjuntos de hasta 95 MB volvieron idénticos, byte a byte. El servidor además rechaza a quien no tenga tu clave. Los detalles están en los [hallazgos de seguridad](https://github.com/abismalmx/OmniSync/blob/main/Github/docs/SECURITY_FINDINGS.md) y en las [pruebas y auditorías](TESTS_AND_AUDITS.md).

**Qué puede ver aún un servidor de buzón.** Aunque todo vaya cifrado, un servidor puede observar *que* algo ocurrió: cuándo sincronizas, más o menos qué tamaño tienen los cambios y cuántos son, y un código de sala anónimo. No ve el contenido ni los nombres. Un relay público además ve tu dirección IP.

| Si usas… | El servidor puede ver… |
|---|---|
| P2P puro (sin relays) | No se guarda nada en ningún servidor. El punto de encuentro puede ver que dos dispositivos se conectaron. |
| Red pública Nostr | Momentos, tamaño aproximado, un código de sala anónimo, tu IP |
| Tu propio servidor de Cloudflare | Lo mismo, pero solo lo manejas **tú** |

Si esto te preocupa, usa **P2P puro** o tu propio servidor de Cloudflare.

### 8.1 El detalle que suele importar: tu dirección IP

Con el buzón en una red pública, el servidor ve desde qué IP te conectas. Eso no le dice qué notas tienes, pero sí puede revelar:
- que tienes una bóveda con OmniSync,
- aproximadamente cuándo escribes,
- que dos equipos están en la misma casa o en la misma oficina.

Si prefieres evitarlo, usa tu propio Cloudflare Worker (todo lo manejas tú) o P2P puro.

### 8.2 Tu clave maestra y dónde vive

| Pregunta | Respuesta |
|---|---|
| ¿Dónde está mi clave? | En el **almacén seguro** de Obsidian (`SecretStorage`), no en un archivo de texto legible. |
| ¿Se guarda en la nube? | No. Vive en tu dispositivo. |
| ¿Qué pasa si la pierdo? | No puedes recuperarla. Tendrías que volver a vincular todos tus dispositivos desde cero. |
| ¿Cambia algún día? | Solo si tú pulsas *Regenerar Clave Maestra* o si desvinculas un dispositivo. |

### 8.3 El resumen en una frase

> Tus notas viajan en un sobre cerrado. El servidor lleva el sobre, sabe de qué tamaño es y cuándo pasó, y lo deja en un buzón. No puede abrirlo. Solo tú tienes la llave.

---

## 9. Gestionar tus dispositivos

### 9.1 Lo que puedes hacer

| Acción | Dónde | Cuándo hacerlo |
|---|---|---|
| **Renombrar o cambiar el tipo** de este dispositivo | *Ajustes → OmniSync → Identidad de este Dispositivo* | La primera vez, para reconocerlo luego en la lista |
| **Ver la lista de dispositivos** | Asistente de vinculación → Paso 3 | Cuando dudes de si todo está bien |
| **Desvincular un dispositivo** | Asistente de vinculación → *Desvincular* | Cuando ya no uses ese equipo (lo vendiste, te lo robaron, se rompió) |
| **Pausar la sincronización** | Desactiva *Sincronización Automática en Tiempo Real* | Si quieres dejar de sincronizar sin desinstalar |

### 9.2 Desvincular un dispositivo

> **Ojo: esto rota tu clave maestra.** Todos los dispositivos que tengas vinculados (incluido el que estás usando) **se desconectan** y tendrás que volver a vincular los que quieras conservar con un QR. Es la única forma real de revocar el acceso, pero es una operación que da miedo. Úsala solo cuando sea necesario.

### 9.3 Perdiste un dispositivo, o ves uno desconocido

Este es el procedimiento exacto:

1. Abre *Ajustes → OmniSync → Seguridad, Criptografía y Recuperación*.
2. Pulsa **Regenerar Clave Maestra**. Lee el aviso con calma: te va a decir exactamente qué va a pasar.
3. Confirma. A partir de ese momento, **ningún** dispositivo vinculado puede leer tus notas. El equipo que perdiste, aunque alguien lo tenga en sus manos, queda fuera.
4. Vuelve a vincular los dispositivos que conserves: en uno de ellos, abre el asistente, y en cada uno de los otros, escanea el QR nuevo.

### 9.4 Lo que NO hay que hacer

| No hagas esto | Por qué |
|---|---|
| Regenerar la clave «a menudo», «por si acaso» | Cada vez desconecta todos tus equipos y te obliga a revincular. |
| Compartir tu clave maestra con alguien | Quien la tiene puede leer todo lo que sincronizas. |
| Vincular el mismo equipo dos veces | Se crearán dos entradas en la lista. Desvincula la que sobre. |

---

## 10. Qué significan los mensajes

OmniSync avisa de lo importante con una notificación en Obsidian. Estos son **todos** los que puedes ver:

### 10.1 Mensajes normales (no requieren acción)

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| «*'nombre' quedó pendiente y se reenviará automáticamente*» | No se pudo llegar al buzón en ese momento. El cambio está guardado y se reintentará. | Nada. Revisa tu conexión si persiste. Sale como máximo una vez cada 10 minutos. |
| «*Se sincronizaron exitosamente N nota(s) desde el buzón seguro*» | Acaban de llegar cambios hechos en otro dispositivo. | Nada. |
| «*¡OmniSync conectado con 'nombre'!*» | Un dispositivo se ha conectado contigo. | Nada. |
| «*'nombre' actualizada mediante parche rápido*» | Se ha aplicado un cambio parcial (solo la parte que había cambiado). | Nada. |
| «*Los cambios de 'nombre' en ambos dispositivos se fusionaron automáticamente*» | Los dos editasteis lo mismo sin conexión y OmniSync lo resolvió solo. | Nada. Revisa el resultado si te importa. |
| «*Archivo 'nombre' recibido desde Blossom*» | Ha llegado un archivo grande. | Nada. |
| «*Adjunto subido a Blossom: 'ruta' (X MB)*» | Un archivo grande se ha enviado a almacenamiento. | Nada. |
| «*Nota extensa subida a Blossom: 'ruta' (X MB)*» | Una nota muy grande se ha enviado a almacenamiento. | Nada. |

### 10.2 Mensajes que requieren una acción

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| «*'nombre' pesa más de 64 KB. Para sincronizarla sin P2P activa el almacenamiento Blossom…*» | Una nota grande ahora solo puede viajar directamente. | Activa Blossom ([sección 3.3](#33-archivos-grandes-blossom)) para que llegue a tus dispositivos aunque el otro esté apagado. |
| «*Tu Cloudflare Worker no tiene activado el buzón…*» | Tu servidor es una versión antigua sin buzón. | Redespliégalo con el comando actual del asistente ([sección 3.2](#32-dónde-vive-tu-buzón)). |
| «*El cambio en 'ruta' supera el límite del buzón; se sincronizará directamente vía P2P*» | Ese cambio no cabe en el buzón y solo viajará si ambos equipos están conectados. | Sube el límite de Blossom o acepta el límite. |
| «*La bóveda está bloqueada por MySecret. Desbloquéala para sincronizar*» | Usas MySecret y la bóveda está cerrada. | Desbloquea MySecret. OmniSync reanuda solo. |
| «*El dispositivo remoto tiene MySecret bloqueado*» | El otro equipo tiene MySecret cerrado. | Desbloquea MySecret en ese dispositivo. |
| «*No hay otros dispositivos conectados en este momento*» | Estás solo. | Vincula otro dispositivo ([sección 5](#5-primeros-pasos-vincular-tus-dispositivos)). |
| «*Conflicto de edición en 'nombre'. Se guardó copia de respaldo: 'copia'*» | Los dos dispositivos editaron lo mismo y OmniSync no pudo unirlos solo. | Abre ambas versiones, quédate con la que quieras y borra la otra. Ver [12.7](#127-veo-una-nota-con-conflicto). |

### 10.3 Mensajes informativos

| Mensaje | Qué significa |
|---|---|
| «*'nombre' no coincide con la versión base. Se sincronizará vía P2P*» | OmniSync detectó que la nota cambió de forma que no puede aplicar un parche parcial. Lo enviará entera por conexión directa. |
| «*No se pudo aplicar el parche en 'nombre'. Programada sincronización directa P2P*» | El parche rápido falló. Se programa el envío completo. |
| «*Falló la comprobación de integridad en 'nombre'*» | El contenido no coincidió al recibirlo. Se descarta y se reenvía por otra vía. |
| «*Nueva clave maestra generada. Vuelve a vincular todos tus dispositivos*» | Confirmación de que la rotación de clave se hizo bien. |
| «*MySecret desbloqueado. Sincronizando notas...*» | MySecret se abrió y OmniSync retoma el trabajo pendiente. |

## 11. Preguntas frecuentes

### 11.1 Sobre el precio y las cuentas

| Pregunta | Respuesta |
|---|---|
| ¿Es gratis? | Sí, para uso personal y no comercial. Ver [sección 13](#13-licencia). |
| ¿Necesito una cuenta? | No. Ni de OmniSync, ni de correo, ni de nada. |
| ¿Necesito Dropbox, Drive o Git? | No. OmniSync no usa carpetas en la nube: conecta tus dispositivos directamente y usa un buzón cuando hace falta. |
| ¿Tengo que montar Cloudflare? | No. La red pública Nostr funciona desde el primer momento. Cloudflare es opcional, para más privacidad y control. |
| ¿Puedo usarlo en mi empresa? | No sin permiso del autor: la licencia es solo no comercial. |

### 11.2 Sobre cómo funciona

| Pregunta | Respuesta |
|---|---|
| ¿Funciona en el móvil? | Sí, en Obsidian para Android e iOS. |
| ¿Deben estar encendidos los dos dispositivos a la vez? | Solo para vincular. Después, si uno está apagado, los cambios esperan en el buzón (y los archivos grandes en Blossom). En modo *P2P puro* sí deben estar los dos encendidos. |
| ¿Cuánto tarda en llegar un cambio? | Menos de un segundo si el otro equipo está encendido y conectado. Hasta un minuto si está en el buzón. |
| ¿Y si pierdo internet a mitad de escribir? | No pasa nada: el cambio se guarda en la lista de espera y se reintenta solo cuando vuelva la conexión (a los 2, 5, 15 segundos y luego cada minuto). |
| ¿Pueden los servidores leer mis notas? | No. El contenido y los nombres van cifrados. Un servidor puede ver momentos y tamaños aproximados. Ver [sección 8](#8-privacidad-qué-se-ve-y-qué-no). |
| ¿Qué pasa si los dos dispositivos están sin cobertura? | Los cambios se acumulan en el buzón de cada uno. Cuando alguno vuelve a tener cobertura, recoge lo pendiente. |
| ¿Se pueden sincronizar varios dispositivos a la vez? | Sí. La barra de estado muestra el número de conectados: `OmniSync (3)` significa que hay tres equipos hablando. |

### 11.3 Sobre el móvil y la batería

| Pregunta | Respuesta |
|---|---|
| Mi teléfono no se actualiza en segundo plano. | Es normal: los teléfonos pausan las conexiones en segundo plano. Se pone al día al abrir la app, cuando vuelve la conexión y cada minuto con la app abierta. |
| ¿Gasta mucho la batería? | Con la app abierta, la conexión se mantiene viva. En segundo plano, el sistema la duerme (y es el sistema, no OmniSync, quien decide). |
| ¿Puedo dejarlo siempre conectado? | En una computadora, sí. En el móvil, no es necesario: al abrir la app ya se pone al día. |

### 11.4 Sobre la recuperación y la seguridad

| Pregunta | Respuesta |
|---|---|
| ¿Y si pierdo un dispositivo? | Regenera la clave maestra ([sección 9.3](#93-perdiste-un-dispositivo-o-ves-uno-desconocido)). |
| ¿Y si borro una nota sin querer? | No se borra de verdad: va a la papelera de Obsidian en el resto de equipos ([sección 9](#9-gestionar-tus-dispositivos)). |
| ¿Qué pasa si borra un archivo de la bóveda? | Va a la papelera. Puedes recuperarlo desde *Ajustes → Archivos y enlaces → Archivos eliminados*. |
| ¿Se puede usar sin conexión, sin internet? | Sí, pero solo dentro del mismo equipo: sin internet no hay conexión con otros dispositivos ni buzón. |
| ¿OmniSync hace de backup? | No. Ver [sección 2.3.1](#omnisync-no-es-un-backup). |

---

## 12. Problemas comunes

Cada problema tiene su número. Busca el tuyo con `Ctrl+F`.

### 12.1 Las notas no llegan

Es el problema más frecuente, y **casi nunca es un fallo de OmniSync**. Revisa en este orden:

| # | Comprueba | Cómo |
|---|---|---|
| 1 | **El otro equipo está encendido y conectado** | En el otro equipo, la barra de estado debe decir `OmniSync (N)` y no `(Desconectado)`. |
| 2 | **El modo es «Doble vía»** | En *Ajustes → OmniSync → Modo de sincronización*. Si está en *P2P puro*, el otro equipo **debe** estar encendido. |
| 3 | **Ambos equipos tienen internet** | Abre el navegador en los dos. |
| 4 | **El buzón está activado** | Sigue al punto 12.2. |
| 5 | **No hay una red que bloquee la conexión** | Las redes de empresas, universidades y algunoswifis domésticos con «aislamiento de clientes» impiden que dos equipos se hablen directamente. El buzón salva la situación: por eso el punto 2 es tan importante. |

Si aun así no funciona, prueba a forzar una sincronización: `Ctrl+P` → *OmniSync: Forzar sincronización completa de la bóveda ahora*.

### 12.2 Con la red pública funcionaba, pero con mi Cloudflare no

Casi siempre es que **tu servidor es una versión antigua sin buzón**.

1. Abre la dirección de tu Worker en un navegador (la de `https://…workers.dev`).
2. Deberías ver el buzón listado como `ready`.
3. Si dice `missing_do_binding`, tu servidor es viejo: **vuelve a desplegarlo** con el comando actual del asistente ([sección 3.2](#32-dónde-vive-tu-buzón)).
4. Comprueba también que el Worker tenga tu **clave pública** en `ALLOWED_PUBKEYS`. El asistente te da el comando exacto para actualizarla.

### 12.3 Las imágenes o archivos grandes no aparecen en mi teléfono

| Causa | Solución |
|---|---|
| Blossom está desactivado | Actívalo en *Ajustes → OmniSync → Almacenamiento de Archivos Grandes*. |
| El otro equipo no tiene el servidor Blossom | Los ajustes son **por dispositivo**. Añádelo también en el móvil. |
| El archivo supera el límite | Sube el *Límite Máximo por Archivo* o usa un perfil más alto. |
| El archivo es demasiado grande y falló la subida | Las subidas tienen un límite de 45 segundos. Déjalo para cuando tengas Wi-Fi. |

### 12.4 El plugin no aparece en la barra

| Comprueba | Solución |
|---|---|
| ¿Lo activaste en *Ajustes → Plugins de la comunidad*? | Actívalo. |
| ¿Faltan archivos en la carpeta? | Deben estar los **tres**: `main.js`, `manifest.json` y `styles.css`. |
| ¿Tu Obsidian es demasiado antiguo? | Necesitas **1.11.4 o superior**. |
| ¿Hay un error? | Abre la consola del desarrollador (`Ctrl+Shift+I`) y mira qué dice. |

### 12.5 No se ve el código de sala

El «Identificador Anónimo de Sala de Conexión» se deriva de tu clave maestra. Si no aparece:

- Comprueba que el plugin esté bien instalado (punto 12.4).
- Reinicia Obsidian: se genera al cargar.

### 12.6 No me deja abrir el asistente de vinculación

- Si el plugin está activo, el asistente debería abrirse desde el icono de la barra lateral, desde la barra de estado o con `Ctrl+P`.
- Si no abre, mira la consola del desarrollador (punto 12.4) para ver el error exacto.

### 12.7 Veo una nota con conflicto

Una nota cuyo nombre termina en `.conflict-AAAA-MM-DD-HHMM.md` (por ejemplo `nota.conflict-2026-10-27-1530.md`).

**Qué pasó:** los dos dispositivos editaron la misma nota sin poder hablar entre sí, y OmniSync no pudo unirlas sin adivinar.

**Qué hacer:**
1. Abre **las dos** versiones y compáralas.
2. Copia a una nota nueva lo que te interese de cada una.
3. Borra la que no quieras conservar (y la otra también, para dejar la bóveda limpia).

> Esto es raro. Si te pasa a menudo, es señal de que dos dispositivos llevan mucho tiempo sin conexión entre sí. Activa el modo **Doble vía** para que el buzón reduzca estas situaciones.

### 12.8 Otros casos

| Síntoma | Causa probable |
|---|---|
| **«Código caducado» o «ya usado»** | Es normal. Vuelve al dispositivo original, donde habrá un QR nuevo, y escanea ese. |
| **El QR no abre Obsidian** | Comprueba que OmniSync esté instalado y activado en el dispositivo nuevo. Si no, usa *Copiar Clave Secreta de Vinculación*. |
| **El dispositivo nuevo no aparece en la lista** | Pulsa el botón ⟳. Comprueba que ambos tengan internet. |
| **«Ya hay una vinculación en curso»** | Espera a que termine la anterior, o reinicia Obsidian. |
| **El móvil no actualiza en segundo plano** | Normal: los sistemas operativos pausan las conexiones en segundo plano. Se pone al día al abrir la app. |
| **Mi puerta de enlace bloquea la conexión** | Prueba con tu propia red de datos móviles (4G/5G) en lugar de wifi. Si funciona, tu wifi bloquea las conexiones entre dispositivos. |

---

## 13. Licencia

OmniSync es **código público, gratuito para uso personal y no comercial**, bajo la [Licencia PolyForm Noncommercial 1.0.0](../LICENSE). Puedes usarlo, leerlo, modificarlo y compartirlo con fines sin ánimo de lucro, incluidas organizaciones sin ánimo de lucro, educativas y públicas. El uso comercial requiere un acuerdo con el autor ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

## Documentos relacionados

| Documento | Para qué te sirve |
|---|---|
| [Guía de Usuario en inglés](User_Guide_EN.md) | The same guide, in English. |
| [Guía de Desarrolladores](Guía%20de%20Desarrolladores.md) | Cómo está hecho el plugin por dentro. No lo necesitas para usarlo. |
| [Pruebas y auditorías](TESTS_AND_AUDITS.md) | Qué se ha comprobado y cómo. Para los que desconfían. |
| [Protocolo de sincronización (whitepaper)](https://github.com/abismalmx/OmniSync/blob/main/PROTOCOL_WHITEPAPER.md) | El detalle técnico del protocolo de sincronización. |
| [Cambios de versión](https://github.com/abismalmx/OmniSync/blob/main/CHANGELOG.md) | Qué hay de nuevo en cada versión. |

---

¿Dudas o ideas? Abre un issue en el [repositorio](https://github.com/abismalmx/OmniSync). Para reportar un problema de seguridad, consulta la [política de seguridad](https://github.com/abismalmx/OmniSync/blob/main/Github/SECURITY_ES.md).
