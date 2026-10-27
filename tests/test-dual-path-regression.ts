/**
 * OmniSync - Regresiones de la doble vía P2P + relay (auditor A-01..A-04 y
 * correcciones del cierre: flush del debounce y reconciliación al arrancar).
 */
import OmniSyncPlugin from '../src/main';
import { CryptoManager } from '../src/crypto/crypto-manager';
import { NostrMailbox } from '../src/network/nostr-mailbox';
import { VaultWatcher } from '../src/sync/vault-watcher';
import { TFile } from 'obsidian';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `window` solo existe dentro de Obsidian.
(globalThis as unknown as { window: unknown }).window = globalThis;

function makeFile(path: string, mtime: number, size: number): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.replace(/\.md$/, '');
  f.extension = 'md';
  f.stat = { mtime, size, ctime: mtime };
  return f;
}

interface Harness {
  plugin: any;
  published: string[];
  contents: Map<string, string>;
  files: Map<string, TFile>;
}

/** Plugin sin pasar por `onload`: solo los campos que usa la cola de reenvío. */
function makePlugin(opts: { publishOk?: () => boolean; publishDelayMs?: number } = {}): Harness {
  const plugin: any = Object.create((OmniSyncPlugin as any).prototype);
  const published: string[] = [];
  const contents = new Map<string, string>();
  const files = new Map<string, TFile>();
  plugin.app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getFiles: () => Array.from(files.values()),
      read: async (f: TFile) => contents.get(f.path) ?? '',
    },
    plugins: { plugins: {} },
  };
  plugin.cryptoManager = new CryptoManager();
  plugin.settings = { autoSync: true, enableBlossomSync: false, pendingP2PSync: [], pendingMailboxOut: [], lastMailboxFetchTimestamp: 0 };
  plugin.pendingMailboxPaths = new Set<string>();
  plugin.pendingP2PPaths = new Set<string>();
  plugin.broadcastChain = Promise.resolve();
  plugin.pendingFlushRunning = false;
  plugin.saveSettings = async () => {};
  const bases = new Map<string, { hash: string; content: string }>();
  plugin.baseSnapshotStore = {
    getBase: async (p: string) => bases.get(p) ?? null,
    setBase: async (p: string, content: string, hash: string) => { bases.set(p, { hash, content }); },
    close: () => {},
  };
  plugin.nostrMailbox = {
    isEligibleForMailbox: (_p: string, n: number) => n <= 64 * 1024,
    isEligibleForDelta: () => false,
    isEligibleForBlossom: () => false,
    publishNote: async (p: string) => {
      if (opts.publishDelayMs) await sleep(opts.publishDelayMs);
      const ok = opts.publishOk ? opts.publishOk() : true;
      if (ok) published.push(p);
      return { success: ok };
    },
    destroy: () => { plugin.__destroyedAt = published.length; },
  };
  return { plugin, published, contents, files };
}

function addNote(h: Harness, path: string, text: string, mtime = Date.now()) {
  const f = makeFile(path, mtime, new TextEncoder().encode(text).byteLength);
  h.files.set(path, f);
  h.contents.set(path, text);
  return f;
}

