/**
 * OmniSync - Tests de Interoperabilidad con MySecret
 */

import { MySecretCompat, MYSECRET_ARMORED_START, MYSECRET_ARMORED_END } from '../src/security/mysecret-compat';
import { TFile } from './obsidian-stub';

function assert(cond: any, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

async function runTests() {
  console.log('\n=== OmniSync: Interoperabilidad con MySecret ===\n');

  // Test 1: Detección de formato blindado
  const plainText = '# Nota normal en texto plano\nEste es un archivo sin cifrar.';
  const armoredText = `${MYSECRET_ARMORED_START}
Version: 1
IV: qvoV/0+i9uT8XgX5
Tag: 2g4ZNJSVJ3jvKgG217x/+Q==

YwwqAZUWATgsAQiLij0xJCchi28ytKMQITF4+1+rku9G
${MYSECRET_ARMORED_END}
`;

  assert(!MySecretCompat.isArmored(plainText), 'un texto normal no se marca como blindado');
  assert(MySecretCompat.isArmored(armoredText), 'un texto con cabecera MySecret se marca como blindado');
  assert(!MySecretCompat.isArmored(null), 'null no causa excepción y retorna false');

  // Test 2: Detección de cabecera binaria MYSE
  const normalBinary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
  const myseBinary = new Uint8Array(40);
  myseBinary[0] = 0x4d; // 'M'
  myseBinary[1] = 0x59; // 'Y'
  myseBinary[2] = 0x53; // 'S'
  myseBinary[3] = 0x45; // 'E'
  myseBinary[4] = 1;

  assert(!MySecretCompat.isBinaryEncrypted(normalBinary), 'un binario normal (PNG) no se detecta como MYSE');
  assert(MySecretCompat.isBinaryEncrypted(myseBinary), 'un buffer con magic MYSE se detecta correctamente');

  // Test 3: Deserialización de Envelope blindado
  const envelope = MySecretCompat.deserializeArmored(armoredText);
  assert(envelope !== null, 'el envelope blindado se deserializa correctamente');
  assert(envelope?.version === 1, 'la versión del envelope es 1');
  assert(envelope?.iv.length === 12, 'el IV mide exactamente 12 bytes');
  assert(envelope?.tag.length === 16, 'el Tag mide exactamente 16 bytes');
  assert((envelope?.ciphertext.length ?? 0) > 0, 'el ciphertext contiene bytes válidos');

  // Test 4: Cifrado y descifrado real con AES-256-GCM y AAD (simulación de MySecret)
  const rawKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(rawKey);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  const testPath = 'Diario/Secreto.md';
  const secretContent = 'Contenido ultra secreto de prueba 🔒';
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const aad = new TextEncoder().encode(testPath);

  const encryptedBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(secretContent)
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const ctLen = encryptedBytes.length - 16;
  const ct = encryptedBytes.slice(0, ctLen);
  const tag = encryptedBytes.slice(ctLen);

  const ivB64 = Buffer.from(iv).toString('base64');
  const tagB64 = Buffer.from(tag).toString('base64');
  const ctB64 = Buffer.from(ct).toString('base64');

  const generatedArmored = `${MYSECRET_ARMORED_START}
Version: 1
IV: ${ivB64}
Tag: ${tagB64}

${ctB64}
${MYSECRET_ARMORED_END}
`;

  // Mock app con plugin MySecret simulado
  let isLockedMock = false;
  const mockApp: any = {
    plugins: {
      plugins: {
        mysecret: {
          keyManager: {
            get isLocked() { return isLockedMock; },
            getVaultKey: () => cryptoKey,
          },
          interceptor: {
            getRawAdapter: () => ({
              write: async (p: string, d: string) => { mockRawWritten = d; },
            }),
          },
        },
      },
    },
    vault: {
      adapter: {},
    },
  };

  let mockRawWritten = '';

  // Test 5: Descifrado exitoso con MySecretCompat
  const decrypted = await MySecretCompat.decryptArmored(mockApp, generatedArmored, testPath);
  assert(decrypted === secretContent, 'decryptArmored descifra fielmente el contenido con AES-GCM');

  // Test 6: Fallo con AAD distinta (integridad de ruta)
  const decryptedWrongPath = await MySecretCompat.decryptArmored(mockApp, generatedArmored, 'OtraRuta/Fake.md');
  assert(decryptedWrongPath === null, 'decryptArmored rechaza descifrado si la ruta (AAD) no coincide');

  // Test 7: Prevención de doble cifrado al escribir
  const mockFile = new TFile();
  mockFile.path = testPath;
  let vaultModifyCalled = false;
  mockApp.vault.modify = async () => { vaultModifyCalled = true; };

  // Caso A: Texto plano -> debe llamar a vault.modify para que MySecret lo cifre en disco
  await MySecretCompat.writeTextSafely(mockApp, mockFile as any, 'Texto plano nuevo');
  assert(vaultModifyCalled, 'un texto plano se envía a vault.modify para cifrado nativo');

  // Caso B: Texto blindado que no se puede descifrar -> debe usar rawAdapter para NO doble-cifrar
  vaultModifyCalled = false;
  mockRawWritten = '';
  isLockedMock = true; // Simular que MySecret está bloqueado y no puede descifrar
  await MySecretCompat.writeTextSafely(mockApp, mockFile as any, armoredText);
  assert(!vaultModifyCalled, 'un texto blindado NO llama a vault.modify cuando no se puede descifrar');
  assert(mockRawWritten === armoredText, 'un texto blindado se escribe directamente mediante rawAdapter');

  // Test 8: Detección de bloqueo
  assert(MySecretCompat.isLocked(mockApp), 'isLocked detecta correctamente cuando la bóveda está bloqueada');
  isLockedMock = false;
  assert(!MySecretCompat.isLocked(mockApp), 'isLocked detecta correctamente cuando la bóveda está desbloqueada');

  // Test 9: Descifrado de adjuntos binarios cifrados en reposo (cabecera MYSE)
  const binPath = 'Adjuntos/imagen.png';
  const binPlain = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  const binIv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(binIv);
  const binAad = new TextEncoder().encode(binPath);
  const binEncBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: binIv, additionalData: binAad, tagLength: 128 },
    cryptoKey,
    binPlain
  );
  const binEnc = new Uint8Array(binEncBuf);

  // Layout A: magic(4) + version(1) + IV(12) + tag(16) + ciphertext
  const binLayoutA = new Uint8Array(4 + 1 + 12 + 16 + binEnc.length - 16);
  binLayoutA.set([0x4d, 0x59, 0x53, 0x45], 0);
  binLayoutA[4] = 1;
  binLayoutA.set(binIv, 5);
  binLayoutA.set(binEnc.slice(binEnc.length - 16), 17);
  binLayoutA.set(binEnc.slice(0, binEnc.length - 16), 33);

  const binDecryptedA = await MySecretCompat.decryptBinaryEncrypted(mockApp, binLayoutA, binPath);
  assert(binDecryptedA !== null, 'decryptBinaryEncrypted descifra un adjunto con layout A');
  assert(
    binDecryptedA !== null && Buffer.compare(Buffer.from(binDecryptedA), Buffer.from(binPlain)) === 0,
    'el adjunto descifrado es idéntico al original'
  );

  // Layout B: magic(4) + version(1) + IV(12) + ciphertext||tag
  const binLayoutB = new Uint8Array(4 + 1 + 12 + binEnc.length);
  binLayoutB.set([0x4d, 0x59, 0x53, 0x45], 0);
  binLayoutB[4] = 1;
  binLayoutB.set(binIv, 5);
  binLayoutB.set(binEnc, 17);

  const binDecryptedB = await MySecretCompat.decryptBinaryEncrypted(mockApp, binLayoutB, binPath);
  assert(binDecryptedB !== null, 'decryptBinaryEncrypted descifra un adjunto con layout B');
  assert(
    binDecryptedB !== null && Buffer.compare(Buffer.from(binDecryptedB), Buffer.from(binPlain)) === 0,
    'el adjunto descifrado (layout B) es idéntico al original'
  );

  // Ruta distinta => el AAD no valida => null (fail-closed)
  const binWrongPath = await MySecretCompat.decryptBinaryEncrypted(mockApp, binLayoutA, 'Otra/Imagen.png');
  assert(binWrongPath === null, 'decryptBinaryEncrypted rechaza el adjunto si la ruta (AAD) no coincide');

  // MySecret bloqueado => null, nunca se intenta descifrar
  isLockedMock = true;
  const binLocked = await MySecretCompat.decryptBinaryEncrypted(mockApp, binLayoutA, binPath);
  assert(binLocked === null, 'decryptBinaryEncrypted devuelve null cuando MySecret está bloqueado');
  isLockedMock = false;

  // Un binario normal no se considera cifrado
  assert(
    (await MySecretCompat.decryptBinaryEncrypted(mockApp, normalBinary, 'x.png')) === null,
    'decryptBinaryEncrypted ignora binarios no cifrados'
  );

  // Test 10: readVaultFileBytes nunca devuelve ciphertext ajeno (fail-closed)
  const vaultReadMock: any = {
    // El hook de MySecret no puede descifrar: devuelve el bloque blindado tal cual.
    read: async () => armoredText,
    readBinary: async () => binLayoutA,
  };
  const mockApp2: any = {
    plugins: {
      plugins: {
        mysecret: {
          keyManager: {
            get isLocked() { return isLockedMock; },
            getVaultKey: () => cryptoKey,
          },
          interceptor: {
            getRawAdapter: () => ({
              write: async (p: string, d: string) => { mockRawWritten = d; },
            }),
          },
        },
      },
    },
    vault: { ...vaultReadMock, adapter: {} },
  };

  // Con MySecret bloqueado el texto blindado no se puede descifrar: no se devuelve.
  isLockedMock = true;
  const readBytes = await MySecretCompat.readVaultFileBytes(mockApp2, mockFile as any);
  assert(readBytes === null, 'readVaultFileBytes devuelve null en vez de propagar texto blindado ajeno');

  // Con MySecret desbloqueado pero con AAD distinta, tampoco se propaga el bloque.
  isLockedMock = false;
  const readBytes2 = await MySecretCompat.readVaultFileBytes(mockApp2, mockFile as any);
  assert(
    readBytes2 === null,
    'readVaultFileBytes devuelve null si el texto blindado no se puede descifrar'
  );

  // Test 11: sin adaptador crudo no se escribe nada (fail-closed ante doble cifrado)
  const mockAppNoRaw: any = {
    plugins: {
      plugins: {
        mysecret: {
          keyManager: {
            get isLocked() { return true; },
            getVaultKey: () => null,
          },
          interceptor: {},
        },
      },
    },
    vault: {
      adapter: { write: async () => { rawAdapterFallbackUsed = true; } },
      modify: async () => { vaultModifyCalled = true; },
      create: async () => { vaultModifyCalled = true; },
    },
  };
  let rawAdapterFallbackUsed = false;
  vaultModifyCalled = false;
  let threwCompatError = false;
  try {
    await MySecretCompat.writeTextSafely(mockAppNoRaw, mockFile as any, armoredText);
  } catch (err: any) {
    threwCompatError = err?.name === 'MySecretCompatError';
  }
  assert(threwCompatError, 'writeTextSafely lanza MySecretCompatError si no hay adaptador crudo');
  assert(!vaultModifyCalled, 'writeTextSafely no escribe con vault.modify cuando falta el adaptador crudo');
  assert(!rawAdapterFallbackUsed, 'writeTextSafely no usa el adaptador público (parcheado por MySecret)');

  console.log('\n───────────────────────────────────────────────');
  console.log('  Todas las pruebas de MySecretCompat pasaron');
  console.log('───────────────────────────────────────────────\n');
}

runTests().catch((err) => {
  console.error('Error en pruebas de MySecretCompat:', err);
  process.exit(1);
});
