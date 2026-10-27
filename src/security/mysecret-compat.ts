/**
 * OmniSync - MySecret Compatibility Bridge
 *
 * Módulo de interoperabilidad defensiva para convivir transparentemente con
 * la extensión MySecret (cifrado en reposo con AES-256-GCM) sin generar
 * conflictos, dobles cifrados o sobrescritura de notas descifradas.
 */

import { App, normalizePath, TFile } from 'obsidian';

export const MYSECRET_ARMORED_START = '-----BEGIN MYSECRET ENCRYPTED FILE-----';
export const MYSECRET_ARMORED_END = '-----END MYSECRET ENCRYPTED FILE-----';
export const MYSECRET_BINARY_MAGIC = new Uint8Array([0x4d, 0x59, 0x53, 0x45]); // "MYSE"
export const MYSECRET_BINARY_HEADER_LEN = 33; // 4 magic + 1 version + 12 IV + 16 Tag

export interface MySecretArmoredEnvelope {
  version: number;
  iv: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Obtiene el objeto Crypto disponible en el entorno (navegador u Obsidian/Node)
 */
function getCrypto(): Crypto {
  if (typeof window !== 'undefined' && window.crypto) {
    return window.crypto;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto as Crypto;
  }
  throw new Error('WebCrypto no disponible en este entorno.');
}

/**
 * Utilidades Base64 seguras en entorno navegador / Obsidian / Node
 */
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binaryString = atob(clean);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** Error de interoperabilidad con MySecret que impide una escritura segura. */
export class MySecretCompatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MySecretCompatError';
    Object.setPrototypeOf(this, MySecretCompatError.prototype);
  }
}

export class MySecretCompat {
  /**
   * Obtiene la instancia activa del plugin MySecret si está instalado y habilitado en Obsidian.
   */
  public static getPlugin(app: App): any {
    const plugins = (app as any).plugins?.plugins;
    if (!plugins) return null;
    return plugins['mysecret'] || plugins['MySecret'] || null;
  }

  /**
   * Indica si MySecret está presente en la bóveda de Obsidian.
   */
  public static isInstalled(app: App): boolean {
    return Boolean(this.getPlugin(app));
  }

  /**
   * Indica si MySecret está instalado y actualmente en estado bloqueado (requiere contraseña).
   */
  public static isLocked(app: App): boolean {
    const plugin = this.getPlugin(app);
    if (!plugin) return false;
    // Si keyManager existe, consultar su propiedad isLocked
    if (plugin.keyManager && typeof plugin.keyManager.isLocked === 'boolean') {
      return plugin.keyManager.isLocked;
    }
    return false;
  }

  /**
   * Obtiene el adaptador de bajo nivel (DataAdapter original de Obsidian sin hooks)
   * que MySecret expone para escribir en disco sin volver a cifrar.
   *
   * Importante: si MySecret no expone ese adaptador, se devuelve `null` en lugar
   * de recurrir a `app.vault.adapter`. El adaptador público de Obsidian está
   * parcheado por MySecret, por lo que escribir por él cifraría de nuevo el
   * contenido y produciría el doble cifrado que este módulo evita.
   */
  public static getRawAdapter(app: App): any {
    const plugin = this.getPlugin(app);
    if (plugin?.interceptor && typeof plugin.interceptor.getRawAdapter === 'function') {
      try {
        const raw = plugin.interceptor.getRawAdapter();
        if (raw && typeof raw.write === 'function') {
          return raw;
        }
      } catch {
        // En caso de cualquier excepción, no hay adaptador seguro disponible.
      }
    }
    return null;
  }

  /**
   * Detecta si una cadena de texto es un archivo blindado con formato MySecret.
   */
  public static isArmored(text: unknown): boolean {
    if (typeof text !== 'string' || !text) return false;
    return text.trimStart().startsWith(MYSECRET_ARMORED_START);
  }

  /**
   * Detecta si un buffer binario tiene la cabecera mágica "MYSE" de MySecret.
   */
  public static isBinaryEncrypted(data: Uint8Array): boolean {
    if (!data || data.length < MYSECRET_BINARY_HEADER_LEN) return false;
    return (
      data[0] === MYSECRET_BINARY_MAGIC[0] &&
      data[1] === MYSECRET_BINARY_MAGIC[1] &&
      data[2] === MYSECRET_BINARY_MAGIC[2] &&
      data[3] === MYSECRET_BINARY_MAGIC[3]
    );
  }

