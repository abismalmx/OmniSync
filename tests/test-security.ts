/**
 * OmniSync - Suite de regresiones de seguridad
 *
 * Verifica de forma aislada cada control de confianza que se endureció:
 *
 *  - Criptografía: prefijo HMAC común, clave de 256 bits, base64 canónico.
 *  - Aislamiento de dominios: señalización y buzón usan material distinto.
 *  - Política de rutas: traversal, absolutas, papelera, Git, plugins.
 *  - Transferencias: hash, checksum, tamaño y número de fragmentos inválidos
 *    se rechazan antes de reservar memoria o escribir en el Vault.
 *  - Protocolo: envelopes, antigüedad, emisor y replay.
 *  - Señalización: solo `wss://`.
 *  - Integridad temporal: no se sobrescribe ni se borra una versión local
 *    más reciente; los borrados son reversibles.
 *  - Persistencia: la clave maestra no vive en `data.json`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CryptoManager,
  MAILBOX_KEY_CONTEXT,
  SIGNALING_KEY_CONTEXT,
  VAULT_KEY_CONTEXT,
} from '../src/crypto/crypto-manager';
import {
  MAX_ENCODED_CHUNK_LENGTH,
  MAX_TRANSFER_FILE_SIZE,
  validateFileChunk,
  validateFileDeletePayload,
  validateFileRenamePayload,
  validateRemoteManifest,
} from '../src/security/transfer-security';
import {
  MAX_PROTOCOL_MESSAGE_AGE_MS,
  ReplayGuard,
  validateBaseProtocolMessage,
  validatePresencePayload,
  validateWebRtcSignal,
} from '../src/security/protocol-security';
import {
  DEFAULT_VAULT_PATH_POLICY,
  SecurityValidationError,
  decodeCanonicalBase64,
  validateVaultPath,
} from '../src/security/vault-security';
import { validateSecureWebSocketUrl } from '../src/security/network-security';
import {
  decideMailboxNote,
  decideRemoteDelete,
  decideRemoteRename,
  decideRemoteWrite,
} from '../src/security/sync-policy';
import { decodePairingPayload, encodePairingPayload } from '../src/security/pairing';
import { ManifestCalculator } from '../src/sync/manifest-calc';
import { SignalingClient } from '../src/network/signaling-client';
import {
  buildAuthenticatedSignalingUrl,
  deriveWorkerAuthKey,
  isPrivateWorkerUrl,
  normalizeWorkerHost,
  normalizeWorkerHosts,
  workerAuthPublicKey,
} from '../src/security/worker-auth';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Ejecuta una función y devuelve si lanzó `SecurityValidationError`. */
function rejects(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof SecurityValidationError;
  }
}

/** Igual que `rejects` pero acepta cualquier tipo de error. */
function throwsAny(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** Igual que `rejects` pero para funciones asíncronas. */
async function rejectsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof SecurityValidationError;
  }
}

/**
 * Comprueba que un ciphertext no se puede descifrar con una clave ajena.
 *
 * El descifrado con una clave incorrecta falla con el error nativo de
 * WebCrypto (`OperationError`), no con `SecurityValidationError`, así que se
 * acepta cualquier excepción pero se exige que el valor original no se
 * recupere en ningún caso.
 */
async function cannotDecrypt(
  decryptFn: () => Promise<unknown>,
  expected: string
): Promise<boolean> {
  try {
    const result = await decryptFn();
    return result !== expected;
  } catch {
    return true;
  }
}

/* ────────────────────────────────────────────────────────────────
 * Criptografía
 * ──────────────────────────────────────────────────────────────── */

async function testCryptoInvariants(): Promise<void> {
  section('crypto: integridad de clave, base64 y HMAC');

  const crypto = new CryptoManager();

  // 1. La clave maestra tiene exactamente 256 bits y base64 canónico.
  const secret = crypto.generatePairingSecret();
  check('la clave maestra mide 44 caracteres Base64', secret.length === 44, `${secret.length}`);
  check(
    'la clave maestra decodifica a 32 bytes',
    decodeCanonicalBase64(secret).byteLength === 32
  );
  check(
    'el prefijo HMAC es idéntico al crear y al verificar',
    await (async () => {
      const challenge = crypto.generateNonce();
      const token = await crypto.createAuthToken(challenge, secret);
      return crypto.verifyAuthToken(challenge, token, secret);
    })()
  );
  check(
    'un token HMAC no valida con otro desafío',
    await (async () => {
      const token = await crypto.createAuthToken(crypto.generateNonce(), secret);
      return !(await crypto.verifyAuthToken(crypto.generateNonce(), token, secret));
    })()
  );
  check(
    'un token HMAC no valida con otra clave maestra',
    await (async () => {
      const challenge = crypto.generateNonce();
      const token = await crypto.createAuthToken(challenge, secret);
      const otherSecret = crypto.generatePairingSecret();
      return !(await crypto.verifyAuthToken(challenge, token, otherSecret));
    })()
  );

  // 2. El HMAC depende del dominio: misma clave, dominios distintos.
  const hmacA = await crypto.computeHmacHex('dato', secret, 'dominio-a');
  const hmacB = await crypto.computeHmacHex('dato', secret, 'dominio-b');
  check('el HMAC cambia al cambiar de dominio', hmacA !== hmacB);
  check(
    'el HMAC es determinista para el mismo dominio',
    hmacA === (await crypto.computeHmacHex('dato', secret, 'dominio-a'))
  );

  // 3. Se rechazan claves maestras mal formadas.
  check('se rechaza una clave maestra vacía', rejects(() => crypto.requirePairingSecret('')));
  check(
    'se rechaza una clave maestra de 128 bits',
    rejects(() => crypto.requirePairingSecret(crypto.uint8ArrayToBase64(new Uint8Array(16))))
  );
  check(
    'se rechaza Base64 no canónico',
    rejects(() => decodeCanonicalBase64('AAAA=AAA'))
  );
  check(
    'se rechaza Base64 con espacios',
    rejects(() => decodeCanonicalBase64('AA AA'))
  );

  // 4. El nonce y los IDs provienen del CSPRNG.
  const nonces = new Set<string>();
  for (let i = 0; i < 64; i++) nonces.add(crypto.generateNonce());
  check('el CSPRNG no repite nonces', nonces.size === 64, `${nonces.size}/64`);

  // 5. AES-GCM: un ciphertext manipulado no se descifra.
  const key = await crypto.deriveAesKey(secret);
  const encrypted = await crypto.encrypt({ ok: true }, key);
  const tampered = { ...encrypted, ct: encrypted.ct.slice(0, -4) + 'AAAA' };
  let decryptFailed = false;
  try {
    await crypto.decrypt(tampered, key);
  } catch {
    decryptFailed = true;
  }
  check('un ciphertext manipulado es rechazado por AEAD', decryptFailed);

  // 6. El descifrado rechaza una versión de protocolo desconocida.
  check(
    'se rechaza una versión criptográfica no soportada',
    await rejectsAsync(async () =>
      crypto.decrypt({ v: 99, iv: encrypted.iv, ct: encrypted.ct }, key)
    )
  );
}

