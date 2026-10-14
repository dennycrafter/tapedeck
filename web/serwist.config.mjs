// Serwist configuration (configurator mode, per https://serwist.pages.dev/docs/next/config).
// Configurator mode is required because @serwist/next's webpack integration does not
// support Turbopack, which is Next 16's default bundler for `next build`.
// The service worker is built AFTER `next build` (see the "build" script in package.json).
// @ts-check
import { serwist } from "@serwist/next/config";

export default serwist({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Precache the app code, styles, icons and fonts, plus the /~offline
  // fallback page, but no other page HTML: every page is behind the password,
  // and a page fetched while the service worker installs could be stored as
  // the login screen. Pages are cached as you visit them instead (app/sw.ts).
  manifestTransforms: [
    (entries) => ({
      manifest: entries.filter((entry) => !/\/server\/(app|pages)\//.test(entry.url) || entry.url.includes("~offline")),
      warnings: [],
    }),
  ],
});
