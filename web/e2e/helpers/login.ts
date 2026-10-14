import { expect, type Page } from '@playwright/test';
import { APP_PASSWORD } from './env';

// SPEC 8.1: /login is one password field with an "Unlock" button; a successful
// POST /api/login sets the `tapedeck_session` cookie. SPEC 9.0: tests log in
// with the dev password. Only correct-password attempts are made here, because the
// login route 429s after 5 wrong attempts in 10 minutes (SPEC 8.1).
export async function login(page: Page, password: string = APP_PASSWORD): Promise<void> {
  await page.goto('/login');
  if (!page.url().includes('/login')) return; // already signed in, /login bounced us back

  const input = page.locator('input[type="password"]');
  // React hydration wipes a fill that lands before the controlled input is
  // wired up, and the form then submits an empty password (the WebKit project
  // hydrates slower than Chromium, which is how the smoke caught this).
  // Wait for React to own the input before filling.
  await page.waitForFunction(() => {
    const node = document.querySelector('input[type="password"]');
    return node != null && Object.keys(node).some((key) => key.startsWith('__reactProps$'));
  });
  await input.fill(password);
  await expect(input).toHaveValue(password); // the value took through onChange
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page).not.toHaveURL(/\/login/);

  const session = (await page.context().cookies()).find((cookie) => cookie.name === 'tapedeck_session');
  if (!session) throw new Error('Login succeeded but no tapedeck_session cookie was set (SPEC 8.1)');
}
