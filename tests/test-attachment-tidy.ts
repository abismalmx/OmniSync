/** OmniSync - Ordenar adjuntos: no interpola rutas en CSS y no oculta carpetas ajenas. */
import { planAttachmentTidy, TIDY_ATTACHMENT_CSS } from '../src/security/attachment-tidy';

function assert(c: boolean, m: string) { if (!c) throw new Error(`Assertion failed: ${m}`); }
const none = () => false;

let r = planAttachmentTidy('/', none);
assert(r.setConfig && r.hide, 'raíz por defecto → configura y oculta «Adjuntos»');
r = planAttachmentTidy('', none);
assert(r.setConfig && r.hide, 'vacío → configura y oculta');
r = planAttachmentTidy(undefined, none);
assert(r.setConfig && r.hide, 'sin valor → configura y oculta');
r = planAttachmentTidy('Archivos', none);
assert(!r.setConfig && !r.hide, 'carpeta elegida por el usuario → no se toca ni se oculta');
r = planAttachmentTidy('x\n{}\nbody{background:red}\n.q[a="', none);
assert(!r.setConfig && !r.hide, 'ruta con saltos de línea/llaves → nunca llega al CSS');
r = planAttachmentTidy('Adjuntos', none);
assert(!r.setConfig && r.hide, '«Adjuntos» ya elegido → solo se oculta');
r = planAttachmentTidy('/', (f) => f === 'Adjuntos');
assert(!r.setConfig && !r.hide, '«Adjuntos» con notas del usuario → no se cambia ni se oculta');
assert(!/[{}\n\\]/.test(TIDY_ATTACHMENT_CSS.replace(/\{ display: none; \}/, '')), 'CSS constante, sin datos externos');
console.log('Total: 8 | PASS: 8 | FAIL: 0');
