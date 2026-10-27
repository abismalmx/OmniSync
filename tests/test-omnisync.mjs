/**
 * OmniSync - Core Module Test Suite
 *
 * Tests:
 * 1. DiffMergeEngine (3-Way Merge, orthogonal edits, conflict markers)
 * 2. ManifestCalculator (Deltas, renames, additions, deletions)
 *
 * A diferencia de una reimplementacion local, este fichero importa y ejercita
 * los modulos reales del plugin: una regresion en `src/` rompe la suite.
 *
 * Los modulos usados son TypeScript puro sin dependencias de Obsidian, por lo
 * que se transpilan con esbuild antes de ejecutarse.
 */

import assert from 'node:assert';
import { build } from 'esbuild';

/**
 * Compila un modulo TypeScript del proyecto a un bundle ESM en memoria y lo
 * importa. `external` evita resolver el API de Obsidian, que solo esta
 * disponible dentro de la app.
 */
async function importProjectModule(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'warning',
    external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(dataUrl);
}

// 1. Test DiffMergeEngine logic
console.log('--- Testing 3-Way Merge Engine ---');
const { DiffMergeEngine } = await importProjectModule('src/sync/diff-merge.ts');

// Merge Test 1: Identical versions
const m1 = DiffMergeEngine.threeWayMerge('base', 'base', 'base');
assert.strictEqual(m1.hasConflicts, false);
assert.strictEqual(m1.mergedText, 'base');
console.log('PASS Merge Test 1: Identical versions');

// Merge Test 2: Local change only
const m2 = DiffMergeEngine.threeWayMerge('Line 1\nLine 2', 'Line 1 edited\nLine 2', 'Line 1\nLine 2');
assert.strictEqual(m2.hasConflicts, false);
assert.strictEqual(m2.mergedText, 'Line 1 edited\nLine 2');
console.log('PASS Merge Test 2: Single-side edit');

// Merge Test 3: Remote change only
const m3 = DiffMergeEngine.threeWayMerge('Line 1\nLine 2', 'Line 1\nLine 2', 'Line 1 remote\nLine 2');
assert.strictEqual(m3.hasConflicts, false);
assert.strictEqual(m3.mergedText, 'Line 1 remote\nLine 2');
console.log('PASS Merge Test 3: Remote-side edit');

// Merge Test 4: Concurrent conflict
const m4 = DiffMergeEngine.threeWayMerge('Line 1', 'Line 1 Local', 'Line 1 Remote');
assert.strictEqual(m4.hasConflicts, true);
assert(m4.mergedText.includes('<<<<<<< LOCAL'));
assert(m4.mergedText.includes('======='));
assert(m4.mergedText.includes('>>>>>>> REMOTE'));
assert.strictEqual(m4.conflictingHunksCount, 1);
console.log('PASS Merge Test 4: Conflict markers generated cleanly');

// Merge Test 5: Orthogonal edits on different lines merge without conflict
const m5 = DiffMergeEngine.threeWayMerge('A\nB\nC', 'A-local\nB\nC', 'A\nB\nC-remote');
assert.strictEqual(m5.hasConflicts, false);
assert.strictEqual(m5.mergedText, 'A-local\nB\nC-remote');
console.log('PASS Merge Test 5: Orthogonal edits merged without conflict');

// Merge Test 6: Identical concurrent edits are not a conflict
const m6 = DiffMergeEngine.threeWayMerge('A', 'A-same', 'A-same');
assert.strictEqual(m6.hasConflicts, false);
assert.strictEqual(m6.mergedText, 'A-same');
console.log('PASS Merge Test 6: Identical concurrent edits are not a conflict');

// 2. Test ManifestCalculator
console.log('\n--- Testing Manifest Delta Engine ---');
const { ManifestCalculator } = await importProjectModule('src/sync/manifest-calc.ts');

const entry = (path, hash, mtime, size = 10) => ({
  path,
  hash,
  mtime,
  size,
  isBinary: false,
});

