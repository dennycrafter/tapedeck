/// <reference lib="esnext" />
/// <reference lib="webworker" />
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { CacheableResponsePlugin, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

// The injection point below is replaced at build time with the precache manifest
// (prerendered route HTML, .next/static chunks, and everything in public/, per
// serwist.config.mjs). The test-mode build (scripts/build-dev-sw.mjs) leaves it
// undefined: no precache, the runtime rules below do all the work.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/*
 * Runtime caching (SPEC 8.9), written out instead of @serwist/next's
 * defaultCache: that preset caches /api/* responses (network first, with a
 * cache fallback) and caches nothing at all in development. Here:
 *  - every /api/* call is network only, and so is audio from storage (the
 *    phone's offline songs live in IndexedDB, not the Cache API);
 *  - pages are network first, so a page opened once also opens offline;
 *  - app code, styles, fonts and icons are served from cache and refreshed
 *    in the background;
 *  - cover art from iTunes or Deezer is kept so covers show offline.
 */
const runtimeCaching: RuntimeCaching[] = [
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ request }) => request.destination === "audio" || request.headers.has("range"),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
    handler: new NetworkFirst({
      cacheName: "pages",
      networkTimeoutSeconds: 4,
      plugins: [
        new CacheableResponsePlugin({ statuses: [200] }),
        new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      ],
    }),
  },
  {
    // RSC payloads for client-side navigation between cached pages.
    matcher: ({ request, sameOrigin }) => sameOrigin && request.headers.get("RSC") === "1",
    handler: new NetworkFirst({
      cacheName: "pages-rsc",
      networkTimeoutSeconds: 4,
      plugins: [
        new CacheableResponsePlugin({ statuses: [200] }),
        new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      ],
    }),
  },
  {
    matcher: ({ request, sameOrigin }) =>
      sameOrigin && ["script", "style", "font", "image", "manifest", "worker"].includes(request.destination),
    handler: new StaleWhileRevalidate({
      cacheName: "app-assets",
      plugins: [
        new CacheableResponsePlugin({ statuses: [200] }),
        new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      ],
    }),
  },
  {
    matcher: ({ request, sameOrigin }) => !sameOrigin && request.destination === "image",
    handler: new StaleWhileRevalidate({
      cacheName: "covers",
      plugins: [
        // Covers load as no-cors images, which arrive as opaque responses (status 0).
        new CacheableResponsePlugin({ statuses: [0, 200] }),
        new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 90 * 24 * 60 * 60 }),
      ],
    }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  // No navigation preload: offline it can hand a page the wrong response,
  // and pages are small; the network-first rule above is enough.
  navigationPreload: false,
  runtimeCaching,
  fallbacks: {
    entries: [
      {
        // A page never opened before and no network: serve the precached
        // /~offline page (SPEC 8.9). Production builds only (it is precached).
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
