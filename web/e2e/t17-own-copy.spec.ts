import { test, expect } from '@playwright/test';
import { login } from './helpers/login';
import { TEST_AGENT_TOKEN } from './helpers/env';

/*
 * T17 make your own copy @T17: Profile > Downloader setup shows the setup
 * code the PC installer asks for (agent/setup_code.py, covered by pytest),
 * holding the same APP_URL and AGENT_TOKEN as the two rows under it.
 */

test.describe('T17 setup code @T17', () => {
  test('Downloader setup shows a setup code with the app address and agent token', async ({ page }) => {
    await login(page);
    await page.goto('/profile');
    const panel = page.getByTestId('downloader-setup');
    await expect(panel).toContainText('paste this code when it asks');
    const rows = panel.getByTestId('setup-value');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Setup code');

    const code = (await rows.nth(0).locator('code').textContent()) ?? '';
    const appUrl = (await rows.nth(1).locator('code').textContent()) ?? '';
    expect(code.startsWith('tapedeck1:')).toBe(true);
    const packed = JSON.parse(Buffer.from(code.slice('tapedeck1:'.length), 'base64url').toString('utf8')) as { u: string; t: string };
    expect(packed).toEqual({ u: appUrl, t: TEST_AGENT_TOKEN });
    await expect(rows.nth(2)).toContainText(TEST_AGENT_TOKEN);
  });
});
