/**
 * OmniSync - Regresiones de bug_hunter (cripto round-trip, límites, limitador)
 */
import { CryptoManager, MAX_ENCRYPTED_PAYLOAD_BYTES } from '../src/crypto/crypto-manager';
import { NostrMailbox, MAX_DELTA_TOTAL_SIZE } from '../src/network/nostr-mailbox';
import { ManifestCalculator } from '../src/sync/manifest-calc';
import { VaultManifest } from '../src/types';
import { VaultWatcher } from '../src/sync/vault-watcher';
import { TFile } from 'obsidian';
import { DiffMergeEngine } from '../src/sync/diff-merge';
import { ConcurrencyLimiter } from '../src/security/concurrency-limiter';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

type Behavior = 'eose' | 'error';

function installMockWebSocket(behavior: () => Behavior): void {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      setTimeout(() => {
        this.onopen?.();
      }, 0);
    }
    send(raw: string) {
      const msg = JSON.parse(raw);
      if (msg[0] !== 'REQ') return;
      setTimeout(() => {
        if (behavior() === 'eose') this.onmessage?.({ data: JSON.stringify(['EOSE', msg[1]]) });
        else this.onerror?.();
      }, 0);
    }
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
}

async function run() {
  const cm = new CryptoManager();
  const key = await cm.deriveAesKey(cm.generatePairingSecret(), 'omnisync-test-context');

  for (const text of ['123', 'true', 'null', '{"a":1}', '[1,2]', '"x"', 'texto normal']) {
    const payload = await cm.encrypt(text, key);
    const out = await cm.decryptText(payload, key);
    assert(out === text, `decryptText debe devolver el string exacto: ${text}`);
  }
  console.log('  PASS: decryptText hace round-trip de strings con forma de JSON');

  const big = 'a'.repeat(MAX_ENCRYPTED_PAYLOAD_BYTES);
  const payload = await cm.encrypt(big, key);
  const back = await cm.decryptText(payload, key);
  assert(back.length === big.length, 'todo payload cifrable debe poder descifrarse');
  console.log('  PASS: límite de encrypt y decrypt alineados');

  const limiter = new ConcurrencyLimiter(1);
  let active = 0;
  let max = 0;
  const task = async () => {
    active++;
    max = Math.max(max, active);
    await Promise.resolve();
    await Promise.resolve();
    active--;
  };
  const first = limiter.run(task);
  const second = limiter.run(task);
  queueMicrotask(() => queueMicrotask(() => void limiter.run(task)));
  await Promise.all([first, second]);
  await new Promise((r) => setTimeout(r, 10));
  assert(max === 1, `el limitador no debe superar el límite (máx ${max})`);
  console.log('  PASS: ConcurrencyLimiter respeta el límite');

  const cm2 = new CryptoManager();
  const secret = cm2.generatePairingSecret();
  const mailboxKey = await cm2.deriveAesKey(secret);
  let mode: Behavior = 'error';
  installMockWebSocket(() => mode);
  const mailbox = new NostrMailbox('wss://relay.invalid', 'room', 'dev-a', secret, cm2);
  mailbox.setCryptoKey(mailboxKey);
  await mailbox.fetchPendingNotes(0);
  assert(mailbox.lastFetchComplete === false, 'un fallo del relay no debe marcarse como consulta completa');
  mode = 'eose';
  await mailbox.fetchPendingNotes(0);
  assert(mailbox.lastFetchComplete === true, 'EOSE debe marcar la consulta como completa');
  console.log('  PASS: fetchPendingNotes distingue fallo del relay de buzón vacío');

  mode = 'error';
  const patch = 'aaa\u{1F600}'.repeat(Math.ceil(MAX_DELTA_TOTAL_SIZE / 7)).slice(0);
  let bytes = new TextEncoder().encode(patch);
  while (bytes.length > MAX_DELTA_TOTAL_SIZE) {
    bytes = bytes.slice(0, bytes.length - 1);
  }
  const exact = new TextDecoder().decode(bytes);
  const res = await mailbox.publishDeltaPatch('n.md', 'h1', 'h2', exact, Date.now());
  assert(!String(res.reason ?? '').includes('fragmentos'), `un parche dentro del límite no debe exigir más fragmentos: ${res.reason}`);
  console.log('  PASS: parche delta en el límite no excede el número de fragmentos');

  const entry = (path: string, mtime: number, hash: string, deleted = false) => ({
    path, mtime, size: 1, hash, isBinary: false, deleted,
  });
  const manifest = (files: Record<string, ReturnType<typeof entry>>): VaultManifest => ({
    deviceId: 'dev', timestamp: Date.now(), files,
  });
  const H1 = 'a'.repeat(64);
  const H0 = '0'.repeat(64);
  let d = ManifestCalculator.computeDelta(
    manifest({ 'x.md': entry('x.md', 100, H1) }),
    manifest({ 'x.md': entry('x.md', 200, H0, true) })
  );
  assert(d.toDelete.includes('x.md') && !d.toUpload.includes('x.md'), 'lápida remota más nueva borra la copia local');
  d = ManifestCalculator.computeDelta(
    manifest({ 'x.md': entry('x.md', 300, H1) }),
    manifest({ 'x.md': entry('x.md', 200, H0, true) })
  );
  assert(d.toUpload.includes('x.md') && d.toDelete.length === 0, 'una edición local posterior a la lápida gana');
  d = ManifestCalculator.computeDelta(
    manifest({ 'x.md': entry('x.md', 200, H0, true) }),
    manifest({ 'x.md': entry('x.md', 100, H1) })
  );
  assert(d.toUpload.length === 0 && d.toDownload.length === 0 && d.toDelete.length === 0, 'con lápida local el archivo remoto no se descarga');
  console.log('  PASS: computeDelta aplica lápidas de borrado sin resucitar archivos');

  // BUG-16: una edición del usuario dentro de la ventana de ignorado sí se sincroniza.
  {
    const cm3 = new CryptoManager();
    const file = new TFile();
    file.path = 'nota.md';
    file.basename = 'nota';
    file.extension = 'md';
    file.stat = { mtime: 1, size: 1, ctime: 1 };
    let content = 'contenido remoto';
    const handlers: Record<string, (f: unknown, old?: string) => void> = {};
    const app = {
      vault: {
        on: (evt: string, cb: (f: unknown, old?: string) => void) => { handlers[evt] = cb; return {}; },
        offref: () => {},
        read: async () => content,
      },
      plugins: { plugins: {} },
    } as never;
    const changes: string[] = [];
    const watcher = new VaultWatcher(app, cm3, true, false, {
      onFileChanged: (_p, _e, data) => { changes.push(new TextDecoder().decode(data)); },
      onFileDeleted: () => {},
      onFileRenamed: () => {},
    });
    watcher.registerEvents();
    const remoteHash = await cm3.computeHash(new TextEncoder().encode(content));
    watcher.ignoreNextChange('nota.md', 2000, remoteHash);
    handlers['modify'](file);
    await new Promise((r) => setTimeout(r, 500));
    assert(changes.length === 0, 'el eco de una escritura remota no debe difundirse');
    content = 'contenido remoto + edición del usuario';
    handlers['modify'](file);
    await new Promise((r) => setTimeout(r, 500));
    assert(changes.length === 1 && changes[0] === content, 'una edición del usuario dentro de la ventana debe difundirse');
    watcher.cleanup();
    console.log('  PASS: VaultWatcher distingue el eco remoto de una edición real');
  }

  const crlfBase = 'a\r\nb\r\nc\r\nd\r\ne\r\nf';
  const crlf = DiffMergeEngine.threeWayMerge(crlfBase, 'A\r\nb\r\nc\r\nd\r\ne\r\nf', crlfBase.replace('f', 'F'));
  assert(!crlf.hasConflicts && crlf.mergedText === 'A\r\nb\r\nc\r\nd\r\ne\r\nF', 'la fusión conserva los finales CRLF');
  console.log('  PASS: threeWayMerge conserva CRLF');
}

run().then(() => console.log('\nRegresiones OK'), (e) => { console.error(e); process.exit(1); });
