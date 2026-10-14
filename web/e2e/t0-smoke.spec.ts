import { test, expect } from '@playwright/test';
import { login } from './helpers/login';
import { forbidNonLocalRequests } from './helpers/net';

/*
 * SPEC 9.0 harness smoke (@T0): the e2e harness runs against the app's
 * stand-ins. Three assertions per the T0e-w1 verification contract (login,
 * /api/health, /test-audio loads) on all three projects, with a tripwire
 * proving the browser makes no requests beyond localhost.
 */

test.describe('T0 smoke @T0', () => {
  forbidNonLocalRequests();

  test('login: / redirects to /login unauthenticated, dev password reaches Home', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    await login(page); // throws if no tapedeck_session cookie was set (SPEC 8.1)

    // SPEC T0 check: the right password reaches Home. Content is not asserted
    // here; Home's shape evolves with later tickets.
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('health: 401 without a session, STAND-IN database and storage with one', async ({ page }) => {
    // The proxy gates every API route (SPEC 8.1): no cookie means 401.
    const anonymous = await page.request.get('/api/health');
    expect(anonymous.status()).toBe(401);

    // page.request shares the context's cookies, so this call is authenticated.
    await login(page);
    const health = await page.request.get('/api/health');
    expect(health.status()).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body.database).toBe('STAND-IN'); // SPEC T0: stand-ins active in test mode
    expect(body.storage).toBe('STAND-IN');
    // Network services must be reported but stay unasserted: their values
    // come from the MSW fixtures or are skipped, and this smoke must make
    // no requests beyond localhost (SPEC 9.0).
    for (const service of ['youtube', 'soundcloud', 'anthropic', 'itunes', 'deezer']) {
      expect(body).toHaveProperty(service);
    }
  });

  test('test-audio: gated page loads with its controls', async ({ page }) => {
    await login(page);
    await page.goto('/test-audio');
    // SPEC T0 step 8 labels; the page also pins data-testids for later tickets.
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save test1 offline' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play offline copy' })).toBeVisible();
  });
});
