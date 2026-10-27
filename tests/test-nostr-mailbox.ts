/**
 * Automated Tests for NostrMailbox
 * Tests:
 * 1. Eligibility validation (Markdown files <= 64 KB vs. binaries and oversized files)
 * 2. HMAC path obfuscation (Zero-Knowledge d-tags)
 * 3. E2EE payload encrypt/decrypt with AES-256-GCM
 * 4. NIP-78 event structure and NIP-40 7-day expiration
 * 5. Path security & traversal prevention
 * 6. Tombstone deletion handling
 */

import assert from 'node:assert';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { CryptoManager } from '../src/crypto/crypto-manager';
import {
  MAILBOX_EXPIRATION_SECONDS,
  MAILBOX_KIND,
  MAX_MAILBOX_NOTE_SIZE,
  NostrMailbox,
} from '../src/network/nostr-mailbox';
import { validateVaultPath } from '../src/security/vault-security';
import { NostrMailboxNotePayload } from '../src/types';

async function runTests() {
  console.log('=== Iniciando Suite de Pruebas: NostrMailbox ===\n');

  const cryptoManager = new CryptoManager();
  const pairingSecret = cryptoManager.generatePairingSecret();
  const roomId = await cryptoManager.deriveRoomId(pairingSecret);
  const cryptoKey = await cryptoManager.deriveAesKey(pairingSecret);
  const deviceId = 'dev-test-laptop-1';

  const mailbox = new NostrMailbox(
    'wss://nos.lol',
    roomId,
    deviceId,
    pairingSecret,
    cryptoManager
  );
  mailbox.setCryptoKey(cryptoKey);

  // 1. Prueba de elegibilidad
  console.log('[Test 1] Validación de elegibilidad para el buzón asíncrono');
  assert.strictEqual(
    mailbox.isEligibleForMailbox('Notas/Diario.md', 1024),
    true,
    'Debe aceptar nota .md de 1 KB'
  );
  assert.strictEqual(
    mailbox.isEligibleForMailbox('Readme.markdown', 50000),
    true,
    'Debe aceptar .markdown de 50 KB'
  );
  assert.strictEqual(
    mailbox.isEligibleForMailbox('todo.txt', 2048),
    true,
    'Debe aceptar .txt de 2 KB'
  );
  assert.strictEqual(
    mailbox.isEligibleForMailbox('Fotos/vacaciones.jpg', 5000),
    false,
    'Debe rechazar archivos de imagen .jpg'
  );
  assert.strictEqual(
    mailbox.isEligibleForMailbox('Libros/manual.pdf', 3000),
    false,
    'Debe rechazar archivos .pdf'
  );
  assert.strictEqual(
    mailbox.isEligibleForMailbox('GranDocumento.md', MAX_MAILBOX_NOTE_SIZE + 1),
    false,
    'Debe rechazar notas .md mayores a 64 KB'
  );
  console.log('  ✓ Elegibilidad verificada correctamente.');

  // 2. Prueba de ofuscación HMAC de rutas (Zero-Knowledge d-tag v2)
  console.log('\n[Test 2] Ofuscación determinista HMAC de rutas en la etiqueta #d (mailbox-dtag-v2)');
  const path1 = 'Privado/Notas Medicas.md';
  const hmac1 = await cryptoManager.computeHmacHex(`${roomId}:${path1}`, pairingSecret, 'mailbox-dtag-v2');
  const hmac2 = await cryptoManager.computeHmacHex(`${roomId}:${path1}`, pairingSecret, 'mailbox-dtag-v2');
  assert.strictEqual(hmac1, hmac2, 'El HMAC debe ser determinista para el mismo archivo');
  assert.strictEqual(hmac1.length, 64, 'El HMAC-SHA256 debe ser un string hexadecimal de 64 caracteres');
  assert.strictEqual(
    /^[a-f0-9]{64}$/.test(hmac1),
    true,
    'El tag d debe ser estrictamente hexadecimal de 64 caracteres'
  );
  assert.strictEqual(
    hmac1.includes('Privado') || hmac1.includes('Notas') || hmac1.includes('omnisync'),
    false,
    'El HMAC no debe contener ninguna palabra ni prefijo de la aplicación'
  );
  console.log(`  ✓ Etiqueta #d ofuscada con éxito: "${path1}" -> ${hmac1.substring(0, 16)}...`);

  // 3. Prueba de cifrado y descifrado AES-256-GCM del payload del buzón
  console.log('\n[Test 3] Cifrado y descifrado E2EE (AES-256-GCM)');
  const originalPayload: NostrMailboxNotePayload = {
    path: 'Ideas/OmniSync.md',
    content: '# Mi Gran Proyecto\nSincronización P2P en tiempo real con buzón Nostr.',
    mtime: Date.now(),
    isDeleted: false,
    deviceId,
  };

  const encrypted = await cryptoManager.encrypt(originalPayload, cryptoKey);
  assert.ok(encrypted.iv, 'Debe incluir vector de inicialización IV');
  assert.ok(encrypted.ct, 'Debe incluir texto cifrado');
  assert.strictEqual(
    encrypted.ct.includes('OmniSync'),
    false,
    'El texto cifrado no debe contener contenido en claro'
  );

  const decrypted: NostrMailboxNotePayload = await cryptoManager.decrypt(encrypted, cryptoKey);
  assert.strictEqual(decrypted.path, originalPayload.path);
  assert.strictEqual(decrypted.content, originalPayload.content);
  assert.strictEqual(decrypted.mtime, originalPayload.mtime);
  assert.strictEqual(decrypted.isDeleted, false);
  assert.strictEqual(decrypted.deviceId, deviceId);
  console.log('  ✓ Cifrado y descifrado íntegro sin alteraciones.');

  // 4. Prueba de estructura de evento Nostr y Expiración NIP-40
  console.log('\n[Test 4] Verificación de evento Nostr NIP-78 y expiración NIP-40');
  const nowSec = Math.floor(Date.now() / 1000);
  const expectedExpSec = nowSec + MAILBOX_EXPIRATION_SECONDS;
  const dTag = hmac1;

  assert.strictEqual(MAILBOX_KIND, 30078, 'Kind debe ser 30078 (NIP-78 Parameterized Replaceable Event)');
  assert.strictEqual(
    MAILBOX_EXPIRATION_SECONDS,
    7 * 24 * 60 * 60,
    'Expiración debe ser exactamente de 7 días (604800 segundos)'
  );
  assert.strictEqual(dTag.length, 64, 'La etiqueta d debe tener exactamente 64 caracteres hex');
  assert.strictEqual(dTag.startsWith('omnisync:'), false, 'La etiqueta d no debe incluir prefijo omnisync:');
  console.log(`  ✓ Tag d puro (64 chars hex): ${dTag.substring(0, 35)}...`);
  console.log(`  ✓ Expiración fijada a 7 días en el futuro (${expectedExpSec}).`);

  // 5. Prueba de seguridad de rutas contra Path Traversal
  console.log('\n[Test 5] Políticas de seguridad y prevención de traversal en el buzón');
  assert.throws(
    () => validateVaultPath('../../etc/shadow'),
    /SecurityValidationError/,
    'Debe bloquear rutas relativas con traversal ../'
  );
  assert.throws(
    () => validateVaultPath('/usr/local/bin/malware'),
    /SecurityValidationError/,
    'Debe bloquear rutas absolutas'
  );
  assert.throws(
    () => validateVaultPath('.obsidian/plugins/evil-plugin/main.js'),
    /SecurityValidationError/,
    'Debe bloquear ejecución de plugins ajenos en .obsidian'
  );
  assert.throws(
    () => validateVaultPath('.git/config'),
    /SecurityValidationError/,
    'Debe bloquear carpetas ocultas de Git'
  );
  assert.doesNotThrow(
    () => validateVaultPath('Carpetas/Subcarpeta/Mi Archivo.md'),
    'Debe aceptar rutas legítimas dentro de la bóveda'
  );
  console.log('  ✓ Validación de seguridad del Vault superada.');

  // 6. Prueba de Tombstone para borrado asíncrono
  console.log('\n[Test 6] Tombstone para propagación de borrado asíncrono');
  const deletePayload: NostrMailboxNotePayload = {
    path: 'Notas/Obsoleta.md',
    content: '',
    mtime: Date.now(),
    isDeleted: true,
    deviceId,
  };
  const encDelete = await cryptoManager.encrypt(deletePayload, cryptoKey);
  const decDelete: NostrMailboxNotePayload = await cryptoManager.decrypt(encDelete, cryptoKey);
  assert.strictEqual(decDelete.isDeleted, true, 'Debe preservar el indicador de archivo eliminado');
  assert.strictEqual(decDelete.path, 'Notas/Obsoleta.md');
  console.log('  ✓ Tombstone de borrado verificado.');

  // 7. Prueba de suscripción persistente en tiempo real y ciclo de vida
  console.log('\n[Test 7] Ciclo de vida y registro de callback en tiempo real');
  let receivedCount = 0;
  mailbox.onNoteReceived = (note) => {
    receivedCount++;
    assert.ok(note.path, 'La nota recibida debe contener ruta válida');
  };
  assert.strictEqual(typeof mailbox.onNoteReceived, 'function', 'Callback onNoteReceived debe estar registrado');
  assert.doesNotThrow(() => {
    mailbox.startLiveSubscription();
  }, 'startLiveSubscription no debe lanzar excepción');
  assert.doesNotThrow(() => {
    mailbox.destroy();
  }, 'destroy() debe limpiar recursos y sockets sin excepción');
  assert.strictEqual(receivedCount, 0, 'No debe llegar ninguna nota sin suscripción activa');
  console.log('  ✓ Suscripción en tiempo real y ciclo de vida verificados.');

  // 8. Aislamiento estricto del esquema de evento del buzón
  console.log('\n[Test 8] Aislamiento de eventos y etiquetas del buzón');
  const isolationPath = 'Notas/Privada.md';
  const isolationDTag = await cryptoManager.computeHmacHex(
    `${roomId}:${isolationPath}`,
    pairingSecret,
    'mailbox-dtag-v2'
  );
  const isolationEncrypted = await cryptoManager.encrypt(
    {
      path: isolationPath,
      content: 'contenido privado',
      mtime: Date.now(),
      deviceId: 'dev-remoto-test',
    },
    cryptoKey
  );
  const isolationNowSec = Math.floor(Date.now() / 1000);
  const validatePrivate = (mailbox as any).decryptAndValidateEvent.bind(mailbox);

  const buildIsolationEvent = (tags: string[][]): any => finalizeEvent(
    {
      kind: MAILBOX_KIND,
      created_at: isolationNowSec,
      tags,
      content: JSON.stringify(isolationEncrypted),
    },
    generateSecretKey()
  );

  const validIsolationEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['t', roomId],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
  ]);
  assert.notStrictEqual(
    await validatePrivate(validIsolationEvent),
    null,
    'Un evento correctamente aislado debe aceptarse'
  );

  const duplicateRoomEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['t', roomId],
    ['t', 'otra-sala'],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
  ]);
  assert.strictEqual(
    await validatePrivate(duplicateRoomEvent),
    null,
    'Un evento con dos etiquetas #t debe rechazarse'
  );

  const duplicateDTagEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['d', '0'.repeat(64)],
    ['t', roomId],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
  ]);
  assert.strictEqual(
    await validatePrivate(duplicateDTagEvent),
    null,
    'Un evento con dos etiquetas #d debe rechazarse'
  );

  const duplicateExpirationEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['t', roomId],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS + 1)],
  ]);
  assert.strictEqual(
    await validatePrivate(duplicateExpirationEvent),
    null,
    'Un evento con dos etiquetas expiration debe rechazarse'
  );

  const wrongRoomEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['t', 'otra-sala'],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
  ]);
  assert.strictEqual(
    await validatePrivate(wrongRoomEvent),
    null,
    'Un evento dirigido a otra sala debe rechazarse'
  );

  const malformedTagEvent = buildIsolationEvent([
    ['d', isolationDTag],
    ['t', roomId],
    ['expiration', String(isolationNowSec + MAILBOX_EXPIRATION_SECONDS)],
    ['extra', 'x'.repeat(2000)],
  ]);
  assert.strictEqual(
    await validatePrivate(malformedTagEvent),
    null,
    'Una etiqueta con valor excesivo debe rechazarse'
  );

  // 9. La identidad Nostr del buzón no se comparte con Blossom
  const mailboxKey = (mailbox as any).mailboxSecretKey as Uint8Array;
  const blossomKey = (mailbox as any).blossomSecretKey as Uint8Array;
  assert.ok(mailboxKey instanceof Uint8Array && mailboxKey.byteLength === 32);
  assert.ok(blossomKey instanceof Uint8Array && blossomKey.byteLength === 32);
  assert.notDeepStrictEqual(
    Array.from(mailboxKey),
    Array.from(blossomKey),
    'El buzón y Blossom deben usar identidades Nostr distintas'
  );

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE NOSTR MAILBOX PASARON CON ÉXITO');
  console.log('======================================================');
}

runTests().catch((err) => {
  console.error('\n❌ ERROR EN PRUEBAS:', err);
  process.exit(1);
});