/* ────────────────────────────────────────────────────────────────
 * Aislamiento de dominios
 * ──────────────────────────────────────────────────────────────── */

async function testDomainIsolation(): Promise<void> {
  section('crypto: aislamiento de dominios de red');

  const crypto = new CryptoManager();
  const secret = crypto.generatePairingSecret();

  // 1. Cada dominio usa un contexto de derivación distinto.
  check(
    'los contextos de derivación son distintos entre sí',
    new Set([VAULT_KEY_CONTEXT, SIGNALING_KEY_CONTEXT, MAILBOX_KEY_CONTEXT]).size === 3
  );

  // 2. Las claves derivadas de dominios distintos no son intercambiables.
  const vaultKey = await crypto.deriveAesKey(secret, VAULT_KEY_CONTEXT);
  const signalingKey = await crypto.deriveAesKey(secret, SIGNALING_KEY_CONTEXT);
  const mailboxKey = await crypto.deriveAesKey(secret, MAILBOX_KEY_CONTEXT);

  const cipher = await crypto.encrypt('secreto', vaultKey);
  check(
    'un ciphertext de bóveda no se descifra con la clave de señalización',
    await cannotDecrypt(async () => crypto.decrypt(cipher, signalingKey), 'secreto')
  );
  check(
    'un ciphertext de bóveda no se descifra con la clave del buzón',
    await cannotDecrypt(async () => crypto.decrypt(cipher, mailboxKey), 'secreto')
  );
  check(
    'un ciphertext de bóveda sí se descifra con su propia clave',
    (await crypto.decrypt(cipher, vaultKey)) === 'secreto'
  );

  // 3. Los identificadores de sala son seudónimos distintos por dominio.
  const signalingRoom = await crypto.deriveSignalingRoomId(secret);
  const mailboxRoom = await crypto.deriveMailboxRoomId(secret);
  check('la sala de señalización y la del buzón son distintas', signalingRoom !== mailboxRoom);
  check(
    'la sala de señalización no es el hash directo de la clave',
    signalingRoom !== (await crypto.deriveRoomId(secret))
  );
  check(
    'el ID de sala no contiene la clave maestra',
    !signalingRoom.includes(secret) && !mailboxRoom.includes(secret)
  );

  // 4. Con otra clave maestra se obtienen otras salas.
  const otherSecret = crypto.generatePairingSecret();
  check(
    'el ID de sala cambia al rotar la clave maestra',
    (await crypto.deriveSignalingRoomId(otherSecret)) !== signalingRoom
  );
}

/* ────────────────────────────────────────────────────────────────
 * Política de rutas
 * ──────────────────────────────────────────────────────────────── */

function testPathPolicy(): void {
  section('security: política de rutas del Vault');

  // 1. Traversal y rutas absolutas.
  check('se rechaza `..`', rejects(() => validateVaultPath('../fuera.md')));
  check(
    'se rechaza un traversal embebido',
    rejects(() => validateVaultPath('carpeta/../../fuera.md'))
  );
  check('se rechaza una ruta absoluta POSIX', rejects(() => validateVaultPath('/etc/passwd')));
  check(
    'se rechaza una ruta absoluta Windows',
    rejects(() => validateVaultPath('C:/Windows/system.ini'))
  );
  check('se rechaza una ruta vacía', rejects(() => validateVaultPath('')));

  // 2. Zonas que nunca deben sincronizarse.
  check('se rechaza la papelera', rejects(() => validateVaultPath('.trash/nota.md')));
  check('se rechaza el repositorio Git', rejects(() => validateVaultPath('.git/config')));
  check(
    'se rechazan los plugins ejecutables de Obsidian',
    rejects(() => validateVaultPath('.obsidian/plugins/malicioso/main.js'))
  );
  check(
    'se rechaza la configuración de Obsidian por defecto',
    rejects(() => validateVaultPath('.obsidian/app.json'))
  );

  // 3. Segmentos reservados que romperían objetos.
  check(
    'se rechaza `__proto__` como segmento',
    rejects(() => validateVaultPath('carpeta/__proto__/nota.md'))
  );

  // 4. La política de adjuntos se respeta.
  check(
    'se rechazan adjuntos cuando están desactivados',
    rejects(() =>
      validateVaultPath('imagen.png', { syncAttachments: false, syncObsidianConfig: false })
    )
  );
  check(
    'las notas Markdown siguen permitidas sin adjuntos',
    !rejects(() =>
      validateVaultPath('nota.md', { syncAttachments: false, syncObsidianConfig: false })
    )
  );
  check(
    'la configuración de Obsidian se acepta solo si la política lo permite',
    !rejects(() =>
      validateVaultPath('.obsidian/app.json', {
        syncAttachments: true,
        syncObsidianConfig: true,
      })
    )
  );

  // 5. La normalización es estable y canónica.
  check(
    'una ruta con barras invertidas se normaliza',
    validateVaultPath('carpeta\\nota.md') === 'carpeta/nota.md'
  );
  check(
    'una ruta válida se devuelve normalizada',
    validateVaultPath('carpeta/subcarpeta/nota.md') === 'carpeta/subcarpeta/nota.md'
  );
  check(
    'una ruta con doble barra se normaliza',
    validateVaultPath('carpeta//nota.md') === 'carpeta/nota.md'
  );
}

