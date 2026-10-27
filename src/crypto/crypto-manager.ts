/**
 * OmniSync - CryptoManager
 * Cifrado de extremo a extremo (E2EE) utilizando Web Crypto API (AES-256-GCM y PBKDF2/HMAC).
 * 100% nativo, sin dependencias externas, compatible con Obsidian Desktop y Mobile.
 */

import {
  SecurityValidationError,
  decodeCanonicalBase64,
  isPlainObject,
} from '../security/vault-security';
import { EncryptedMessagePayload } from '../types';

/** Tamaño exacto de la clave maestra compartida. */
export const PAIRING_SECRET_BYTES = 32;
/** Longitud Base64 canónica de una clave maestra de 256 bits. */
export const PAIRING_SECRET_BASE64_LENGTH = 44;
/** Tope defensivo para un ciphertext JSON AEAD. */
export const MAX_ENCRYPTED_PAYLOAD_BYTES = 768 * 1024;
const AES_GCM_TAG_BYTES = 16;
/** Contextos de derivación independientes para evitar reutilización de clave. */
export const VAULT_KEY_CONTEXT = 'OmniSync-Salt-v1';
export const SIGNALING_KEY_CONTEXT = 'OmniSync-Signaling-v1';
export const MAILBOX_KEY_CONTEXT = 'OmniSync-Mailbox-v1';
export const BLOSSOM_KEY_CONTEXT = 'OmniSync-Blossom-v1';
/** Longitud máxima de un desafío de autenticación. */
export const MAX_AUTH_CHALLENGE_LENGTH = 1024;

export class CryptoManager {
  private cryptoSubtle: SubtleCrypto;

