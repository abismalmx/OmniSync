# Guía de Usuario – OmniSync

OmniSync mantiene tus notas de Obsidian iguales en todos tus dispositivos, en tiempo real, gratis y de forma privada. Esta guía está escrita para personas, no para ingenieros: cuando aparece un término técnico, lo explicamos con una comparación.

## 1. Visión general

Imagina que cada nota es una carta. Con un servicio de nube tradicional, la dejas en una oficina de correos ajena y esperas que nadie la abra. Con OmniSync, **tus propios dispositivos se pasan la carta de mano en mano**, y la llevan siempre dentro de una caja fuerte cuya llave solo tienes tú.

| Quieres… | OmniSync te da… |
|---|---|
| No pagar una suscripción | Sincronización gratuita |
| Que nadie lea tus notas | Cifrado de extremo a extremo |
| No crear cuentas | Vinculas con un QR; no hay correo ni contraseña |
| Que los cambios lleguen ya | Tiempo real entre dispositivos |

## 2. Cómo funciona (con analogías)

| Concepto | Qué significa | Comparación |
|---|---|---|
| **P2P** (de igual a igual) | Tus dispositivos se conectan directamente entre sí | Una llamada entre dos teléfonos, sin centralita |
| **Cifrado de extremo a extremo (AES-256)** | El contenido se encripta antes de salir de tu equipo y solo se descifra en los tuyos | Una caja fuerte: el cartero la lleva pero no puede abrirla |
| **Clave maestra** | La llave secreta común a tus dispositivos | La llave de tu casa: quien la tiene, entra |
| **Servidor de señalización** | Un lugar donde tus dispositivos se encuentran la primera vez | Una cafetería donde quedáis; el local no participa en la conversación |
| **Nostr** | Red pública y abierta que OmniSync usa como punto de encuentro (y como buzón) | Un tablón de anuncios que nadie controla; lo que dejas ahí va en clave |
| **Cloudflare Worker** (opcional) | Tu propio punto de encuentro, gratuito | Tu propia cafetería privada |
| **Blossom** | Red donde se guardan archivos grandes (imágenes, PDF, audio) | Un guardarropa donde cada abrigo se identifica por su huella; si lo cambian, se nota |
| **Buzón** | Cambios pequeños que esperan cifrados a que el otro dispositivo se conecte | Una carta que queda en el buzón hasta que llegas a casa |

**Lo importante:** una vez que tus dispositivos se han encontrado, las notas viajan directamente entre ellos. El punto de encuentro solo ayuda a que se localicen.

## 3. Instalación

> OmniSync está en validación para el directorio oficial de plugins de la comunidad. Cuando se apruebe, bastará con buscarlo en Obsidian. Mientras tanto:

