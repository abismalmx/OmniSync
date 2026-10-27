# Guía de Usuario – OmniSync

OmniSync mantiene tus notas de Obsidian iguales en todos tus dispositivos, en tiempo real, gratis y de forma privada. Esta guía está escrita para personas, no para ingenieros: cuando aparece un término técnico, lo explicamos con una comparación.

- [1. La idea en un minuto](#1-la-idea-en-un-minuto)
- [2. Cómo funciona OmniSync, paso a paso](#2-cómo-funciona-omnisync-paso-a-paso)
- [3. Elegir cómo viajan tus notas](#3-elegir-cómo-viajan-tus-notas)
- [4. Instalación](#4-instalación)
- [5. Primeros pasos: vincular tus dispositivos](#5-primeros-pasos-vincular-tus-dispositivos)
- [6. Qué se sincroniza](#6-qué-se-sincroniza)
- [7. Privacidad: qué se ve y qué no](#7-privacidad-qué-se-ve-y-qué-no)
- [8. Gestionar tus dispositivos](#8-gestionar-tus-dispositivos)
- [9. Qué significan los mensajes](#9-qué-significan-los-mensajes)
- [10. Preguntas frecuentes](#10-preguntas-frecuentes)
- [11. Problemas comunes](#11-problemas-comunes)
- [12. Licencia](#12-licencia)

## 1. La idea en un minuto

Imagina que cada nota es una carta. Con un servicio de nube tradicional, la dejas en una oficina de correos ajena y esperas que nadie la abra. Con OmniSync, **tus propios dispositivos se pasan la carta entre ellos**, siempre dentro de una caja cerrada cuya llave solo tienes tú.

| Quieres… | OmniSync te da… |
|---|---|
| No pagar una suscripción | Sincronización gratuita |
| Que nadie lea tus notas | Cifrado de extremo a extremo |
| No crear cuentas | Vinculas con un QR; no hay correo ni contraseña |
| Que los cambios lleguen ya | Tiempo real entre dispositivos |
| Que tu teléfono se ponga al día tras estar apagado | Un buzón que guarda tus cambios hasta que el otro dispositivo vuelve |

## 2. Cómo funciona OmniSync, paso a paso

### 2.1 Las palabras clave

| Concepto | Qué significa | Comparación |
|---|---|---|
| **P2P** (de igual a igual) | Tus dispositivos se conectan directamente entre sí | Una llamada entre dos personas, sin centralita |
| **Cifrado de extremo a extremo (AES-256)** | El contenido se revuelve antes de salir de tu dispositivo y solo se desrevuelve en los tuyos | Una caja cerrada: el mensajero la lleva pero no puede abrirla |
| **Clave maestra** | El secreto que comparten tus dispositivos | La llave de tu casa: quien la tiene, entra |
| **Punto de encuentro (señalización)** | Un lugar donde tus dispositivos se encuentran | Una cafetería donde quedan; la cafetería no participa en la conversación |
| **Relay / Nostr** | Una red pública y abierta que OmniSync puede usar como punto de encuentro **y buzón** | Un tablón de anuncios público: lo que dejas ahí está en clave |
| **Cloudflare Worker** (opcional) | Tu propio punto de encuentro y buzón privados, en tu cuenta gratuita de Cloudflare | Tu propia cafetería privada con buzón |
| **Buzón** | Cambios pequeños que esperan, cifrados, hasta que el otro dispositivo se conecta | Una carta esperando en el buzón hasta que llegas a casa |
| **Blossom** | Almacenamiento para archivos grandes (imágenes, PDF, audio) | Un guardarropa: cada abrigo se identifica por su huella, así que un cambiazo se notaría |

### 2.2 Qué pasa cuando escribes una nota

1. **Escribes.** Tras una fracción de segundo sin teclear, OmniSync nota el cambio.
2. **Cierra la nota.** El texto se cifra en tu dispositivo y el nombre del archivo se convierte en un código ilegible.
3. **Envía el cambio por dos vías a la vez** (es el modo «Doble vía», el predeterminado):
   - **Directamente** a tu otro dispositivo, si está encendido, así que aparece casi al instante.
   - **A tu buzón**, para que esté ahí aunque el otro dispositivo esté apagado.
4. **El otro dispositivo la abre.** Comprueba que la nota es genuina, la descifra con la clave compartida y la escribe en tu bóveda.

Si en ese momento no se puede llegar al buzón (por ejemplo, sin señal), OmniSync **deja el cambio en una lista de espera y lo reintenta solo** (a los 2, 5 y 15 segundos, y luego cada 60). Esa lista sobrevive al cierre de Obsidian, así que no se pierde nada.

### 2.3 Qué pasa si tu otro dispositivo estaba apagado

Escribes en el teléfono con el ordenador apagado. El cambio va al buzón. Más tarde abres Obsidian en el ordenador: OmniSync **consulta el buzón enseguida** y trae el cambio. En el teléfono también lo consulta cada minuto con la app abierta, al volver a ella y cuando regresa la conexión, porque los teléfonos duermen las conexiones en segundo plano para ahorrar batería.

### 2.4 Qué pasa si cierras la app justo después de escribir

Cuando sales o cierras Obsidian, OmniSync **envía primero lo que quedaba pendiente** (incluso el último segundo de escritura) y después se cierra. Al volver a arrancar también busca cambios que nunca llegaron a salir del dispositivo y los envía.

### 2.5 Si dos dispositivos editan la misma nota sin conexión

OmniSync une ambas versiones automáticamente, incluso dentro del mismo párrafo (una «fusión a tres vías», como Google Docs reconciliando a dos personas). Si no puede unirlas sin adivinar, conserva **las dos**: escribe la versión del otro dispositivo y guarda la tuya al lado, como una copia con un nombre del estilo `nota.conflict-2026-10-27-1530.md`. Nada se sobrescribe en silencio.

### 2.6 Si borras una nota

En tus otros dispositivos va a la **papelera de Obsidian**, nunca se destruye. Puedes recuperarla.

### 2.7 Edición en vivo

Si abres la misma nota en dos dispositivos a la vez, ves el cursor y la selección del otro sobre el texto.

## 3. Elegir cómo viajan tus notas

En *Ajustes → OmniSync* eliges dos cosas.

### 3.1 Modo de sincronización

| Modo | Qué hace | Elígelo si… |
|---|---|---|
| **Doble vía (P2P + relay)** (predeterminado) | Envía cada cambio directamente **y** a tu buzón | Quieres que funcione aunque tu otro dispositivo esté apagado (lo que quiere la mayoría) |
| **P2P puro (sin relays)** | Solo conexión directa; no se usa buzón (el punto de encuentro sigue sirviendo para que tus dispositivos se encuentren) | No quieres ningún servidor de por medio y tus dos dispositivos suelen estar encendidos a la vez |

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

## 4. Instalación

> OmniSync está en proceso de validación para el directorio oficial de plugins de la comunidad. Cuando lo aprueben, bastará con buscarlo en Obsidian. Mientras tanto:

1. Descarga `main.js`, `manifest.json` y `styles.css` de la [última versión](https://github.com/abismalmx/OmniSync/releases).
2. En tu bóveda, crea `.obsidian/plugins/omnisync/` y copia ahí los tres archivos. (En el móvil, usa tu gestor de archivos o la herramienta que uses para mover archivos a la bóveda.)
3. Reinicia Obsidian y activa **OmniSync** en *Ajustes → Plugins de la comunidad*.

**Hazlo en cada dispositivo** que quieras sincronizar. Para actualizar, repite los mismos pasos con los archivos nuevos. Mantén todos tus dispositivos en la misma versión.

## 5. Primeros pasos: vincular tus dispositivos

Vincular presenta tus dispositivos entre sí para que compartan la clave. Se hace una vez por dispositivo.

### 5.1 Vincular con un QR

1. En el dispositivo **que ya está configurado**, abre *Ajustes → OmniSync → Asistente de Vinculación y Código QR*. Aparece un **código QR**.
2. En el **dispositivo nuevo**, abre la cámara del sistema y apúntala al QR. Se abre Obsidian y OmniSync te pide **confirmar** la vinculación.
3. Acepta. El dispositivo nuevo aparece en *Dispositivos Vinculados a esta Bóveda* en pocos segundos (hay un botón ⟳ para refrescar).

Ambos dispositivos deben estar en línea durante este paso.

**Por qué es seguro (la tarjeta de hotel):**
- El QR funciona **una sola vez** y **caduca a los 2 minutos**. Al caducar se genera uno nuevo automáticamente mientras el asistente sigue abierto.
- La clave maestra **no va dentro del QR**. Se envía cifrada, y solo después de que el dispositivo nuevo presente el código. Una foto del QR, caducado o ya usado, no sirve de nada.
- Siempre se te pide confirmar. Cualquier página web podría intentar abrir un enlace de OmniSync, así que **acepta solo si acabas de escanear tu propio QR**.

### 5.2 Alternativa: copiar el código

Si la cámara no abre Obsidian, usa **Copiar código de vinculación** en el asistente y pégalo en *Vincular Dispositivo Ahora* en el dispositivo nuevo. Es el último recurso porque el código pasa por el portapapeles (que otras apps pueden leer); caduca en los mismos 2 minutos.

### 5.3 Cosas a tener en cuenta

- **Vincular reemplaza la clave maestra del dispositivo nuevo** por la tuya. Si ese dispositivo ya tenía otra, se te avisa antes.
- Si el QR trae un **servidor distinto del tuyo**, OmniSync muestra la dirección y te pide confirmar. **Confirma solo si la reconoces.**
- **Escanea solo QR que hayas generado tú.** Quien escanea el QR de otra persona puede acabar entregando su clave y su servidor.
- Tras vincular, revisa la lista de dispositivos. Si ves uno que no reconoces, **desvincúlalo y regenera la clave maestra** (ver sección 8).
- Si usas tu propio servidor de Cloudflare, la vinculación también necesita que esté actualizado. El asistente muestra el comando que registra tu clave.

## 6. Qué se sincroniza

Se configura en *Ajustes → OmniSync → Contenido y Alcance de la Sincronización*:

- **Notas** (siempre).
- **Adjuntos**: imágenes, PDF, audio, etc. (*Sincronizar Archivos Adjuntos*, opcional).
- **Apariencia de Obsidian**: temas y fragmentos CSS (*Sincronizar Configuración Visual de Obsidian*, opcional). Los plugins ejecutables y las cachés **no** se sincronizan, por seguridad y compatibilidad entre sistemas.

Y el interruptor **Sincronización Automática en Tiempo Real** activa o desactiva todo.

## 7. Privacidad: qué se ve y qué no

**Todo lo importante va cifrado.** El texto de tus notas, tus adjuntos y los **nombres de archivos y carpetas** viajan cifrados (AES-256-GCM). Nadie por el camino puede leerlos sin tu clave. Los nombres se convierten en códigos ilegibles, así que un servidor ni siquiera puede saber cómo se llaman tus notas.

**Qué se comprobó.** El equipo de OmniSync desplegó servidores reales de Cloudflare, sincronizó notas y adjuntos a través de ellos e **inspeccionó lo que recibía el propio servidor**. Solo vio códigos de aspecto aleatorio y datos revueltos: ni nombres de archivo, ni rutas, ni texto. Los adjuntos de hasta 95 MB volvieron idénticos, byte a byte. El servidor además rechaza a quien no tenga tu clave. Los detalles están en los [hallazgos de seguridad](SECURITY_FINDINGS.md) y en las [pruebas y auditorías](TESTS_AND_AUDITS.md).

**Qué puede ver aún un servidor de buzón.** Aunque todo vaya cifrado, un servidor puede observar *que* algo ocurrió: cuándo sincronizas, más o menos qué tamaño tienen los cambios y cuántos son, y un código de sala anónimo. No ve el contenido ni los nombres. Un relay público además ve tu dirección IP.

| Si usas… | El servidor puede ver… |
|---|---|
| P2P puro (sin relays) | No se guarda nada en ningún servidor. El punto de encuentro puede ver que dos dispositivos se conectaron. |
| Red pública Nostr | Momentos, tamaño aproximado, un código de sala anónimo, tu IP |
| Tu propio servidor de Cloudflare | Lo mismo, pero solo lo manejas **tú** |

Si esto te preocupa, usa **P2P puro** o tu propio servidor de Cloudflare.

## 8. Gestionar tus dispositivos

- **Renombrar o cambiar el tipo** de este dispositivo: *Ajustes → OmniSync → Identidad de este Dispositivo*.
- **Perdiste un dispositivo, o ves uno desconocido:** usa **Regenerar Clave Maestra** (en *Seguridad, Criptografía y Recuperación*). Es la forma definitiva de revocar el acceso: todos los dispositivos vinculados pierden la sincronización al instante y tendrás que volver a vincular, con QR, los que quieras conservar.
- **Pausar la sincronización:** desactiva *Sincronización Automática en Tiempo Real*; OmniSync queda desconectado hasta que la vuelvas a activar o lances una sincronización.

## 9. Qué significan los mensajes

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| «*'nombre' quedó pendiente y se reenviará automáticamente*» | No se pudo llegar al buzón en ese momento. El cambio está guardado y se reintentará. | Nada. Revisa tu conexión si persiste. Sale como máximo una vez cada 10 minutos. |
| «*Se sincronizaron exitosamente N nota(s) desde el buzón seguro*» | Acaban de llegar cambios hechos en otro dispositivo. | Nada. |
| «*'nombre' pesa más de 64 KB. Para sincronizarla sin P2P activa el almacenamiento Blossom…*» | Una nota grande ahora solo puede viajar directamente. | Activa Blossom (sección 3.3) para que llegue a tus dispositivos aunque el otro esté apagado. |
| «*Tu Cloudflare Worker no tiene activado el buzón…*» | Tu servidor es una versión antigua sin buzón. | Redespliégalo con el comando actual del asistente. |

## 10. Preguntas frecuentes

| Pregunta | Respuesta |
|---|---|
| ¿Es gratis? | Sí, para uso personal y no comercial. Ver sección 12. |
| ¿Necesito una cuenta? | No. |
| ¿Necesito Dropbox, Drive o Git? | No. OmniSync no usa carpetas en la nube: conecta tus dispositivos directamente y usa un buzón cuando hace falta. |
| ¿Funciona en el móvil? | Sí, en Obsidian para Android e iOS. |
| ¿Deben estar encendidos los dos dispositivos a la vez? | Solo para vincular. Después, si uno está apagado, los cambios esperan en el buzón (y los archivos grandes en Blossom). En modo *P2P puro* sí deben estar los dos encendidos. |
| ¿Pueden los servidores leer mis notas? | No. El contenido y los nombres van cifrados. Un servidor puede ver momentos y tamaños aproximados. Ver sección 7. |
| ¿Tengo que montar Cloudflare? | No. La red pública Nostr funciona desde el primer momento. Cloudflare es opcional, para más privacidad y control. |
| Mi teléfono no se actualiza en segundo plano. | Es normal: los teléfonos pausan las conexiones en segundo plano. Se pone al día al abrir la app, cuando vuelve la conexión y cada minuto con la app abierta. |
| ¿Y si pierdo un dispositivo? | Regenera la clave maestra (sección 8). |
| ¿Puedo usarlo en mi empresa? | No sin permiso del autor: la licencia es solo no comercial. |

## 11. Problemas comunes

- **Mis notas no llegan cuando el otro dispositivo estaba apagado.** Revisa, en orden: (1) estás en modo *Doble vía* y no en *P2P puro*; (2) la opción del buzón está activada; (3) si usas tu propio servidor de Cloudflare, abre su dirección en un navegador: debe indicar el buzón como `ready`. Si dice `missing_do_binding`, redespliégalo con el comando actual del asistente.
- **Con la red pública funcionaba pero con mi servidor de Cloudflare no.** Casi siempre el servidor es una versión antigua sin buzón. Redespliégalo (sección 3.2).
- **Las imágenes o archivos grandes no aparecen en mi teléfono.** Blossom debe estar activado, con tu servidor en la lista, **también en ese dispositivo**, y el archivo debe estar por debajo del límite de tamaño.
- **El QR no abre Obsidian:** comprueba que OmniSync esté instalado y activado en el dispositivo nuevo. Si no, usa *Copiar código de vinculación*.
- **«Código caducado» o «ya usado»:** es normal; vuelve al dispositivo original, donde habrá un QR nuevo, y escanea ese.
- **El dispositivo nuevo no aparece en la lista:** pulsa el botón ⟳. Comprueba que ambos tengan internet.
- **Veo una nota que termina en `.conflict-…`:** dos dispositivos cambiaron la misma nota sin conexión y no se pudieron unir limpiamente. Abre las dos, quédate con lo que quieras y borra la copia.

## 12. Licencia

OmniSync es **código público, gratuito para uso personal y no comercial**, bajo la [Licencia PolyForm Noncommercial 1.0.0](../LICENSE). Puedes usarlo, leerlo, modificarlo y compartirlo con fines sin ánimo de lucro, incluidas organizaciones sin ánimo de lucro, educativas y públicas. El uso comercial requiere un acuerdo con el autor ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

¿Dudas o ideas? Abre un issue en el [repositorio](https://github.com/abismalmx/OmniSync). Para reportar un problema de seguridad, consulta la [política de seguridad](../SECURITY_ES.md).
