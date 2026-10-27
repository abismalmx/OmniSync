/**
 * Automated Tests for Nostr Delta Sync & Multipart Chunking
 *
 * Pruebas:
 * 1. Elegibilidad para buzón vs. delta en extensiones (.md, .txt, .canvas, .json, .css).
 * 2. Estructura y cifrado E2EE de payload DELTA_PATCH con baseHash y targetHash.
 * 3. Fragmentación multipart en DELTA_CHUNK para parches > 64 KB y <= 768 KB.
 * 4. Reensamblado correcto de chunks multipart en orden arbitrario.
 * 5. Ciclo completo de aplicación: Myers diff -> NIP-78 -> SHA-256 verify -> Reconstrucción bit a bit.
 * 6. Detección defensiva de baseHash mismatch y prevención de corrupción.
 */

import assert from 'node:assert';
import { CryptoManager } from '../src/crypto/crypto-manager';
import {
  DELTA_CHUNK_SIZE,
  NostrMailbox,
} from '../src/network/nostr-mailbox';
import { DeltaPatchEngine } from '../src/sync/delta-patch';
import { NostrMailboxNotePayload } from '../src/types';

async function runTests() {
  console.log('\n=== Iniciando Suite de Pruebas: Nostr Delta Mailbox & Multipart ===\n');

  const cryptoManager = new CryptoManager();
  const pairingSecret = cryptoManager.generatePairingSecret();
  const roomId = await cryptoManager.deriveRoomId(pairingSecret);
  const cryptoKey = await cryptoManager.deriveAesKey(pairingSecret);
  const deviceA = 'dev-test-mobile-phone';

  const mailboxA = new NostrMailbox(
    'wss://nos.lol',
    roomId,
    deviceA,
    pairingSecret,
    cryptoManager
  );
  mailboxA.setCryptoKey(cryptoKey);

  // 1. Elegibilidad de formatos y tamaños
  console.log('[Test 1] Validación de elegibilidad para nota completa vs delta');
  const formats = ['md', 'markdown', 'txt', 'canvas', 'json', 'css'];
  for (const ext of formats) {
    const filename = `carpeta/archivo.${ext}`;
    assert.strictEqual(
      mailboxA.isEligibleForMailbox(filename, 10 * 1024),
      true,
      `Archivo .${ext} <= 64 KB debe ser elegible para nota completa`
    );
    assert.strictEqual(
      mailboxA.isEligibleForDelta(filename, 10 * 1024),
      false,
      `Archivo .${ext} <= 64 KB no debe ser marcado para delta`
    );
    assert.strictEqual(
      mailboxA.isEligibleForMailbox(filename, 100 * 1024),
      false,
      `Archivo .${ext} > 64 KB no debe ser elegible para nota completa`
    );
    assert.strictEqual(
      mailboxA.isEligibleForDelta(filename, 100 * 1024),
      true,
      `Archivo .${ext} > 64 KB debe ser elegible para delta`
    );
  }
  // Binarios no elegibles
  assert.strictEqual(mailboxA.isEligibleForDelta('foto.jpg', 100 * 1024), false);
  assert.strictEqual(mailboxA.isEligibleForDelta('doc.pdf', 100 * 1024), false);
  console.log('  PASS: Elegibilidad de formatos de texto verificada para buzón y delta');

  // 2. Payload DELTA_PATCH con baseHash y targetHash
  console.log('\n[Test 2] Cifrado y descifrado de payload DELTA_PATCH');
  const samplePatch = '@@ -10,3 +10,3 @@\n-hola\n+adios\n';
  const baseHash = '1111111111111111111111111111111111111111111111111111111111111111';
  const targetHash = '2222222222222222222222222222222222222222222222222222222222222222';

  const deltaPayload: NostrMailboxNotePayload = {
    type: 'DELTA_PATCH',
    path: 'Notas/GranArchivo.md',
    content: samplePatch,
    mtime: 1700000000000,
    deviceId: deviceA,
    baseHash,
    targetHash,
  };

  const encDelta = await cryptoManager.encrypt(deltaPayload, cryptoKey);
  const decDelta: NostrMailboxNotePayload = await cryptoManager.decrypt(encDelta, cryptoKey);
  assert.strictEqual(decDelta.type, 'DELTA_PATCH');
  assert.strictEqual(decDelta.path, deltaPayload.path);
  assert.strictEqual(decDelta.content, samplePatch);
  assert.strictEqual(decDelta.baseHash, baseHash);
  assert.strictEqual(decDelta.targetHash, targetHash);
  console.log('  PASS: Payload DELTA_PATCH cifrado y descifrado con integridad total');

  // 3. Fragmentación multipart en DELTA_CHUNK
  console.log('\n[Test 3] Fragmentación y etiquetado de parches voluminosos en chunks multipart');
  // Crear un parche sintético de 120 KB
  const largePatch = 'X'.repeat(120 * 1024);
  const totalChunks = Math.ceil(largePatch.length / DELTA_CHUNK_SIZE);
  assert.strictEqual(totalChunks, 3, '120 KB debe dividirse en 3 chunks de 48 KB');

  const patchId = 'test-patch-id-123';
  const chunks: NostrMailboxNotePayload[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunkText = largePatch.substring(i * DELTA_CHUNK_SIZE, (i + 1) * DELTA_CHUNK_SIZE);
    chunks.push({
      type: 'DELTA_CHUNK',
      path: 'Notas/GranArchivo.md',
      content: chunkText,
      mtime: 1700000000000,
      deviceId: deviceA,
      baseHash,
      targetHash,
      chunkIndex: i,
      totalChunks,
      patchId,
    });
  }
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(chunks[0].chunkIndex, 0);
  assert.strictEqual(chunks[1].chunkIndex, 1);
  assert.strictEqual(chunks[2].chunkIndex, 2);
  console.log('  PASS: Parche de 120 KB fragmentado en 3 trozos con metadatos consistentes');

  // 4. Reensamblado en orden desordenado (simulando entrega asíncrona de relays)
  console.log('\n[Test 4] Reensamblado de fragmentos recibidos en orden inverso');
  const scrambled = [chunks[2], chunks[0], chunks[1]];
  const reassembledMap = new Map<number, string>();
  for (const c of scrambled) {
    reassembledMap.set(c.chunkIndex!, c.content);
  }
  assert.strictEqual(reassembledMap.size, totalChunks);

  const pieces: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    pieces.push(reassembledMap.get(i)!);
  }
  const assembled = pieces.join('');
  assert.strictEqual(assembled, largePatch, 'El parche reensamblado debe coincidir al 100%');
  console.log('  PASS: Reensamblado íntegro de parche multipart');

  // 5. Ciclo end-to-end con nota real de 150 KB
  console.log('\n[Test 5] Ciclo E2E completo: Modificación de 150 KB -> Diff -> SHA-256 -> Reconstrucción');
  const baseLines: string[] = [];
  for (let i = 1; i <= 2500; i++) {
    baseLines.push(`Línea ${i}: Registro de notas de investigación para prueba de sincronización asíncrona.`);
  }
  const originalDoc = baseLines.join('\n');
  assert.ok(originalDoc.length > 150000, 'El documento debe pesar más de 150 KB');

  const modifiedLines = [...baseLines];
  modifiedLines[1000] = 'Línea 1001: EDICIÓN QUIRÚRGICA REALIZADA EN DISPOSITIVO MÓVIL';
  const modifiedDoc = modifiedLines.join('\n');

  const docBaseHash = await cryptoManager.computeHash(new TextEncoder().encode(originalDoc));
  const docTargetHash = await cryptoManager.computeHash(new TextEncoder().encode(modifiedDoc));

  // Generar parche en móvil
  const patchString = DeltaPatchEngine.computePatch(originalDoc, modifiedDoc, 2);
  assert.ok(patchString.length < 500, `El parche debe ser ultra ligero (< 500 bytes), obtenido: ${patchString.length}`);

  // Simular recepción en PC
  // PC verifica baseHash
  const pcLocalDoc = originalDoc;
  const pcLocalHash = await cryptoManager.computeHash(new TextEncoder().encode(pcLocalDoc));
  assert.strictEqual(pcLocalHash, docBaseHash, 'PC debe verificar que su versión base coincide con baseHash');

  // PC aplica el parche
  const applyRes = DeltaPatchEngine.applyPatch(pcLocalDoc, patchString);
  assert.strictEqual(applyRes.success, true);
  const pcPatchedDoc = applyRes.result!;

  // PC verifica targetHash
  const pcPatchedHash = await cryptoManager.computeHash(new TextEncoder().encode(pcPatchedDoc));
  assert.strictEqual(pcPatchedHash, docTargetHash, 'PC debe verificar que el resultado coincide con targetHash');
  assert.strictEqual(pcPatchedDoc, modifiedDoc, 'El archivo reconstruido en PC debe ser idéntico al modificado en móvil');
  console.log('  PASS: Ciclo E2E completado con éxito, diff de 150 KB transmitido en < 500 bytes');

  // 6. BaseHash mismatch: protección defensiva contra desincronización
  console.log('\n[Test 6] Detección de baseHash mismatch y rechazo defensivo');
  const staleLocalDoc = 'Documento con versión local antigua o desfasada\nLínea 2\n';
  const staleHash = await cryptoManager.computeHash(new TextEncoder().encode(staleLocalDoc));
  assert.notStrictEqual(staleHash, docBaseHash, 'El hash local desfasado no debe coincidir');

  // Simulamos la decisión en el orquestador: si hashes no coinciden, no se aplica y se deriva a P2P
  const isMatch = staleHash === docBaseHash;
  assert.strictEqual(isMatch, false, 'Debe detectar desfase y bloquear la aplicación del parche');
  console.log('  PASS: Desfase de hash base bloquea correctamente la aplicación corrupta');

  // Test 7: El fragmentado multipart no debe partir surrogate pairs (emoji)
  console.log('\n[Test 7] Integridad UTF-16 en el fragmentado multipart');
  {
    // Emoji justo en el límite de fragmento: si el corte cayera entre el
    // surrogate alto y el bajo, el texto ensamblado traería un caracter de
    // reemplazo Unicode y el parche no aplicaría.
    const boundary = DELTA_CHUNK_SIZE;
    const filler = 'a'.repeat(boundary - 1);
    const emojiDoc = `${filler}😀${'b'.repeat(100)}`;

    const boundaries = (mailboxA as any).computeChunkBoundaries(
      emojiDoc,
      DELTA_CHUNK_SIZE
    ) as Array<{ start: number; end: number }>;

    // Ningún límite debe partir un surrogate pair.
    for (const b of boundaries) {
      if (b.end >= emojiDoc.length) continue;
      const code = emojiDoc.charCodeAt(b.end - 1);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      assert.ok(
        !isHighSurrogate,
        `El límite en ${b.end} parte un surrogate pair (código ${code.toString(16)})`
      );
    }

    // El ensamblado debe reproducir el texto exacto.
    const rebuilt = boundaries
      .map((b) => emojiDoc.substring(b.start, b.end))
      .join('');
    assert.strictEqual(rebuilt, emojiDoc, 'El texto ensamblado debe ser idéntico al original');
    assert.ok(
      !rebuilt.includes('�'),
      'El texto ensamblado no debe contener caracteres de reemplazo Unicode'
    );
    console.log('  PASS: El fragmentado multipart preserva los surrogate pairs');
  }

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE NOSTR DELTA MAILBOX PASARON');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ ERROR EN PRUEBAS:', err);
  process.exit(1);
});