  /**
   * Intenta descifrar un adjunto binario blindado por MySecret usando la clave
   * de la bóveda en memoria (si MySecret está presente y desbloqueado).
   *
   * Se admiten los dos encabezados binarios plausibles de MySecret:
   *  - A: `magic(4) + version(1) + IV(12) + tag(16) + ciphertext`
   *  - B: `magic(4) + version(1) + IV(12) + ciphertext||tag`
   *
   * La etiqueta GCM autentica el resultado, por lo que un descifrado exitoso
   * garantiza que el texto plano es el original. Si ninguno de los dos
   * formatos valida, se devuelve `null` (fail-closed): es preferible no
   * sincronizar el adjunto antes que propagar un ciphertext ajeno.
   *
   * @param path Ruta del archivo dentro de la bóveda (usado como AAD).
   * @returns El binario en claro, o `null` si no se pudo descifrar.
   */
  public static async decryptBinaryEncrypted(
    app: App,
    data: Uint8Array,
    path: string
  ): Promise<Uint8Array | null> {
    if (!this.isBinaryEncrypted(data)) return null;

    const plugin = this.getPlugin(app);
    if (!plugin || this.isLocked(app)) return null;

    const vaultKey: CryptoKey | null = plugin.keyManager?.getVaultKey?.() || null;
    if (!vaultKey) return null;

    const iv = data.slice(5, 17);
    if (iv.byteLength !== 12) return null;

    const aad = new TextEncoder().encode(normalizePath(path));

    // Layout A: el tag viaja en la cabecera, antes del ciphertext.
    const candidates: Uint8Array[] = [];
    const tag = data.slice(17, 33);
    const ciphertext = data.slice(33);
    const combinedA = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    combinedA.set(ciphertext, 0);
    combinedA.set(tag, ciphertext.byteLength);
    candidates.push(combinedA);

    // Layout B: el tag va pegado al final del ciphertext.
    candidates.push(data.slice(17));

    for (const combined of candidates) {
      if (combined.byteLength < 16) continue;
      try {
        const decrypted = await getCrypto().subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: iv as BufferSource,
            additionalData: aad as BufferSource,
            tagLength: 128,
          },
          vaultKey,
          combined as BufferSource
        );
        return new Uint8Array(decrypted);
      } catch {
        // Formato no válido: se prueba el siguiente candidato.
      }
    }

    return null;
  }

  /**
   * Deserializa un contenedor de texto blindado ASCII de MySecret a sus componentes binarios.
   */
  public static deserializeArmored(text: string): MySecretArmoredEnvelope | null {
    const startIndex = text.indexOf(MYSECRET_ARMORED_START);
    const endIndex = text.indexOf(MYSECRET_ARMORED_END);

    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      return null;
    }

    const rawInner = text.substring(startIndex + MYSECRET_ARMORED_START.length, endIndex);
    const lines = rawInner.split(/\r?\n/);

    let version = 1;
    let ivStr = '';
    let tagStr = '';
    let bodyStartIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        if (ivStr && tagStr) {
          bodyStartIndex = i + 1;
          break;
        }
        continue;
      }
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const key = line.substring(0, colonIdx).trim().toLowerCase();
        const val = line.substring(colonIdx + 1).trim();
        if (key === 'version') version = parseInt(val, 10);
        else if (key === 'iv') ivStr = val;
        else if (key === 'tag') tagStr = val;
      }
    }

    if (ivStr && tagStr && bodyStartIndex === -1) {
      bodyStartIndex = lines.length;
    }

    if (!ivStr || !tagStr) return null;

    try {
      const bodyLines = bodyStartIndex < lines.length
        ? lines.slice(bodyStartIndex).map((l) => l.trim()).join('')
        : '';
      const iv = base64ToBytes(ivStr);
      const tag = base64ToBytes(tagStr);
      const ciphertext = bodyLines ? base64ToBytes(bodyLines) : new Uint8Array(0);

      return { version, iv, tag, ciphertext };
    } catch {
      return null;
    }
  }

  /**
   * Intenta descifrar un texto blindado de MySecret utilizando la clave de la bóveda
   * en memoria (si MySecret está presente y desbloqueado).
   *
   * @param app Instancia de la app de Obsidian
   * @param armoredText Texto con el envelope `-----BEGIN MYSECRET ENCRYPTED FILE-----`
   * @param path Ruta del archivo dentro de la bóveda (usado como AAD en AES-GCM)
   * @returns El texto plano descifrado, o null si no se pudo descifrar o no está blindado.
   */
  public static async decryptArmored(app: App, armoredText: string, path: string): Promise<string | null> {
    if (!this.isArmored(armoredText)) return null;

    const plugin = this.getPlugin(app);
    if (!plugin || this.isLocked(app)) return null;

    const vaultKey: CryptoKey | null = plugin.keyManager?.getVaultKey?.() || null;
    if (!vaultKey) return null;

    const envelope = this.deserializeArmored(armoredText);
    if (!envelope) return null;

    try {
      const normPath = normalizePath(path);
      const aad = new TextEncoder().encode(normPath);

      // WebCrypto AES-GCM espera [ciphertext + tag] juntos
      const combined = new Uint8Array(envelope.ciphertext.length + envelope.tag.length);
      combined.set(envelope.ciphertext, 0);
      combined.set(envelope.tag, envelope.ciphertext.length);

      const decrypted = await getCrypto().subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: envelope.iv as BufferSource,
          additionalData: aad as BufferSource,
          tagLength: 128,
        },
        vaultKey,
        combined as BufferSource
      );

      return new TextDecoder().decode(decrypted);
    } catch (err) {
      // Fallo de autenticación o AAD distinta
      console.warn('[OmniSync MySecretCompat] No se pudo descifrar texto blindado en:', path, err);
      return null;
    }
  }

  /**
   * Lee de forma robusta y consistente el contenido de un archivo del Vault,
   * garantizando que devuelva siempre los bytes del texto plano descifrado
   * (interoperando con `app.vault.read()`).
   *
   * Reglas de seguridad aplicadas:
   *  - Si el texto sigue blindado porque MySecret está bloqueado o no se
   *    puede descifrar, se devuelve `null` en lugar del ciphertext. Propagar
   *    un bloque cifrado ajeno por la red produciría doble cifrado en cascada
   *    en los demás dispositivos.
   *  - Si un binario llega cifrado por MySecret, se intenta descifrar con la
   *    clave de la bóveda. Si no es posible, se devuelve `null` (fail-closed).
   */
  public static async readVaultFileBytes(
    app: App,
    file: TFile
  ): Promise<Uint8Array | null> {
    const isText = Boolean(file.extension.match(/^(md|txt|canvas|json|css|js)$/i));

    if (isText) {
      // Usar `vault.read` para que el hook de MySecret descifre el texto plano
      let text = await app.vault.read(file);

      // Si el texto devuelto es todavía un envelope blindado (doble cifrado previo)
      if (this.isArmored(text)) {
        const innerPlain = await this.decryptArmored(app, text, file.path);
        if (innerPlain === null) {
          // Fail-closed: no se sincroniza ni se propaga un bloque ajeno.
          return null;
        }
        text = innerPlain;
      }

      return new TextEncoder().encode(text);
    }

    // Para archivos binarios puros (imágenes, audio, pdf):
    const buffer = await app.vault.readBinary(file);
    const bytes = new Uint8Array(buffer);

    // Si el binario está cifrado en reposo por MySecret, se descifra antes de
    // enviarlo: cada dispositivo debe cifrar con su propia contraseña local.
    if (this.isBinaryEncrypted(bytes)) {
      const plain = await this.decryptBinaryEncrypted(app, bytes, file.path);
      if (plain === null) {
        // Fail-closed: un adjunto que no se puede descifrar no se sincroniza.
        return null;
      }
      return plain;
    }

    return bytes;
  }

  /**
   * Escribe texto en una nota asegurándose de que si el texto entrante ya está blindado,
   * no sea cifrado una segunda vez (lo que provocaría el bug de "nota bloqueada en editor").
   */
  public static async writeTextSafely(
    app: App,
    file: TFile,
    text: string,
    options?: { mtime?: number }
  ): Promise<void> {
    // Si el texto entrante ya viene blindado por MySecret:
    if (this.isArmored(text)) {
      // 1. Intentar descifrarlo si MySecret está presente y desbloqueado
      const decrypted = await this.decryptArmored(app, text, file.path);
      if (decrypted !== null) {
        // Al pasar el texto plano a `vault.modify`, MySecret lo cifrará limpiamente con un IV nuevo
        await app.vault.modify(file, decrypted, options);
        return;
      }

      // 2. Si no se puede descifrar (o MySecret no tiene la clave en memoria),
      // escribir directamente al disco usando el rawAdapter para NO doble-cifrarlo.
      const raw = this.getRawAdapter(app);
      if (raw && typeof raw.write === 'function') {
        await raw.write(file.path, text);
        return;
      }

      // 3. Sin adaptador crudo no hay forma de escribir el bloque sin volver a
      //    cifrarlo. Es preferible no escribir (fail-closed) antes que dejar
      //    en disco un doble cifrado que el usuario no puede abrir.
      throw new MySecretCompatError(
        'No se puede escribir un archivo blindado sin el adaptador crudo de MySecret: ' +
          'se evitaría el doble cifrado, pero el bloque no se puede materializar de forma segura.'
      );
    }

    // Flujo normal: el texto es plano. `vault.modify` invocará a MySecret (si está activo)
    // para cifrarlo transparentemente antes de tocar el disco.
    await app.vault.modify(file, text, options);
  }

  /**
   * Crea una nota de texto en el Vault de forma segura contra dobles cifrados.
   */
  public static async createTextSafely(
    app: App,
    path: string,
    text: string,
    options?: { mtime?: number }
  ): Promise<void> {
    if (this.isArmored(text)) {
      const decrypted = await this.decryptArmored(app, text, path);
      if (decrypted !== null) {
        await app.vault.create(path, decrypted, options);
        return;
      }

      const raw = this.getRawAdapter(app);
      if (raw && typeof raw.write === 'function') {
        await raw.write(path, text);
        return;
      }

      throw new MySecretCompatError(
        'No se puede crear un archivo blindado sin el adaptador crudo de MySecret: ' +
          'se evitaría el doble cifrado, pero el bloque no se puede materializar de forma segura.'
      );
    }

    await app.vault.create(path, text, options);
  }
}
