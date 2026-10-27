/**
 * OmniSync - Security regressions for realtime mailbox and Blossom.
 *
 * Covers the boundaries introduced by the persistent mailbox and large-file
 * implementation: SSRF through a remote server pointer, unbounded HTTP
 * responses, upload hash mismatch, redirect handling, receiver-side path
 * policy, UTF-8 chunk sizing and per-path write serialization.
 */

import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { CryptoManager, MAILBOX_KEY_CONTEXT } from '../src/crypto/crypto-manager';
import { BlossomClient, NIP98_AUTH_KIND } from '../src/network/blossom-client';
import {
  DELTA_CHUNK_SIZE,
  MAILBOX_EXPIRATION_SECONDS,
  MAILBOX_KIND,
  MAX_CONCURRENT_BLOSSOM_OPERATIONS,
  NostrMailbox,
} from '../src/network/nostr-mailbox';
import { PathOperationQueue } from '../src/security/path-operation-queue';
import { ConcurrencyLimiter } from '../src/security/concurrency-limiter';
import { ReplayGuard } from '../src/security/protocol-security';
import { sanitizeExternalError, sanitizeExternalText } from '../src/security/external-text';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function rejectsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function runTests(): Promise<void> {
  console.log('\n=== OmniSync realtime + Blossom security regressions ===\n');
  const cryptoManager = new CryptoManager();
  const pairingSecret = cryptoManager.generatePairingSecret();
  const mailboxKey = await cryptoManager.deriveAesKey(pairingSecret, MAILBOX_KEY_CONTEXT);
  const originalFetch = globalThis.fetch;

  try {
    console.log('=== Endpoint policy ===');
    check(
      'HTTP inseguro se rechaza',
      await rejectsAsync(async () => BlossomClient.normalizeServerUrl('http://example.com'))
    );
    check(
      'Credenciales embebidas se rechazan',
      await rejectsAsync(async () => BlossomClient.normalizeServerUrl('https://user:pass@example.com'))
    );
    check(
      'Query strings se rechazan en la URL base',
      await rejectsAsync(async () => BlossomClient.normalizeServerUrl('https://example.com/?token=x'))
    );
    check(
      'Fragmentos se rechazan en la URL base',
      await rejectsAsync(async () => BlossomClient.normalizeServerUrl('https://example.com/#x'))
    );
    check(
      'Una URL HTTPS pública se canonicaliza',
      BlossomClient.normalizeServerUrl('https://example.com/') === 'https://example.com'
    );

    console.log('\n=== NIP-98 ===');
    const secretKey = generateSecretKey();
    const body = new Uint8Array([1, 2, 3, 4]);
    const bodyHash = await BlossomClient.computeSha256Hex(body);
    const authHeader = BlossomClient.createNip98AuthHeader(
      'https://example.com/upload',
      'PUT',
      bodyHash,
      secretKey
    );
    const event = JSON.parse(
      Buffer.from(authHeader.replace('Nostr ', ''), 'base64').toString('utf8')
    );
    check('NIP-98 usa kind 27235', event.kind === NIP98_AUTH_KIND);
    check(
      'NIP-98 incluye el tag payload con SHA-256',
      event.tags.some((tag: string[]) => tag[0] === 'payload' && tag[1] === bodyHash)
    );
    check(
      'NIP-98 no incluye el tag obsoleto x',
      !event.tags.some((tag: string[]) => tag[0] === 'x')
    );

    console.log('\n=== Upload integrity ===');
    let uploadCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      uploadCalls++;
      check('La subida bloquea redirects', init?.redirect === 'error');
      check(
        'La subida adjunta Authorization NIP-98',
        typeof (init?.headers as Record<string, string> | undefined)?.Authorization === 'string'
      );
      const requestUrl = String(input);
      const hash = await BlossomClient.computeSha256Hex(body);
      return new Response(
        JSON.stringify({
          url: `${requestUrl.replace(/\/upload$/, '')}/${hash}`,
          sha256: hash,
          size: body.byteLength,
          type: 'application/octet-stream',
          uploaded: Math.floor(Date.now() / 1000),
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    check(
      'Un hash de upload manipulado se rechaza antes de fetch',
      await rejectsAsync(() =>
        BlossomClient.uploadBlob(body, '0'.repeat(64), ['https://example.com'], secretKey)
      )
    );
    check('El hash manipulado no causa ninguna petición', uploadCalls === 0);
    const uploadResult = await BlossomClient.uploadBlob(
      body,
      bodyHash,
      ['https://example.com'],
      secretKey
    );
    check('La subida válida devuelve el hash recalculado', uploadResult.sha256 === bodyHash);

    console.log('\n=== Upload descriptor validation ===');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          url: 'https://example.com/' + '0'.repeat(64),
          sha256: '0'.repeat(64),
          size: body.byteLength,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;
    check(
      'Un descriptor BUD-01 con hash incorrecto se rechaza',
      await rejectsAsync(() =>
        BlossomClient.uploadBlob(body, bodyHash, ['https://example.com'], secretKey)
      )
    );
    globalThis.fetch = (async () =>
      new Response('not-json', { status: 201 })) as typeof fetch;
    check(
      'Un descriptor BUD-01 corrupto se rechaza',
      await rejectsAsync(() =>
        BlossomClient.uploadBlob(body, bodyHash, ['https://example.com'], secretKey)
      )
    );
    globalThis.fetch = (async () =>
      new Response(null, { status: 409 })) as typeof fetch;
    let conflictAccepted = false;
    try {
      await BlossomClient.uploadBlob(body, bodyHash, ['https://example.com'], secretKey);
      conflictAccepted = true;
    } catch {
      conflictAccepted = false;
    }
    check('Un 409 idempotente sin cuerpo se acepta', conflictAccepted);

    console.log('\n=== Remote pointer / SSRF ===');
    const allowedBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const allowedHash = await BlossomClient.computeSha256Hex(allowedBytes);
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      check('La descarga bloquea redirects', init?.redirect === 'error');
      return new Response(allowedBytes, {
        status: 200,
        headers: { 'content-length': String(allowedBytes.byteLength) },
      });
    }) as typeof fetch;

    const downloaded = await BlossomClient.downloadBlob(
      allowedHash,
      'http://127.0.0.1/internal',
      ['https://allowed.example'],
      (bytes) => cryptoManager.computeSha256Hex(bytes)
    );
    check('La descarga devuelve los bytes permitidos', downloaded.byteLength === allowedBytes.byteLength);
    check(
      'El servidor remoto no permitido nunca se contacta',
      requestedUrls.length === 1 && requestedUrls[0].startsWith('https://allowed.example/')
    );
    check(
      'El puntero remoto no introduce una URL HTTP',
      !requestedUrls.some((url) => url.startsWith('http://127.0.0.1'))
    );

    console.log('\n=== Download size limit ===');
    const largeBytes = new Uint8Array(1024, 7);
    const largeHash = await BlossomClient.computeSha256Hex(largeBytes);
    globalThis.fetch = (async () =>
      new Response(largeBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as typeof fetch;
    check(
      'Una respuesta superior al límite se rechaza',
      await rejectsAsync(() =>
        BlossomClient.downloadBlob(
          largeHash,
          'https://allowed.example',
          ['https://allowed.example'],
          (bytes) => cryptoManager.computeSha256Hex(bytes),
          1000,
          100
        )
      )
    );

    console.log('\n=== Receiver path policy ===');
    const roomId = await cryptoManager.deriveMailboxRoomId(pairingSecret);
    const mailbox = new NostrMailbox(
      'wss://nos.lol',
      roomId,
      'dev-local-test',
      pairingSecret,
      cryptoManager
    );
    mailbox.setCryptoKey(mailboxKey);
    mailbox.setVaultPathPolicy({
      syncAttachments: false,
      syncObsidianConfig: false,
    });
    check(
      'Un adjunto se rechaza cuando el receptor desactiva adjuntos',
      !mailbox.isEligibleForBlossom('imagen.png', 1024)
    );
    check(
      'Una nota Markdown sigue permitida sin adjuntos',
      mailbox.isEligibleForMailbox('nota.md', 1024)
    );

    const remotePath = 'imagen.png';
    const hmac = await cryptoManager.computeHmacHex(
      `${roomId}:${remotePath}`,
      pairingSecret,
      'mailbox-dtag-v2'
    );
    const encrypted = await cryptoManager.encrypt(
      {
        type: 'BLOB_ATTACHMENT',
        path: remotePath,
        content: '',
        mtime: Date.now(),
        deviceId: 'dev-remote-test',
        blobSha256: 'a'.repeat(64),
        blobSize: 128,
        blobServer: 'https://allowed.example',
      },
      mailboxKey
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const signedEvent = finalizeEvent(
      {
        kind: MAILBOX_KIND,
        created_at: nowSec,
        tags: [
          ['d', hmac],
          ['t', roomId],
          ['expiration', String(nowSec + MAILBOX_EXPIRATION_SECONDS)],
        ],
        content: JSON.stringify(encrypted),
      },
      generateSecretKey()
    );
    const validatePrivate = (mailbox as any).decryptAndValidateEvent.bind(mailbox);
    const rejected = await validatePrivate(signedEvent);
    check('El evento de adjunto se rechaza con la política local', rejected === null);
      mailbox.setVaultPathPolicy({
      syncAttachments: true,
      syncObsidianConfig: false,
    });
    const accepted = await validatePrivate(signedEvent);
    check('El mismo evento se acepta si la política lo permite', accepted?.path === remotePath);

    console.log('\n=== Configuration limits ===');
    const {
      clampMaxBlobSizeMb,
      resolveMaxBlobSizeBytes,
    } = await import('../src/network/blossom-providers');
    check(
      'Un límite NaN se descarta',
      resolveMaxBlobSizeBytes({
        maxBlobSizePreset: 'custom',
        customMaxBlobSizeMb: Number.NaN,
      }) === 25 * 1024 * 1024
    );
    check(
      'Un límite Infinity se descarta',
      resolveMaxBlobSizeBytes({
        maxBlobSizePreset: 'custom',
        customMaxBlobSizeMb: Number.POSITIVE_INFINITY,
      }) === 25 * 1024 * 1024
    );
    check(
      'Un límite fraccionario se descarta',
      clampMaxBlobSizeMb(12.5) === null
    );
    check(
      'Un límite mayor de 1024 MB se descarta',
      clampMaxBlobSizeMb(1025) === null
    );
    check(
      'Un límite de 0 MB se descarta',
      clampMaxBlobSizeMb(0) === null
    );
    check(
      'La allowlist descarta destinos HTTP y credenciales',
      BlossomClient.normalizeServerList([
        'http://example.com',
        'https://user:pass@example.com',
        'https://valid.example/',
      ]).join(',') === 'https://valid.example'
    );
    check(
      'La allowlist deduplica URLs canónicas',
      BlossomClient.normalizeServerList([
        'https://valid.example',
        'https://valid.example/',
      ]).length === 1
    );

    const { coerceBoolean, sanitizeBooleanSettings } = await import(
      '../src/security/settings-security'
    );
    check(
      'El string "false" no se interpreta como booleano activo',
      coerceBoolean('false', false) === false
    );
    check(
      'Un booleano real se conserva',
      coerceBoolean(true, false) === true
    );
    const dirtySettings: any = {
      autoSync: 'false',
      syncAttachments: 'true',
      syncObsidianConfig: 1,
      enableNostrMailbox: 'yes',
      enableBlossomSync: true,
    };
    sanitizeBooleanSettings(dirtySettings, {
      autoSync: true,
      syncAttachments: true,
      syncObsidianConfig: false,
      enableNostrMailbox: false,
      enableBlossomSync: false,
    });
    check(
      'Los flags booleanos manipulados se restauran a valores seguros',
      dirtySettings.autoSync === true &&
        dirtySettings.syncAttachments === true &&
        dirtySettings.syncObsidianConfig === false &&
        dirtySettings.enableNostrMailbox === false &&
        dirtySettings.enableBlossomSync === true
    );

    console.log('\n=== Publication acknowledgement ===');
    const closedMailbox = new NostrMailbox(
      'wss://nos.lol',
      roomId,
      'dev-local-test',
      pairingSecret,
      cryptoManager
    );
    closedMailbox.setCryptoKey(mailboxKey);
    closedMailbox.destroy();
    const publishResult = await closedMailbox.publishNote('nota.md', 'contenido', Date.now());
    check('Un buzón cerrado no reporta publicación exitosa', publishResult.success === false);

    console.log('\n=== UTF-8 multipart sizing ===');
    const multibyte = '€'.repeat(40_000);
    const boundaries = (mailbox as any).computeChunkBoundaries(
      multibyte,
      DELTA_CHUNK_SIZE
    ) as Array<{ start: number; end: number }>;
    const chunks = boundaries.map((boundary) =>
      multibyte.substring(boundary.start, boundary.end)
    );
    check(
      'Cada fragmento multibyte cabe en 48 KB UTF-8',
      chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= DELTA_CHUNK_SIZE)
    );
    check(
      'El texto multibyte se reconstruye sin corrupciones',
      chunks.join('') === multibyte && !chunks.join('').includes('�')
    );

    console.log('\n=== Per-path write serialization ===');
    const queue = new PathOperationQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((index) =>
      queue.run('Nota.md', async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        order.push(index);
      })
    ));
    check('Las operaciones de la misma ruta nunca se solapan', maxActive === 1);
    check('Las operaciones de la misma ruta conservan el orden', order.join(',') === '0,1,2');

    console.log('\n=== Global concurrency limit ===');
    const limiter = new ConcurrencyLimiter(2);
    let limiterActive = 0;
    let limiterMaxActive = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          limiterActive++;
          limiterMaxActive = Math.max(limiterMaxActive, limiterActive);
          await new Promise((resolve) => setTimeout(resolve, 5));
          limiterActive--;
        })
      )
    );
    check('El limitador nunca excede el máximo configurado', limiterMaxActive === 2);
    check('El limitador libera todos sus slots', limiter.activeCount === 0);

    const singleLimiter = new ConcurrencyLimiter(1);
    let singleActive = 0;
    let singleMax = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        singleLimiter.run(async () => {
          singleActive++;
          singleMax = Math.max(singleMax, singleActive);
          await new Promise((resolve) => setTimeout(resolve, 3));
          singleActive--;
        })
      )
    );
    check('Un limitador unitario serializa las operaciones', singleMax === 1);

    const boundedLimiter = new ConcurrencyLimiter(1, 1);
    let releaseFirst: (() => void) | null = null;
    const first = boundedLimiter.run(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const second = boundedLimiter.run(async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const thirdRejected = await rejectsAsync(() => boundedLimiter.run(async () => undefined));
    check('La cola del limitador rechaza el exceso', thirdRejected);
    releaseFirst?.();
    await first;
    await second;

    console.log('\n=== Blossom global limit is wired ===');
    check(
      'El buzón aplica un límite global de operaciones Blossom',
      MAX_CONCURRENT_BLOSSOM_OPERATIONS === 1
    );

    console.log('\n=== Replay reservation release ===');
    const guard = new ReplayGuard();
    const reservationId = 'a'.repeat(64);
    check('El guard acepta la primera vez', guard.accept(reservationId) === true);
    check('El guard rechaza el replay', guard.accept(reservationId) === false);
    guard.release(reservationId);
    check('El guard acepta de nuevo tras liberar', guard.accept(reservationId) === true);
    check(
      'El guard informa si un ID ya fue procesado',
      guard.isAccepted(reservationId) === true
    );

    console.log('\n=== External text sanitization ===');
    check(
      'Los saltos de línea se eliminan',
      sanitizeExternalText('linea1\nlinea2') === 'linea1 linea2'
    );
    check(
      'Las secuencias ANSI se eliminan',
      !sanitizeExternalText('\u001b[31mrojo\u001b[0m').includes('\u001b')
    );
    check(
      'El texto se acota en longitud',
      sanitizeExternalText('x'.repeat(5000)).length <= 160
    );
    check(
      'Un prefijo del plugin no puede inyectarse',
      sanitizeExternalText('OmniSync: mensaje falso') === 'OmniSync mensaje falso'
    );
    check(
      'Un valor vacío produce un texto de respaldo',
      sanitizeExternalError(undefined, 'fallback') === 'fallback'
    );
    check(
      'Un error externo se sanea',
      sanitizeExternalError(new Error('fallo\ncon salto')) === 'fallo con salto'
    );

    console.log('\n=== Replay release on application failure ===');
    {
      const retryRoomId = await cryptoManager.deriveMailboxRoomId(pairingSecret);
      const retryMailbox = new NostrMailbox(
        'wss://nos.lol',
        retryRoomId,
        'dev-local-test',
        pairingSecret,
        cryptoManager
      );
      retryMailbox.setCryptoKey(mailboxKey);

      const retryPath = 'nota-reintento.md';
      const retryHmac = await cryptoManager.computeHmacHex(
        `${retryRoomId}:${retryPath}`,
        pairingSecret,
        'mailbox-dtag-v2'
      );
      const retryEncrypted = await cryptoManager.encrypt(
        {
          path: retryPath,
          content: 'contenido remoto',
          mtime: Date.now(),
          deviceId: 'dev-remoto-test',
        },
        mailboxKey
      );
      const retryNowSec = Math.floor(Date.now() / 1000);
      const retryEvent = finalizeEvent(
        {
          kind: MAILBOX_KIND,
          created_at: retryNowSec,
          tags: [
            ['d', retryHmac],
            ['t', retryRoomId],
            ['expiration', String(retryNowSec + MAILBOX_EXPIRATION_SECONDS)],
          ],
          content: JSON.stringify(retryEncrypted),
        },
        generateSecretKey()
      );

      const validateWithId = (retryMailbox as any).decryptAndValidateEventWithId.bind(retryMailbox);

      // La primera validación reserva el ID en el guard de replay.
      const firstPass = await validateWithId(retryEvent);
      check('El evento válido se valida y reserva su ID', firstPass !== null);

      // Un reintento inmediato se descarta como duplicado.
      const secondPass = await validateWithId(retryEvent);
      check('El replay del mismo evento se descarta', secondPass === null);

      // Si la aplicación falla, la reserva se libera y el evento es procesable.
      retryMailbox.releaseReservations([firstPass.eventId]);
      const thirdPass = await validateWithId(retryEvent);
      check(
        'Tras liberar la reserva el evento vuelve a ser válido',
        thirdPass !== null && thirdPass.eventId === firstPass.eventId
      );

      // La liberación de un ID inexistente no lanza errores.
      let releaseSafe = true;
      try {
        retryMailbox.releaseReservations(['id-inexistente', '']);
        retryMailbox.releaseReservations(undefined as any);
      } catch {
        releaseSafe = false;
      }
      check('Liberar reservas inválidas es seguro', releaseSafe);

      // El camino realtime libera la reserva si el consumidor falla.
      const deliverNote = (retryMailbox as any).deliverNote.bind(retryMailbox);
      retryMailbox.onNoteReceived = async () => {
        throw new Error('fallo transitorio de red');
      };
      const replayGuard = (retryMailbox as any).replayGuard;
      // Se reserva primero en el guard, como ocurre al validar el evento.
      replayGuard.accept('reserva-fallida');
      let deliverFailed = false;
      try {
        await deliverNote(
          { path: retryPath, content: '', mtime: Date.now(), deviceId: 'dev-remoto-test' },
          ['reserva-fallida']
        );
      } catch {
        deliverFailed = true;
      }
      check('La entrega realtime propaga el fallo del consumidor', deliverFailed);

      check(
        'La reserva se libera cuando la aplicación realtime falla',
        replayGuard.isAccepted('reserva-fallida') === false
      );

      // Si la aplicación tiene éxito, la reserva se conserva (anti-replay).
      // Se reserva primero en el guard, como ocurre al validar el evento.
      retryMailbox.onNoteReceived = async () => {};
      replayGuard.accept('reserva-ok');
      await deliverNote(
        { path: retryPath, content: '', mtime: Date.now(), deviceId: 'dev-remoto-test' },
        ['reserva-ok']
      );
      check(
        'La reserva se conserva cuando la aplicación tiene éxito',
        replayGuard.isAccepted('reserva-ok') === true
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\nTotal: ${passed} | PASS: ${passed} | FAIL: ${failed}`);
  if (failed > 0) {
    throw new Error(`Fallaron ${failed} regresiones: ${failures.join(', ')}`);
  }
  console.log('\n✅ Todas las regresiones realtime + Blossom pasaron.\n');
}

runTests().catch((error) => {
  console.error('\n❌ Error en las regresiones realtime + Blossom:', error);
  process.exit(1);
});


