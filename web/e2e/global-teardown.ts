import { rmSync } from 'node:fs';
import path from 'node:path';

/*
 * playwright.config.ts creates the per-run temp dir and exports its path as
 * TAPEDECK_E2E_DATA_DIR; this removes it after the run. If the variable did
 * not survive process handoff this no-ops — OS temp cleanup handles the rest.
 */
export default async function globalTeardown(): Promise<void> {
  const dir = process.env.TAPEDECK_E2E_DATA_DIR;
  // Guardrail: only ever delete a directory this harness created.
  if (!dir || !path.basename(dir).startsWith('tapedeck-e2e-')) return;
  rmSync(dir, { recursive: true, force: true });
}