/* ────────────────────────────────────────────────────────────────
 * Transferencias
 * ──────────────────────────────────────────────────────────────── */

async function testTransferLimits(): Promise<void> {
  section('security: límites de transferencia');

  const crypto = new CryptoManager();
  const { FileTransferManager } = await import('../src/sync/file-transfer');

  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const hash = await crypto.computeHash(payload);
  const { header, chunks } = new FileTransferManager(crypto).prepareOutgoingChunks(
    'nota.md',
    payload,
    Date.now(),
    hash,
    false
  );

  // 1. Un hash global inválido se rechaza antes de reservar memoria.
  const manager = new FileTransferManager(crypto);
  const before = manager.activeTransferCount;
  check(
    'un hash SHA-256 inválido se rechaza en la cabecera',
    rejects(() => manager.registerIncomingHeader({ ...header, hash: 'no-es-un-hash' }))
  );
  check(
    'una cabecera inválida no reserva memoria de transferencia',
    manager.activeTransferCount === before
  );

  // 2. Un tamaño declarado enorme se rechaza.
  check(
    'un tamaño superior al límite se rechaza',
    rejects(() =>
      manager.registerIncomingHeader({ ...header, size: MAX_TRANSFER_FILE_SIZE + 1 })
    )
  );

  // 3. Un número de fragmentos inconsistente se rechaza.
  check(
    'un número de fragmentos inconsistente se rechaza',
    rejects(() => manager.registerIncomingHeader({ ...header, totalChunks: 9999 }))
  );

  // 4. Una ruta fuera de política se rechaza en la cabecera.
  check(
    'una cabecera con ruta fuera de política se rechaza',
    rejects(() => manager.registerIncomingHeader({ ...header, path: '../fuera.md' }))
  );

  // 5. Un fragmento con checksum ausente se rechaza.
  const manager2 = new FileTransferManager(crypto);
  manager2.registerIncomingHeader(header);
  check(
    'un fragmento sin checksum se rechaza',
    rejects(() =>
      validateFileChunk({ ...chunks[0], checksum: undefined }, header, DEFAULT_VAULT_PATH_POLICY)
    )
  );

  // 6. Un fragmento con datos mayores que el máximo se rechaza.
  check(
    'un fragmento con Base64 sobredimensionado se rechaza',
    rejects(() =>
      validateFileChunk(
        { ...chunks[0], data: 'A'.repeat(MAX_ENCODED_CHUNK_LENGTH + 4) },
        header,
        DEFAULT_VAULT_PATH_POLICY
      )
    )
  );

  // 7. Un fragmento que apunta a otra ruta se rechaza.
  check(
    'un fragmento con ruta distinta a la cabecera se rechaza',
    rejects(() =>
      validateFileChunk({ ...chunks[0], path: 'otra.md' }, header, DEFAULT_VAULT_PATH_POLICY)
    )
  );

  // 8. Un índice de fragmento fuera de rango se rechaza.
  check(
    'un índice de fragmento fuera de rango se rechaza',
    rejects(() =>
      validateFileChunk(
        { ...chunks[0], chunkIndex: 99 },
        header,
        DEFAULT_VAULT_PATH_POLICY
      )
    )
  );

  // 9. El límite de transferencias simultáneas se aplica.
  const manager3 = new FileTransferManager(crypto);
  manager3.registerIncomingHeader(header);
  manager3.registerIncomingHeader({ ...header, transferId: 'transferencia-2' });
  check(
    'el número de transferencias entrantes está acotado',
    manager3.activeTransferCount === 2,
    `${manager3.activeTransferCount}`
  );
  check(
    'una tercera transferencia simultánea se rechaza',
    throwsAny(() =>
      manager3.registerIncomingHeader({ ...header, transferId: 'transferencia-3' })
    )
  );
}

/* ────────────────────────────────────────────────────────────────
 * Manifiestos y órdenes remotas
 * ──────────────────────────────────────────────────────────────── */

async function testManifestAndOrders(): Promise<void> {
  section('security: manifiestos y órdenes remotas');

  const crypto = new CryptoManager();
  const hash = await crypto.computeHash(new Uint8Array([1]));

  // 1. Un manifiesto con una ruta fuera de política se rechaza.
  check(
    'un manifiesto con ruta fuera de política se rechaza',
    rejects(() =>
      validateRemoteManifest({
        deviceId: 'dev-remoto-1',
        timestamp: Date.now(),
        files: {
          '../fuera.md': {
            path: '../fuera.md',
            mtime: Date.now(),
            size: 1,
            hash,
            isBinary: false,
          },
        },
      })
    )
  );

  // 2. Un manifiesto con hash inválido se rechaza.
  check(
    'un manifiesto con hash inválido se rechaza',
    rejects(() =>
      validateRemoteManifest({
        deviceId: 'dev-remoto-1',
        timestamp: Date.now(),
        files: {
          'nota.md': {
            path: 'nota.md',
            mtime: Date.now(),
            size: 1,
            hash: 'x',
            isBinary: false,
          },
        },
      })
    )
  );

  // 3. Un `mtime` en el futuro se rechaza.
  check(
    'un manifiesto con fecha en el futuro se rechaza',
    rejects(() =>
      validateRemoteManifest({
        deviceId: 'dev-remoto-1',
        timestamp: Date.now() + 60 * 60 * 1000,
        files: {},
      })
    )
  );

  // 4. Las órdenes de borrado y renombrado exigen `mtime` y rutas limpias.
  check(
    'un borrado sin `mtime` se rechaza',
    rejects(() => validateFileDeletePayload({ path: 'nota.md' }))
  );
  check(
    'un borrado con ruta fuera de política se rechaza',
    rejects(() => validateFileDeletePayload({ path: '../fuera.md', mtime: Date.now() }))
  );
  check(
    'un renombrado a la misma ruta se rechaza',
    rejects(() =>
      validateFileRenamePayload({ oldPath: 'nota.md', newPath: 'nota.md', mtime: Date.now() })
    )
  );
  check(
    'un renombrado con ruta fuera de política se rechaza',
    rejects(() =>
      validateFileRenamePayload({
        oldPath: 'nota.md',
        newPath: '../fuera.md',
        mtime: Date.now(),
      })
    )
  );
  check(
    'un renombrado sin `mtime` se rechaza',
    rejects(() => validateFileRenamePayload({ oldPath: 'nota.md', newPath: 'otra.md' }))
  );
}

