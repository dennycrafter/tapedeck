import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This file lives at web/e2e/helpers/env.ts.
export const WEB_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..');
export const AGENT_SCRIPT = path.join(REPO_ROOT, 'agent', 'downloader.py');

// SPEC 9.0: the e2e server runs on its own port so a developer's
// `npm run dev` on 3000 never collides with a test run. The server is https:
// SPEC 8.1 marks the session cookie Secure, and WebKit rejects Secure
// cookies on plain http://localhost (Chromium exempts it; the smoke caught
// the difference), so the contract is only exercised faithfully over TLS.
//
// V2-PLAN T9: E2E_PORT and E2E_PROD_PORT pick the ports (defaults 3100 and
// 3102), so several worktrees can run their e2e checks at the same time.
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be a port number from 1024 to 65535, got "${raw}"`);
  }
  return port;
}
export const E2E_PORT = portFromEnv('E2E_PORT', 3100);
export const BASE_URL = `https://localhost:${E2E_PORT}`;
/** The e2e production server (e2e/prod-server.mjs) for the offline checks (T4). */
export const E2E_PROD_PORT = portFromEnv('E2E_PROD_PORT', 3102);
export const PROD_URL = `https://localhost:${E2E_PROD_PORT}`;
/** Its build folder carries the port, so two runs never share one. */
export const E2E_PROD_DIST_DIR = `.next-e2e-${E2E_PROD_PORT}`;

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
// Derived from fixed labels so they are the same in every process of a run
// (config, workers, downloader children) without a 64-character hex
// literal in the repo (T7 hygiene check).
function testSecret(label: string): string {
  return createHash('sha256').update(`tapedeck-e2e-${label}`).digest('hex');
}
export const TEST_SESSION_SECRET = testSecret('session');
export const TEST_AGENT_TOKEN = testSecret('agent');
export const TEST_CRON_SECRET = testSecret('cron');

export type E2ECertificate = { dir: string; keyPath: string; certPath: string };

/*
 * Throwaway self-signed certificate for the https dev server. Generated once
 * per invocation in the config master process and shared with workers and
 * agent children through TAPEDECK_E2E_KEY_FILE / TAPEDECK_E2E_CERT_FILE, so
 * every consumer sees the same key pair. Not a secret: it only covers
 * localhost for this one run.
 */
export function ensureE2ECertificate(): E2ECertificate {
  const certFile = process.env.TAPEDECK_E2E_CERT_FILE;
  const keyFile = process.env.TAPEDECK_E2E_KEY_FILE;
  if (certFile && keyFile) return { dir: path.dirname(certFile), keyPath: keyFile, certPath: certFile };

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tapedeck-e2e-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
  ]);
  process.env.TAPEDECK_E2E_KEY_FILE = keyPath;
  process.env.TAPEDECK_E2E_CERT_FILE = certPath;
  return { dir, keyPath, certPath };
}

/* The generated cert, for consumers that must trust it (agent children). */
export function e2eCertFile(): string {
  const certFile = process.env.TAPEDECK_E2E_CERT_FILE;
  if (!certFile) throw new Error('e2e certificate not generated yet: playwright.config.ts generates it per run');
  return certFile;
}

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
