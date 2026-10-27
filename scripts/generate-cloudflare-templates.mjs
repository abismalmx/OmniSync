/**
 * Regenera src/templates/cloudflare-worker-template.ts a partir de los archivos
 * fuente de scripts/. Ejecutar con `npm run build:templates` tras editar un worker.
 *
 * El comando de despliegue usa heredocs con delimitador entrecomillado
 * (<<'OMNISYNC_EOF'): bash no interpreta backticks, `${}` ni `$` dentro del
 * cuerpo, así que el contenido de cada archivo llega intacto.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const blossomWorker = read('scripts/cloudflare-blossom-worker.js');
const allInOneWorker = read('scripts/cloudflare-allinone/worker.js');
const wranglerConfig = read('scripts/cloudflare-allinone/wrangler.jsonc');
const packageJson = read('scripts/cloudflare-allinone/package.json');

const DELIMITER = 'OMNISYNC_EOF';
const files = [
  ['package.json', packageJson],
  ['wrangler.jsonc', wranglerConfig],
  ['worker.js', allInOneWorker],
];
for (const [name, content] of files) {
  if (content.split('\n').some((line) => line.trim() === DELIMITER)) {
    throw new Error(`${name} contiene una línea igual al delimitador del heredoc.`);
  }
}

const heredocs = files
  .map(([name, content]) => `cat > ${name} <<'${DELIMITER}'\n${content.replace(/\n$/, '')}\n${DELIMITER}`)
  .join('\n');
const oneLiner =
  'mkdir -p omnisync-server && cd omnisync-server\n' +
  `${heredocs}\n` +
  // La regla borra los archivos con más de 10 días: los avisos del buzón duran 7 y nadie los referencia después.
  // Si la regla ya existe (redespliegue), el aviso de error es inofensivo.
  'npm install && (npx wrangler r2 bucket create omnisync-blossom || true) && ' +
  '(npx wrangler r2 bucket lifecycle add omnisync-blossom expire-blobs --expire-days 10 -y || true) && npx wrangler deploy\n';

const lines = [
  '/**',
  ' * OmniSync - Plantillas Oficiales Embebidas de Cloudflare Workers',
  ' *',
  ' * ARCHIVO GENERADO por scripts/generate-cloudflare-templates.mjs (npm run build:templates).',
  ' * No editar a mano: modifica los archivos de scripts/ y vuelve a generarlo.',
  ' */',
  '',
  '/** Marcador que el asistente sustituye por la clave pública autorizada del usuario. */',
  `export const CLOUDFLARE_PUBKEY_PLACEHOLDER: string = ${JSON.stringify('__OMNISYNC_ALLOWED_PUBKEYS__')};`,
  '',
  `export const CLOUDFLARE_BLOSSOM_WORKER_TEMPLATE: string = ${JSON.stringify(blossomWorker)};`,
  '',
  `export const CLOUDFLARE_ALLINONE_WORKER_TEMPLATE: string = ${JSON.stringify(allInOneWorker)};`,
  '',
  `export const CLOUDFLARE_WRANGLER_CONFIG_TEMPLATE: string = ${JSON.stringify(wranglerConfig)};`,
  '',
  `export const CLOUDFLARE_PACKAGE_JSON_TEMPLATE: string = ${JSON.stringify(packageJson)};`,
  '',
  '/** Comando bash/zsh que crea los tres archivos, instala dependencias y despliega. */',
  `export const CLOUDFLARE_ONELINER_DEPLOY_COMMAND: string = ${JSON.stringify(oneLiner)};`,
  '',
];

writeFileSync(join(root, 'src/templates/cloudflare-worker-template.ts'), lines.join('\n'));
process.stdout.write('Plantillas regeneradas en src/templates/cloudflare-worker-template.ts\n');
