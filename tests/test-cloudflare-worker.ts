/**
 * OmniSync - Security regressions for the Cloudflare Blossom Worker.
 *
 * Executes the Worker handler against an in-memory R2 bucket and verifies that
 * NIP-98 authorization is bound to the exact URL, method and payload hash, that
 * oversized requests are rejected and that no uploader identity is persisted.
 */

import assert from 'node:assert';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import worker from '../scripts/cloudflare-blossom-worker.js';

interface StoredObject {
  bytes: Uint8Array;
  options: Record<string, unknown>;
}

class MemoryBucket {
  public readonly objects = new Map<string, StoredObject>();
  public readonly putCalls: Array<{ key: string; options: Record<string, unknown> }> = [];

  public async put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options: Record<string, unknown> = {}
  ): Promise<void> {
    const bytes = value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value);
    this.objects.set(key, { bytes, options });
    this.putCalls.push({ key, options });
  }

  public async head(key: string): Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
    httpEtag?: string;
  } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      size: object.bytes.byteLength,
      httpMetadata: { contentType: 'application/octet-stream' },
      httpEtag: `"${key}"`,
    };
  }

  public async get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    httpMetadata?: { contentType?: string };
    httpEtag?: string;
  } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes).body as ReadableStream<Uint8Array>,
      size: object.bytes.byteLength,
      httpMetadata: { contentType: 'application/octet-stream' },
      httpEtag: `"${key}"`,
    };
  }
}

