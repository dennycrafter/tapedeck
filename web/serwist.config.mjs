// Serwist configuration (configurator mode, per https://serwist.pages.dev/docs/next/config).
// Configurator mode is required because @serwist/next's webpack integration does not
// support Turbopack, which is Next 16's default bundler for `next build`.
// The service worker is built AFTER `next build` (see the "build" script in package.json),
// which lets Serwist precache the prerendered HTML of every static route automatically.
// @ts-check
import { serwist } from "@serwist/next/config";

export default serwist({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
});
