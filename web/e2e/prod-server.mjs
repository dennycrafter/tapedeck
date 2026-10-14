// e2e production server (SPEC 9.0, T4): a real production build of the app,
// served over https with the run's self-signed certificate, on the same
// stand-ins as the dev test server (TAPEDECK_TEST=1: in-memory PGlite, local
// storage). The offline checks need it: only a production build runs the
// service worker with its precache, and `next dev` will not start the app
// from cached files with the network off.
//
// Builds into .next-e2e (TAPEDECK_DIST_DIR) so it never touches the dev
// server's .next. Set TAPEDECK_E2E_SKIP_BUILD=1 to reuse the last build.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TAPEDECK_E2E_PROD_PORT ?? 3102);
const distDir = process.env.TAPEDECK_DIST_DIR ?? '.next-e2e';
process.env.TAPEDECK_DIST_DIR = distDir;

const keyFile = process.env.TAPEDECK_E2E_KEY_FILE;
const certFile = process.env.TAPEDECK_E2E_CERT_FILE;
if (!keyFile || !certFile) throw new Error('prod-server: TAPEDECK_E2E_KEY_FILE and TAPEDECK_E2E_CERT_FILE must be set (playwright.config.ts does this)');

const skipBuild = process.env.TAPEDECK_E2E_SKIP_BUILD === '1' && existsSync(path.join(webRoot, distDir, 'BUILD_ID'));
if (!skipBuild) {
  const env = { ...process.env, NODE_ENV: 'production' };
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log(`[prod-server] building into ${distDir} ...`);
  execFileSync(npx, ['next', 'build'], { cwd: webRoot, env, stdio: 'inherit' });
  execFileSync(npx, ['serwist', 'build', 'serwist.config.mjs'], { cwd: webRoot, env, stdio: 'inherit' });
}

process.env.NODE_ENV = 'production';
const { default: next } = await import('next');
const app = next({ dev: false, dir: webRoot, hostname: 'localhost', port });
const handle = app.getRequestHandler();
await app.prepare();

createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  void handle(req, res);
}).listen(port, 'localhost', () => {
  console.log(`[prod-server] ready on https://localhost:${port}`);
});
