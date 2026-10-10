import { setupServer } from 'msw/node'
import type { SetupServer } from 'msw/node'

import { handlers } from './handlers'

/**
 * MSW server for Tapedeck's external APIs, backed by the recorded fixtures
 * in web/e2e/fixtures/ (SPEC 9.0). Importing this module has no side effects:
 * interception only starts when startTestMocks() is called AND TAPEDECK_TEST=1,
 * so nothing is ever mocked outside the test stand-ins (SPEC 4.1, 8.12).
 */
export const server: SetupServer = setupServer(...handlers)

let started = false

/**
 * Register the mock handlers. No-op and returns false unless TAPEDECK_TEST=1;
 * returns true when interception is (already) active. Idempotent — MSW warns
 * on a second listen, so repeat calls reuse the running server.
 */
export function startTestMocks(
  options: { onUnhandledRequest?: 'bypass' | 'error' | 'warn' } = {},
): boolean {
  if (process.env.TAPEDECK_TEST !== '1') return false
  if (started) return true
  server.listen({ onUnhandledRequest: options.onUnhandledRequest ?? 'bypass' })
  started = true
  return true
}

/** Stop intercepting (test teardown). Safe to call when never started. */
export function stopTestMocks(): void {
  if (!started) return
  server.close()
  started = false
}