/* ────────────────────────────────────────────────────────────────
 * Protocolo y replay
 * ──────────────────────────────────────────────────────────────── */

function testProtocolAndReplay(): void {
  section('security: envelopes de protocolo y replay');

  const senderId = 'dev-remoto-1';
  const now = Date.now();
  const base = {
    type: 'PING',
    senderId,
    messageId: 'mensaje-0123456789abcdef',
    timestamp: now,
    payload: {},
  };

  // 1. Un envelope válido se acepta.
  let accepted = true;
  try {
    validateBaseProtocolMessage(base, senderId, now);
  } catch {
    accepted = false;
  }
  check('un envelope de protocolo válido se acepta', accepted);

  // 2. Un emisor distinto al peer autenticado se rechaza.
  check(
    'un mensaje de otro emisor se rechaza',
    rejects(() => validateBaseProtocolMessage(base, 'dev-otro-1', now))
  );

  // 3. Un tipo desconocido se rechaza.
  check(
    'un tipo de mensaje desconocido se rechaza',
    rejects(() => validateBaseProtocolMessage({ ...base, type: 'UNKNOWN' }, senderId, now))
  );

  // 4. Un mensaje demasiado antiguo se rechaza.
  check(
    'un mensaje fuera de la ventana temporal se rechaza',
    rejects(() =>
      validateBaseProtocolMessage(
        { ...base, timestamp: now - MAX_PROTOCOL_MESSAGE_AGE_MS - 1000 },
        senderId,
        now
      )
    )
  );

  // 5. Un mensaje con desviación excesiva hacia el futuro se rechaza.
  check(
    'un mensaje con reloj adelantado excesivo se rechaza',
    rejects(() =>
      validateBaseProtocolMessage({ ...base, timestamp: now + 60 * 60 * 1000 }, senderId, now)
    )
  );

  // 6. La presencia exige una ruta válida.
  check(
    'la presencia con ruta fuera de política se rechaza',
    rejects(() =>
      validatePresencePayload({ filePath: '../fuera.md', pos: 1 }, DEFAULT_VAULT_PATH_POLICY)
    )
  );

  // 7. El guard de replay rechaza duplicados y caduca.
  const guard = new ReplayGuard(1000, 10);
  check('el primer mensaje es aceptado', guard.accept('mensaje-1', now));
  check('el mismo mensaje se rechaza la segunda vez', !guard.accept('mensaje-1', now));
  check('un mensaje distinto es aceptado', guard.accept('mensaje-2', now));
  check('un mensaje caducado vuelve a aceptarse', guard.accept('mensaje-1', now + 2000));

  // 8. El guard se puede vaciar al rotar la clave.
  guard.clear();
  check(
    'el guard de replay se puede vaciar al rotar la clave',
    guard.accept('mensaje-1', now + 2000)
  );
}

/* ────────────────────────────────────────────────────────────────
 * Señalización y señales WebRTC
 * ──────────────────────────────────────────────────────────────── */

function testNetworkEndpoints(): void {
  section('security: endpoints y señales de red');

  // 1. Solo se admiten endpoints con TLS.
  check(
    'se acepta una URL wss válida',
    !rejects(() => validateSecureWebSocketUrl('wss://relay.example.org'))
  );
  // La URL sin TLS es precisamente lo que esta prueba debe rechazar.
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  check('se rechaza ws sin TLS', rejects(() => validateSecureWebSocketUrl('ws://relay.example.org')));
  check(
    'se rechaza http',
    rejects(() => validateSecureWebSocketUrl('http://relay.example.org'))
  );
  check(
    'se rechazan credenciales en la URL',
    rejects(() => validateSecureWebSocketUrl('wss://usuario:clave@relay.example.org'))
  );
  check(
    'se rechaza un fragmento en la URL',
    rejects(() => validateSecureWebSocketUrl('wss://relay.example.org/#sala'))
  );
  check('se rechaza una URL vacía', rejects(() => validateSecureWebSocketUrl('')));

  // 2. Las señales WebRTC se validan antes de tocar el navegador.
  check(
    'se acepta una oferta con SDP',
    !rejects(() => validateWebRtcSignal({ type: 'offer', sdp: 'v=0\r\n' }))
  );
  check(
    'se rechaza una oferta sin SDP',
    rejects(() => validateWebRtcSignal({ type: 'offer', sdp: '' }))
  );
  check(
    'se rechaza un tipo de señal desconocido',
    rejects(() => validateWebRtcSignal({ type: 'desconocido' }))
  );
  check(
    'se acepta un candidato ICE válido',
    !rejects(() =>
      validateWebRtcSignal({ type: 'candidate', candidate: { candidate: 'candidate:1 1 udp' } })
    )
  );
  check(
    'se rechaza un candidato ICE vacío',
    rejects(() => validateWebRtcSignal({ type: 'candidate', candidate: { candidate: '' } }))
  );
}

/* ────────────────────────────────────────────────────────────────
 * Integridad temporal
 * ──────────────────────────────────────────────────────────────── */

