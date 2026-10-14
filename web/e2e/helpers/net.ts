import { test } from '@playwright/test';

/*
 * SPEC 9.0 network tags:
 *  - @net  tests make real no-key calls (YouTube oEmbed, SoundCloud oEmbed,
 *          iTunes, Deezer). Without internet they are skipped and noted in
 *          TEST-REPORT.md, not failed.
 *  - @live tests use real accounts (the 5.1 variables). They run only via
 *          `npm run e2e:live` when those variables exist; otherwise they are
 *          skipped and listed in the handoff as "runs after you go live".
 */

const LIVE_ENV_VARS = [
  'APP_PASSWORD',
  'SESSION_SECRET',
  'DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
] as const;

// Probed once per worker process, in the background, so a slow or dead
// network never stalls the first test's beforeEach.
const internetProbe: Promise<boolean> = (async () => {
  try {
    await fetch('https://itunes.apple.com/search?term=tapedeck&limit=1', {
      signal: AbortSignal.timeout(5_000),
    });
    return true; // any HTTP response proves outbound internet
  } catch {
    return false;
  }
})();

export function skipWithoutNet(): void {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(!(await internetProbe), '@net: no internet on this machine, skipped and noted in TEST-REPORT.md (SPEC 9.0)');
  });
}

export function skipWithoutLive(): void {
  test.beforeEach(async (_fixtures, testInfo) => {
    const missing = LIVE_ENV_VARS.filter((name) => !process.env[name]);
    testInfo.skip(missing.length > 0, `@live: missing 5.1 variables (${missing.join(', ')}); runs after you go live, via npm run e2e:live`);
  });
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/*
 * Browser-level tripwire for "no network beyond localhost" (SPEC 9.0): any
 * request the page attempts outside the test server is aborted and the test
 * fails in afterEach with the recorded URLs. Image requests are exempt:
 * since SPEC 8.5 the library renders cover artwork from the iTunes/Deezer
 * CDNs, so remote images are a product contract, not an accident. Scripts,
 * fonts, analytics, and API calls still fail the test. Note: requests made
 * by a service worker bypass Playwright routing (known limitation), so the
 * guard therefore proves the page itself stays local; server-side calls are
 * invisible to it by design.
 */
export function forbidNonLocalRequests(): void {
  const attempted: string[] = [];

  test.beforeEach(async ({ context }) => {
    attempted.length = 0;
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (LOCAL_HOSTS.has(hostname)) return route.fallback();
      if (route.request().resourceType() === 'image') return route.fallback();
      attempted.push(route.request().url());
      return route.abort();
    });
  });

  test.afterEach(() => {
    if (attempted.length > 0) {
      throw new Error(`Test reached beyond localhost (${attempted.length} request(s), aborted): ${attempted.slice(0, 5).join(', ')}`);
    }
  });
}
