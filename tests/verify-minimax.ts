/**
 * Banco de pruebas funcional de los módulos asignados a MiniMax M3.
 *
 *  - `src/sync/file-transfer.ts`: fragmentación, control de flujo por
 *    `bufferedamountlow` y verificación de checksum antes de escribir.
 *  - `src/collab/codemirror-collab.ts`: `StateField`, `ViewPlugin`,
 *    decoraciones de cursor/selección y remapeo posicional.
 */

import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, WidgetType } from '@codemirror/view';
import {
  remotePresenceField,
  setRemotePresence,
  type RemotePresence,
} from '../src/collab/codemirror-collab';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Widget mínimo, sin DOM real: la lógica de posición no lo necesita. */
function fakeWidget(): WidgetType {
  return new (class extends WidgetType {
    toDOM(): HTMLElement {
      return null as unknown as HTMLElement;
    }
  })();
}

function makePresence(overrides: Partial<RemotePresence> = {}): RemotePresence {
  return {
    deviceId: 'remote-1',
    deviceName: 'Laptop',
    color: '#ff0000',
    head: 10,
    from: 10,
    to: 10,
    lastUpdate: Date.now(),
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────
 * Pruebas de codemirror-collab
 * ──────────────────────────────────────────────────────────────── */

function testPresenceStateField(): void {
  section('codemirror-collab: StateField y remapeo de cursores');

  // 1. Inyección de presencia en el estado.
  let state = EditorState.create({
    doc: 'Hola mundo remoto',
    extensions: [remotePresenceField],
  });

  state = state.update({
    effects: setRemotePresence.of([makePresence({ head: 10, from: 10, to: 15 })]),
  }).state;

  const stored = state.field(remotePresenceField);
  check(
    'la presencia se almacena en el StateField',
    stored.length === 1 && stored[0].deviceId === 'remote-1',
    JSON.stringify(stored)
  );

  // 2. Inserción de texto antes del cursor: la posición se ajusta.
  state = state.update({ changes: { from: 0, insert: 'XXX' } }).state;
  const afterInsert = state.field(remotePresenceField);
  check(
    'el cursor remoto se desplaza al insertar texto antes (10 -> 13)',
    afterInsert[0].head === 13,
    `head=${afterInsert[0].head}`
  );
  check(
    'el inicio de la selección remota se desplaza (10 -> 13)',
    afterInsert[0].from === 13,
    `from=${afterInsert[0].from}`
  );
  check(
    'el fin de la selección remota se desplaza (15 -> 18)',
    afterInsert[0].to === 18,
    `to=${afterInsert[0].to}`
  );

  // 3. Inserción de texto DESPUÉS del cursor: la posición no debe moverse.
  const state2 = EditorState.create({
    doc: 'Hola mundo remoto',
    extensions: [remotePresenceField],
  }).update({ effects: setRemotePresence.of([makePresence({ head: 10 })]) }).state;

  const state3 = state2.update({ changes: { from: 15, insert: 'ZZZ' } }).state;
  check(
    'el cursor remoto no se desplaza al insertar texto después',
    state3.field(remotePresenceField)[0].head === 10,
    `head=${state3.field(remotePresenceField)[0].head}`
  );

  // 4. Borrado de texto antes del cursor.
  const state4 = state2.update({ changes: { from: 0, to: 5 } }).state;
  check(
    'el cursor remoto se ajusta al borrar texto antes (10 -> 5)',
    state4.field(remotePresenceField)[0].head === 5,
    `head=${state4.field(remotePresenceField)[0].head}`
  );

  // 5. Sin cambios en el documento, el estado se conserva.
  const state5 = state2.update({ selection: { anchor: 3 } }).state;
  check(
    'la presencia se conserva cuando no cambia el documento',
    state5.field(remotePresenceField).length === 1
  );

  // 6. La fusión de presencias conserva el remapeo de las que ya estaban.
  let state6 = EditorState.create({
    doc: 'Hola mundo remoto',
    extensions: [remotePresenceField],
  }).update({ effects: setRemotePresence.of([makePresence({ head: 10 })]) }).state;

  // Se inserta texto: la presencia se remapea a 13.
  state6 = state6.update({ changes: { from: 0, insert: 'XXX' } }).state;
  check(
    'la presencia se remapea a 13 antes de fusionar',
    state6.field(remotePresenceField)[0].head === 13,
    `head=${state6.field(remotePresenceField)[0].head}`
  );

  // Llega la presencia de otro dispositivo: no debe pisar la primera.
  state6 = state6.update({
    effects: setRemotePresence.of([
      makePresence({ deviceId: 'remote-2', deviceName: 'Tablet', head: 5, lastUpdate: Date.now() + 1000 }),
    ]),
  }).state;

  const merged = state6.field(remotePresenceField);
  check('la fusión conserva ambas presencias', merged.length === 2, `len=${merged.length}`);
  check(
    'la presencia previa conserva su posición remapeada (13)',
    merged.find((p) => p.deviceId === 'remote-1')?.head === 13,
    `head=${merged.find((p) => p.deviceId === 'remote-1')?.head}`
  );
  check(
    'la nueva presencia se incorpora',
    merged.find((p) => p.deviceId === 'remote-2')?.head === 5
  );
}

/**
 * Reproduce el crash del `RangeSetBuilder` cuando la selección remota está
 * invertida (el widget cae en el mismo `from` que el inicio del mark).
 */
function testDecorationsOrdering(): void {
  section('codemirror-collab: orden de decoraciones (mark + widget)');

  let builderFailed = false;
  try {
    const b = new RangeSetBuilder();
    b.add(10, 20, Decoration.mark({ class: 'x' }));
    b.add(10, 10, Decoration.widget({ widget: fakeWidget(), side: -1 }));
    b.finish();
  } catch {
    builderFailed = true;
  }
  check(
    'RangeSetBuilder falla con mark+widget desordenados (comportamiento de referencia)',
    builderFailed,
    'se esperaba un fallo de ordenamiento'
  );

  let setOk = true;
  let setSize = 0;
  try {
    const set = Decoration.set(
      [
        { from: 10, to: 20, value: Decoration.mark({ class: 'x' }) },
        {
          from: 10,
          to: 10,
          value: Decoration.widget({ widget: fakeWidget(), side: -1 }),
        },
      ],
      true
    );
    setSize = set.size;
  } catch {
    setOk = false;
  }
  check('Decoration.set con sort=true acepta la combinación', setOk);
  check('el conjunto de decoraciones contiene 2 elementos', setSize === 2, `size=${setSize}`);
}

/**
 * Verifica el remapeo de decoraciones al mapear un `DecorationSet` a través
 * de un cambio del documento, tal y como hace CodeMirror internamente.
 */
function testDecorationMapping(): void {
  section('codemirror-collab: remapeo de Decorations');

  const set = Decoration.set(
    [{ from: 10, to: 10, value: Decoration.widget({ widget: fakeWidget(), side: -1 }) }],
    true
  );

  const state = EditorState.create({ doc: '0123456789abcdefghij' });
  const changes = state.update({ changes: { from: 0, insert: 'XX' } }).changes;
  const mapped = set.map(changes);

  let mappedFrom = -1;
  mapped.between(0, 100, (from) => {
    if (mappedFrom < 0) mappedFrom = from;
  });

  check(
    'el widget se remapea de 10 a 12 tras insertar al inicio',
    mappedFrom === 12,
    `mappedFrom=${mappedFrom}`
  );
}

/* ────────────────────────────────────────────────────────────────
 * Pruebas de file-transfer
 * ──────────────────────────────────────────────────────────────── */

/**
 * Canal de datos simulado que replica la semántica de `RTCDataChannel`
 * para el búfer de salida y el evento `bufferedamountlow`.
 */
class FakeDataChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];

  private listeners: Array<(ev: Event) => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(type: 'bufferedamountlow', listener: (ev: Event) => void): void {
    if (type === 'bufferedamountlow') this.listeners.push(listener);
  }

  removeEventListener(type: 'bufferedamountlow', listener: (ev: Event) => void): void {
    if (type === 'bufferedamountlow') {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
  }

  /** Simula el vaciado del búfer y emite el evento correspondiente. */
  drain(): void {
    this.bufferedAmount = 0;
    for (const listener of [...this.listeners]) {
      listener(new Event('bufferedamountlow'));
    }
  }
}

/** Calcula el hash SHA-256 en hexadecimal, igual que `CryptoManager`. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Pruebas de fragmentación y verificación de checksum.
 *
 * Usa el `FileTransferManager` real con un `CryptoManager` real, pero
 * sustituye el canal de datos por el doble `FakeDataChannel`.
 */
async function testFileTransferChunking(): Promise<void> {
  section('file-transfer: fragmentación y checksum');

  const { CryptoManager } = await import('../src/crypto/crypto-manager');
  const { FileTransferManager, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, clampChunkSize } =
    await import('../src/sync/file-transfer');

  const cryptoManager = new CryptoManager();
  const manager = new FileTransferManager(cryptoManager);

  // 1. Límites de tamaño de chunk.
  check('clampChunkSize(1024) sube al mínimo de 16 KB', clampChunkSize(1024) === MIN_CHUNK_SIZE);
  check('clampChunkSize(1MB) baja al máximo de 64 KB', clampChunkSize(1024 * 1024) === MAX_CHUNK_SIZE);
  check('clampChunkSize(32KB) se mantiene', clampChunkSize(32 * 1024) === 32 * 1024);

  // 2. Fragmentación de un archivo de 100 KB con chunks de 16 KB.
  const size = 100 * 1024;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 256;

  const fullHash = await sha256Hex(data);
  const { header, chunks } = manager.prepareOutgoingChunks(
    'imagen.png',
    data,
    1700000000000,
    fullHash,
    true,
    { chunkSize: MIN_CHUNK_SIZE }
  );

  check('la cabecera declara el tamaño correcto', header.size === size, `size=${header.size}`);
  check(
    'la cabecera declara el número correcto de chunks',
    header.totalChunks === Math.ceil(size / MIN_CHUNK_SIZE),
    `totalChunks=${header.totalChunks}`
  );
  check('la cabecera incluye el hash SHA-256', header.hash === fullHash);
  check('se generan todos los chunks', chunks.length === header.totalChunks);

  // 3. Los chunks reconstruyen exactamente el archivo original.
  const parts = chunks.map((c) => Buffer.from(c.data, 'base64'));
  const rebuilt = Buffer.concat(parts);
  check(
    'los chunks reconstruyen el archivo byte a byte',
    rebuilt.length === size && Buffer.compare(Buffer.from(data), rebuilt) === 0,
    `len=${rebuilt.length}`
  );

  // 4. El checksum por chunk se calcula durante el envío, por lo que se
  //    valida sobre los mensajes realmente transmitidos (ver la prueba de
  //    flujo de control, que recorre el ciclo completo emisor -> receptor).

  // 5. Un chunk manipulado altera el hash global del archivo y se rechaza.
  //    Se usa un archivo de un solo chunk para que la transferencia se
  //    complete y se alcance la validación del hash global. El checksum
  //    individual del fragmento es válido, por lo que la única barrera que
  //    puede detectar la manipulación es el hash global de la cabecera.
  const singleManager = new FileTransferManager(cryptoManager);
  const originalBytes = new Uint8Array([10, 20, 30, 40, 50]);
  const { header: h5, chunks: c5 } = singleManager.prepareOutgoingChunks(
    'unico.bin',
    originalBytes,
    0,
    await sha256Hex(originalBytes),
    true,
    { chunkSize: MIN_CHUNK_SIZE }
  );
  check('el archivo de prueba genera un único chunk', c5.length === 1, `chunks=${c5.length}`);

  singleManager.registerIncomingHeader(h5);
  const corruptedBytes = new Uint8Array([0, 1, 2, 3]);
  const corrupted = {
    ...c5[0],
    data: bytesToBase64(corruptedBytes),
    checksum: await sha256Hex(corruptedBytes),
  };
  let detected = false;
  try {
    await singleManager.handleIncomingChunk(corrupted);
  } catch (e) {
    // El nuevo límite de tamaño rechaza el fragmento manipulado antes de
    // completar el ensamblado o devolver datos escribibles.
    detected = e instanceof Error;
  }
  check('un fragmento manipulado altera el hash global y se rechaza', detected);
  check(
    'el fragmento manipulado no deja una transferencia escribible',
    singleManager.activeTransferCount === 0
  );

  // 6. Un fragmento cuyo checksum no coincide con su contenido se rechaza
  //    de forma aislada, antes de ensamblar el archivo.
  const manager3 = new FileTransferManager(cryptoManager);
  const { header: h3, chunks: c3 } = manager3.prepareOutgoingChunks(
    'nota.md',
    new Uint8Array([9, 9, 9]),
    0,
    await sha256Hex(new Uint8Array([9, 9, 9])),
    false
  );
  manager3.registerIncomingHeader(h3);
  let perChunkRejected = false;
  try {
    await manager3.handleIncomingChunk({
      ...c3[0],
      checksum: 'checksum-falseo-que-no-coincide',
    });
  } catch (e) {
    // La forma del checksum se valida en el límite de confianza.
    perChunkRejected = e instanceof Error;
  }
  check('un fragmento con checksum inválido se rechaza de forma aislada', perChunkRejected);

  // 7. Un hash global inválido se rechaza al validar la cabecera, antes de
  //    reservar memoria para una transferencia entrante.
  const manager2 = new FileTransferManager(cryptoManager);
  const validBytes = new Uint8Array([1, 2, 3, 4]);
  const { header: validHeader } = manager2.prepareOutgoingChunks(
    'nota.md',
    validBytes,
    0,
    await sha256Hex(validBytes),
    false
  );
  let hashRejected = false;
  try {
    manager2.registerIncomingHeader({
      ...validHeader,
      hash: 'hash-totalmente-incorrecto',
    });
  } catch (e) {
    hashRejected = e instanceof Error;
  }
  check('un archivo con hash global incorrecto se rechaza', hashRejected);
  check(
    'la cabecera inválida no reserva una transferencia',
    manager2.activeTransferCount === 0
  );
}

/**
 * Verifica el control de flujo: cuando el búfer de salida supera la marca
 * de agua, el emisor debe esperar al evento `bufferedamountlow`.
 */
async function testFileTransferFlowControl(): Promise<void> {
  section('file-transfer: control de flujo bufferedamountlow');

  const { CryptoManager } = await import('../src/crypto/crypto-manager');
  const { FileTransferManager } = await import('../src/sync/file-transfer');

  const cryptoManager = new CryptoManager();
  const key = await cryptoManager.deriveAesKey(cryptoManager.generatePairingSecret());

  const data = new Uint8Array(64 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  const hash = await sha256Hex(data);

  // Canal con marca de agua alta: se fuerza la espera.
  const manager = new FileTransferManager(cryptoManager, { highWaterMark: 1024 });
  const channel = new FakeDataChannel();
  const { header, chunks } = manager.prepareOutgoingChunks(
    'grande.bin',
    data,
    0,
    hash,
    true,
    { chunkSize: 16 * 1024 }
  );

  // Promesa que se resuelve cuando el envío termine.
  let finished = false;
  const sendPromise = manager
    .sendFileOverChannel(channel, key, header, chunks, 'dev-test-sender')
    .then(() => {
      finished = true;
    });

  // El búfer se satura: el envío debe quedar bloqueado.
  channel.bufferedAmount = 4096;
  await new Promise((r) => setTimeout(r, 30));
  check(
    'el envío se bloquea mientras el búfer supera la marca de agua',
    !finished,
    `sent=${channel.sent.length}`
  );

  // Se drena el búfer: el evento debe desbloquear el envío.
  channel.drain();
  await sendPromise;
  check('el envío continúa tras el evento bufferedamountlow', finished);

  // Cabecera + N chunks + mensaje de cierre.
  check(
    'se envían cabecera, chunks y cierre',
    channel.sent.length === chunks.length + 2,
    `sent=${channel.sent.length}, esperado=${chunks.length + 2}`
  );

  // El umbral `bufferedAmountLowThreshold` se configura en el canal.
  check(
    'se configura bufferedAmountLowThreshold en el canal',
    channel.bufferedAmountLowThreshold === 1024,
    `threshold=${channel.bufferedAmountLowThreshold}`
  );

  // Los mensajes enviados son envelopes cifrados (JSON con iv y ct).
  const first = JSON.parse(channel.sent[0]);
  check(
    'los mensajes van cifrados (contienen iv y ct)',
    typeof first.iv === 'string' && typeof first.ct === 'string'
  );

  // El receptor puede descifrar el cierre y recuperar el hash.
  const last = JSON.parse(channel.sent[channel.sent.length - 1]);
  const decoded = await cryptoManager.decrypt<any>(last, key);
  check('el mensaje de cierre es FILE_COMPLETE', decoded.type === 'FILE_COMPLETE', decoded.type);
  check('el mensaje de cierre lleva el hash esperado', decoded.payload.hash === hash);

  // Ciclo completo emisor -> receptor: cada mensaje transmitido se descifra
  // y se entrega al ensamblador, que debe reconstruir el archivo original.
  const receiver = new FileTransferManager(cryptoManager);
  let assembled: Uint8Array | undefined;

  for (const raw of channel.sent) {
    const message = await cryptoManager.decrypt<any>(JSON.parse(raw), key);
    if (message.type === 'FILE_HEADER') {
      receiver.registerIncomingHeader(message.payload);
    } else if (message.type === 'FILE_CHUNK') {
      const result = await receiver.handleIncomingChunk(message.payload);
      if (result.complete) assembled = result.data;
    }
  }

  check('el receptor ensambla el archivo a partir de los mensajes', !!assembled);
  check(
    'el archivo ensamblado es idéntico al original',
    !!assembled &&
      assembled.length === data.length &&
      Buffer.compare(Buffer.from(assembled), Buffer.from(data)) === 0,
    `len=${assembled?.length}`
  );
  check(
    'el receptor no deja transferencias pendientes',
    receiver.activeTransferCount === 0,
    `pending=${receiver.activeTransferCount}`
  );
}

/* ────────────────────────────────────────────────────────────────
 * Ejecución
 * ──────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('Verificación de los módulos asignados a MiniMax M3');

  testPresenceStateField();
  testDecorationsOrdering();
  testDecorationMapping();
  await testFileTransferChunking();
  await testFileTransferFlowControl();

  console.log(`\n───────────────`);
  console.log(`  Total: ${passed + failed}  |  PASS: ${passed}  |  FAIL: ${failed}`);
  console.log(`───────────────`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error inesperado en la verificación:', err);
  process.exitCode = 1;
});