function testTemporalIntegrity(): void {
  section('security: integridad temporal de las órdenes remotas');

  const now = 1_700_000_000_000;

  // 1. Escritura: nunca se sobrescribe una versión local más reciente.
  check(
    'una versión local más reciente bloquea la escritura remota',
    decideRemoteWrite(now + 1000, now) === 'skip_newer_local'
  );
  check(
    'una versión local igual o anterior permite la escritura',
    decideRemoteWrite(now, now) === 'apply'
  );
  check(
    'un archivo inexistente siempre se escribe',
    decideRemoteWrite(null, now) === 'apply'
  );

  // 2. Borrado: se usa la papelera y nunca se destruye una versión reciente.
  check(
    'un borrado remoto más antiguo no elimina la versión local',
    decideRemoteDelete(now + 1000, now) === 'skip_newer_local'
  );
  check(
    'un borrado remoto posterior mueve el archivo a la papelera',
    decideRemoteDelete(now, now + 1000) === 'trash'
  );
  check(
    'un borrado de un archivo inexistente no hace nada',
    decideRemoteDelete(null, now) === 'skip_missing'
  );

  // 3. Renombrado: no se sobrescribe un destino existente.
  check(
    'un renombrado no sobrescribe un destino existente',
    decideRemoteRename(now, now + 1000, true) === 'skip_destination_exists'
  );
  check(
    'un renombrado aplica cuando el destino no existe',
    decideRemoteRename(now, now + 1000, false) === 'rename'
  );
  check(
    'un renombrado antiguo no se aplica sobre una versión reciente',
    decideRemoteRename(now + 1000, now, false) === 'skip_newer_local'
  );
  check(
    'un renombrado de un archivo inexistente no hace nada',
    decideRemoteRename(null, now, false) === 'skip_missing'
  );

  // 4. Buzón: una nota antigua no pisa la local; una nota nueva sí.
  check(
    'una nota del buzón más antigua no pisa la versión local',
    decideMailboxNote(now + 1000, now, 'local', 'remoto', 0) === 'skip'
  );
  check(
    'una nota del buzón con el mismo contenido se ignora',
    decideMailboxNote(now, now + 1000, 'igual', 'igual', 0) === 'skip'
  );
  check(
    'una nota del buzón más reciente se aplica',
    decideMailboxNote(now, now + 1000, 'local', 'remoto', now) === 'apply'
  );
  check(
    'una nota del buzón con cambio local reciente se marca como conflicto',
    decideMailboxNote(now + 1000, now + 2000, 'local', 'remoto', now) === 'conflict'
  );

  // 5. La marca de la consulta delimita los cambios locales propios. Si la
  //    marca se avanzara antes de aplicar las notas, el conflicto nunca
  //    se detectaría: esta aserción fija ese orden.
  check(
    'un cambio local posterior a la última consulta se detecta como conflicto',
    decideMailboxNote(
      now + 1000,
      now + 2000,
      'local',
      'remoto',
      now // marca de la consulta anterior
    ) === 'conflict'
  );
  check(
    'un cambio local anterior a la última consulta se aplica sin conflicto',
    decideMailboxNote(
      now - 1000,
      now + 2000,
      'local',
      'remoto',
      now // marca de la consulta anterior
    ) === 'apply'
  );
}

/* ────────────────────────────────────────────────────────────────
 * Emparejamiento
 * ──────────────────────────────────────────────────────────────── */

async function testPairing(): Promise<void> {
  section('security: payload de emparejamiento');

  const crypto = new CryptoManager();
  const secret = crypto.generatePairingSecret();
  const roomId = await crypto.deriveRoomId(secret);

  const uri = encodePairingPayload({
    v: 1,
    name: 'Laptop',
    platform: 'desktop',
    secret,
    roomId,
  });

  const decoded = decodePairingPayload(uri);
  check('el payload codificado se decodifica sin pérdida', decoded.secret === secret);
  check('el room ID se conserva', decoded.roomId === roomId);

  // 1. Un room ID que no corresponde a la clave se detecta como inconsistente.
  const mismatched = decodePairingPayload(
    encodePairingPayload({ v: 1, secret, roomId: '0'.repeat(32) })
  );
  check(
    'un room ID ajeno a la clave se detecta como inconsistente',
    (await crypto.deriveRoomId(mismatched.secret)) !== mismatched.roomId
  );

  // 2. Un payload con versión desconocida se rechaza.
  check(
    'una versión de payload desconocida se rechaza',
    rejects(() => decodePairingPayload(JSON.stringify({ v: 2, secret, roomId })))
  );

  // 3. Una clave de tamaño incorrecto se rechaza.
  check(
    'una clave maestra de tamaño incorrecto se rechaza',
    rejects(() =>
      decodePairingPayload(JSON.stringify({ v: 1, secret: 'corta', roomId }))
    )
  );

  // 4. Un payload enorme se rechaza.
  check(
    'un payload sobredimensionado se rechaza',
    rejects(() => decodePairingPayload('x'.repeat(20000)))
  );
}

/* ────────────────────────────────────────────────────────────────
 * Persistencia de la clave maestra
 * ──────────────────────────────────────────────────────────────── */

/** Extrae el cuerpo de una función por su firma y las llaves de cierre. */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

function testMasterKeyPersistence(): void {
  section('security: persistencia de la clave maestra');

  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');

  // 1. `saveSettings` no persiste el secreto ni el room ID.
  const saveSettingsBody = extractFunctionBody(source, 'async saveSettings(');
  check(
    'saveSettings elimina `pairingSecret` antes de guardar',
    saveSettingsBody.includes('delete persisted.pairingSecret')
  );
  check(
    'saveSettings elimina `roomId` antes de guardar',
    saveSettingsBody.includes('delete persisted.roomId')
  );
  check(
    'saveSettings escribe la clave en SecretStorage',
    saveSettingsBody.includes('setSecret(')
  );

  // 2. `loadSettings` migra el secreto heredado y no lo deja en data.json.
  const loadSettingsBody = extractFunctionBody(source, 'async loadSettings(');
  check(
    'loadSettings borra el secreto heredado de los datos persistidos',
    loadSettingsBody.includes('delete persisted.pairingSecret')
  );
  check(
    'loadSettings traslada el secreto heredado a SecretStorage',
    loadSettingsBody.includes('setSecret(secretId, secret)')
  );

  // 3. El rotador de clave cierra los pares y persiste la clave nueva.
  const resetBody = extractFunctionBody(source, 'public async resetMasterKey(');
  check(
    'la rotación de clave cierra los peers existentes',
    resetBody.includes('peer.close()')
  );
  check(
    'la rotación de clave genera una clave maestra nueva',
    resetBody.includes('generatePairingSecret()')
  );
  check(
    'la rotación de clave deriva nuevas claves por dominio',
    resetBody.includes('deriveDomainKeys()')
  );
  check(
    'la rotación de clave invalida el guard de replay',
    resetBody.includes('replayGuard.clear()')
  );

  // 4. El Vault nunca se borra de forma destructiva al recibir órdenes.
  check(
    'no se usa `vault.delete` en el orquestador',
    !source.includes('vault.delete(')
  );
  check(
    'las órdenes remotas usan la papelera',
    source.includes('vault.trash(')
  );
}

