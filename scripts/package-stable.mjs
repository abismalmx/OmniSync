/**
 * OmniSync - Empaquetado del artefacto de distribución estable
 *
 * Copia el bundle de producción y los metadatos al paquete publicable
 * (`zip/OmnySync_stable/`) y regenera `zip/OmnySync_stable.zip`.
 *
 * Motivo (auditoría de seguridad del 2026-10-26, hallazgo SEC-01): el paquete
 * publicado se había quedado congelado en un build anterior al endurecimiento
 * de Blossom, los parches delta, NIP-98 y el almacén de snapshots cifrado, y
 * además exponía al relay el roomId en claro en la etiqueta `d` del buzón.
 * Este script es el único camino de publicación: el paquete no puede quedar
 * desincronizado sin que sea deliberado.
 *
 * El ZIP se escribe en Node puro (sin la utilidad `zip` del sistema) para que
 * el empaquetado funcione en cualquier entorno de CI, incluidos contenedores
 * mínimos que no la tengan instalada.
 *
 * Uso: `npm run package:stable` (ejecuta antes `npm run build`).
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'OmnySync_stable';
const PACKAGE_DIR = path.join(ROOT, 'zip', PACKAGE_NAME);
const ZIP_PATH = path.join(ROOT, 'zip', `${PACKAGE_NAME}.zip`);
const FILES = ['main.js', 'manifest.json', 'styles.css'];

/** Fecha fija (época POSIX) para que el .zip sea reproducible. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021; // 1 de enero de 1980

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  console.error(`\n[package:stable] ERROR: ${message}\n`);
  process.exit(1);
}

/**
 * Escribe un archivo ZIP (método deflate) a partir de sus entradas.
 *
 * @param {{name: string, content: Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.content, { level: 9 });
    const useDeflate = deflated.length < entry.content.length;
    const payload = useDeflate ? deflated : entry.content;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.content);

    // Encabezado local (30 bytes + nombre).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // firma
    localHeader.writeUInt16LE(20, 4); // versión necesaria
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extras

    localChunks.push(localHeader, nameBytes, payload);

    // Directorio central (46 bytes + nombre).
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // versión de creación
    centralHeader.writeUInt16LE(20, 6); // versión necesaria
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extras
    centralHeader.writeUInt16LE(0, 32); // comentario
    centralHeader.writeUInt16LE(0, 34); // nº de disco
    centralHeader.writeUInt16LE(0, 36); // atributos internos
    centralHeader.writeUInt32LE(0, 38); // atributos externos
    centralHeader.writeUInt32LE(offset, 42); // desplazamiento del encabezado local

    centralChunks.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}

/** CRC-32 (polinomio IEEE) para las entradas ZIP. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 1. El bundle de producción debe existir y ser un build (no el de desarrollo).
const bundlePath = path.join(ROOT, 'main.js');
if (!existsSync(bundlePath)) {
  fail('No existe main.js. Ejecuta `npm run build` antes de empaquetar.');
}
const bundle = readFileSync(bundlePath);
if (bundle.includes('sourceMappingURL=main.js.map')) {
  fail('main.js contiene un sourcemap en línea (build de desarrollo). Usa `npm run build`.');
}

// 2. Copiar los tres archivos al paquete.
mkdirSync(PACKAGE_DIR, { recursive: true });
for (const fileName of FILES) {
  const source = path.join(ROOT, fileName);
  if (!existsSync(source)) {
    fail(`Falta el archivo de origen "${fileName}".`);
  }
  copyFileSync(source, path.join(PACKAGE_DIR, fileName));
}

// 3. Regenerar el .zip con las entradas en orden fijo y fecha constante: el
//    archivo resultante depende solo del contenido, no del recorrido del
//    sistema de archivos ni de la hora de empaquetado.
const entries = FILES.map((fileName) => ({
  name: `${PACKAGE_NAME}/${fileName}`,
  content: readFileSync(path.join(PACKAGE_DIR, fileName)),
}));
writeFileSync(ZIP_PATH, buildZip(entries));

// 4. Verificación final: el paquete y el .zip deben coincidir con la raíz.
for (const fileName of FILES) {
  const rootHash = sha256(readFileSync(path.join(ROOT, fileName)));
  const packageHash = sha256(readFileSync(path.join(PACKAGE_DIR, fileName)));
  if (rootHash !== packageHash) {
    fail(`El archivo empaquetado "${fileName}" no coincide con el de la raíz.`);
  }
}

console.log('\n[package:stable] Artefacto de distribución regenerado:');
for (const fileName of FILES) {
  const buffer = readFileSync(path.join(PACKAGE_DIR, fileName));
  console.log(
    `  - zip/${PACKAGE_NAME}/${fileName}  ${buffer.length} bytes  sha256:${sha256(buffer).slice(0, 16)}…`
  );
}
console.log(`  - zip/${PACKAGE_NAME}.zip  ${readFileSync(ZIP_PATH).length} bytes`);
console.log('[package:stable] Listo. Verifica con `npm run test:distribution`.\n');
