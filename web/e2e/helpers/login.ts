import { expect, type Page } from '@playwright/test';
import { APP_PASSWORD } from './env';

// SPEC 8.1: /login is one password field with an "Unlock" button; a successful
// POST /api/login sets the `tapedeck_session` cookie. SPEC 9.0: tests log in
// with the dev password. Only correct-password attempts are made here — the
// login route 429s after 5 wrong attempts in 10 minutes (SPEC 8.1).
export async function login(page: Page, password: string = APP_PASSWORD): Promise<void> {
  await page.goto('/login');
  if (!page.url().includes('/login')) return; // already signed in, /login bounced us back

  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page).not.toHaveURL(/\/login/);

  const session = (await page.context().cookies()).find((cookie) => cookie.name === 'tapedeck_session');
  if (!session) throw new Error('Login succeeded but no tapedeck_session cookie was set (SPEC 8.1)');
}
