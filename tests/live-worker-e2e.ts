/**
 * OmniSync - Prueba de extremo a extremo contra un Worker todo-en-uno REAL (herramienta manual).
 *
 * No forma parte de `npm test`: necesita un Worker desplegado y red. Usa el propio código del
 * plugin (NostrMailbox, auth NIP-98) con dos «dispositivos» que comparten el mismo secreto:
 *   A publica mientras B está desconectado; B «arranca después» y debe recibirlo.
 *
 * Uso:
 *   MODE=pubkey [SECRET=<secreto>] node …          # imprime secreto y clave pública para ALLOWED_PUBKEYS
 *   MODE=run    SECRET=<secreto> WORKER=wss://host/ node …
 *   MODE=blossom-only SECRET=<secreto> WORKER=wss://host/ node …
 *               Worker de SOLO Blossom (sin buzón): subida con clave propia, descarga, y rechazo si el
 *               Worker no está registrado como propio. El buzón/WebRTC irían por otro relay.
 *   MODE=blob   SECRET=<secreto> WORKER=wss://host/ [BLOB_MBS=1,20,50,95,101] node …
 *               Sube adjuntos de cada tamaño, los descarga desde otro dispositivo, los descifra y
 *               compara byte a byte. Un tamaño por encima del límite del Worker debe fallar limpio.
 */
import { CryptoManager, MAILBOX_KEY_CONTEXT, BLOSSOM_KEY_CONTEXT } from '../src/crypto/crypto-manager';
import { NostrMailbox } from '../src/network/nostr-mailbox';
import { BlossomClient } from '../src/network/blossom-client';
import { deriveWorkerAuthKey, workerAuthPublicKey } from '../src/security/worker-auth';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!ok) failures++;
}

