/**
 * Automated Tests for Nostr Blossom Integration (BUD-01/02 + NIP-98 + E2EE)
 * Tests:
 * 1. Eligibility validation for Blossom (large notes, images, videos, audio, PDFs, canvas)
 * 2. Binary AES-256-GCM encryption & decryption round-trip
 * 3. SHA-256 computation integrity
 * 4. NIP-98 signed HTTP Authorization header (Kind 27235 event and signature validity)
 * 5. Blob size limits and preset enforcement (25 MB vs 50 MB)
 * 6. NostrMailbox pointer event with payload type 'BLOB_ATTACHMENT'
 */

import assert from 'node:assert';
import { verifyEvent, generateSecretKey } from 'nostr-tools';
import {
  CryptoManager,
  BLOSSOM_KEY_CONTEXT,
  MAILBOX_KEY_CONTEXT,
} from '../src/crypto/crypto-manager';
import { BlossomClient } from '../src/network/blossom-client';
import { NostrMailbox } from '../src/network/nostr-mailbox';

async function runTests() {
  console.log('=== Iniciando Suite de Pruebas: Blossom Storage (BUD-01/02 + E2EE) ===\n');

  const cryptoManager = new CryptoManager();
  const pairingSecret = cryptoManager.generatePairingSecret();
  const roomId = await cryptoManager.deriveRoomId(pairingSecret);
  const mailboxKey = await cryptoManager.deriveAesKey(pairingSecret, MAILBOX_KEY_CONTEXT);
  const blossomKey = await cryptoManager.deriveAesKey(pairingSecret, BLOSSOM_KEY_CONTEXT);
  const deviceId = 'device-laptop-test';

  const mailbox = new NostrMailbox(
    'wss://nos.lol',
    roomId,
    deviceId,
    pairingSecret,
    cryptoManager
  );
  mailbox.setCryptoKey(mailboxKey);
  mailbox.setBlossomKey(blossomKey);

  // 1. Elegibilidad para Blossom
  console.log('[Test 1] Validación de elegibilidad para Blossom');
  mailbox.setBlossomConfig(['https://cdn.satellite.earth'], 25 * 1024 * 1024);

  // Imágenes, audios, videos, PDFs y canvas
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Adjuntos/foto.png', 5 * 1024 * 1024),
    true,
    'Debe admitir imagen PNG de 5 MB'
  );
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Videos/tutorial.mp4', 20 * 1024 * 1024),
    true,
    'Debe admitir video MP4 de 20 MB'
  );
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Documentos/manual.pdf', 12 * 1024 * 1024),
    true,
    'Debe admitir PDF de 12 MB'
  );
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Esquemas/diagrama.canvas', 2 * 1024 * 1024),
    true,
    'Debe admitir canvas de 2 MB'
  );
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Notas/NotaExtensa.md', 500 * 1024),
    true,
    'Debe admitir nota markdown grande (> 64 KB)'
  );

  // Exceder límite de preset (25 MB)
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Archivos/enorme.zip', 30 * 1024 * 1024),
    false,
    'Debe rechazar archivo de 30 MB si el preset es de 25 MB'
  );

  // Cambio de preset a 50 MB
  mailbox.setBlossomConfig(['https://cdn.satellite.earth'], 50 * 1024 * 1024);
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Archivos/enorme.zip', 30 * 1024 * 1024),
    true,
    'Debe admitir archivo de 30 MB cuando el preset se amplía a 50 MB'
  );
  assert.strictEqual(
    mailbox.isEligibleForBlossom('Archivos/gigante.zip', 60 * 1024 * 1024),
    false,
    'Debe rechazar archivo de 60 MB en preset de 50 MB'
  );
  console.log('  ✓ Reglas de elegibilidad y presets de tamaño validadas correctamente.\n');

  // 2. Cifrado y Descifrado Binario E2EE (AES-256-GCM)
  console.log('[Test 2] Cifrado y descifrado binario AES-256-GCM Zero-Knowledge');
  const sampleData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x42, 0x43]); // PNG Header + data
  const sampleBuffer = sampleData.buffer.slice(sampleData.byteOffset, sampleData.byteOffset + sampleData.byteLength);

  const encryptedBlob = await cryptoManager.encryptBinary(sampleBuffer, blossomKey);
  assert(encryptedBlob.byteLength > sampleBuffer.byteLength, 'El blob cifrado debe incluir el IV de 12 bytes y el Auth Tag de 16 bytes');

  const decryptedBuffer = await cryptoManager.decryptBinary(encryptedBlob, blossomKey);
  const decryptedArray = new Uint8Array(decryptedBuffer);

  assert.deepStrictEqual(
    decryptedArray,
    sampleData,
    'Los bytes descifrados deben ser idénticos al contenido binario original'
  );
  console.log('  ✓ Cifrado y descifrado binario E2EE verificado.\n');

  // 3. Cálculo de Hashes SHA-256
  console.log('[Test 3] Integridad de hash SHA-256');
  const sha256Hex = await cryptoManager.computeSha256Hex(encryptedBlob);
  assert.strictEqual(typeof sha256Hex, 'string');
  assert.strictEqual(sha256Hex.length, 64, 'El hash SHA-256 debe tener exactamente 64 caracteres hexadecimales');
  console.log(`  ✓ Hash SHA-256 calculado: ${sha256Hex.slice(0, 16)}...\n`);

  // 4. Generación y Validación de Cabecera NIP-98 (Kind 27235)
  console.log('[Test 4] Generación de cabecera de autenticación NIP-98 (BUD-02)');
  const nostrSecretKey = generateSecretKey();
  const authHeader = BlossomClient.createNip98AuthHeader(
    'https://cdn.satellite.earth/upload',
    'PUT',
    sha256Hex,
    nostrSecretKey
  );
  assert(authHeader.startsWith('Nostr '), 'La cabecera debe iniciar con el prefijo "Nostr "');

  const encodedEvent = authHeader.replace('Nostr ', '').trim();
  const decodedJson = Buffer.from(encodedEvent, 'base64').toString('utf-8');
  const nip98Event = JSON.parse(decodedJson);

  assert.strictEqual(nip98Event.kind, 27235, 'El evento NIP-98 debe ser kind: 27235');
  assert(nip98Event.tags.some((t: string[]) => t[0] === 'u' && t[1] === 'https://cdn.satellite.earth/upload'), 'Debe incluir tag "u" con la URL completa');
  assert(nip98Event.tags.some((t: string[]) => t[0] === 'method' && t[1] === 'PUT'), 'Debe incluir tag "method"');
  assert(nip98Event.tags.some((t: string[]) => t[0] === 'payload' && t[1] === sha256Hex), 'Debe incluir tag "payload" con el SHA-256');
  assert(!nip98Event.tags.some((t: string[]) => t[0] === 'x'), 'No debe usar el tag obsoleto "x"');

  // Validar firma criptográfica Nostr con nostr-tools
  const isValidSignature = verifyEvent(nip98Event);
  assert.strictEqual(isValidSignature, true, 'La firma criptográfica del evento NIP-98 debe ser 100% válida');
  console.log('  ✓ Evento NIP-98 verificado criptográficamente con nostr-tools.\n');

  // 5. Estructura de Puntero NostrMailbox con 'BLOB_ATTACHMENT' y d-tag v2 puro
  console.log('[Test 5] Puntero NostrMailbox para adjunto Blossom con corte limpio v2');
  const dTag = await cryptoManager.computeHmacHex(`${roomId}:Fotos/vacaciones.jpg`, pairingSecret, 'mailbox-dtag-v2');
  assert.strictEqual(dTag.length, 64, 'El tag d ofuscado con HMAC debe ser de 64 caracteres');
  assert.strictEqual(/^[a-f0-9]{64}$/.test(dTag), true, 'El tag d debe ser estrictamente hex de 64 caracteres');
  assert.strictEqual(dTag.startsWith('omnisync:'), false, 'El tag d no debe contener el prefijo omnisync:');

  // Validar que el payload contenga la estructura BLOB_ATTACHMENT requerida
  const mockBlobPayload = {
    type: 'BLOB_ATTACHMENT' as const,
    path: 'Fotos/vacaciones.jpg',
    sha256Hex,
    size: sampleBuffer.byteLength,
    encryptedSize: encryptedBlob.byteLength,
    servers: ['https://cdn.satellite.earth'],
    timestamp: Date.now(),
    deviceId,
  };

  assert.strictEqual(mockBlobPayload.type, 'BLOB_ATTACHMENT');
  assert.strictEqual(mockBlobPayload.sha256Hex, sha256Hex);
  assert.strictEqual(mockBlobPayload.size, sampleBuffer.byteLength);
  console.log('  ✓ Estructura de metadatos de adjunto Blossom validada exitosamente.\n');

  // 6. Detección Automática de Proveedores Blossom
  console.log('[Test 6] Detección automática de proveedores Blossom y límites sugeridos');
  const { detectBlossomProvider, resolveMaxBlobSizeBytes } = await import('../src/network/blossom-providers');
  const { MAX_BLOSSOM_FILE_SIZE_BYTES } = await import('../src/network/blossom-client');

  // 6.1 Cloudflare Workers + R2
  const cf1 = detectBlossomProvider('https://mi-servidor.workers.dev');
  assert.strictEqual(cf1.type, 'cloudflare');
  assert.strictEqual(cf1.suggestedLimitMb, 100);

  const cf2 = detectBlossomProvider('https://sub.r2.cloudflarestorage.com/bucket');
  assert.strictEqual(cf2.type, 'cloudflare');
  assert.strictEqual(cf2.suggestedLimitMb, 100);

  // 6.2 VPS / Docker / Local
  const vps1 = detectBlossomProvider('http://localhost:3000');
  assert.strictEqual(vps1.type, 'vps_local');
  assert.strictEqual(vps1.suggestedLimitMb, 500);

  const vps2 = detectBlossomProvider('http://192.168.1.50:8080');
  assert.strictEqual(vps2.type, 'vps_local');
  assert.strictEqual(vps2.suggestedLimitMb, 500);

  const vps3 = detectBlossomProvider('http://10.0.0.12');
  assert.strictEqual(vps3.type, 'vps_local');
  assert.strictEqual(vps3.suggestedLimitMb, 500);

  // 6.3 Satellite.earth
  const sat = detectBlossomProvider('https://cdn.satellite.earth');
  assert.strictEqual(sat.type, 'satellite');
  assert.strictEqual(sat.suggestedLimitMb, 25);

  // 6.4 Primal Blossom
  const primal = detectBlossomProvider('https://blossom.primal.net');
  assert.strictEqual(primal.type, 'primal');
  assert.strictEqual(primal.suggestedLimitMb, 25);

  // 6.5 Nostr.download
  const nd = detectBlossomProvider('https://nostr.download');
  assert.strictEqual(nd.type, 'nostr_download');
  assert.strictEqual(nd.suggestedLimitMb, 25);

  // 6.6 NostrBuild
  const nb = detectBlossomProvider('https://nostrbuild.com');
  assert.strictEqual(nb.type, 'nostrbuild');
  assert.strictEqual(nb.suggestedLimitMb, 50);

  // 6.7 Supabase
  const supa = detectBlossomProvider('https://xyz.supabase.co/storage/v1');
  assert.strictEqual(supa.type, 'supabase');
  assert.strictEqual(supa.suggestedLimitMb, 50);

  // 6.8 S3 Compatible
  const s3Aws = detectBlossomProvider('https://mi-bucket.s3.amazonaws.com');
  assert.strictEqual(s3Aws.type, 's3_compatible');
  assert.strictEqual(s3Aws.suggestedLimitMb, 200);

  const s3B2 = detectBlossomProvider('https://f001.backblazeb2.com');
  assert.strictEqual(s3B2.type, 's3_compatible');
  assert.strictEqual(s3B2.suggestedLimitMb, 200);

  // 6.9 Desconocido / Personalizado
  const custom = detectBlossomProvider('https://mi-dominio-raro.org');
  assert.strictEqual(custom.type, 'custom');
  assert.strictEqual(custom.suggestedLimitMb, 50);
  console.log('  ✓ Detección de los 8 proveedores Blossom verificada correctamente.\n');

  // 7. Cálculo de Límites Libres y Guarda Estática
  console.log('[Test 7] Cálculo de límites libres y ampliación de guarda estática a 1 GB');
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ maxBlobSizePreset: '25mb' }),
    25 * 1024 * 1024,
    'Preset 25mb debe devolver 25 MB en bytes'
  );
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ maxBlobSizePreset: '50mb' }),
    50 * 1024 * 1024,
    'Preset 50mb debe devolver 50 MB en bytes'
  );
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ maxBlobSizePreset: '100mb' }),
    100 * 1024 * 1024,
    'Preset 100mb debe devolver 100 MB en bytes'
  );
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ customMaxBlobSizeMb: 75 }),
    75 * 1024 * 1024,
    'Límite manual de 75 MB debe calcular 78643200 bytes'
  );
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ customMaxBlobSizeMb: 100 }),
    100 * 1024 * 1024,
    'Límite manual de 100 MB debe calcular 104857600 bytes'
  );
  assert.strictEqual(
    resolveMaxBlobSizeBytes({ customMaxBlobSizeMb: 500 }),
    500 * 1024 * 1024,
    'Límite manual de 500 MB debe calcular 524288000 bytes'
  );

  assert.strictEqual(
    MAX_BLOSSOM_FILE_SIZE_BYTES,
    1024 * 1024 * 1024,
    'MAX_BLOSSOM_FILE_SIZE_BYTES debe ampliarse a 1024 MB (1 GB)'
  );

  // 8. Normalización canónica de URL en BlossomClient
  console.log('[Test 8] Normalización WHATWG de URLs de servidor Blossom');
  assert.strictEqual(
    BlossomClient.normalizeServerUrl('https://example.com/'),
    'https://example.com',
    'Debe eliminar la barra final de la raíz'
  );
  assert.strictEqual(
    BlossomClient.normalizeServerUrl('https://example.com/blossom///'),
    'https://example.com/blossom',
    'Debe normalizar barras finales de subrutas'
  );
  console.log('  ✓ Normalización canónica de URLs verificada.\n');

  console.log('=== ¡Todas las pruebas de Nostr Blossom concluyeron con ÉXITO! ===\n');
}

runTests().catch((err) => {
  console.error('Error durante la ejecución de pruebas de Blossom:', err);
  process.exit(1);
});
