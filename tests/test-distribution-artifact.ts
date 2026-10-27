/**
 * OmniSync - Tests de Regresión del Artefacto de Distribución
 *
 * El paquete que se publica (`zip/OmnySync_stable/` y `zip/OmnySync_stable.zip`)
 * debe ser idéntico a un build fresco del código fuente. Sin esta comprobación,
 * un bundle obsoleto puede llegar a los usuarios finales sin que nada lo delate:
 * en la auditoría del 2026-10-26 el paquete publicado arrastraba un build
 * anterior al endurecimiento de Blossom, los parches delta, NIP-98 y el
 * almacén de snapshots cifrado, y además exponía al relay metadatos de
 * correlación (etiqueta `d` en formato `omnisync:<roomId>:<hmac>`).
 *
 * Valida:
 * 1. El bundle del paquete es reproducible byte a byte desde `src/main.ts`.
 * 2. `manifest.json` y `styles.css` del paquete coinciden con los de la raíz.
 * 3. El `.zip` publicado contiene exactamente esos tres archivos, con el
 *    mismo contenido.
 * 4. El bundle contiene los marcadores de seguridad que separan la versión
 *    endurecida de la obsoleta (regresión de privacidad del buzón incluida).
 */

import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import * as esbuild from 'esbuild';
import builtinModules from 'builtin-modules';

const ROOT = process.cwd();
const PACKAGE_DIR = path.join(ROOT, 'zip', 'OmnySync_stable');
const ZIP_PATH = path.join(ROOT, 'zip', 'OmnySync_stable.zip');

/** Archivos que компон el paquete de distribución publicable. */
const FILES = ['main.js', 'manifest.json', 'styles.css'];

/** Marcadores que el bundle endurecido debe contener y el obsoleto no. */
const REQUIRED_MARKERS: ReadonlyArray<readonly [string, string]> = [
  // Etiqueta `d` opaca del buzón: sin prefijo de aplicación ni roomId en claro.
  ['mailbox-dtag-v2', 'derivación opaca de la etiqueta `d` del buzón (anti-correlación con el relay)'],
  ['OmniSync-Snapshot-v1', 'cifrado del almacén local de snapshots'],
  ['OmniSync-Blossom-v1', 'contexto de derivación de clave para Blossom'],
  ['BLOB_ATTACHMENT', 'punteros de adjuntos Blossom'],
  ['DELTA_PATCH', 'parches delta multipart'],
];

/** Marcadores del bundle obsoleto que indicarían una regresión de privacidad. */
const FORBIDDEN_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['mailbox-path-v1', 'derivación antigua de la etiqueta `d` (filtra el roomId en claro)'],
];

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface ZipEntry {
  name: string;
  content: Buffer;
}

/**
 * Lee el directorio central de un ZIP y devuelve el contenido de cada entrada.
 *
 * Implementación propia en Node para no depender de la utilidad `unzip`,
 * que no está presente en todas las imágenes de CI. Se soportan los métodos
 * 0 (stored) y 8 (deflate), que son los que produce la utilidad `zip`.
 */
function readZipEntries(zipPath: string): ZipEntry[] {
  const buffer = readFileSync(zipPath);
  const EOCD_SIGNATURE = 0x06054b50;

  // Fin del directorio central: se busca hacia atrás desde el final.
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'El .zip no tiene un registro de fin de directorio central válido.');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    assert.strictEqual(
      buffer.readUInt32LE(offset),
      0x02014b50,
      'El .zip tiene un directorio central corrupto.'
    );
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // El encabezado local repite nombre y extras con su propia longitud.
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (compressionMethod === 0) {
      content = Buffer.from(raw);
    } else if (compressionMethod === 8) {
      content = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`Método de compresión ZIP no soportado: ${compressionMethod}`);
    }

    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

console.log('=== Iniciando Suite de Pruebas: Artefacto de Distribución OmniSync ===\n');

let failures = 0;

