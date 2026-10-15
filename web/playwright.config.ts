import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  appEnv,
  BASE_URL,
  E2E_PORT,
  E2E_PROD_DIST_DIR,
  E2E_PROD_PORT,
  ensureE2ECertificate,
  PROD_URL,
} from './e2e/helpers/env';

/*
 * SPEC 9.0: Playwright starts the app itself with the 4.1 stand-ins:
 * TAPEDECK_TEST=1 (in-memory PGlite, local storage in a temp folder), and
 * every test logs in with the dev password. No secrets are needed except the
 * `@live` tests (npm run e2e:live).
 *
 * Tag scheme (SPEC 9.0): each test title carries its ticket tag @T0..@T8;
 * `npm run e2e:tN` runs a ticket's own tag plus every earlier tag. @net tests
 * self-skip without internet; @live tests run only via `npm run e2e:live`
 * when the 5.1 variables exist.
 */

// One temp dir per Playwright invocation, shared with the app server and the
// helper processes through appEnv() (see helpers/env.ts). The harness-internal
// name is read again by e2e/global-teardown.ts to clean up.
const dataDir = process.env.TAPEDECK_E2E_DATA_DIR ?? mkdtempSync(path.join(os.tmpdir(), 'tapedeck-e2e-'));
process.env.TAPEDECK_E2E_DATA_DIR = dataDir;

// Throwaway self-signed cert covering localhost (see helpers/env.ts): SPEC 8.1
// marks the session cookie Secure, and WebKit only stores Secure cookies over
// https, so the harness serves TLS too.
const e2eCert = ensureE2ECertificate();

// Chromium checks a service worker script's certificate even with
// ignoreHTTPSErrors, so the self-signed run certificate would stop the
// offline checks (T4) from installing one. This flag trusts it.
const CHROMIUM_TLS = { args: ['--ignore-certificate-errors'] };

export default defineConfig({
  testDir: './e2e',
  // Playwright owns *.spec.ts; vitest owns *.test.ts (e.g. e2e/mocks/).
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  // One worker: the app server's in-memory PGlite is a single library every
  // spec in a run shares, and specs assert on it (t1's empty state, t3's
  // row checks). Parallel workers added rows to each other's libraries and
  // flipped shared status mid-assertion; serial tests make the shared state
  // deterministic (t0's smoke runs first, then t1 on a still-empty
  // library, then later tickets add on top).
  workers: 1,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // On CI the 'github' reporter turns each failure into an annotation on the
  // check run, readable through the API when the raw logs are not.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true, // the self-signed run certificate
    trace: 'retain-on-failure',
    // The app's service worker stays out of the way of every test except the
    // offline ones (T4), which opt in with test.use({ serviceWorkers: 'allow' }):
    // Playwright's request routing does not see requests a service worker
    // makes in WebKit.
    serviceWorkers: 'block',
  },
  projects: [
    // SPEC 9.0: desktop (Chromium 1440x900).
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, launchOptions: CHROMIUM_TLS },
    },
    // SPEC 9.0: iphone (WebKit, devices['iPhone 13']). WebKit is a stand-in
    // for the real phone; lock-screen checks stay in the handoff (SPEC 12).
    {
      name: 'iphone',
      use: { ...devices['iPhone 13'] },
    },
    // SPEC 9.0: android (Chromium, devices['Pixel 7']).
    {
      name: 'android',
      use: { ...devices['Pixel 7'], launchOptions: CHROMIUM_TLS },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- -p ${E2E_PORT} --experimental-https --experimental-https-key "${e2eCert.keyPath}" --experimental-https-cert "${e2eCert.certPath}"`,
      url: BASE_URL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // App env carries TAPEDECK_TEST=1, the throwaway test secrets and the
      // per-run temp data dir (helpers/env.ts).
      env: appEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    },
    // A production build on the same stand-ins, for the offline checks (T4):
    // only production runs the service worker with its precache. Building
    // takes a minute or two (e2e/prod-server.mjs).
    {
      command: 'node e2e/prod-server.mjs',
      url: PROD_URL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        ...appEnv(),
        TAPEDECK_DIST_DIR: E2E_PROD_DIST_DIR,
        TAPEDECK_E2E_PROD_PORT: String(E2E_PROD_PORT),
        TAPEDECK_E2E_KEY_FILE: e2eCert.keyPath,
        TAPEDECK_E2E_CERT_FILE: e2eCert.certPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
