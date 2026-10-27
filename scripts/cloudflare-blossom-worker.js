/**
 * OmniSync - Plantilla Oficial de Servidor Blossom para Cloudflare Workers + R2
 *
 * Despliega tu propio servidor Blossom personal descentralizado con 10 GB de almacenamiento
 * gratuito en Cloudflare R2 y soporte para archivos pesados de hasta 100 MB.
 *
 * ======================================================================================
 * INSTRUCCIONES DE DESPLIEGUE EN MENOS DE 2 MINUTOS (Dashboard de Cloudflare):
 * ======================================================================================
 * 1. Ve a https://dash.cloudflare.com/ y entra a "R2 Object Storage".
 * 2. Haz clic en "Create bucket", nómbralo "omnisync-blossom" y créalo.
 * 3. Ve a "Workers & Pages" -> "Create application" -> "Create Worker".
 * 4. Nómbralo (ej. "mi-blossom") y haz clic en "Deploy".
 * 5. Entra a la configuración del Worker: "Settings" -> "Variables" -> "R2 Bucket Bindings".
 *    - Haz clic en "Add binding".
 *    - Variable name: MY_BUCKET
 *    - R2 Bucket: omnisync-blossom
 *    - Guarda los cambios ("Save and Deploy").
 * 6. Haz clic en "Edit code", borra el código existente, pega TODO este archivo y haz clic en "Deploy".
 * 7. Añade la variable de texto ALLOWED_PUBKEYS ("Settings" -> "Variables and Secrets" -> "Add",
 *    tipo "Text") con la clave pública que muestra OmniSync en el asistente de Cloudflare.
 *    SIN esta variable el servidor rechaza todas las subidas (es privado por diseño).
 * 8. Copia la URL de tu Worker (ej. "https://mi-blossom.tu-usuario.workers.dev") y pégala
 *    en Ajustes -> OmniSync -> Servidores Blossom.
 * ======================================================================================
 */

// Límite máximo por archivo para Cloudflare Workers (100 MB en plan gratuito)
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

/** Límites defensivos para el evento NIP-98 recibido en la cabecera Authorization. */
const MAX_NIP98_AUTH_HEADER_LENGTH = 32 * 1024;
const MAX_NIP98_EVENT_BYTES = 16 * 1024;
const MAX_NIP98_TAGS = 16;
const MAX_NIP98_TAG_PARAMETERS = 8;
const MAX_NIP98_TAG_VALUE_LENGTH = 2048;
const NIP98_EVENT_WINDOW_SECONDS = 120;

/** Cabeceras para contenido de usuario: nunca se interpreta como documento. */
const BLOB_SECURITY_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'attachment',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * Claves públicas autorizadas (variable de texto ALLOWED_PUBKEYS, separadas por
 * comas o espacios). Si no hay ninguna válida el servidor rechaza todo (fail-closed).
 */
function getAllowedPubkeys(env) {
  const raw = typeof env?.ALLOWED_PUBKEYS === 'string' ? env.ALLOWED_PUBKEYS : '';
  const keys = raw
    .split(/[\s,]+/)
    .map(k => k.trim().toLowerCase())
    .filter(k => isLowerHex(k, 64))
    .slice(0, 32);
  return keys.length > 0 ? new Set(keys) : null;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Length, X-Sha-256',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag, X-Sha-256',
};

// Curva secp256k1 para verificación Schnorr BIP-340 autónoma sin dependencias externas
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BB5BF5670D94309E5n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m = P) {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

function modPow(base, exp, m = P) {
  let res = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = mod(res * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return res;
}

function modInverse(k, m = P) {
  return modPow(k, m - 2n, m);
}

// Coordenadas Jacobianas (X, Y, Z): evita una inversión modular por cada suma de puntos.
// El punto en el infinito se representa con null.
function jacDouble(p) {
  if (!p) return null;
  const [x, y, z] = p;
  if (y === 0n) return null;
  const ySq = mod(y * y);
  const s = mod(4n * x * ySq);
  const m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s);
  const y3 = mod(m * (s - x3) - 8n * ySq * ySq);
  const z3 = mod(2n * y * z);
  return [x3, y3, z3];
}

function jacAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  const z1Sq = mod(z1 * z1);
  const z2Sq = mod(z2 * z2);
  const u1 = mod(x1 * z2Sq);
  const u2 = mod(x2 * z1Sq);
  const s1 = mod(y1 * z2Sq * z2);
  const s2 = mod(y2 * z1Sq * z1);
  if (u1 === u2) return s1 === s2 ? jacDouble(p1) : null;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hSq = mod(h * h);
  const hCu = mod(h * hSq);
  const v = mod(u1 * hSq);
  const x3 = mod(r * r - hCu - 2n * v);
  const y3 = mod(r * (v - x3) - s1 * hCu);
  const z3 = mod(h * z1 * z2);
  return [x3, y3, z3];
}

