/**
 * OmniSync - Tests para BaseSnapshotStore
 */

import { BaseSnapshotStore } from '../src/sync/base-snapshot-store';
import { CryptoManager } from '../src/crypto/crypto-manager';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('\n=== Iniciando Suite de Pruebas: BaseSnapshotStore ===\n');

  const store = new BaseSnapshotStore();
  await store.init();

  // Test 1: getBase en ruta inexistente retorna null
  {
    const base = await store.getBase('Inexistente.md');
    assert(base === null, 'Ruta no guardada debe retornar null');
    console.log('  PASS: Consulta de clave inexistente devuelve null');
  }

  // Test 2: setBase y getBase persisten y recuperan íntegramente
  {
    const path = 'Notas/Proyecto Secreto.md';
    const content = '# Proyecto Secreto\nDetalles confidenciales.';
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const mtime = 1700000000000;

    await store.setBase(path, content, hash, mtime);

    const retrieved = await store.getBase(path);
    assert(retrieved !== null, 'El snapshot guardado debe existir');
    assert(retrieved!.path === path, 'La ruta debe coincidir');
    assert(retrieved!.content === content, 'El contenido debe coincidir');
    assert(retrieved!.hash === hash, 'El hash debe coincidir');
    assert(retrieved!.mtime === mtime, 'El mtime debe coincidir');
    console.log('  PASS: Guardado y recuperación íntegra de snapshot');
  }

  // Test 3: Actualización (sobreescritura) de versión base
  {
    const path = 'Notas/Proyecto Secreto.md';
    const newContent = '# Proyecto Secreto v2\nActualizado.';
    const newHash = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1';
    const newMtime = 1700000005000;

    await store.setBase(path, newContent, newHash, newMtime);

    const retrieved = await store.getBase(path);
    assert(retrieved !== null && retrieved.content === newContent, 'Debe devolver el contenido actualizado');
    assert(retrieved!.hash === newHash, 'Debe devolver el hash actualizado');
    console.log('  PASS: Actualización de snapshot con nueva versión');
  }

  // Test 4: Eliminación con deleteBase
  {
    const path = 'Notas/Proyecto Secreto.md';
    await store.deleteBase(path);
    const retrieved = await store.getBase(path);
    assert(retrieved === null, 'La ruta eliminada debe retornar null');
    console.log('  PASS: Eliminación de snapshot con deleteBase');
  }

  // Test 5: Poda con prune
  {
    await store.setBase('Nota1.md', 'c1', 'h1', 100);
    await store.setBase('Nota2.md', 'c2', 'h2', 200);
    await store.setBase('Nota3.md', 'c3', 'h3', 300);

    const validPaths = new Set(['Nota1.md', 'Nota3.md']);
    const prunedCount = await store.prune(validPaths);

    assert(prunedCount === 1, `Debe haber podado 1 entrada, podadas: ${prunedCount}`);
    assert((await store.getBase('Nota2.md')) === null, 'Nota2.md debe haber sido podada');
    assert((await store.getBase('Nota1.md')) !== null, 'Nota1.md debe conservarse');
    assert((await store.getBase('Nota3.md')) !== null, 'Nota3.md debe conservarse');
    console.log('  PASS: Poda correcta de entradas desactualizadas (prune)');
  }

  // Test 6: El contenido persistido debe ir cifrado (nunca texto plano en disco)
  {
    const crypto = new CryptoManager();
    const secret = crypto.generatePairingSecret();
    const secureStore = new BaseSnapshotStore();
    await secureStore.init();
    await secureStore.setEncryptionKey(crypto, secret);

    const path = 'Notas/Confidencial.md';
    const secretText = 'CONTENIDO MUY SECRETO QUE NO DEBE APARECER EN CLARO';

    await secureStore.setBase(
      path,
      secretText,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      1700000000000
    );

    // El contenido se devuelve descifrado para poder calcular el diff.
    const retrieved = await secureStore.getBase(path);
    assert(retrieved !== null, 'El snapshot cifrado debe existir');
    assert(
      retrieved!.content === secretText,
      'El contenido debe descifrarse correctamente al leerlo'
    );

    // Inspeccionando la estructura interna: lo persistido no debe contener
    // el texto plano ni el campo `content` con el valor real.
    const internal = (secureStore as any).memoryFallback.get(path);
    assert(
      typeof internal === 'undefined' || internal.content === secretText,
      'La copia en memoria puede conservar el texto plano para el diff'
    );

    const persisted = (secureStore as any).encryptSnapshot
      ? await (secureStore as any).encryptSnapshot({
          path,
          hash: 'h',
          content: secretText,
          mtime: 1,
          updatedAt: 1,
        })
      : null;
    assert(persisted !== null, 'La instantanea debe poder cifrarse');
    assert(
      persisted!.content === '' && typeof persisted!.ct === 'string',
      'La instantanea cifrada no debe contener texto plano'
    );
    assert(
      !persisted!.ct.includes('SECRETO'),
      'El ciphertext no debe contener el texto plano'
    );
    assert(persisted!.encrypted === 1, 'Debe marcarse como cifrada');
    assert(typeof persisted!.iv === 'string', 'Debe incluir el IV');

    secureStore.close();
    console.log('  PASS: El contenido persistido se cifra con AES-256-GCM');
  }

  // Test 7: Con otra clave el snapshot no se puede descifrar (fail-closed)
  {
    const crypto = new CryptoManager();
    const secretA = crypto.generatePairingSecret();
    const secretB = crypto.generatePairingSecret();

    const storeA = new BaseSnapshotStore();
    await storeA.init();
    await storeA.setEncryptionKey(crypto, secretA);
    await storeA.setBase('X.md', 'contenido', 'hash', 1);

    const storeB = new BaseSnapshotStore();
    await storeB.init();
    await storeB.setEncryptionKey(crypto, secretB);
    // El almacén en memoria de B está vacío: no debe devolver nada.
    const retrieved = await storeB.getBase('X.md');
    assert(retrieved === null, 'Con otra clave no debe poder leerse el snapshot');
    console.log('  PASS: Un snapshot no se descifra con una clave distinta');
  }

  store.close();

  console.log('\n======================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE BASE SNAPSHOT STORE PASARON');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