  constructor() {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      this.cryptoSubtle = window.crypto.subtle;
    } else if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      this.cryptoSubtle = globalThis.crypto.subtle;
    } else {
      throw new Error('Web Crypto API no disponible en este entorno.');
    }
  }

  /**
   * Genera una clave de emparejamiento segura de 256 bits (32 bytes) codificada en Base64 URL-safe.
   */
  public generatePairingSecret(): string {
    const bytes = new Uint8Array(PAIRING_SECRET_BYTES);
    this.getCrypto().getRandomValues(bytes);
    return this.uint8ArrayToBase64(bytes);
  }

  /** Genera un identificador de dispositivo no predecible. */
  public generateDeviceId(): string {
    const bytes = new Uint8Array(16);
    this.getCrypto().getRandomValues(bytes);
    return `dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  /** Genera un identificador aleatorio válido para SecretStorage. */
  public generateSecretId(): string {
    const bytes = new Uint8Array(16);
    this.getCrypto().getRandomValues(bytes);
    return `omnisync-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  /** Genera un nonce aleatorio de 256 bits codificado en Base64 URL-safe. */
  public generateNonce(): string {
    const bytes = new Uint8Array(32);
    this.getCrypto().getRandomValues(bytes);
    return this.uint8ArrayToBase64Url(bytes);
  }

  /**
   * Genera un identificador hexadecimal aleatorio para suscripciones WebSocket.
   *
   * Se usa en lugar de prefijos legibles o de fragmentos del room ID: un relay
   * no debe poder distinguir esta aplicación ni correlacionar dos sesiones a
   * partir del `subId`.
   */
  public generateHexId(byteLength: number = 8): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 8 || byteLength > 32) {
      throw new SecurityValidationError('La longitud del identificador aleatorio no es válida.');
    }
    const bytes = new Uint8Array(byteLength);
    this.getCrypto().getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Genera un ID de sala determinista pero seguro a partir del secreto de emparejamiento.
   */
  public async deriveRoomId(pairingSecret: string): Promise<string> {
    const secretBytes = this.requirePairingSecret(pairingSecret);
    const hashBuffer = await this.cryptoSubtle.digest('SHA-256', secretBytes as BufferSource);
    const hashBytes = new Uint8Array(hashBuffer);
    // Identificador legado conservado para validar payloads de emparejamiento v1.
    return Array.from(hashBytes.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Deriva un identificador pseudónimo independiente para señalización. */
  public async deriveSignalingRoomId(pairingSecret: string): Promise<string> {
    return this.computeHmacHex('room', pairingSecret, 'signaling-room-v1');
  }

  /** Deriva un identificador pseudónimo independiente para el buzón Nostr. */
  public async deriveMailboxRoomId(pairingSecret: string): Promise<string> {
    return this.computeHmacHex('room', pairingSecret, 'mailbox-room-v1');
  }

  /**
   * Deriva una CryptoKey AES-GCM a partir del secreto de emparejamiento usando PBKDF2 con 100,000 iteraciones.
   */
  public async deriveAesKey(pairingSecret: string, saltString = VAULT_KEY_CONTEXT): Promise<CryptoKey> {
    if (typeof saltString !== 'string' || saltString.length === 0 || saltString.length > 256) {
      throw new SecurityValidationError('El contexto de derivación de clave es inválido.');
    }
    const secretBytes = this.requirePairingSecret(pairingSecret);
    const saltBytes = new TextEncoder().encode(saltString);

    const baseKey = await this.cryptoSubtle.importKey(
      'raw',
      secretBytes as BufferSource,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return this.cryptoSubtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 100000,
        hash: 'SHA-256',
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Cifra un objeto JavaScript o cadena de texto con AES-256-GCM con un IV aleatorio de 12 bytes.
   */
  public async encrypt(data: unknown, key: CryptoKey): Promise<EncryptedMessagePayload> {
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    if (typeof plaintext !== 'string') {
      throw new SecurityValidationError('El dato a cifrar no es serializable.');
    }
    const plaintextBytes = new TextEncoder().encode(plaintext);
    if (plaintextBytes.byteLength > MAX_ENCRYPTED_PAYLOAD_BYTES) {
      throw new SecurityValidationError('El plaintext supera el límite permitido.');
    }

    const iv = new Uint8Array(12);
    this.getCrypto().getRandomValues(iv);

    const ciphertextBuffer = await this.cryptoSubtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      plaintextBytes
    );

    return {
      v: 1,
      iv: this.uint8ArrayToBase64(iv),
      ct: this.uint8ArrayToBase64(new Uint8Array(ciphertextBuffer)),
    };
  }

  /**
   * Descifra un payload cifrado con AES-256-GCM y devuelve el dato original decodificado.
   */
  public async decrypt<T = unknown>(payload: unknown, key: CryptoKey, asText = false): Promise<T> {
    if (!isPlainObject(payload)) {
      throw new SecurityValidationError('Payload criptográfico inválido.');
    }
    if (payload.v !== 1) {
      throw new SecurityValidationError('Versión de protocolo criptográfico no soportada.');
    }

    const iv = decodeCanonicalBase64(payload.iv);
    const ciphertext = decodeCanonicalBase64(payload.ct);
    if (iv.byteLength !== 12) {
      throw new SecurityValidationError('El vector de inicialización AES-GCM no tiene 12 bytes.');
    }
    if (ciphertext.byteLength < 16) {
      throw new SecurityValidationError('El ciphertext AES-GCM no contiene una etiqueta de autenticación válida.');
    }
    if (ciphertext.byteLength > MAX_ENCRYPTED_PAYLOAD_BYTES + AES_GCM_TAG_BYTES) {
      throw new SecurityValidationError('El ciphertext supera el límite permitido.');
    }

    const decryptedBuffer = await this.cryptoSubtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      ciphertext as BufferSource
    );

    const decryptedText = new TextDecoder().decode(decryptedBuffer);
    if (asText) return decryptedText as unknown as T;
    try {
      return JSON.parse(decryptedText) as T;
    } catch {
      return decryptedText as unknown as T;
    }
  }

  /** Descifra devolviendo el texto exacto, sin interpretarlo como JSON. */
  public async decryptText(payload: unknown, key: CryptoKey): Promise<string> {
    return this.decrypt<string>(payload, key, true);
  }

  /**
   * Cifra un buffer binario (Uint8Array) devolviendo el IV y Ciphertext en formato binario empaquetado.
   */
  public async encryptBinary(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = new Uint8Array(12);
    this.getCrypto().getRandomValues(iv);

    const cipherBuffer = await this.cryptoSubtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      data as BufferSource
    );

    const cipherBytes = new Uint8Array(cipherBuffer);
    const result = new Uint8Array(12 + cipherBytes.length);
    result.set(iv, 0);
    result.set(cipherBytes, 12);
    return result;
  }

  /**
   * Descifra un buffer binario empaquetado (12 bytes IV + ciphertext con auth tag).
   */
  public async decryptBinary(packedData: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    if (packedData.length < 12 + 16) {
      throw new SecurityValidationError('Buffer binario cifrado demasiado corto o inválido.');
    }

    const iv = packedData.slice(0, 12);
    const ciphertext = packedData.slice(12);

    const decryptedBuffer = await this.cryptoSubtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      ciphertext as BufferSource
    );

    return new Uint8Array(decryptedBuffer);
  }

  /**
   * Calcula el hash SHA-256 de un texto o buffer binario en formato hexadecimal.
   */
  public async computeHash(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const hashBuffer = await this.cryptoSubtle.digest('SHA-256', bytes as BufferSource);
    const hashBytes = new Uint8Array(hashBuffer);
    return Array.from(hashBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Genera un token HMAC-SHA256 para autenticación de desafío mutuo durante el apretón de manos.
   */
  public async createAuthToken(challenge: string, pairingSecret: string): Promise<string> {
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > MAX_AUTH_CHALLENGE_LENGTH) {
      throw new SecurityValidationError('El desafío de autenticación es inválido.');
    }
    const secretBytes = this.requirePairingSecret(pairingSecret);
    const hmacKey = await this.cryptoSubtle.importKey(
      'raw',
      secretBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await this.cryptoSubtle.sign(
      'HMAC',
      hmacKey,
      new TextEncoder().encode(`OmniSync-Auth-v1\0${challenge}`) as BufferSource
    );

    return this.uint8ArrayToBase64(new Uint8Array(signature));
  }

  /**
   * Verifica un token HMAC-SHA256 contra un desafío.
   */
  public async verifyAuthToken(challenge: string, token: string, pairingSecret: string): Promise<boolean> {
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > MAX_AUTH_CHALLENGE_LENGTH) {
      return false;
    }
    if (typeof token !== 'string') return false;

    try {
      const secretBytes = this.requirePairingSecret(pairingSecret);
      const signature = decodeCanonicalBase64(token);
      if (signature.byteLength !== 32) return false;

      const hmacKey = await this.cryptoSubtle.importKey(
        'raw',
        secretBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      // `verify` realiza la comparación del MAC de forma resistente a fugas por tiempo.
      return await this.cryptoSubtle.verify(
        'HMAC',
        hmacKey,
        signature as BufferSource,
        new TextEncoder().encode(`OmniSync-Auth-v1\0${challenge}`) as BufferSource
      );
    } catch {
      return false;
    }
  }

  /**
   * Calcula un digest HMAC-SHA256 en hexadecimal para ofuscación de etiquetas de rutas en relays públicos.
   */
  public async computeHmacHex(
    data: string,
    pairingSecret: string,
    domain = 'default'
  ): Promise<string> {
    if (typeof data !== 'string' || data.length === 0 || data.length > 1024 * 1024) {
      throw new SecurityValidationError('El dato a autenticar es inválido.');
    }
    if (typeof domain !== 'string' || domain.length === 0 || domain.length > 128) {
      throw new SecurityValidationError('El dominio HMAC es inválido.');
    }
    const secretBytes = this.requirePairingSecret(pairingSecret);
    const hmacKey = await this.cryptoSubtle.importKey(
      'raw',
      secretBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await this.cryptoSubtle.sign(
      'HMAC',
      hmacKey,
      new TextEncoder().encode(
        `OmniSync-HMAC-v1\0${domain}\0${data}`
      ) as BufferSource
    );

    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  public uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Codifica bytes sin padding en Base64 URL-safe. */
  public uint8ArrayToBase64Url(bytes: Uint8Array): string {
    return this.uint8ArrayToBase64(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  public base64ToUint8Array(base64: string): Uint8Array {
    if (base64.length === 0) return new Uint8Array(0);
    return decodeCanonicalBase64(base64);
  }

  /** Valida que el secreto tenga exactamente 256 bits y codificación canónica. */
  public requirePairingSecret(pairingSecret: string): Uint8Array {
    if (
      typeof pairingSecret !== 'string' ||
      pairingSecret.length !== PAIRING_SECRET_BASE64_LENGTH
    ) {
      throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
    }
    const bytes = decodeCanonicalBase64(pairingSecret);
    if (bytes.byteLength !== PAIRING_SECRET_BYTES) {
      throw new SecurityValidationError('La clave de vinculación no tiene 256 bits.');
    }
    return bytes;
  }


  /**
   * Calcula el hash SHA-256 de un buffer en formato hexadecimal (64 caracteres en minúscula).
   */
  public async computeSha256Hex(data: Uint8Array): Promise<string> {
    const digest = await this.cryptoSubtle.digest('SHA-256', data as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private getCrypto(): Crypto {
    if (typeof globalThis !== 'undefined' && globalThis.crypto) {
      return globalThis.crypto;
    }
    throw new Error('Web Crypto API no disponible en este entorno.');
  }
}