function jacToAffine(p) {
  if (!p) return null;
  const zInv = modInverse(p[2]);
  const zInvSq = mod(zInv * zInv);
  return [mod(p[0] * zInvSq), mod(p[1] * zInvSq * zInv)];
}

function pointAdd(p1, p2) {
  const toJac = (p) => (p ? [p[0], p[1], 1n] : null);
  return jacToAffine(jacAdd(toJac(p1), toJac(p2)));
}

function pointMultiply(k, point = [Gx, Gy]) {
  let curr = [point[0], point[1], 1n];
  let result = null;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) result = jacAdd(result, curr);
    curr = jacDouble(curr);
    scalar >>= 1n;
  }
  return jacToAffine(result);
}

function liftX(x) {
  if (x >= P || x < 0n) return null;
  const ySq = mod(modPow(x, 3n) + 7n);
  let y = modPow(ySq, (P + 1n) / 4n);
  if (modPow(y, 2n) !== ySq) return null;
  if (y & 1n) y = P - y;
  return [x, y];
}

async function taggedHash(tag, data) {
  const enc = new TextEncoder();
  const tagHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(tag)));
  const combined = new Uint8Array(tagHash.length * 2 + data.length);
  combined.set(tagHash, 0);
  combined.set(tagHash, tagHash.length);
  combined.set(data, tagHash.length * 2);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isLowerHex(value, expectedLength) {
  return typeof value === 'string' &&
    value.length === expectedLength &&
    (expectedLength === 0 || expectedLength % 2 === 0) &&
    /^[0-9a-f]+$/.test(value);
}

function hexToBytes(hex) {
  if (!isLowerHex(hex, hex.length)) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifySchnorrSignature(sigHex, msgHex, pubkeyHex) {
  try {
    if (sigHex.length !== 128 || msgHex.length !== 64 || pubkeyHex.length !== 64) return false;
    const rBytes = hexToBytes(sigHex.substring(0, 64));
    const rx = BigInt('0x' + sigHex.substring(0, 64));
    const s = BigInt('0x' + sigHex.substring(64, 128));
    const px = BigInt('0x' + pubkeyHex);
    if (rx >= P || s >= N) return false;

    const P_point = liftX(px);
    if (!P_point) return false;

    const mBytes = hexToBytes(msgHex);
    const pkBytes = hexToBytes(pubkeyHex);
    const challengeData = new Uint8Array(32 + 32 + 32);
    challengeData.set(rBytes, 0);
    challengeData.set(pkBytes, 32);
    challengeData.set(mBytes, 64);

    const eHash = await taggedHash('BIP0340/challenge', challengeData);
    const e = mod(BigInt('0x' + bytesToHex(eHash)), N);

    const sG = pointMultiply(s);
    const eP = pointMultiply(e, P_point);
    const negEP = eP ? [eP[0], mod(-eP[1])] : null;
    const R = pointAdd(sG, negEP);

    if (!R || (R[1] & 1n) !== 0n || R[0] !== rx) return false;
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extrae el hash SHA-256 de una ruta de blob (`/<hash>` o `/<hash>.<ext>`).
 *
 * El análisis es manual y lineal en lugar de usar una expresión regular:
 * un patrón con un grupo opcional anidado sobre la extensión es un
 * candidato habitual a backtracking y resulta marcado por los analizadores
 * de seguridad. Aquí la longitud de la ruta acota el trabajo y no existe
 * ninguna forma de degradación con entradas adversarias.
 *
 * @returns El hash en minúsculas o `null` si la ruta no corresponde a un blob.
 */
function parseBlobPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (path.charCodeAt(0) !== 47 /* '/' */) return null;

  // 64 dígitos hexadecimales.
  const HASH_LENGTH = 64;
  if (path.length < 1 + HASH_LENGTH) return null;

  let hash = '';
  for (let i = 1; i <= HASH_LENGTH; i++) {
    const code = path.charCodeAt(i);
    const isHex =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 97 && code <= 102) || // a-f
      (code >= 65 && code <= 70); // A-F
    if (!isHex) return null;
    hash += path[i];
  }

  const rest = path.slice(1 + HASH_LENGTH);
  if (rest.length === 0) return hash.toLowerCase();

  // Extensión opcional: `.` seguida de uno o más caracteres alfanuméricos.
  if (rest.charCodeAt(0) !== 46 /* '.' */) return null;
  if (rest.length < 2) return null;
  for (let i = 1; i < rest.length; i++) {
    const code = rest.charCodeAt(i);
    const isAlnum =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90); // A-Z
    if (!isAlnum) return null;
  }

  return hash.toLowerCase();
}