const localManifest = {
  deviceId: 'dev-local',
  timestamp: 1000,
  files: {
    'igual.md': entry('igual.md', 'a'.repeat(64), 100),
    'solo-local.md': entry('solo-local.md', 'b'.repeat(64), 100),
    'nuevo-local.md': entry('nuevo-local.md', 'c'.repeat(64), 100),
  },
  isLocked: false,
};
const remoteManifest = {
  deviceId: 'dev-remote',
  timestamp: 1000,
  files: {
    'igual.md': entry('igual.md', 'a'.repeat(64), 100),
    'solo-remoto.md': entry('solo-remoto.md', 'd'.repeat(64), 100),
    'nuevo-remoto.md': entry('nuevo-remoto.md', 'e'.repeat(64), 100),
  },
  isLocked: false,
};

const delta = ManifestCalculator.computeDelta(localManifest, remoteManifest);
assert.ok(delta.toUpload.includes('solo-local.md'), 'El archivo solo local debe subirse');
assert.ok(delta.toUpload.includes('nuevo-local.md'), 'El archivo nuevo local debe subirse');
assert.ok(delta.toDownload.includes('solo-remoto.md'), 'El archivo solo remoto debe descargarse');
assert.ok(delta.toDownload.includes('nuevo-remoto.md'), 'El archivo nuevo remoto debe descargarse');
assert.ok(!delta.toUpload.includes('igual.md'), 'El archivo identico no debe transferirse');
assert.strictEqual(delta.conflicts.length, 0, 'No debe haber conflictos sin ancestro');
console.log('PASS Manifest Test 1: Deltas calculated correctly');

// Manifest Test 2: conflicts are detected when both sides changed the same file
const conflictLocal = {
  deviceId: 'dev-local',
  timestamp: 1000,
  files: { 'nota.md': entry('nota.md', 'f'.repeat(64), 200) },
  isLocked: false,
};
const conflictRemote = {
  deviceId: 'dev-remote',
  timestamp: 1000,
  files: { 'nota.md': entry('nota.md', '0'.repeat(64), 200) },
  isLocked: false,
};
const conflictDelta = ManifestCalculator.computeDelta(conflictLocal, conflictRemote);
assert.ok(conflictDelta.conflicts.includes('nota.md'), 'El cambio simultaneo debe ser conflicto');
console.log('PASS Manifest Test 2: Simultaneous change flagged as conflict');

// Manifest Test 3: rename detection by hash matching
const renames = ManifestCalculator.detectRenames(
  [entry('nuevo-nombre.md', 'a'.repeat(64), 100)],
  [entry('viejo-nombre.md', 'a'.repeat(64), 100)]
);
assert.strictEqual(renames.length, 1);
assert.strictEqual(renames[0].oldPath, 'viejo-nombre.md');
assert.strictEqual(renames[0].newPath, 'nuevo-nombre.md');
console.log('PASS Manifest Test 3: Rename detected by hash matching');

// 3. Test Cryptography
console.log('\n--- Testing Crypto Engine (Web Crypto API) ---');
async function testCrypto() {
  const subtle = globalThis.crypto.subtle;

  // SHA-256 test
  const data = new TextEncoder().encode('Hello OmniSync');
  const digest = await subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  assert.strictEqual(hashHex.length, 64);
  console.log('PASS Crypto Test 1: SHA-256 digest generated');

  // AES-256-GCM test
  const rawKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(rawKey);
  const key = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode('Private note secret content');

  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  assert(ciphertext.byteLength > plaintext.byteLength);

  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const decryptedText = new TextDecoder().decode(decrypted);
  assert.strictEqual(decryptedText, 'Private note secret content');
  console.log('PASS Crypto Test 2: AES-256-GCM round-trip verified');

  // HMAC Auth Token test
  const hmacKey = await subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const challenge = 'random-challenge-12345';
  const sig = await subtle.sign('HMAC', hmacKey, new TextEncoder().encode(challenge));
  const valid = await subtle.verify('HMAC', hmacKey, sig, new TextEncoder().encode(challenge));
  assert.strictEqual(valid, true);
  console.log('PASS Crypto Test 3: HMAC mutual authentication verified');
}

await testCrypto();

console.log('\n========================================');
console.log('ALL AUTOMATED TESTS PASSED SUCCESSFULLY!');
console.log('========================================');
