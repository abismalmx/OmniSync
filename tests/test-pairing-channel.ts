/**
 * OmniSync - Vinculación efímera de extremo a extremo sobre un relay simulado
 * (variantes Worker y Nostr).
 */

import assert from 'node:assert';
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools';
import { runPairingGuest, startPairingHost } from '../src/network/pairing-channel';
import { generatePairingToken } from '../src/security/pairing-session';

/** Hub en memoria: retransmite a los demás sockets de la misma URL de sala. */
const hubs = new Map<string, Set<MockSocket>>();
class MockSocket {
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  private key: string;
  private nostrRoom: string | null = null;
  constructor(public url: string) {
    this.key = url;
    if (!url.includes('nos.lol')) {
      if (!hubs.has(url)) hubs.set(url, new Set());
      hubs.get(url)!.add(this);
    }
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string): void {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed[0] === 'REQ') {
      this.nostrRoom = parsed[2]['#t'][0];
      const key = `${this.url}#${this.nostrRoom}`;
      this.key = key;
      if (!hubs.has(key)) hubs.set(key, new Set());
      hubs.get(key)!.add(this);
      return;
    }
    if (Array.isArray(parsed) && parsed[0] === 'EVENT') {
      assert.ok(verifyEvent(parsed[1]), 'el evento Nostr debe estar firmado');
      const key = `${this.url}#${parsed[1].tags.find((t: string[]) => t[0] === 't')[1]}`;
      for (const peer of hubs.get(key) ?? []) peer.onmessage?.({ data: JSON.stringify(['EVENT', 'sub', parsed[1]]) });
      return;
    }
    if (!hubs.has(this.key)) hubs.set(this.key, new Set());
    hubs.get(this.key)!.add(this);
    for (const peer of hubs.get(this.key)!) if (peer !== this) peer.onmessage?.({ data });
  }
  close(): void {
    this.readyState = 3;
    hubs.get(this.key)?.delete(this);
  }
}
(globalThis as any).WebSocket = MockSocket;

const PAYLOAD = {
  v: 1,
  secret: 'A'.repeat(43) + '=',
  roomId: 'b'.repeat(32),
  name: 'Laptop',
  platform: 'desktop',
};

for (const transport of ['worker', 'nostr'] as const) {
  const server = transport === 'worker' ? 'wss://w.test/' : 'wss://nos.lol/';
  let guestIdentity: unknown = null;
  const host = await startPairingHost({
    transport,
    server,
    getPayload: async () => PAYLOAD,
    onPaired: (g) => (guestIdentity = g),
  });
  // El invitado del worker se anuncia antes de suscribirse; dar un tick al host.
  const guest = await runPairingGuest<typeof PAYLOAD>(host.invite);
  assert.deepStrictEqual(guest.payload, PAYLOAD, `${transport}: el invitado recibe la clave`);
  await guest.complete({ deviceId: 'dev-' + 'c'.repeat(32), deviceName: 'Android', devicePlatform: 'mobile' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(
    guestIdentity,
    { deviceId: 'dev-' + 'c'.repeat(32), deviceName: 'Android', devicePlatform: 'mobile' },
    `${transport}: el anfitrión recibe la identidad`
  );
  console.log(`  PASS: vinculación completa por ${transport}`);

  // El código ya se usó: un segundo invitado no obtiene nada.
  const second = await Promise.race([
    runPairingGuest(host.invite).then(() => 'paired', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('no-response'), 300)),
  ]);
  assert.strictEqual(second, 'no-response');
  console.log(`  PASS: ${transport}: el código no se puede reutilizar`);
  host.cancel();
}

{
  // El invitado falla enseguida (no a los 30 s) si el canal se cae antes de recibir la clave.
  const Original = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = class extends Original {
    constructor(url: string) {
      super(url);
      setTimeout(() => this.onclose?.(), 20);
    }
  };
  const started = Date.now();
  const outcome = await runPairingGuest({ v: 2, token: generatePairingToken(), transport: 'nostr', server: 'wss://nos.lol' }).then(
    () => 'paired',
    () => 'rejected'
  );
  (globalThis as any).WebSocket = Original;
  assert.strictEqual(outcome, 'rejected');
  assert.ok(Date.now() - started < 5000, 'rechazo rápido al caerse el canal');
  console.log('  PASS: el invitado falla rápido si el canal se cierra');
}

{
  // Un código sin usar caduca a los 2 min contados desde que el QR queda visible.
  const { PAIRING_TOKEN_TTL_MS } = await import('../src/security/pairing-session');
  assert.strictEqual(PAIRING_TOKEN_TTL_MS, 2 * 60 * 1000);
  const before = Date.now();
  const host = await startPairingHost({
    transport: 'nostr',
    server: 'wss://nos.lol',
    getPayload: async () => PAYLOAD,
    onPaired: () => {},
  });
  assert.ok(host.expiresAt >= before + PAIRING_TOKEN_TTL_MS, 'la vigencia cuenta desde que el canal está listo');
  assert.ok(host.expiresAt - Date.now() <= PAIRING_TOKEN_TTL_MS, 'sin exceder 2 min');
  host.cancel();
  console.log('  PASS: el código dura 2 min desde que el QR es visible');
}

{
  // Camino real del temporizador (escalado): sin usar muere al TTL; con intercambio en curso se da margen y luego muere.
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms === 120_000 ? 200 : ms === 15_000 ? 300 : ms, ...rest);
  try {
    const ended: string[] = [];
    const idle = await startPairingHost({
      transport: 'nostr',
      server: 'wss://nos.lol',
      getPayload: async () => PAYLOAD,
      onPaired: () => {},
      onEnded: (r) => ended.push(`idle:${r}`),
    });
    await new Promise((r) => realSetTimeout(r, 350));
    assert.deepStrictEqual(ended, ['idle:expired'], 'el código sin usar muere al TTL');
    void idle;

    const busy = await startPairingHost({
      transport: 'nostr',
      server: 'wss://nos.lol',
      getPayload: async () => PAYLOAD,
      onPaired: () => assert.fail('no debe emparejar'),
      onEnded: (r) => ended.push(`busy:${r}`),
    });
    const guest = await runPairingGuest<unknown>(busy.invite); // hello válido: el código queda consumido
    await new Promise((r) => realSetTimeout(r, 350)); // pasado el TTL, dentro del margen
    assert.ok(!ended.includes('busy:expired'), 'un intercambio en curso recibe margen');
    await new Promise((r) => realSetTimeout(r, 400));
    assert.ok(ended.includes('busy:expired'), 'sin done, tras el margen también muere');
    guest.abort();
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }
  console.log('  PASS: expiración real: sin usar y con intercambio en curso');
}

void finalizeEvent; void generateSecretKey;
console.log('\nTotal: 7 | PASS: 7 | FAIL: 0');
process.exit(0);