/** Devuelve todas las apariciones de una etiqueta; exige unicidad donde importa. */
function getTagValues(event, name) {
  return event.tags
    .filter(tag => tag[0] === name)
    .map(tag => tag[1])
    .filter(value => typeof value === 'string');
}

/** Decodifica de forma estricta el evento Base64 de la cabecera Authorization. */
function decodeNip98Event(tokenB64) {
  if (
    typeof tokenB64 !== 'string' ||
    tokenB64.length === 0 ||
    tokenB64.length > MAX_NIP98_AUTH_HEADER_LENGTH ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(tokenB64) ||
    tokenB64.length % 4 !== 0
  ) {
    return null;
  }

  try {
    const binary = atob(tokenB64);
    if (binary.length === 0 || binary.length > MAX_NIP98_EVENT_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const event = JSON.parse(json);
    return isPlainRecord(event) ? event : null;
  } catch {
    return null;
  }
}

/**
 * Valida la cabecera NIP-98 Authorization para Blossom (BUD-01).
 *
 * La autorización debe vincularse de forma inequívoca a la URL absoluta, al
 * método HTTP y, cuando hay cuerpo, al SHA-256 exacto de ese cuerpo. Sin este
 * vínculo una firma válida podría reutilizarse para autorizar otra petición.
 */
async function validateNip98Auth(request, targetUrl, requirePayloadHash, env) {
  const allowedPubkeys = getAllowedPubkeys(env);
  if (!allowedPubkeys) {
    return { valid: false, status: 503, reason: 'Servidor sin configurar: define la variable ALLOWED_PUBKEYS' };
  }
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.length > MAX_NIP98_AUTH_HEADER_LENGTH) {
    return { valid: false, reason: 'Cabecera Authorization demasiado grande' };
  }
  const match = /^Nostr\s+([A-Za-z0-9+/]+={0,2})$/.exec(authHeader);
  if (!match) {
    return { valid: false, reason: 'Falta cabecera Authorization: Nostr <token>' };
  }

  const event = decodeNip98Event(match[1]);
  if (!event) {
    return { valid: false, reason: 'Token NIP-98 inválido o no decodificable en base64' };
  }
  if (event.kind !== 27235) {
    return { valid: false, reason: `Kind de evento NIP-98 incorrecto: ${event.kind}` };
  }
  if (typeof event.content !== 'string' || event.content.length !== 0) {
    return { valid: false, reason: 'El contenido del evento NIP-98 debe estar vacío' };
  }
  if (!isLowerHex(event.id, 64) || !isLowerHex(event.pubkey, 64) || !isLowerHex(event.sig, 128)) {
    return { valid: false, reason: 'El evento NIP-98 contiene identificadores o firma inválidos' };
  }
  if (!Number.isSafeInteger(event.created_at)) {
    return { valid: false, reason: 'created_at inválido en el evento NIP-98' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - event.created_at) > NIP98_EVENT_WINDOW_SECONDS) {
    return { valid: false, reason: 'Evento NIP-98 caducado o desfase de reloj superior a 120s' };
  }

  if (
    !Array.isArray(event.tags) ||
    event.tags.length > MAX_NIP98_TAGS
  ) {
    return { valid: false, reason: 'Etiquetas NIP-98 inválidas' };
  }
  for (const tag of event.tags) {
    if (
      !Array.isArray(tag) ||
      tag.length > MAX_NIP98_TAG_PARAMETERS ||
      tag.some(value => typeof value !== 'string' || value.length > MAX_NIP98_TAG_VALUE_LENGTH)
    ) {
      return { valid: false, reason: 'Etiquetas NIP-98 inválidas' };
    }
  }

  // Control de acceso ANTES de cualquier operación criptográfica costosa.
  if (!allowedPubkeys.has(event.pubkey)) {
    return { valid: false, status: 403, reason: 'Clave no autorizada' };
  }

  const methodTags = getTagValues(event, 'method');
  if (methodTags.length !== 1 || methodTags[0] !== request.method.toUpperCase()) {
    return { valid: false, reason: 'Etiqueta method en NIP-98 no coincide con método HTTP' };
  }

  const urlTags = getTagValues(event, 'u');
  if (urlTags.length !== 1 || urlTags[0] !== targetUrl.toString()) {
    return { valid: false, reason: 'Etiqueta u (URL) no coincide con la URL absoluta solicitada' };
  }

  const expirationTags = getTagValues(event, 'expiration');
  if (expirationTags.length > 1) {
    return { valid: false, reason: 'Etiqueta expiration duplicada' };
  }
  if (expirationTags.length === 1) {
    const expiration = Number(expirationTags[0]);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSec) {
      return { valid: false, reason: 'Etiqueta expiration inválida o caducada' };
    }
  }

  const payloadTags = getTagValues(event, 'payload');
  if (payloadTags.length > 1) {
    return { valid: false, reason: 'Etiqueta payload duplicada' };
  }
  const payloadTag = payloadTags.length === 1 ? payloadTags[0] : null;
  if (payloadTag !== null && !isLowerHex(payloadTag, 64)) {
    return { valid: false, reason: 'Etiqueta payload NIP-98 inválida' };
  }
  if (requirePayloadHash && payloadTag === null) {
    return { valid: false, reason: 'Falta el hash SHA-256 del cuerpo en payload' };
  }

  // Verificar hash del evento con la serialización NIP-01 exacta.
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const computedIdBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  const computedId = bytesToHex(new Uint8Array(computedIdBuf));

  if (computedId !== event.id) {
    return { valid: false, reason: 'El ID del evento NIP-98 no coincide con su contenido' };
  }

  // Verificar firma criptográfica Schnorr.
  const isSigValid = await verifySchnorrSignature(event.sig, event.id, event.pubkey);
  if (!isSigValid) {
    return { valid: false, reason: 'Firma Schnorr BIP-340 inválida' };
  }

  return { valid: true, pubkey: event.pubkey, payloadHash: payloadTag };
}