async function check(description: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${description}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${description}`);
    console.error(`    ${(err as Error).message}`);
  }
}

await check(
  'El paquete de distribución existe con los tres archivos esperados',
  () => {
    assert.ok(existsSync(PACKAGE_DIR), 'Falta el directorio zip/OmnySync_stable/');
    assert.ok(existsSync(ZIP_PATH), 'Falta el archivo zip/OmnySync_stable.zip');
    for (const fileName of ['main.js', 'manifest.json', 'styles.css']) {
      assert.ok(
        existsSync(path.join(PACKAGE_DIR, fileName)),
        `Falta ${fileName} en zip/OmnySync_stable/`
      );
    }
  }
);

await check(
  'El bundle del paquete se reproduce byte a byte desde src/main.ts',
  async () => {
    // Se construye en un archivo temporal para no tocar el bundle de la raíz.
    // Se replican exactamente las opciones de producción de
    // `esbuild.config.mjs` (banner, external, formato, target y minificación)
    // para que el resultado sea comparable byte a byte con el publicado.
    const tmpBundle = path.join(ROOT, 'node_modules', '.cache', 'audit-distribution-build.js');
    const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;
    await esbuild.build({
      banner: { js: banner },
      entryPoints: [path.join(ROOT, 'src', 'main.ts')],
      bundle: true,
      external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        ...builtinModules,
      ],
      format: 'cjs',
      target: 'es2020',
      logLevel: 'silent',
      sourcemap: false,
      treeShaking: true,
      minify: true,
      outfile: tmpBundle,
    });

    const fresh = readFileSync(tmpBundle);
    const shipped = readFileSync(path.join(PACKAGE_DIR, 'main.js'));
    assert.strictEqual(
      sha256(fresh),
      sha256(shipped),
      'El bundle publicado en zip/OmnySync_stable/main.js no coincide con un build fresco ' +
        'de src/main.ts. Ejecuta `npm run package:stable` para regenerarlo.'
    );
  }
);

await check(
  'manifest.json y styles.css del paquete coinciden con los de la raíz',
  () => {
    for (const fileName of ['manifest.json', 'styles.css']) {
      const root = readFileSync(path.join(ROOT, fileName));
      const packaged = readFileSync(path.join(PACKAGE_DIR, fileName));
      assert.strictEqual(
        sha256(root),
        sha256(packaged),
        `${fileName} del paquete no coincide con el de la raíz. ` +
          'Ejecuta `npm run package:stable` para regenerarlo.'
      );
    }
  }
);

await check(
  'El .zip publicado contiene exactamente main.js, manifest.json y styles.css con el mismo contenido',
  () => {
    // El ZIP se lee con Node puro (sin depender de `unzip`, que no está en
    // todas las imágenes de CI) recorriendo el directorio central.
    const entries = readZipEntries(ZIP_PATH);
    const files = entries
      .filter((entry) => !entry.name.endsWith('/'))
      .map((entry) => entry.name)
      .sort();
    const expected = [
      'OmnySync_stable/manifest.json',
      'OmnySync_stable/main.js',
      'OmnySync_stable/styles.css',
    ].sort();
    assert.deepStrictEqual(
      files,
      expected,
      `El .zip publicado no contiene exactamente los archivos esperados: ${files.join(', ')}`
    );

    for (const fileName of FILES) {
      const extracted = entries.find((entry) => entry.name === `OmnySync_stable/${fileName}`);
      assert.ok(extracted !== undefined, `El .zip no contiene ${fileName}`);
      const packaged = readFileSync(path.join(PACKAGE_DIR, fileName));
      assert.strictEqual(
        sha256(extracted.content),
        sha256(packaged),
        `${fileName} dentro del .zip no coincide con el del directorio del paquete. ` +
          'Ejecuta `npm run package:stable` para regenerarlo.'
      );
    }
  }
);

await check(
  'El bundle publicado contiene los marcadores de seguridad del build endurecido',
  () => {
    const bundle = readFileSync(path.join(PACKAGE_DIR, 'main.js'), 'utf8');
    for (const [marker, description] of REQUIRED_MARKERS) {
      assert.ok(
        bundle.includes(marker),
        `El bundle publicado no contiene "${marker}" (${description}). ` +
          'El paquete parece corresponder a un build anterior al endurecimiento.'
      );
    }
  }
);

await check(
  'El bundle publicado no contiene marcadores de la regresión de privacidad del buzón',
  () => {
    const bundle = readFileSync(path.join(PACKAGE_DIR, 'main.js'), 'utf8');
    for (const [marker, description] of FORBIDDEN_MARKERS) {
      assert.ok(
        !bundle.includes(marker),
        `El bundle publicado todavía contiene "${marker}" (${description}). ` +
          'Ese formato de etiqueta `d` permite al relay correlacionar buzón y señalización.'
      );
    }
    // El prefijo legible `omnisync:` en la etiqueta `d` también filtra la aplicación.
    assert.ok(
      !bundle.includes('omnisync:${this.roomId}'),
      'El bundle publicado deriva la etiqueta `d` con el roomId en claro (prefijo "omnisync:").'
    );
  }
);

await check(
  'El bundle de la raíz y el del paquete son el mismo artefacto',
  () => {
    const root = readFileSync(path.join(ROOT, 'main.js'));
    const packaged = readFileSync(path.join(PACKAGE_DIR, 'main.js'));
    assert.strictEqual(
      sha256(root),
      sha256(packaged),
      'main.js de la raíz y el del paquete difieren: publica siempre el mismo build.'
    );
  }
);

await check(
  'El paquete no contiene archivos fuera de los tres permitidos',
  () => {
    const entries = readdirSync(PACKAGE_DIR);
    const unexpected = entries.filter(
      (entry) => !['main.js', 'manifest.json', 'styles.css'].includes(entry)
    );
    assert.deepStrictEqual(
      unexpected,
      [],
      `El paquete contiene archivos inesperados: ${unexpected.join(', ')}`
    );
    for (const entry of entries) {
      assert.ok(
        statSync(path.join(PACKAGE_DIR, entry)).isFile(),
        `El paquete contiene una entrada que no es un archivo regular: ${entry}`
      );
    }
  }
);

console.log('');
if (failures > 0) {
  console.error(`======================================================`);
  console.error(`❌ ${failures} PRUEBA(S) DEL ARTEFACTO DE DISTRIBUCIÓN FALLARON`);
  console.error(`======================================================`);
  process.exit(1);
}

console.log(`======================================================`);
console.log(`🎉 TODAS LAS PRUEBAS DEL ARTEFACTO DE DISTRIBUCIÓN CONCLUYERON CON ÉXITO`);
console.log(`======================================================`);