/** Única identidad autorizada en ALLOWED_PUBKEYS durante la batería. */
const ALLOWED_SECRET = generateSecretKey();
const ALLOWED_PUBKEY = getPublicKey(ALLOWED_SECRET);

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createAuthHeader(options: {
  url: string;
  method: string;
  payloadHash?: string;
  createdAt?: number;
  secretKey?: Uint8Array;
  includePayload?: boolean;
  includeExpiration?: boolean;
}): string {
  const tags: string[][] = [
    ['u', options.url],
    ['method', options.method],
  ];
  if (options.includePayload !== false && options.payloadHash) {
    tags.push(['payload', options.payloadHash]);
  }
  if (options.includeExpiration !== false) {
    tags.push(['expiration', String((options.createdAt ?? Math.floor(Date.now() / 1000)) + 300)]);
  }

  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    options.secretKey ?? ALLOWED_SECRET
  );
  return `Nostr ${toBase64(JSON.stringify(event))}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function runTests(): Promise<void> {
  console.log('\n=== Cloudflare Blossom Worker security regressions ===\n');

  const bucket = new MemoryBucket();
  const env = { MY_BUCKET: bucket, ALLOWED_PUBKEYS: ALLOWED_PUBKEY } as any;
  const uploadUrl = 'https://blossom.test/upload';
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const payloadHash = await sha256Hex(payload);

  // 1. Subida válida.
  const validAuth = createAuthHeader({
    url: uploadUrl,
    method: 'PUT',
    payloadHash,
  });
  const validResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: validAuth,
        'Content-Type': 'application/octet-stream',
        'X-SHA-256': payloadHash,
      },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(validResponse.status, 200, 'Una autorización NIP-98 válida debe permitirse');
  const descriptor = await validResponse.json() as {
    sha256: string;
    size: number;
    url: string;
  };
  assert.strictEqual(descriptor.sha256, payloadHash, 'El descriptor debe devolver el hash real');
  assert.strictEqual(descriptor.size, payload.byteLength, 'El descriptor debe devolver el tamaño real');
  assert.ok(bucket.objects.has(payloadHash), 'El blob debe almacenarse por su hash');

  // 2. No se persiste identidad del uploader ni fecha de subida.
  const stored = bucket.objects.get(payloadHash)!;
  assert.ok(
    !stored.options.customMetadata,
    'R2 no debe persistir metadatos de identidad del uploader'
  );
  const serializedOptions = JSON.stringify(stored.options);
  assert.ok(!serializedOptions.includes('pubkey'), 'Los metadatos R2 no deben contener pubkey');
  assert.ok(!serializedOptions.includes('uploadedAt'), 'Los metadatos R2 no deben contener uploadedAt');

  // 3. La autorización no puede reutilizarse para otra URL.
  const wrongUrlAuth = createAuthHeader({
    url: 'https://blossom.test/otro',
    method: 'PUT',
    payloadHash,
  });
  const wrongUrlResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: wrongUrlAuth },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(wrongUrlResponse.status, 401, 'Una URL distinta debe rechazarse');

  // 4. La autorización no puede reutilizarse para otro método.
  const wrongMethodAuth = createAuthHeader({
    url: uploadUrl,
    method: 'POST',
    payloadHash,
  });
  const wrongMethodResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: wrongMethodAuth },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(wrongMethodResponse.status, 401, 'Un método distinto debe rechazarse');

  // 5. La autorización debe vincularse al hash exacto del cuerpo.
  const wrongPayloadAuth = createAuthHeader({
    url: uploadUrl,
    method: 'PUT',
    payloadHash: await sha256Hex(new Uint8Array([9, 9, 9])),
  });
  const wrongPayloadResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: wrongPayloadAuth },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(wrongPayloadResponse.status, 401, 'Un payload hash distinto debe rechazarse');

  // 6. Una carga con cuerpo no puede omitir el tag payload.
  const missingPayloadAuth = createAuthHeader({
    url: uploadUrl,
    method: 'PUT',
    includePayload: false,
  });
  const missingPayloadResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: missingPayloadAuth },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(missingPayloadResponse.status, 401, 'Una carga sin payload hash debe rechazarse');

  // 7. Eventos NIP-98 antiguos o manipulados se rechazan.
  const staleAuth = createAuthHeader({
    url: uploadUrl,
    method: 'PUT',
    payloadHash,
    createdAt: Math.floor(Date.now() / 1000) - 600,
  });
  const staleResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: staleAuth },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(staleResponse.status, 401, 'Una autorización antigua debe rechazarse');

  const tampered = JSON.parse(
    Buffer.from(validAuth.replace('Nostr ', ''), 'base64').toString('utf8')
  ) as Record<string, unknown>;
  tampered.id = '0'.repeat(64);
  const tamperedResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Nostr ${toBase64(JSON.stringify(tampered))}` },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(tamperedResponse.status, 401, 'Un evento manipulado debe rechazarse');

  // 8. Cabeceras y tokens malformados no producen errores 500.
  for (const badHeader of [
    '',
    'Nostr',
    'Nostr ***',
    `Bearer ${validAuth.slice(6)}`,
  ]) {
    const response = await worker.fetch(
      new Request(uploadUrl, {
        method: 'PUT',
        headers: badHeader ? { Authorization: badHeader } : undefined,
        body: payload,
      }),
      env,
      {} as any
    );
    assert.strictEqual(response.status, 401, `La cabecera "${badHeader}" debe rechazarse`);
  }

  // 9. El límite de tamaño se aplica antes de leer el cuerpo.
  const oversizedResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: validAuth,
        'Content-Length': String(100 * 1024 * 1024 + 1),
      },
      body: payload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(oversizedResponse.status, 413, 'Un Content-Length excesivo debe rechazarse');

  // 10. Descarga y HEAD sirven exactamente el blob almacenado.
  const downloadUrl = `https://blossom.test/${payloadHash}`;
  const downloadResponse = await worker.fetch(
    new Request(downloadUrl, { method: 'GET' }),
    env,
    {} as any
  );
  assert.strictEqual(downloadResponse.status, 200, 'La descarga del blob debe funcionar');
  const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
  assert.deepStrictEqual(downloaded, payload, 'La descarga debe devolver los bytes exactos');

  const headResponse = await worker.fetch(
    new Request(downloadUrl, { method: 'HEAD' }),
    env,
    {} as any
  );
  assert.strictEqual(headResponse.status, 200, 'HEAD debe encontrar el blob');
  assert.strictEqual(
    headResponse.headers.get('content-length'),
    String(payload.byteLength),
    'HEAD debe declarar el tamaño correcto'
  );

  // 11. El contenido nunca se sirve como documento activo.
  assert.strictEqual(downloadResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(downloadResponse.headers.get('content-type'), 'application/octet-stream');
  assert.strictEqual(downloadResponse.headers.get('content-disposition'), 'attachment');
  assert.ok(downloadResponse.headers.get('content-security-policy')?.includes('sandbox'));

  // 12. Una clave válida pero NO autorizada no puede subir nada (control de acceso).
  const strangerPayload = new Uint8Array([7, 7, 7, 7]);
  const strangerHash = await sha256Hex(strangerPayload);
  const strangerResponse = await worker.fetch(
    new Request(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: createAuthHeader({
          url: uploadUrl,
          method: 'PUT',
          payloadHash: strangerHash,
          secretKey: generateSecretKey(),
        }),
      },
      body: strangerPayload,
    }),
    env,
    {} as any
  );
  assert.strictEqual(strangerResponse.status, 403, 'Una clave no autorizada debe rechazarse');
  assert.ok(!bucket.objects.has(strangerHash), 'Nada debe escribirse en R2 para una clave no autorizada');

  // 13. Fail-closed: sin ALLOWED_PUBKEYS (o con valores inválidos) se rechaza todo.
  for (const misconfigured of [undefined, '', 'no-es-hex', 'ABC']) {
    const closedResponse = await worker.fetch(
      new Request(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: createAuthHeader({ url: uploadUrl, method: 'PUT', payloadHash }),
        },
        body: payload,
      }),
      { MY_BUCKET: bucket, ALLOWED_PUBKEYS: misconfigured } as any,
      {} as any
    );
    assert.strictEqual(closedResponse.status, 503, 'Sin lista de claves autorizadas el servidor debe cerrarse');
  }

  console.log('\n✅ Todas las regresiones del Cloudflare Blossom Worker pasaron.\n');
}

runTests().catch((error) => {
  console.error('\n❌ Error en las regresiones del Cloudflare Blossom Worker:', error);
  process.exit(1);
});