/* ────────────────────────────────────────────────────────────────
 * Cifrado en reposo (MySecret)
 * ──────────────────────────────────────────────────────────────── */

/**
 * Verifica que OmniSync nunca propaga material cifrado ajeno por la red ni
 * lo materializa en disco:
 *  - Un texto blindado que no se puede descifrar devuelve `null` (no se
 *    difunde el ciphertext, que produciría doble cifrado en cascada).
 *  - Un adjunto binario blindado se descifra con la clave local antes de
 *    enviarse, de modo que cada dispositivo cifre con su propia contraseña.
 *  - Sin adaptador crudo no se escribe un bloque blindado (fail-closed).
 */
async function testAtRestEncryption(): Promise<void> {
  section('security: cifrado en reposo y doble cifrado');

  const { MySecretCompat, MySecretCompatError } = await import(
    '../src/security/mysecret-compat'
  );

  const rawKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(rawKey);
  const vaultKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  const path = 'Notas/Secreto.md';
  const aad = new TextEncoder().encode(path);

  // Texto blindado con AAD correcta.
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const encBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    vaultKey,
    new TextEncoder().encode('contenido secreto')
  );
  const enc = new Uint8Array(encBuf);
  const armored = [
    '-----BEGIN MYSECRET ENCRYPTED FILE-----',
    'Version: 1',
    `IV: ${Buffer.from(iv).toString('base64')}`,
    `Tag: ${Buffer.from(enc.slice(enc.length - 16)).toString('base64')}`,
    '',
    Buffer.from(enc.slice(0, enc.length - 16)).toString('base64'),
    '-----END MYSECRET ENCRYPTED FILE-----',
    '',
  ].join('\n');

  let locked = false;
  const app: any = {
    plugins: {
      plugins: {
        mysecret: {
          keyManager: {
            get isLocked() {
              return locked;
            },
            getVaultKey: () => vaultKey,
          },
          interceptor: {
            getRawAdapter: () => ({
              write: async () => {
                rawWrites++;
              },
            }),
          },
        },
      },
    },
    vault: {
      read: async () => armored,
      readBinary: async () => armoredBuffer,
      modify: async () => {
        vaultWrites++;
      },
      create: async () => {
        vaultWrites++;
      },
      adapter: {
        write: async () => {
          publicAdapterWrites++;
        },
      },
    },
  };

  let vaultWrites = 0;
  let publicAdapterWrites = 0;
  let armoredBuffer = new Uint8Array(0);

  const file: any = { path, extension: 'md' };

  // 1. Texto blindado descifrable => se devuelve el texto plano.
  const plain = await MySecretCompat.readVaultFileBytes(app, file);
  check(
    'un texto blindado descifrable se devuelve en claro',
    plain !== null && new TextDecoder().decode(plain) === 'contenido secreto'
  );

  // 2. MySecret bloqueado => null, nunca el ciphertext.
  locked = true;
  const blocked = await MySecretCompat.readVaultFileBytes(app, file);
  check('un texto blindado ilegible devuelve null (fail-closed)', blocked === null);
  locked = false;

  // 3. Un adjunto binario blindado se descifra antes de salir del dispositivo.
  const binPath = 'Adjuntos/imagen.png';
  const binIv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(binIv);
  const binPlain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const binEncBuf = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: binIv,
      additionalData: new TextEncoder().encode(binPath),
      tagLength: 128,
    },
    vaultKey,
    binPlain
  );
  const binEnc = new Uint8Array(binEncBuf);
  armoredBuffer = new Uint8Array(4 + 1 + 12 + binEnc.length);
  armoredBuffer.set([0x4d, 0x59, 0x53, 0x45], 0);
  armoredBuffer[4] = 1;
  armoredBuffer.set(binIv, 5);
  armoredBuffer.set(binEnc, 17);

  const binFile: any = { path: binPath, extension: 'png' };
  const binOut = await MySecretCompat.readVaultFileBytes(app, binFile);
  check(
    'un adjunto cifrado en reposo se descifra antes de sincronizarlo',
    binOut !== null && Buffer.compare(Buffer.from(binOut), Buffer.from(binPlain)) === 0
  );

  // 4. Sin adaptador crudo no se escribe un bloque blindado.
  locked = true;
  const appNoRaw: any = {
    plugins: {
      plugins: {
        mysecret: {
          keyManager: {
            get isLocked() {
              return locked;
            },
            getVaultKey: () => null,
          },
          interceptor: {},
        },
      },
    },
    vault: {
      modify: async () => {
        vaultWrites++;
      },
      create: async () => {
        vaultWrites++;
      },
      adapter: {
        write: async () => {
          publicAdapterWrites++;
        },
      },
    },
  };
  vaultWrites = 0;
  publicAdapterWrites = 0;

  let raised = false;
  try {
    await MySecretCompat.writeTextSafely(appNoRaw, file, armored);
  } catch (err: any) {
    raised = err instanceof MySecretCompatError || err?.name === 'MySecretCompatError';
  }
  check('sin adaptador crudo la escritura blindada se aborta', raised);
  check('no se escribe con vault.modify (evita el doble cifrado)', vaultWrites === 0);
  check(
    'no se escribe con el adaptador público parcheado por MySecret',
    publicAdapterWrites === 0
  );
  locked = false;
}

