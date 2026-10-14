import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, seedReadyTracks, uniqueTag } from './helpers/library';
import { PROD_URL } from './helpers/env';

/*
 * T5 checks @T5 (SPEC 9 T5, section 10 rules), on every page, on every
 * project (the iphone project is the 390px check). They run against the
 * production e2e server so development-only console noise does not count.
 *  - no sideways scroll: scrollWidth <= innerWidth
 *  - no U+2013 or U+2014 in any rendered text
 *  - at most one visible element with the accent as its background
 *  - no console errors
 * The pages have made-up songs, a playlist and a favourite album; nothing
 * is playing, so the player's own accent button is not on screen.
 */

// The service worker runs, as it does for real users.
test.use({ baseURL: PROD_URL, serviceWorkers: 'allow' });

const ACCENT = 'rgb(255, 122, 26)';

const made: { trackIds: string[]; playlistIds: string[] } = { trackIds: [], playlistIds: [] };

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

interface PageFacts {
  scrollWidth: number;
  innerWidth: number;
  dashes: string[];
  accents: string[];
}

async function facts(page: Page): Promise<PageFacts> {
  return page.evaluate((accent) => {
    const text = document.body.innerText;
    const dashes = [...text.matchAll(/.{0,20}[\u2013\u2014].{0,20}/g)].map((m) => m[0]);
    const accents: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const style = getComputedStyle(el);
      if (style.backgroundColor !== accent) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.closest('[hidden], [aria-hidden="true"]')) continue;
      accents.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}]`);
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      dashes,
      accents,
    };
  }, ACCENT);
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`));
  return errors;
}

async function check(page: Page, path: string, errors: string[], ready: () => Promise<void>): Promise<void> {
  errors.length = 0;
  await page.goto(path);
  await ready();
  // Let polls and images settle before reading the page.
  await page.waitForTimeout(800);
  const f = await facts(page);
  expect.soft(f.scrollWidth, `${path}: no sideways scroll`).toBeLessThanOrEqual(f.innerWidth);
  expect.soft(f.dashes, `${path}: no long dashes in text`).toEqual([]);
  expect.soft(f.accents.length, `${path}: at most one accent (${f.accents.join(', ')})`).toBeLessThanOrEqual(1);
  expect.soft(errors, `${path}: no console errors`).toEqual([]);
}

test.describe('T5 UI rules @T5', () => {
  test('every page: no sideways scroll, no long dashes, one accent, no console errors', async ({ page, browser }) => {
    test.setTimeout(180_000);
    // The password screen, logged out.
    const fresh = await browser.newContext({ baseURL: PROD_URL, ignoreHTTPSErrors: true });
    const loginPage = await fresh.newPage();
    const loginErrors = watchConsole(loginPage);
    await check(loginPage, '/login', loginErrors, () => expect(loginPage.getByRole('button', { name: 'Unlock' })).toBeVisible());
    await fresh.close();

    await login(page);
    const errors = watchConsole(page);
    const tag = uniqueTag();
    const album = `Review Album ${tag}`;
    const songs = await seedReadyTracks(page.request, [
      { title: `Review one ${tag}`, artist: `Review Band ${tag}`, album, albumArtist: `Review Band ${tag}` },
      { title: `Review two ${tag}`, artist: `Review Band ${tag}`, album, albumArtist: `Review Band ${tag}` },
      { title: `Review three ${tag}`, artist: 'Someone Else' },
    ]);
    made.trackIds.push(...songs.map((song) => song.id));
    const created = (await (await page.request.post('/api/playlists', { data: { name: `Review ${tag}` } })).json()) as {
      id: string;
    };
    made.playlistIds.push(created.id);
    await page.request.post(`/api/playlists/${created.id}/tracks`, { data: { trackIds: songs.map((s) => s.id) } });
    await page.request.put('/api/albums/favorite', {
      data: { album, albumArtist: `Review Band ${tag}`, favorite: true },
    });
    await page.request.put(`/api/tracks/${songs[0].id}/like`, { data: { liked: true } });

    const greeting = () => expect(page.getByTestId('home-greeting')).toBeVisible();
    const main = () => expect(page.locator('main').first()).toBeVisible();
    await check(page, '/', errors, async () => {
      await greeting();
      await expect(page.getByTestId('home-recently-added')).toBeVisible();
    });
    await check(page, '/search', errors, () => expect(page.getByTestId('library-search')).toBeVisible());
    for (const tab of ['songs', 'liked', 'playlists', 'albums', 'artists', 'recent', 'downloaded']) {
      await check(page, tab === 'songs' ? '/library' : `/library?tab=${tab}`, errors, main);
    }
    await check(page, `/playlist?id=${created.id}`, errors, () => expect(page.getByTestId('playlist-tracks')).toBeVisible());
    await check(page, `/album?name=${encodeURIComponent(album)}&artist=${encodeURIComponent(`Review Band ${tag}`)}`, errors, () =>
      expect(page.getByTestId('album-tracks')).toBeVisible(),
    );
    await check(page, `/artist?name=${encodeURIComponent(`Review Band ${tag}`)}`, errors, () =>
      expect(page.getByTestId('artist-tracks')).toBeVisible(),
    );
    await check(page, '/profile', errors, () => expect(page.getByTestId('profile-stats')).toBeVisible());
  });
});
