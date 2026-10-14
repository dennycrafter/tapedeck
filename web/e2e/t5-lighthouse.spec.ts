import { test, expect, chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { login } from './helpers/login';
import { cleanup, seedReadyTracks, uniqueTag } from './helpers/library';
import { PROD_URL } from './helpers/env';

/*
 * T5 check @T5: Lighthouse accessibility score of 90 or more on Home and
 * Library (SPEC 9 T5). Runs once, on the desktop project, against the
 * production e2e server, in Playwright's own Chromium, logged in through
 * the session cookie. Failing audits are listed in the message.
 */

test.use({ baseURL: PROD_URL });

const made: { trackIds: string[] } = { trackIds: [] };

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

test('Lighthouse accessibility is 90 or more on Home and Library @T5', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, 'Runs once, on the desktop project');
  test.setTimeout(240_000);
  await login(page);
  const songs = await seedReadyTracks(page.request, [
    { title: `Lighthouse one ${uniqueTag()}`, artist: 'Band' },
    { title: `Lighthouse two ${uniqueTag()}`, artist: 'Band', album: 'Some Album', albumArtist: 'Band' },
  ]);
  made.trackIds.push(...songs.map((song) => song.id));
  const session = (await page.context().cookies()).find((cookie) => cookie.name === 'tapedeck_session');
  expect(session, 'logged in').toBeTruthy();

  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox', '--ignore-certificate-errors', '--disable-gpu'],
  });
  const results: string[] = [];
  try {
    for (const path of ['/', '/library']) {
      const run = await lighthouse(`${PROD_URL}${path}`, {
        port: chrome.port,
        onlyCategories: ['accessibility'],
        extraHeaders: { Cookie: `tapedeck_session=${session!.value}` },
        logLevel: 'error',
        output: 'json',
        formFactor: 'desktop',
        screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
      });
      const lhr = run!.lhr;
      const score = Math.round((lhr.categories.accessibility?.score ?? 0) * 100);
      const failing = Object.values(lhr.audits)
        .filter((audit) => audit.score === 0 && audit.scoreDisplayMode === 'binary')
        .map((audit) => audit.id);
      results.push(`${path}: ${score}${failing.length ? ` (failing: ${failing.join(', ')})` : ''}`);
      expect.soft(score, `${path} accessibility score; failing audits: ${failing.join(', ') || 'none'}`).toBeGreaterThanOrEqual(90);
    }
  } finally {
    chrome.kill();
  }
  test.info().annotations.push({ type: 'lighthouse', description: results.join(' | ') });
  console.log(`[lighthouse] ${results.join(' | ')}`);
});