/* ────────────────────────────────────────────────────────────────
 * Motor de parches delta
 * ──────────────────────────────────────────────────────────────── */

/**
 * Verifica que un parche delta provenance de la red no pueda corromper la
 * nota local:
 *  - Los rangos del hunk se validan antes de aplicarse.
 *  - Un parche con desfase de contexto no altera el texto base.
 *  - El tamaño del parche y el número de bloques están acotados.
 */
async function testDeltaPatchSecurity(): Promise<void> {
  section('security: parches delta');

  const { DeltaPatchEngine, MAX_PATCH_LENGTH, MAX_PATCH_HUNKS } = await import(
    '../src/sync/delta-patch'
  );

  const base = 'linea A\nlinea B\nlinea C';

  // 1. Un hunk con rangos incoherentes se rechaza sin tocar el texto base.
  const incoherent = ['--- a/f.md', '+++ b/f.md', '@@ -1,99 +1,1 @@', ' linea A', '+x', ''].join('\n');
  const r1 = DeltaPatchEngine.applyPatch(base, incoherent);
  check('un hunk con recuentos inconsistentes se rechaza', !r1.success);
  check('el texto base no se altera al rechazar el parche', r1.result === undefined);

  // 2. Un hunk con desfase de contexto se rechaza (el texto queda intacto).
  const drifted = ['--- a/f.md', '+++ b/f.md', '@@ -1,1 +1,1 @@', '-linea B', '+linea X', ''].join('\n');
  const r2 = DeltaPatchEngine.applyPatch(base, drifted);
  check('un parche con contexto desfasado se rechaza', !r2.success);

  // 3. Un parche sobredimensionado se rechaza antes de parsearlo.
  const huge = 'x'.repeat(MAX_PATCH_LENGTH + 10);
  const r3 = DeltaPatchEngine.applyPatch(base, huge);
  check('un parche que excede el límite de tamaño se rechaza', !r3.success);

  // 4. Un parche con demasiados bloques se rechaza.
  const manyHunks: string[] = ['--- a/f.md', '+++ b/f.md'];
  for (let i = 0; i < MAX_PATCH_HUNKS + 10; i++) {
    manyHunks.push('@@ -1,1 +1,1 @@', ' linea A', '+x');
  }
  const r4 = DeltaPatchEngine.applyPatch(base, manyHunks.join('\n'));
  check('un parche con demasiados bloques se rechaza', !r4.success);

  // 5. Un parche bien formado se aplica y produce exactamente el objetivo.
  const patch = DeltaPatchEngine.computePatch(base, 'linea A\nlinea B modificada\nlinea C', 1);
  const r5 = DeltaPatchEngine.applyPatch(base, patch);
  check('un parche bien formado se aplica correctamente', r5.success);
  check(
    'el parche reconstruye el texto objetivo exacto',
    r5.result === 'linea A\nlinea B modificada\nlinea C'
  );

  // 6. Un contexto de 0 líneas no debe romper el generador.
  const p0 = DeltaPatchEngine.computePatch(base, 'linea A\nX\nlinea C', 0);
  const r6 = DeltaPatchEngine.applyPatch(base, p0);
  check('un parche con contextLines=0 se aplica correctamente', r6.success);
  check(
    'el parche con contextLines=0 reconstruye el objetivo',
    r6.result === 'linea A\nX\nlinea C'
  );

  // 7. El parche no debe partir surrogate pairs.
  const emojiPatch = DeltaPatchEngine.computePatch('hola', 'a😀b', 1);
  const r7 = DeltaPatchEngine.applyPatch('hola', emojiPatch);
  check('el parche preserva los surrogate pairs', r7.success && r7.result === 'a😀b');
}

/* ────────────────────────────────────────────────────────────────
 * Ejecución
 * ──────────────────────────────────────────────────────────────── */

function testPlatformPathHardening(): void {
  section('security: rutas que el sistema de archivos resuelve a zonas protegidas');
  const withConfig = { syncAttachments: true, syncObsidianConfig: true };

  // Windows elimina el punto/espacio final de un segmento: `plugins.` == `plugins`.
  for (const evil of [
    '.obsidian/plugins./evil/main.js',
    '.obsidian/plugins /evil/main.js',
    '.obsidian./plugins/evil/main.js',
    '.git./hooks/pre-commit',
    '.git /hooks/pre-commit',
    '.trash./nota.md',
    'notas/archivo.',
    'notas/archivo.md ',
  ]) {
    check(`se rechaza «${evil}»`, rejects(() => validateVaultPath(evil, withConfig)));
  }
  check(
    'se rechaza un flujo alternativo NTFS (nota.md:script.js)',
    rejects(() => validateVaultPath('notas/nota.md:script.js', withConfig))
  );
  check('se rechaza un nombre de dispositivo (CON.md)', rejects(() => validateVaultPath('notas/CON.md')));
  check('se rechaza un nombre de dispositivo (nul)', rejects(() => validateVaultPath('notas/NUL')));
  check('se rechaza LPT1.txt', rejects(() => validateVaultPath('LPT1.txt')));
  check(
    'se rechaza el alias corto 8.3 de un directorio oculto',
    rejects(() => validateVaultPath('.obsidian/PLUGIN~1/evil/main.js', withConfig))
  );
  check('se rechazan comodines de Windows', rejects(() => validateVaultPath('notas/a*b.md')));
  check('se rechaza `toString` como nombre', rejects(() => validateVaultPath('toString')));
  check('se rechaza `valueOf` como nombre', rejects(() => validateVaultPath('carpeta/valueOf')));

  // Los nombres legítimos siguen funcionando.
  check('«Mi nota.md» sigue permitida', !rejects(() => validateVaultPath('Mi nota.md')));
  check('«a~b.md» (sin alias oculto) sigue permitida', !rejects(() => validateVaultPath('notas/a~1.md')));
  check('«Console.md» (no es CON) sigue permitida', !rejects(() => validateVaultPath('Console.md')));
  check(
    'un snippet CSS legítimo sigue permitido con la config activada',
    !rejects(() => validateVaultPath('.obsidian/snippets/tema.css', withConfig))
  );

  // Claves heredadas de Object.prototype no se hacen pasar por entradas de manifiesto.
  const entry = (path: string) => ({ path, mtime: 1000, size: 3, hash: 'a'.repeat(64), isBinary: false });
  const delta = ManifestCalculator.computeDelta(
    { deviceId: 'dev-a', timestamp: 1, files: {} },
    { deviceId: 'dev-b', timestamp: 1, files: { 'normal.md': entry('normal.md') } }
  );
  check('un archivo nuevo remoto se descarga', delta.toDownload.includes('normal.md'));
  // Un borrado remoto de `toString` no debe heredar la función de Object.prototype
  // como si fuera una entrada local y provocar una subida de un archivo inexistente.
  const ghost = ManifestCalculator.computeDelta(
    { deviceId: 'dev-a', timestamp: 1, files: {} },
    { deviceId: 'dev-b', timestamp: 1, files: { toString: { ...entry('toString'), deleted: true } } }
  );
  check(
    'las claves del prototipo no generan operaciones fantasma',
    ghost.toUpload.length === 0 && ghost.toDownload.length === 0 && ghost.conflicts.length === 0 && ghost.toDelete.length === 0
  );
}