/**
 * Lee el cuerpo de la petición con un límite estricto. `request.arrayBuffer()`
 * por sí solo permitiría que una petición sin Content-Length consumiera memoria
 * antes de poder comprobar su tamaño.
 */
async function readRequestBodyWithLimit(request, maxBytes) {
  if (!request.body) {
    return { ok: false, status: 400, reason: 'Cuerpo de la petición ausente' };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { }
        return { ok: false, status: 413, reason: 'Cuerpo de la petición demasiado grande' };
      }
      chunks.push(value);
    }
  } catch {
    try { await reader.cancel(); } catch { }
    return { ok: false, status: 400, reason: 'No se pudo leer el cuerpo de la petición' };
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

export default {
  async fetch(request, env) {
    // 1. Manejo CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Verificar que el bucket R2 esté vinculado correctamente
    if (!env.MY_BUCKET) {
      return new Response(
        JSON.stringify({ error: 'R2 Bucket "MY_BUCKET" no configurado en este Cloudflare Worker' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Endpoint de Subida: PUT /upload
    if (request.method === 'PUT' && (path === '/upload' || path === '/')) {
      // El evento NIP-98 debe incluir el hash del cuerpo; la coincidencia con
      // los bytes realmente recibidos se comprueba después de leerlos.
      const auth = await validateNip98Auth(request, url, true, env);
      if (!auth.valid) {
        return new Response(
          JSON.stringify({ message: auth.reason }),
          { status: auth.status || 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let declaredContentLength = null;
      const contentLengthHeader = request.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          return new Response(
            JSON.stringify({ message: 'Content-Length inválido' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (contentLength > MAX_UPLOAD_SIZE_BYTES) {
          return new Response(
            JSON.stringify({ message: `Archivo demasiado grande. Límite máximo: ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024} MB` }),
            { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        declaredContentLength = contentLength;
      }

      const bodyResult = await readRequestBodyWithLimit(request, MAX_UPLOAD_SIZE_BYTES);
      if (!bodyResult.ok) {
        return new Response(
          JSON.stringify({ message: bodyResult.reason }),
          { status: bodyResult.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      const arrayBuffer = bodyResult.body;
      if (arrayBuffer.byteLength === 0) {
        return new Response(
          JSON.stringify({ message: 'Cuerpo de la petición vacío' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      if (
        declaredContentLength !== null &&
        declaredContentLength !== arrayBuffer.byteLength
      ) {
        return new Response(
          JSON.stringify({ message: 'Content-Length no coincide con el cuerpo recibido' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Calcular hash SHA-256 y vincularlo al evento NIP-98 firmado.
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const sha256Hex = bytesToHex(new Uint8Array(hashBuffer));
      if (auth.payloadHash !== sha256Hex) {
        return new Response(
          JSON.stringify({ message: 'El hash del cuerpo no coincide con la autorización NIP-98' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const declaredHash = request.headers.get('x-sha-256');
      if (declaredHash !== null && declaredHash.toLowerCase() !== sha256Hex) {
        return new Response(
          JSON.stringify({ message: 'X-Sha-256 no coincide con el cuerpo recibido' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Guardar en Cloudflare R2. No se persisten la pubkey ni la fecha del
      // uploader: el bucket solo necesita conocer el hash y los bytes.
      await env.MY_BUCKET.put(sha256Hex, arrayBuffer, {
        httpMetadata: {
          contentType: 'application/octet-stream',
        },
      });

      // Respuesta estándar BUD-01 Blossom
      const blobDescriptor = {
        url: `${url.origin}/${sha256Hex}`,
        sha256: sha256Hex,
        size: arrayBuffer.byteLength,
        type: 'application/octet-stream',
        uploaded: Math.floor(Date.now() / 1000),
      };

      return new Response(JSON.stringify(blobDescriptor), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'X-Sha-256': sha256Hex,
        },
      });
    }

    // 3. Endpoint de Descarga o Comprobación: GET /:sha256 y HEAD /:sha256
    const sha256Hex = parseBlobPath(path);
    if (sha256Hex) {
      if (request.method === 'HEAD') {
        const object = await env.MY_BUCKET.head(sha256Hex);
        if (!object) {
          return new Response(null, { status: 404, headers: CORS_HEADERS });
        }
        return new Response(null, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            ...BLOB_SECURITY_HEADERS,
            'Content-Length': String(object.size),
            'ETag': object.httpEtag,
            'X-Sha-256': sha256Hex,
          },
        });
      }

      if (request.method === 'GET') {
        const object = await env.MY_BUCKET.get(sha256Hex);
        if (!object) {
          return new Response(
            JSON.stringify({ message: 'Blob no encontrado' }),
            { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        return new Response(object.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            ...BLOB_SECURITY_HEADERS,
            'Content-Length': String(object.size),
            'ETag': object.httpEtag,
            'X-Sha-256': sha256Hex,
          },
        });
      }
    }

    // 4. Ruta raíz informativa
    if (path === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'OmniSync Blossom Server',
          version: '1.0.0',
          protocol: 'BUD-01/02',
          maxFileSizeMb: MAX_UPLOAD_SIZE_BYTES / 1024 / 1024,
          storage: 'Cloudflare R2',
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ message: 'Endpoint no encontrado' }),
      { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  },
};