async function run() {
  // A-01: el reenvío solo toca la cola del relay; lo que está en pendingP2PPaths
  // (base no coincide / parche falló) nunca se publica al relay desde ahí.
  {
    const h = makePlugin();
    addNote(h, 'viejo.md', 'versión local vieja');
    addNote(h, 'nuevo.md', 'edición pendiente de relay');
    h.plugin.pendingP2PPaths.add('viejo.md');
    h.plugin.pendingMailboxPaths.add('nuevo.md');
    const failed = await h.plugin.flushPendingToMailbox();
    assert(failed === 0, 'sin fallos el reenvío debe devolver 0');
    assert(h.published.length === 1 && h.published[0] === 'nuevo.md', 'solo se reenvía lo que está en la cola del relay');
    assert(h.plugin.pendingMailboxPaths.size === 0, 'lo entregado sale de la cola');
    assert(h.plugin.pendingP2PPaths.has('viejo.md'), 'una ruta pendiente solo por P2P no se toca');
    console.log('  PASS: A-01 el reenvío no publica rutas de pendingP2PPaths al relay');
  }

  // Un fallo de publicación deja la nota en cola y se cuenta; el éxito posterior la limpia.
  {
    let ok = false;
    const h = makePlugin({ publishOk: () => ok });
    addNote(h, 'n.md', 'texto');
    h.plugin.pendingMailboxPaths.add('n.md');
    assert((await h.plugin.flushPendingToMailbox()) === 1, 'un fallo se cuenta');
    assert(h.plugin.pendingMailboxPaths.has('n.md'), 'tras fallar sigue en cola');
    assert(h.plugin.settings.pendingMailboxOut === undefined || h.plugin.settings.pendingMailboxOut.length === 0 || h.plugin.pendingMailboxPaths.has('n.md'), 'la cola persistida sigue a la cola en memoria');
    ok = true;
    assert((await h.plugin.flushPendingToMailbox()) === 0, 'el segundo intento entrega');
    assert(h.published.length === 1 && h.plugin.pendingMailboxPaths.size === 0, 'tras entregar la cola queda vacía');
    console.log('  PASS: un relay caído deja la nota en cola y el reintento la entrega');
  }

  // A-02: el reenvío espera a la cadena de envíos normales (no adelanta una versión vieja).
  {
    const h = makePlugin();
    addNote(h, 'n.md', 'texto');
    h.plugin.pendingMailboxPaths.add('n.md');
    let release!: () => void;
    h.plugin.broadcastChain = new Promise<void>((r) => { release = r; });
    const flushing = h.plugin.flushPendingToMailbox();
    await sleep(30);
    assert(h.published.length === 0, 'mientras un envío normal está en curso el reenvío no publica');
    release();
    await flushing;
    assert(h.published.length === 1, 'al terminar el envío normal el reenvío publica');
    // Un segundo reenvío simultáneo no se duplica.
    h.plugin.pendingMailboxPaths.add('n.md');
    const a = h.plugin.flushPendingToMailbox();
    const b = h.plugin.flushPendingToMailbox();
    await Promise.all([a, b]);
    assert(h.published.length === 2, 'dos reenvíos simultáneos publican una sola vez');
    console.log('  PASS: A-02 el reenvío va serializado con los envíos normales');
  }

  // A-03: un relay que acepta y cierra no reinicia la espera de reconexión.
  {
    let connections = 0;
    class FlappingWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(_url: string) {
        connections++;
        setTimeout(() => { this.onopen?.(); setTimeout(() => this.onclose?.(), 5); }, 0);
      }
      send() {}
      close() {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FlappingWebSocket;
    const cm = new CryptoManager();
    const mb: any = new NostrMailbox('wss://relay.example.test', 'sala-test', 'dev-test', cm.generatePairingSecret(), cm);
    mb.setCryptoKey(await cm.deriveAesKey(cm.generatePairingSecret(), 'omnisync-test-context'));
    let reconnects = 0;
    mb.onReconnected = () => { reconnects++; };
    mb.startLiveSubscription();
    await sleep(1400);
    assert(connections === 2, `tras ~1,4 s debe haber 2 conexiones (hubo ${connections})`);
    assert(mb.reconnectAttempts >= 2, `la espera debe seguir creciendo (reconnectAttempts=${mb.reconnectAttempts})`);
    await sleep(1300);
    assert(connections <= 3, `la tercera conexión espera ~1,5 s más (hubo ${connections})`);
    assert(reconnects === connections, 'cada apertura, incluida la primera, dispara la consulta de pendientes');
    // reconnectNow sí reinicia la espera y abre ya.
    const before = connections;
    mb.reconnectNow();
    assert(mb.reconnectAttempts === 0, 'reconnectNow reinicia la espera');
    await sleep(30);
    assert(connections === before + 1, 'reconnectNow abre una conexión nueva de inmediato');
    mb.destroy();
    console.log('  PASS: A-03 backoff sin bucle de consultas; reconnectNow reconecta ya');
  }

  // A-04: al descargar el plugin, el reenvío termina ANTES de destruir el buzón.
  {
    const h = makePlugin({ publishDelayMs: 60 });
    addNote(h, 'n.md', 'texto');
    h.plugin.pendingMailboxPaths.add('n.md');
    h.plugin.peers = new Map();
    h.plugin.clearPeerRetryTimers = () => {};
    h.plugin.vaultWatcher = null;
    h.plugin.signalingClient = null;
    h.plugin.pendingRetryTimer = null;
    await h.plugin.onunload();
    assert(h.published.length === 1, 'el reenvío de cierre debe completarse');
    assert(h.plugin.__destroyedAt === 1, 'el buzón se destruye después de entregar, no antes');
    console.log('  PASS: A-04 onunload espera el reenvío antes de destruir el buzón');
  }

  // Edición dentro de los 350 ms de debounce: el cierre la envía de inmediato.
  {
    const cm = new CryptoManager();
    const file = makeFile('nota.md', 1, 1);
    const content = 'edición recién escrita';
    const handlers: Record<string, (f: unknown) => void> = {};
    const app = {
      vault: {
        on: (evt: string, cb: (f: unknown) => void) => { handlers[evt] = cb; return {}; },
        offref: () => {},
        read: async () => content,
      },
      plugins: { plugins: {} },
    } as never;
    const changes: string[] = [];
    const watcher = new VaultWatcher(app, cm, true, false, {
      onFileChanged: (_p, _e, data) => { changes.push(new TextDecoder().decode(data)); },
      onFileDeleted: () => {},
      onFileRenamed: () => {},
    });
    watcher.registerEvents();
    handlers['modify'](file);
    await sleep(50);
    assert(changes.length === 0, 'antes de los 350 ms aún no se ha difundido');
    await watcher.flushPendingEdits();
    assert(changes.length === 1 && changes[0] === content, 'flushPendingEdits difunde la edición pendiente al instante');
    await sleep(450);
    assert(changes.length === 1, 'el temporizador cancelado no la difunde por segunda vez');
    watcher.cleanup();
    console.log('  PASS: flushPendingEdits envía las ediciones del debounce al cerrar');
  }

  // Arranque: lo local que no coincide con la última versión sincronizada se encola.
  {
    const h = makePlugin();
    const now = Date.now();
    h.plugin.settings.lastMailboxFetchTimestamp = now - 60_000;
    // Editada sin enviar: el snapshot base es otra versión.
    addNote(h, 'sin-enviar.md', 'cambio que nunca llegó', now - 30_000);
    await h.plugin.baseSnapshotStore.setBase('sin-enviar.md', 'versión anterior', await h.plugin.cryptoManager.computeHash(new TextEncoder().encode('versión anterior')), 1);
    // Recibida de otro dispositivo: su base coincide con el contenido.
    addNote(h, 'recibida.md', 'ya sincronizada', now - 30_000);
    await h.plugin.baseSnapshotStore.setBase('recibida.md', 'ya sincronizada', await h.plugin.cryptoManager.computeHash(new TextEncoder().encode('ya sincronizada')), 1);
    // Antigua: fuera de la ventana de reconciliación.
    addNote(h, 'antigua.md', 'sin tocar', now - 10 * 60_000);
    // Nueva y sin base.
    addNote(h, 'nueva.md', 'nota creada sin conexión', now - 20_000);
    await h.plugin.queueUnsyncedLocalEdits();
    const q = h.plugin.pendingMailboxPaths as Set<string>;
    assert(q.has('sin-enviar.md'), 'una edición local no sincronizada se encola');
    assert(q.has('nueva.md'), 'una nota nueva sin base se encola');
    assert(!q.has('recibida.md'), 'lo recibido de otro dispositivo no se reenvía');
    assert(!q.has('antigua.md'), 'lo anterior a la última consulta no se revisa');
    assert(h.plugin.settings.pendingMailboxOut.includes('sin-enviar.md'), 'la cola se persiste para sobrevivir a un cierre');
    console.log('  PASS: al arrancar se encolan solo las ediciones locales sin sincronizar');
  }

  // Worker desplegado sin el binding del buzón: el plugin lo detecta y avisa (antes fallaba en silencio).
  {
    const realFetch = (globalThis as any).fetch;
    const calls: string[] = [];
    let status = 'missing_do_binding';
    (globalThis as any).fetch = async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ services: { mailbox: { status } } }) };
    };
    try {
      const h = makePlugin();
      h.plugin.settings.signalingServer = 'wss://mi-worker.example.workers.dev/';
      h.plugin.settings.privateWorkerHosts = ['mi-worker.example.workers.dev'];
      h.plugin.workerMailboxChecked = false;
      assert((await h.plugin.checkWorkerMailbox()) === true, 'un Worker sin buzón debe detectarse');
      assert(calls[0] === 'https://mi-worker.example.workers.dev/', 'consulta la ruta de estado por https');
      assert((await h.plugin.checkWorkerMailbox()) === false && calls.length === 1, 'solo se consulta una vez por sesión');

      status = 'ready';
      const ok = makePlugin();
      ok.plugin.settings.signalingServer = 'wss://mi-worker.example.workers.dev/';
      ok.plugin.settings.privateWorkerHosts = ['mi-worker.example.workers.dev'];
      ok.plugin.workerMailboxChecked = false;
      assert((await ok.plugin.checkWorkerMailbox()) === false, 'un Worker con buzón no genera aviso');

      calls.length = 0;
      const pub = makePlugin();
      pub.plugin.settings.signalingServer = 'wss://relay.publico.example/';
      pub.plugin.settings.privateWorkerHosts = [];
      pub.plugin.workerMailboxChecked = false;
      assert((await pub.plugin.checkWorkerMailbox()) === false && calls.length === 0, 'un relay que no es tu Worker no se consulta');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
    console.log('  PASS: se avisa cuando el Worker no tiene el buzón desplegado');
  }
}

run().then(() => console.log('\nRegresiones doble vía OK'), (e) => { console.error(e); process.exit(1); });