async function testWorkerIdentityAndSignals(): Promise<void> {
  section('security: identidad del Worker y señales de señalización');
  const cm = new CryptoManager();
  const secret = cm.generatePairingSecret();

  const key = await deriveWorkerAuthKey(cm, secret);
  const again = await deriveWorkerAuthKey(cm, secret);
  check('la identidad de acceso es de 32 bytes', key.byteLength === 32);
  check('la identidad se deriva de forma determinista', Buffer.from(key).equals(Buffer.from(again)));
  check(
    'otro secreto produce otra identidad',
    !Buffer.from(key).equals(Buffer.from(await deriveWorkerAuthKey(cm, cm.generatePairingSecret())))
  );
  check('la clave pública es hexadecimal de 64 caracteres', /^[a-f0-9]{64}$/.test(workerAuthPublicKey(key)));
  const roomId = await cm.deriveSignalingRoomId(secret);
  check(
    'la identidad no coincide con la sala ni con la clave de vault',
    !Buffer.from(key).toString('hex').includes(roomId.slice(0, 16)) &&
      workerAuthPublicKey(key) !== roomId
  );

  // Hosts propios.
  check('normalizeWorkerHost extrae el host', normalizeWorkerHost('https://Mi-Worker.USER.workers.dev/ruta') === 'mi-worker.user.workers.dev');
  check('normalizeWorkerHost rechaza basura', normalizeWorkerHost('no es un host!!') === null);
  check(
    'normalizeWorkerHosts deduplica y limita',
    normalizeWorkerHosts(['a.test', 'A.test', 'b.test', 5, null, ...Array.from({ length: 20 }, (_, i) => `h${i}.test`)]).length === 8
  );
  check('isPrivateWorkerUrl reconoce un host marcado', isPrivateWorkerUrl('wss://a.test/', ['a.test']));
  check('isPrivateWorkerUrl no marca hosts ajenos', !isPrivateWorkerUrl('wss://nos.lol', ['a.test']));

  // URL autenticada.
  check('se rechaza una sala inválida', rejects(() => buildAuthenticatedSignalingUrl('wss://a.test/', 'corta', key)));
  check('se rechaza ws:// sin TLS', rejects(() => buildAuthenticatedSignalingUrl('ws://a.test/', roomId, key)));
  const url = new URL(buildAuthenticatedSignalingUrl('wss://a.test/', roomId, key));
  check('la URL lleva sala y token', url.searchParams.get('room') === roomId && !!url.searchParams.get('auth'));

  // El cliente descarta señales sin timestamp reciente (replay tras reinicio).
  const signalingKey = await cm.deriveAesKey(secret, SIGNALING_KEY_CONTEXT);
  const client = new SignalingClient('wss://a.test/', roomId, 'dev-local', cm);
  client.setCryptoKey(signalingKey);
  const joined: string[] = [];
  client.onPeerJoined = (id) => joined.push(id);
  const send = async (inner: Record<string, unknown>) =>
    (client as unknown as { handleIncomingEnvelope(v: unknown): Promise<void> }).handleIncomingEnvelope({
      type: 'join',
      roomId,
      payload: await cm.encrypt(inner, signalingKey),
    });
  const base = (id: string) => ({ type: 'join', senderId: id, messageId: cm.generateNonce() });
  await send({ ...base('dev-fresh'), timestamp: Date.now() });
  await send({ ...base('dev-old'), timestamp: Date.now() - MAX_PROTOCOL_MESSAGE_AGE_MS - 60_000 });
  await send({ ...base('dev-future'), timestamp: Date.now() + 60 * 60 * 1000 });
  await send(base('dev-notimestamp'));
  check('una señal reciente se acepta', joined.includes('dev-fresh'));
  check('una señal antigua se descarta', !joined.includes('dev-old'));
  check('una señal del futuro se descarta', !joined.includes('dev-future'));
  check('una señal sin timestamp se descarta', !joined.includes('dev-notimestamp'));
}

async function main(): Promise<void> {
  console.log('Suite de regresiones de seguridad de OmniSync');

  await testCryptoInvariants();
  await testDomainIsolation();
  testPathPolicy();
  testPlatformPathHardening();
  await testWorkerIdentityAndSignals();
  await testTransferLimits();
  await testManifestAndOrders();
  testProtocolAndReplay();
  testNetworkEndpoints();
  testTemporalIntegrity();
  await testPairing();
  testMasterKeyPersistence();
  await testAtRestEncryption();
  await testDeltaPatchSecurity();

  console.log(`\n───────────────`);
  console.log(`  Total: ${passed + failed}  |  PASS: ${passed}  |  FAIL: ${failed}`);
  console.log(`───────────────`);

  if (failed > 0) {
    console.log('\nPruebas fallidas:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error inesperado en la suite de seguridad:', err);
  process.exitCode = 1;
});

