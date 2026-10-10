/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

// The injection point below is replaced at build time with the precache manifest
// (prerendered route HTML, .next/static chunks, and everything in public/, per
// serwist.config.mjs).
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // defaultCache: fonts, images and static assets get runtime caching; every
  // same-origin /api/* request stays network-only (SPEC 8.9).
  runtimeCaching: defaultCache,
  fallbacks: {
    entries: [
      {
        // Offline navigation fallback: when a document request fails (no network),
        // serve the precached /~offline page (SPEC 8.9).
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
