import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { appEnv, BASE_URL, E2E_PORT } from './e2e/helpers/env';

/*
 * SPEC 9.0 — Playwright starts the app itself with the 4.1 stand-ins:
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

export default defineConfig({
  testDir: './e2e',
  // Playwright owns *.spec.ts; vitest owns *.test.ts (e.g. e2e/mocks/).
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    // SPEC 9.0: desktop (Chromium 1440x900).
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    // SPEC 9.0: iphone (WebKit, devices['iPhone 13']). WebKit is a stand-in
    // for the real phone — lock-screen checks stay in the handoff (SPEC 12).
    {
      name: 'iphone',
      use: { ...devices['iPhone 13'] },
    },
    // SPEC 9.0: android (Chromium, devices['Pixel 7']).
    {
      name: 'android',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: `npm run dev -- -p ${E2E_PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // App env carries TAPEDECK_TEST=1, the throwaway test secrets and the
    // per-run temp data dir (helpers/env.ts).
    env: appEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