1. Descarga `main.js`, `manifest.json` y `styles.css` desde la [última versión](https://github.com/abismalmx/OmniSync/releases).
2. En tu bóveda, crea la carpeta `.obsidian/plugins/omnisync/` y copia ahí los tres archivos. (En móvil, usa el gestor de archivos o la herramienta que uses para llevar archivos a la bóveda.)
3. Reinicia Obsidian y activa **OmniSync** en *Ajustes → Plugins de la comunidad*.

**Hazlo en cada dispositivo** que quieras sincronizar.

## 4. Primeros pasos: vincular tus dispositivos

Vincular es presentar tus dispositivos entre sí para que compartan la clave. Solo se hace una vez por dispositivo.

### 4.1 Vincular con un QR

1. En el dispositivo que **ya tienes configurado**, abre *Ajustes → OmniSync → Abrir Asistente de Vinculación*. Aparece un **código QR**.
2. En el **dispositivo nuevo**, abre la cámara del sistema y apunta al QR. Se abre Obsidian y OmniSync te pide **confirmar** la vinculación.
3. Acepta. El dispositivo nuevo aparece en *Dispositivos Vinculados a esta Bóveda* en pocos segundos (hay un botón ⟳ para refrescar).

Ambos dispositivos deben estar conectados a internet durante este paso.

**Por qué es seguro (la llave de hotel):**
- El QR funciona **una sola vez** y **caduca a los 2 minutos**. Al caducar, se genera otro solo mientras el asistente siga abierto.
- La clave maestra **no está dentro del QR**. Se envía cifrada, y solo después de que el dispositivo nuevo presente el código. Una foto del QR, caducado o ya usado, no sirve de nada.
- Siempre se te pide confirmar. Cualquier página web podría intentar abrir un enlace de OmniSync, así que **acepta solo si acabas de escanear tu propio QR**.

### 4.2 Alternativa: copiar el código

Si la cámara no abre Obsidian, usa **Copiar código de vinculación** en el asistente, y pégalo en *Vincular Dispositivo Ahora* en el dispositivo nuevo. Es el último recurso porque el código pasa por el portapapeles (que otras apps pueden leer); caduca igual a los 2 minutos.

### 4.3 Elegir el canal de encuentro

- **Nostr** (predeterminado): no hay que montar nada.
- **Mi Cloudflare Worker**: solo si ya usas tu propio servidor. Requiere haberlo redesplegado con la versión actual y que la clave pública del dispositivo esté en `ALLOWED_PUBKEYS` (el asistente de Cloudflare te genera el comando).

### 4.4 Avisos a tener en cuenta

- **Vincular reemplaza la clave maestra del dispositivo nuevo** por la tuya. Si ese dispositivo ya tenía otra, se te avisa antes.
- Si el QR trae un **servidor distinto al tuyo**, OmniSync te muestra la dirección y te pide confirmar. **Confírmala solo si la reconoces.**
- **Escanea solo QR que hayas generado tú.** Quien escanee el QR de otra persona puede acabar cediendo su clave y su servidor.
- Tras vincular, revisa la lista de dispositivos. Si ves uno que no reconoces, **desvincula y regenera la clave maestra** (ver sección 7).
- El modo antiguo de clave permanente sigue en *Avanzado*, con advertencia. Úsalo solo si sabes por qué.

### 4.5 Buenas prácticas: el orden importa (especialmente con Cloudflare)

Si piensas usar tu propio **Cloudflare Worker**, sigue este orden para evitar confusiones:

**Orden recomendado:**

1. **Instala OmniSync en todos tus dispositivos** (ver sección 3).
2. **Vincula todos los dispositivos entre sí con QR** (sección 4.1), usando el canal Nostr (el predeterminado). No configures Cloudflare todavía.
3. Una vez vinculados, abre *Ajustes → OmniSync → Asistente de Cloudflare* en **cada dispositivo** y copia su clave pública.
4. **Despliega el Worker** con todas las claves públicas en `ALLOWED_PUBKEYS` (una por dispositivo, separadas por espacio).
5. Configura la URL del Worker en cada dispositivo.

**¿Por qué este orden?** Cloudflare solo acepta conexiones de claves públicas que conoce. Si configuras el Worker antes de vincular, el dispositivo nuevo tendrá una clave distinta y el Worker lo rechazará con error 401.

**Es normal que la conexión se vea como «Desconectado» mientras configuras Cloudflare.** El plugin sigue funcionando por Nostr en paralelo; el estado vuelve a «Conectado» en cuanto el Worker acepta la clave del dispositivo.

**Añadir un tercer dispositivo más adelante:**

No necesitas desconectar ni pausar nada. El QR de vinculación usa un canal separado que no requiere autenticación (el dispositivo nuevo aún no tiene clave), de modo que los dispositivos ya sincronizados siguen funcionando sin interrupción.

Además, no hace falta cambiar `ALLOWED_PUBKEYS` ni redesplegar el Worker: todos los dispositivos vinculados comparten la misma clave maestra, y de ella se deriva automáticamente la misma clave pública. El Worker ya acepta el dispositivo nuevo en cuanto queda vinculado.

## 5. Qué se sincroniza

Todo esto se configura en *Ajustes → OmniSync → Contenido y Alcance de la Sincronización*:

- **Notas** (siempre).
- **Archivos adjuntos**: imágenes, PDF, audio, etc. (opcional).
- **Apariencia de Obsidian**: temas y *snippets* CSS (opcional). Los plugins ejecutables y la caché **no** se sincronizan, por seguridad y compatibilidad entre sistemas.

**Si el otro dispositivo está apagado:** con *Sincronización Online (Red Nostr)* activada, los cambios pequeños esperan cifrados en un buzón y se recogen al reconectar. Los archivos grandes usan *Blossom*, con un límite por archivo que puedes elegir (hay perfiles recomendados para servidores públicos o un valor libre en MB).

**Si dos dispositivos editan la misma nota sin conexión:** OmniSync combina los cambios (fusión de tres vías). Si no se pueden unir sin ambigüedad, te lo marca para que decidas.

**Si borras una nota en un dispositivo:** en los demás va a la **papelera de Obsidian**, no se destruye. Puedes recuperarla.

**Edición simultánea:** si abres la misma nota en dos dispositivos, ves el cursor del otro sobre el texto.

## 6. Privacidad: qué se ve y qué no

**Cifrado de extremo a extremo.** El contenido de tus notas y los nombres de tus archivos viajan cifrados. Nadie en el camino puede leerlos sin tu clave.

**Lo que un punto de encuentro (relay) público sí puede observar:** tu dirección IP, que existe una «sala» con un nombre seudónimo, la hora de la actividad y el tamaño aproximado de los mensajes. No ve el contenido. Si esto te importa, monta tu propio Cloudflare Worker (*Ajustes → OmniSync → Red y Servidores de Señalización P2P → Desplegar Servidor Privado Todo-en-Uno*): el asistente te guía paso a paso.

**Cifrado de extremo a extremo (AES-GCM).** OmniSync cifra tus notas de extremo a extremo con AES-256-GCM.

## 7. Gestionar tus dispositivos

- **Cambiar el nombre y tipo** de este dispositivo: *Ajustes → OmniSync → Identidad de este Dispositivo*.
- **Perdiste un dispositivo, o ves uno desconocido:** usa **Regenerar Clave Maestra**. Es la forma definitiva de revocar el acceso: todos los dispositivos vinculados pierden la sincronización al instante, y tendrás que volver a vincular, con QR, los que quieras conservar.
- **Pausar la sincronización:** desactiva *Sincronización Automática en Tiempo Real*; OmniSync queda desconectado hasta que lo actives o pulses sincronizar.

## 8. Preguntas frecuentes

| Pregunta | Respuesta |
|---|---|
| ¿Es gratis? | Sí, para uso personal y no comercial. Mira la licencia en la sección 10. |
| ¿Necesito crear una cuenta? | No. |
| ¿Necesito Dropbox, Drive o Git? | No. OmniSync no usa carpetas de nube: conecta tus dispositivos directamente. |
| ¿Funciona en móvil? | Sí, en Obsidian para Android e iOS. |
| ¿Tienen que estar los dos dispositivos encendidos a la vez? | Solo para vincular. Después, si uno está apagado, los cambios pequeños esperan en el buzón y los archivos grandes en Blossom. |
| ¿Pueden leer mis notas los servidores? | No el contenido. Un relay público puede ver metadatos (IP, hora, tamaños). Ver sección 6. |
| ¿Qué pasa si pierdo un dispositivo? | Regenera la clave maestra (sección 7). |
| ¿Puedo usarlo en mi empresa? | No sin permiso del autor: la licencia es solo para uso no comercial. |

## 9. Problemas frecuentes

- **El QR no abre Obsidian:** comprueba que OmniSync esté instalado y activado en el dispositivo nuevo. Si no, usa *Copiar código de vinculación*.
- **«El código caducó» o «ya se usó»:** es normal; vuelve al dispositivo original, donde habrá un QR nuevo, y escanea ese.
- **El dispositivo nuevo no aparece en la lista:** pulsa el botón ⟳. Asegúrate de que ambos tengan internet.
- **Con mi Worker no conecta:** redespliega el Worker con la versión actual y comprueba que la clave pública esté en `ALLOWED_PUBKEYS`. Solo necesitas **una entrada**: todos los dispositivos vinculados comparten la misma clave pública, derivada de la clave maestra común. Puedes copiarla desde *Ajustes → OmniSync → Asistente de Cloudflare*.
- **Aparece «Desconectado» después de configurar Cloudflare:** es normal durante los primeros segundos o mientras redespliegas el Worker. Si persiste, comprueba que la clave pública de ese dispositivo esté en `ALLOWED_PUBKEYS` y que el Worker esté redesplegado.
- **Un archivo grande no se sincroniza:** puede superar el límite por archivo que elegiste en Blossom; súbelo o cambia el perfil.

## 10. Licencia

OmniSync es **código público, gratuito para uso personal y no comercial**, bajo la [PolyForm Noncommercial License 1.0.0](../LICENSE). Puedes usarlo, leerlo, modificarlo y compartirlo sin fines de lucro, también en organizaciones sin ánimo de lucro, educativas o públicas. Para uso comercial hace falta un acuerdo con el autor ([abismalmx.splurge748@8shield.net](mailto:abismalmx.splurge748@8shield.net)).

---

¿Dudas o ideas? Abre un *issue* en el [repositorio](https://github.com/abismalmx/OmniSync).
