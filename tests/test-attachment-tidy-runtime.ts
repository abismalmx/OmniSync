/** OmniSync - «Ordenar los adjuntos» ejercido sobre el plugin real con un DOM y un vault simulados. */
(globalThis as any).window = globalThis;
import OmniSyncPlugin from '../src/main';

function assert(c: boolean, m: string) { if (!c) throw new Error(`Assertion failed: ${m}`); }

const styles = new Map<string, { id: string; textContent: string }>();
(globalThis as any).document = {
  getElementById: (id: string) => {
    const el = styles.get(id);
    return el ? { remove: () => styles.delete(id) } : null;
  },
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (el: { id: string; textContent: string }) => { styles.set(el.id, el); } },
};

function make(config: unknown, notes: string[] = [], enabled = true) {
  const cfg: Record<string, unknown> = { attachmentFolderPath: config };
  const plugin: any = Object.create((OmniSyncPlugin as any).prototype);
  plugin.settings = { tidyAttachments: enabled };
  plugin.app = {
    vault: {
      getConfig: (k: string) => cfg[k],
      setConfig: (k: string, v: unknown) => { cfg[k] = v; },
      getMarkdownFiles: () => notes.map((path) => ({ path })),
    },
  };
  return { plugin, cfg };
}

let n = 0;
const ok = (c: boolean, m: string) => { assert(c, m); n++; };

styles.clear();
let h = make('/');
h.plugin.applyAttachmentTidy();
ok(h.cfg.attachmentFolderPath === 'Adjuntos', 'raíz → se configura «Adjuntos»');
ok(styles.size === 1, 'se inyecta un único estilo');

h.plugin.applyAttachmentTidy(); h.plugin.applyAttachmentTidy();
ok(styles.size === 1, 'llamarlo varias veces no duplica el estilo');

h.plugin.settings.tidyAttachments = false;
h.plugin.applyAttachmentTidy();
ok(styles.size === 0, 'apagar el ajuste retira el estilo');
ok(h.cfg.attachmentFolderPath === 'Adjuntos', 'apagar no cambia la ruta ya configurada');

h.plugin.settings.tidyAttachments = true;
h.plugin.applyAttachmentTidy();
ok(styles.size === 1, 'volver a encender lo oculta de nuevo');

styles.clear();
h = make('Archivos');
h.plugin.applyAttachmentTidy();
ok(h.cfg.attachmentFolderPath === 'Archivos' && styles.size === 0, 'carpeta propia del usuario intacta y visible');

h = make('/', ['Adjuntos/nota.md']);
h.plugin.applyAttachmentTidy();
ok(h.cfg.attachmentFolderPath === '/' && styles.size === 0, '«Adjuntos» con notas: no se cambia ni se oculta');

h = make(undefined);
h.plugin.applyAttachmentTidy();
ok(h.cfg.attachmentFolderPath === 'Adjuntos', 'sin valor definido → «Adjuntos»');

h = make('/');
h.plugin.app.vault.getConfig = undefined; h.plugin.app.vault.setConfig = undefined;
h.plugin.applyAttachmentTidy();
ok(styles.size === 0, 'versión de Obsidian sin getConfig/setConfig: no lanza ni oculta nada');

console.log(`Total: ${n} | PASS: ${n} | FAIL: 0`);