async function runBlob(make: (id: string) => NostrMailbox, cm: CryptoManager, httpOrigin: string) {
  const sizes = (process.env.BLOB_MBS || '1,20,50,95,101').split(',').map((x) => Number(x.trim()));
  console.log(`Adjuntos contra ${httpOrigin} (MB: ${sizes.join(', ')})`);
  for (const mb of sizes) {
    const size = Math.floor(mb * 1024 * 1024);
    const data = new Uint8Array(size);
    // Contenido pseudoaleatorio por bloques (crypto limita getRandomValues a 64 KB).
    for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(o + 65536, size)));
    const want = await cm.computeSha256Hex(data);
    const path = `Adjuntos/prueba-${mb}mb.bin`;

    const A = make(`movil-${mb}`);
    const t0 = Date.now();
    const pub = await A.publishBlobAttachment(path, data, Date.now());
    const upMs = Date.now() - t0;
    if (!pub.success) {
      console.log(`  ${mb} MB: publicación rechazada (${pub.reason}) en ${upMs} ms`);
      if (mb > 100) check(true, `${mb} MB por encima del límite del Worker: falla limpio, sin colgarse`);
      else check(false, `${mb} MB debía poder subirse`);
      A.destroy();
      continue;
    }
    const B = make(`pc-${mb}`);
    const pending = await B.fetchPendingNotes(0);
    const note = pending.find((p) => p.note.path === path)?.note;
    if (!note) { check(false, `${mb} MB: B no vio el aviso del adjunto`); A.destroy(); B.destroy(); continue; }
    const t1 = Date.now();
    let got: Uint8Array | null = null;
    let err = '';
    try { got = await B.downloadBlobAttachment(note); } catch (e: any) { err = String(e?.message || e); }
    const downMs = Date.now() - t1;
    const got256 = got ? await cm.computeSha256Hex(got) : '';
    check(!!got && got.byteLength === size && got256 === want,
      `${mb} MB: subida ${upMs} ms, bajada+descifrado ${downMs} ms, ${got ? (got256 === want ? 'idéntico byte a byte' : 'CONTENIDO DISTINTO') : 'falló: ' + err}`);
    A.destroy(); B.destroy();
  }
  console.log(failures === 0 ? '\nBLOBS OK' : `\nBLOBS CON ${failures} FALLO(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const cm = new CryptoManager();
  const secret = process.env.SECRET || cm.generatePairingSecret();
  const authKey = await deriveWorkerAuthKey(cm, secret);
  if (process.env.MODE === 'pubkey') {
    console.log(`SECRET=${secret}`);
    console.log(`PUBKEY=${workerAuthPublicKey(authKey)}`);
    return;
  }

  const worker = process.env.WORKER!;
  const host = new URL(worker).host;
  const httpOrigin = `https://${host}`;
  const room = await cm.deriveMailboxRoomId(secret);
  const mailboxKey = await cm.deriveAesKey(secret, MAILBOX_KEY_CONTEXT);
  const blossomKey = await cm.deriveAesKey(secret, BLOSSOM_KEY_CONTEXT);

  const make = (deviceId: string) => {
    const mb = new NostrMailbox(worker, room, deviceId, secret, cm);
    mb.setCryptoKey(mailboxKey);
    mb.setBlossomKey(blossomKey);
    mb.setBlossomConfig([httpOrigin], (process.env.MODE === 'blob' ? 200 : 5) * 1024 * 1024);
    mb.setPrivateWorkerAuth(authKey, [host]);
    return mb;
  };

  if (process.env.MODE === 'blossom-only') {
    const mbs = (process.env.BLOB_MBS || '1,50,95').split(',').map((x) => Number(x.trim()));
    const ephemeral = crypto.getRandomValues(new Uint8Array(32));
    console.log(`Worker de solo Blossom: ${httpOrigin} (MB: ${mbs.join(', ')})`);
    const info = (await (await fetch(httpOrigin + '/')).json()) as any;
    console.log(`  estado público: ${JSON.stringify(info)}`);
    check(!/mailbox/i.test(JSON.stringify(info)), 'el Worker de solo Blossom no ofrece buzón (por diseño)');
    for (const mb of mbs) {
      const size = Math.floor(mb * 1024 * 1024);
      const data = new Uint8Array(size);
      for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(o + 65536, size)));
      const enc = await cm.encryptBinary(data, blossomKey);
      const sha = await cm.computeSha256Hex(enc);
      const t0 = Date.now();
      let up: any = null; let upErr = '';
      try { up = await BlossomClient.uploadBlob(enc, sha, [httpOrigin], ephemeral, 120000, { privateKey: authKey, privateHosts: [host] }); }
      catch (e: any) { upErr = String(e?.message || e); }
      const upMs = Date.now() - t0;
      if (!up) { check(false, `${mb} MB: subida falló (${upErr})`); continue; }
      const t1 = Date.now();
      const down = await BlossomClient.downloadBlob(sha, up.serverUrl, [httpOrigin], (b) => cm.computeSha256Hex(b), 120000, enc.byteLength + 64, enc.byteLength);
      const plain = await cm.decryptBinary(down, blossomKey);
      const same = plain.byteLength === size && (await cm.computeSha256Hex(plain)) === (await cm.computeSha256Hex(data));
      check(same, `${mb} MB: subida ${upMs} ms, bajada+descifrado ${Date.now() - t1} ms, ${same ? 'idéntico byte a byte' : 'CONTENIDO DISTINTO'}`);
    }
    // Si el Worker NO está registrado como propio, se firma con una clave efímera y debe rechazarse.
    const small = await cm.encryptBinary(new Uint8Array(2048).fill(7), blossomKey);
    const smallSha = await cm.computeSha256Hex(small);
    let rejected = false; let why = '';
    try { await BlossomClient.uploadBlob(small, smallSha, [httpOrigin], ephemeral, 30000, undefined); }
    catch (e: any) { rejected = true; why = String(e?.message || e).slice(0, 120); }
    check(rejected, `sin registrar el Worker como propio la subida se rechaza (${why})`);
    console.log(failures === 0 ? '\nBLOSSOM-ONLY OK' : `\nBLOSSOM-ONLY CON ${failures} FALLO(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  if (process.env.MODE === 'blob') {
    await runBlob(make, cm, httpOrigin);
    return;
  }

  console.log(`Worker: ${worker}`);
  const health = (await (await fetch(httpOrigin + '/')).json()) as any;
  check(health?.services?.mailbox?.status === 'ready', `estado del buzón = ${health?.services?.mailbox?.status}`);
  check(health?.services?.signaling?.status === 'ready', `estado de señalización = ${health?.services?.signaling?.status}`);
  check(health?.services?.blossom?.status === 'ready', `estado de Blossom = ${health?.services?.blossom?.status}`);
  check(health?.services?.auth?.status === 'ready', `estado de auth = ${health?.services?.auth?.status}`);

  // 1) Dispositivo A (móvil) publica con B (PC) apagado.
  const A = make('movil-A');
  const t0 = Date.now();
  const r1 = await A.publishNote('Prueba/nota.md', 'versión 1 escrita con el PC apagado', t0, false);
  check(r1.success === true, `A publica la nota en el Worker (${r1.success ? 'OK' : r1.reason})`);

  // 2) A edita la misma nota: el buzón conserva solo la última versión.
  await sleep(1100);
  const r2 = await A.publishNote('Prueba/nota.md', 'versión 2 (la que debe llegar)', t0 + 1000, false);
  check(r2.success === true, 'A publica la versión 2 de la misma nota');
  const r2b = await A.publishNote('Prueba/otra.md', 'otra nota', t0 + 1500, false);
  check(r2b.success === true, 'A publica una segunda nota distinta');

  // 3) B «arranca después» y consulta el buzón (lo que hace el PC al abrir Obsidian).
  const B = make('pc-B');
  const pending = await B.fetchPendingNotes(0);
  check(B.lastFetchComplete === true, 'B completa la consulta (EOSE recibido)');
  const nota = pending.find((p) => p.note.path === 'Prueba/nota.md');
  check(!!nota && nota.note.content === 'versión 2 (la que debe llegar)', 'B recibe la última versión de la nota');
  check(pending.some((p) => p.note.path === 'Prueba/otra.md'), 'B recibe también la segunda nota');
  check(pending.filter((p) => p.note.path === 'Prueba/nota.md').length === 1, 'solo una versión por nota (reemplazo)');

  // 4) Borrado propagado.
  const r3 = await A.publishNote('Prueba/otra.md', '', t0 + 3000, true);
  check(r3.success === true, 'A publica un borrado');

  // 5) Entrega en vivo con B conectado.
  const live: string[] = [];
  B.onNoteReceived = async (n) => { live.push(`${n.path}:${n.content}`); };
  B.startLiveSubscription();
  await sleep(2500);
  const r4 = await A.publishNote('Prueba/vivo.md', 'en vivo', Date.now(), false);
  check(r4.success === true, 'A publica con B conectado');
  for (let i = 0; i < 20 && !live.some((l) => l.startsWith('Prueba/vivo.md')); i++) await sleep(250);
  check(live.some((l) => l === 'Prueba/vivo.md:en vivo'), 'B recibe en vivo la nota publicada');

  // 6) Adjunto por Blossom del propio Worker.
  const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
  const r5 = await A.publishBlobAttachment('Prueba/adjunto.bin', bytes, Date.now());
  check(r5.success === true, `A sube un adjunto a Blossom (${r5.success ? 'OK' : r5.reason})`);
  const C = make('pc-C');
  const pend2 = await C.fetchPendingNotes(0);
  const adj = pend2.find((p) => p.note.path === 'Prueba/adjunto.bin');
  check(!!adj, 'otro dispositivo ve el aviso del adjunto en el buzón');

  A.destroy(); B.destroy(); C.destroy();
  console.log(failures === 0 ? '\nE2E OK' : `\nE2E CON ${failures} FALLO(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
