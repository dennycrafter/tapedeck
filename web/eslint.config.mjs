import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // The e2e production server's build (e2e/prod-server.mjs).
    ".next-e2e/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated service worker (see serwist.config.mjs):
    "public/sw.js",
    "public/swe-worker*.js",
  ]),
]);

export default eslintConfig;
