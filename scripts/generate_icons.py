import base64

with open('assets/omnisync-badge-128-opt.png', 'rb') as f:
    b64_badge = base64.b64encode(f.read()).decode('utf-8')

with open('assets/omnisync-emblem-tight-opt.png', 'rb') as f:
    b64_emblem = base64.b64encode(f.read()).decode('utf-8')

with open('assets/omnisync-banner-opt.png', 'rb') as f:
    b64_banner = base64.b64encode(f.read()).decode('utf-8')

icon_data = 'data:image/png;base64,' + b64_badge
emblem_data = 'data:image/png;base64,' + b64_emblem
banner_data = 'data:image/png;base64,' + b64_banner

ts_lines = [
    "/**",
    " * OmniSync - Custom Brand Icons and Graphics",
    " * Iconos y emblemas oficiales registrados en Obsidian mediante addIcon()",
    " */",
    "",
    "import { addIcon } from 'obsidian';",
    "",
    "/** Base64 del emblema circular / badge optimizado para el Ribbon y Modales */",
    f"export const OMNISYNC_ICON_DATA = '{icon_data}';",
    "",
    "/** Base64 de la silueta horizontal del emblema artístico */",
    f"export const OMNISYNC_EMBLEM_DATA = '{emblem_data}';",
    "",
    "/** Base64 del banner oficial completo (Emblema + Tipografía OMNISYNC) */",
    f"export const OMNISYNC_BANNER_DATA = '{banner_data}';",
    "",
    "/** SVG para addIcon: Emblema estelar en disco cósmico (Badge oficial para Ribbon y UI) */",
    'export const OMNISYNC_LOGO_SVG = `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" class="omnisync-svg-badge">',
    '  <image href="${OMNISYNC_ICON_DATA}" width="100" height="100" preserveAspectRatio="xMidYMid meet" />',
    '</svg>`;',
    "",
    "/** SVG para addIcon: Silueta artística horizontal */",
    'export const OMNISYNC_EMBLEM_SVG = `<svg viewBox="0 0 128 81" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">',
    '  <image href="${OMNISYNC_EMBLEM_DATA}" width="128" height="81" preserveAspectRatio="xMidYMid meet" />',
    '</svg>`;',
    "",
    "/** SVG para addIcon: Variante vectorial geométrica nativa Obsidian */",
    'export const OMNISYNC_VECTOR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
    '  <circle cx="7" cy="12" r="4.5" />',
    '  <ellipse cx="7" cy="12" rx="1.8" ry="4.5" />',
    '  <circle cx="17" cy="12" r="4.5" />',
    '  <ellipse cx="17" cy="12" rx="1.8" ry="4.5" />',
    '  <path d="M7 7.5 C 10 5.2, 14 5.2, 17 7.5" stroke-dasharray="1 2" />',
    '  <path d="M7 16.5 C 10 18.8, 14 18.8, 17 16.5" />',
    '  <circle cx="12" cy="12" r="1.2" fill="currentColor" />',
    '</svg>`;',
    "",
    "/**",
    " * Registra todos los iconos oficiales de OmniSync en el sistema de Obsidian.",
    " * Permite usar 'omnisync-logo', 'omnisync-badge', 'omnisync-emblem' y 'omnisync-vector'.",
    " */",
    "export function registerOmniSyncIcons(): void {",
    "  addIcon('omnisync-logo', OMNISYNC_LOGO_SVG);",
    "  addIcon('omnisync-badge', OMNISYNC_LOGO_SVG);",
    "  addIcon('omnisync-emblem', OMNISYNC_EMBLEM_SVG);",
    "  addIcon('omnisync-vector', OMNISYNC_VECTOR_SVG);",
    "}",
    ""
]

with open('src/ui/icons.ts', 'w') as f:
    f.write('\n'.join(ts_lines))

print('src/ui/icons.ts successfully written!')
