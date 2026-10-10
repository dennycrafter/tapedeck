import path from 'node:path';

// This file lives at web/e2e/helpers/env.ts.
export const WEB_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..');
export const AGENT_SCRIPT = path.join(REPO_ROOT, 'agent', 'downloader.py');

// SPEC 9.0: the e2e server runs on its own fixed port so a developer's
// `npm run dev` on 3000 never collides with a test run.
export const E2E_PORT = 3100;
export const BASE_URL = `http://localhost:${E2E_PORT}`;

// SPEC 4.1: APP_PASSWORD defaults to `tapedeck-dev` in development.
// Tests pass it explicitly (appEnv below) so every run is deterministic.
export const APP_PASSWORD = 'tapedeck-dev';

/*
 * Throwaway 64-hex test values. SPEC 4.1 says SESSION_SECRET / AGENT_TOKEN /
 * CRON_SECRET are 64-hex values. These are NOT secrets: they only sign
 * cookies and local-storage URLs for the disposable in-memory app that
 * Playwright starts per run. The agent helper hands the same AGENT_TOKEN to
 * `downloader.py --selftest` ("AGENT_TOKEN = the test server's token", 9.0).
 */
export const TEST_SESSION_SECRET = '985f0778eb4219b59803c37237c7167b31ca025500bdf2e166720c9aa7ee122a';
export const TEST_AGENT_TOKEN = '6e05ba201312f6c769135801d4f54c3ba2011d25f262d9bff7f4ce5ded383b58';
export const TEST_CRON_SECRET = '98b4a0fa034a44303ad1c30a5c52a45ea2096a94b69b7133880830d604a3654c';

/*
 * The exact environment the app-under-test needs to run on the 4.1 stand-ins
 * (SPEC 9.0: TAPEDECK_TEST=1, in-memory PGlite, local storage in a temp
 * folder). Used by three consumers so they cannot drift apart:
 *   - playwright.config.ts passes it to the webServer it starts,
 *   - helpers/db.ts applies it before loading web/lib/db.ts and storage.ts,
 *   - helpers/agent.ts passes it to --selftest child processes.
 * TAPEDECK_DATA_DIR points at the harness's per-run temp dir so the app's
 * test-mode stand-in data (if it honors the variable) is isolated per run;
 * if the app manages its own `.data/` location instead, the variable is
 * ignored harmlessly.
 */
export function appEnv(): Record<string, string> {
  const dataDir = process.env.TAPEDECK_E2E_DATA_DIR;
  return {
    TAPEDECK_TEST: '1',
    APP_PASSWORD,
    SESSION_SECRET: TEST_SESSION_SECRET,
    AGENT_TOKEN: TEST_AGENT_TOKEN,
    CRON_SECRET: TEST_CRON_SECRET,
    NEXT_TELEMETRY_DISABLED: '1',
    ...(dataDir ? { TAPEDECK_DATA_DIR: dataDir } : {}),
  };
}
