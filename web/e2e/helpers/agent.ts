import { spawn } from 'node:child_process';
import { appEnv, AGENT_SCRIPT, BASE_URL, REPO_ROOT, TEST_AGENT_TOKEN } from './env';

export type SelftestResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/*
 * SPEC 9.0 downloader stand-in: e2e tests seed a waiting track, run
 * `python agent/downloader.py --selftest --track <id>` as a child process
 * with env APP_URL = the test server URL and AGENT_TOKEN = the test server's
 * token, then assert the track became ready. This is the only "song becomes
 * ready" path in tests, because YouTube blocks cloud machines.
 */
export async function runSelftest(trackId: string, opts: { timeoutMs?: number } = {}): Promise<SelftestResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const result = await new Promise<SelftestResult>((resolve, reject) => {
    const child = spawn(process.env.E2E_PYTHON ?? 'python3', [AGENT_SCRIPT, '--selftest', '--track', trackId], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...appEnv(), APP_URL: BASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`--selftest for track ${trackId} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not spawn the downloader (--selftest) for track ${trackId}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
  if (result.code !== 0) {
    throw new Error(`--selftest exited ${result.code} for track ${trackId}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

/*
 * Direct agent API access for tests that exercise the downloader endpoints
 * themselves (e.g. the atomic-claim check, SPEC 8.3 / T1). Bearer-token auth
 * with the test server's AGENT_TOKEN.
 */
export async function agentApi(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}
