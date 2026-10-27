// OmniSync - ESLint flat config
// Auditoría de calidad y seguridad: reglas de "correctness" activadas por
// defecto (no-unused-vars, no-undef, no-constant-condition, etc.) más un
// conjunto de plugins de seguridadpara JavaScript/TypeScript.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "zip/**",
      "assets/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        ArrayBuffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        WebSocket: "readonly",
        RTCPeerConnection: "readonly",
        RTCDataChannel: "readonly",
        performance: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        require: "readonly",
        module: "writable",
      },
    },
    rules: {
      // --- Corrección / bugs ---
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-undef": "off",
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-fallthrough": "error",
      "no-self-compare": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-optional-chaining": "error",
      "no-async-promise-executor": "error",
      "no-return-await": "error",
      "require-await": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-param-reassign": "error",
      "no-shadow": "error",
      "no-useless-escape": "error",
      // `no-control-regex` se desactiva de forma deliberada: el proyecto usa
      // rangos de caracteres de control de forma intencional en sus
      // validaciones de seguridad (rechazar entradas con \u0000-\u001f) y en
      // el saneador de texto externo (eliminar secuencias ANSI). El patrón
      // ES la detección del carácter peligroso, no un uso accidental.
      "no-control-regex": "off",
      "no-prototype-builtins": "error",
      "prefer-promise-reject-errors": "error",
      "no-implicit-coercion": ["error", { boolean: false }],

      // --- TypeScript ---
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-empty-function": "off",

      // --- Seguridad (eslint-plugin-security) ---
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-non-literal-fs-filename": "error",
      "security/detect-child-process": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-bidi-characters": "warn",
      "security/detect-invisible-characters": "warn",
    },
  },
  {
    // Los tests y el worker de Cloudflare usan APIs de Node y variables relaxed.
    files: ["tests/**/*.ts", "scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "off",
      "no-console": "off",
    },
  },
  {
    // El test del artefacto de distribución lee archivos con rutas calculadas a
    // partir de la raíz del proyecto. Esas rutas no provienen de entrada no
    // confiable (no hay entrada externa en un test), por lo que la regla de
    // nombre de archivo no literal no aporta seguridad aquí.
    files: ["tests/test-distribution-artifact.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // Suites .mjs ejecutadas con Node: globals del runtime de Node.
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  }
);
