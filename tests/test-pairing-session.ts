/**
 * OmniSync - Tests de la vinculación efímera (ECDH + token de un solo uso)
 */

import assert from 'node:assert';
import {
  PAIRING_TOKEN_TTL_MS,
  PairingGuestSession,
  PairingHostSession,
  decodePairingInvite,
  derivePairingRoom,
  encodePairingInvite,
  encodePairingLink,
  inviteUriFromLinkData,
  isPairingInviteUri,
  generatePairingToken,
  validateWireMessage,
} from '../src/security/pairing-session';

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    throw err;
  }
}

const PAYLOAD = { v: 1, secret: 'S3CR3T-MASTER-KEY-PAYLOAD', roomId: 'r' };

await test('flujo completo: hello → offer → done', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const guest = new PairingGuestSession(token);
  const hello = await guest.buildHello();
  const offer = await host.handleHello(hello, PAYLOAD);
  assert.ok(offer);
  assert.deepStrictEqual(await guest.handleOffer(offer!), PAYLOAD);
  const done = await guest.buildDone({ deviceId: 'dev-x', deviceName: 'Móvil' });
  assert.deepStrictEqual(await host.handleDone(done), { deviceId: 'dev-x', deviceName: 'Móvil' });
});

await test('el QR no contiene la clave maestra ni el token en claro de la sala', async () => {
  const token = generatePairingToken();
  const uri = encodePairingInvite({ v: 2, token, transport: 'nostr', server: 'wss://nos.lol/' });
  assert.ok(!uri.includes(PAYLOAD.secret));
  assert.strictEqual(decodePairingInvite(uri).token, token);
  const room = await derivePairingRoom(token);
  assert.ok(/^[a-f0-9]{64}$/.test(room));
  assert.ok(!room.includes(token));
});

await test('el ciphertext no revela la clave maestra', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const guest = new PairingGuestSession(token);
  const offer = await host.handleHello(await guest.buildHello(), PAYLOAD);
  assert.ok(!JSON.stringify(offer).includes(PAYLOAD.secret));
});

await test('un hello con otro token es rechazado', async () => {
  const host = new PairingHostSession(generatePairingToken());
  const attacker = new PairingGuestSession(generatePairingToken());
  assert.strictEqual(await host.handleHello(await attacker.buildHello(), PAYLOAD), null);
});

await test('un hello manipulado (clave pública cambiada) es rechazado', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const other = new PairingGuestSession(token);
  const hello = await new PairingGuestSession(token).buildHello();
  const forged = { ...hello, pub: (await other.buildHello()).pub };
  assert.strictEqual(await host.handleHello(forged, PAYLOAD), null);
});

await test('el código es de un solo uso (replay de hello ignorado)', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const hello = await new PairingGuestSession(token).buildHello();
  assert.ok(await host.handleHello(hello, PAYLOAD));
  assert.strictEqual(await host.handleHello(hello, PAYLOAD), null);
  assert.strictEqual(await host.handleHello(await new PairingGuestSession(token).buildHello(), PAYLOAD), null);
});

await test('un código caducado se rechaza', async () => {
  const token = generatePairingToken();
  let now = 1_000_000;
  const host = new PairingHostSession(token, () => now, now + PAIRING_TOKEN_TTL_MS);
  const hello = await new PairingGuestSession(token).buildHello();
  now += PAIRING_TOKEN_TTL_MS + 1;
  assert.strictEqual(await host.handleHello(hello, PAYLOAD), null);
});

await test('un offer forjado sin el token es rechazado por el invitado', async () => {
  const token = generatePairingToken();
  const guest = new PairingGuestSession(token);
  const hello = await guest.buildHello();
  const rogue = new PairingHostSession(generatePairingToken());
  // El atacante responde con su propia sesión (no conoce el token real).
  const rogueGuest = new PairingGuestSession((rogue as unknown as { token: string }).token);
  const rogueOffer = await rogue.handleHello(await rogueGuest.buildHello(), { evil: true });
  assert.ok(rogueOffer);
  const retargeted = { ...rogueOffer!, roomId: hello.roomId };
  assert.strictEqual(await guest.handleOffer(retargeted), null);
});

await test('un offer alterado (ciphertext) no se descifra', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const guest = new PairingGuestSession(token);
  const offer = (await host.handleHello(await guest.buildHello(), PAYLOAD))!;
  const bytes = Uint8Array.from(atob(offer.ct!), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  const tampered = { ...offer, ct: btoa(String.fromCharCode(...bytes)) };
  assert.strictEqual(await guest.handleOffer(tampered), null);
});

await test('un done de otra sesión no se acepta', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const guest = new PairingGuestSession(token);
  await guest.handleOffer((await host.handleHello(await guest.buildHello(), PAYLOAD))!);

  const token2 = generatePairingToken();
  const host2 = new PairingHostSession(token2);
  const guest2 = new PairingGuestSession(token2);
  await guest2.handleOffer((await host2.handleHello(await guest2.buildHello(), PAYLOAD))!);
  const foreignDone = await guest2.buildDone({ deviceId: 'dev-evil', deviceName: 'x' });
  assert.strictEqual(await host.handleDone({ ...foreignDone, roomId: await host.getRoom() }), null);
});

await test('la validación de invitación rechaza esquemas y tokens inválidos', async () => {
  assert.throws(() => encodePairingInvite({ v: 2, token: 'corto', transport: 'nostr', server: 'wss://nos.lol/' }));
  assert.throws(() =>
    encodePairingInvite({ v: 2, token: generatePairingToken(), transport: 'nostr', server: 'ws://inseguro' })
  );
  assert.throws(() => decodePairingInvite('omnisync://pair2?data=%%%'));
  assert.strictEqual(validateWireMessage({ v: 1, roomId: 'a', type: 'hello' }, 'b'), null);
  assert.strictEqual(validateWireMessage({ v: 1, roomId: 'a', type: 'otro' }, 'a'), null);
});

await test('uso único también con hellos válidos simultáneos (sin carrera)', async () => {
  const token = generatePairingToken();
  const host = new PairingHostSession(token);
  const a = new PairingGuestSession(token);
  const b = new PairingGuestSession(token);
  const [ha, hb] = [await a.buildHello(), await b.buildHello()];
  const offers = await Promise.all([host.handleHello(ha, PAYLOAD), host.handleHello(hb, PAYLOAD)]);
  assert.strictEqual(offers.filter(Boolean).length, 1, 'solo un hello puede recibir la clave');
});

await test('enlace obsidian:// del QR: ida y vuelta y mismo contenido que el código copiable', async () => {
  const invite = { v: 2 as const, token: generatePairingToken(), transport: 'nostr' as const, server: 'wss://nos.lol' };
  const link = encodePairingLink(invite);
  assert.ok(link.startsWith('obsidian://omnisync-pair?data='));
  assert.ok(isPairingInviteUri(link));
  assert.deepStrictEqual(decodePairingInvite(link), invite);
  assert.deepStrictEqual(decodePairingInvite(encodePairingInvite(invite)), invite);
  // Lo que entrega Obsidian al manejador: el parámetro `data` ya decodificado.
  const data = decodeURIComponent(link.slice('obsidian://omnisync-pair?data='.length));
  assert.deepStrictEqual(decodePairingInvite(inviteUriFromLinkData(data)), invite);
  assert.throws(() => inviteUriFromLinkData(undefined));
  assert.throws(() => inviteUriFromLinkData('x'.repeat(5000)));
  assert.throws(() => decodePairingInvite(inviteUriFromLinkData('AAAA')));
});


console.log(`\nTotal: ${passed} | PASS: ${passed} | FAIL: 0`);
