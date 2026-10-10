import { rmSync } from 'node:fs';
import path from 'node:path';

/*
 * playwright.config.ts creates the per-run temp dirs and exports their paths
 * (TAPEDECK_E2E_DATA_DIR, TAPEDECK_E2E_CERT_FILE); this removes them after
 * the run. If a variable did not survive process handoff this no-ops — OS
 * temp cleanup handles the rest.
 */
export default async function globalTeardown(): Promise<void> {
  const dataDir = process.env.TAPEDECK_E2E_DATA_DIR;
  const certFile = process.env.TAPEDECK_E2E_CERT_FILE;
  const certDir = certFile ? path.dirname(certFile) : '';
  // Guardrail: only ever delete a directory this harness created.
  if (dataDir && path.basename(dataDir).startsWith('tapedeck-e2e-')) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (certDir && path.basename(certDir).startsWith('tapedeck-e2e-cert-')) {
    rmSync(certDir, { recursive: true, force: true });
  }
}
