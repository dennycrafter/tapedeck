import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { runSelftest } from './helpers/agent';
import { skipWithoutNet } from './helpers/net';

/*
 * T3 covers, cleanup and search @T3, iphone project (SPEC 9 T3 checks):
 * the Add window's YouTube search box runs only on submit and shows the
 * SPEC's no-key message; Edit details and Restore original round-trip
 * against the database's kept originals; a SoundCloud song adds with a
 * clean title while a set link is rejected; five pasted music videos come
 * out with clean titles, channel-based artists and matched cover art.
 *
 * The e2e app server runs keyless (helpers/env.ts), so cleanup here is the
 * deterministic rule cleaner and search stays off — the fixture-AI and
 * keyed-search paths are covered by the vitest suites with MSW. Adds make
 * real no-key calls server-side (oEmbed, iTunes, Deezer), so the network
 * tests carry @net.
 */

// One stable video per test — shared in-memory database means every test
// adds a distinct song (a duplicate answers "already in your library").
const EDIT_FIXTURE_URL = 'https://youtu.be/dQw4w9WgXcQ';
const SOUNDCLOUD_SONG_URL = 'https://soundcloud.com/theweeknd/blinding-lights';
const SOUNDCLOUD_SET_URL = 'https://soundcloud.com/theweeknd/sets/house-of-balloons';

// The five recorded music videos (e2e/fixtures/youtube-oembed.json) with
// their rule-cleaner results — captured by running cleanTitleRules on the
// recorded raw titles (the AI path is Anthropic-optional and absent here).
const FIVE_MV_URLS = [
  'https://youtu.be/4NRXx6U8ABQ',
  'https://youtu.be/kJQP7kiw5Fk',
  'https://youtu.be/9bZkp7q19f0',
  'https://youtu.be/RgKAFK5djSk',
  'https://youtu.be/OPf0YbXqDm0',
];
const FIVE_MV_EXPECTED: Array<{ title: string; artist: string }> = [
  { title: 'Blinding Lights', artist: 'The Weeknd' },
  { title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi' },
  { title: 'GANGNAM STYLE(강남스타일)', artist: 'PSY' },
  { title: 'See You Again (feat. Charlie Puth Furious 7 Soundtrack)', artist: 'Wiz Khalifa' },
  { title: 'Uptown Funk (feat. Bruno Mars)', artist: 'Mark Ronson' },
];

async function pasteAndSubmit(page: Page, urls: string | string[]): Promise<void> {
  await page.getByTestId('add-open').first().click();
  await page.getByTestId('add-input').fill(Array.isArray(urls) ? urls.join('\n') : urls);
  await page.getByTestId('add-submit').click();
}

test.describe('T3 search box @T3', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'T3 checks run on the iphone project like the T1 tracer');

  // No network: the e2e server is keyless, so a submitted search answers
  // with the stand-in no-key response without leaving the machine.
  test('the search box runs only on submit and shows the no-key message', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.getByTestId('add-open').first().click();

    // The daily-limit note is always visible under the box (SPEC 8.7).
    await expect(page.getByTestId('search-note')).toHaveText(
      "Search uses YouTube's free daily limit (about 100 searches a day).",
    );

    // Under two characters the Search button stays disabled — no request.
    const input = page.getByTestId('search-input');
    const submit = page.getByTestId('search-submit');
    await expect(submit).toBeDisabled();
    await input.fill('g');
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId('search-message')).toHaveCount(0);

    // Submitting sends the search; without a key the SPEC message appears.
    await input.fill('get lucky');
    await submit.click();
    await expect(page.getByTestId('search-message')).toHaveText('Add a YouTube key to turn on search');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
  });
});

test.describe('T3 adds with cleanup and covers @T3', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'T3 checks run on the iphone project like the T1 tracer');
  skipWithoutNet();

  test('edit details changes the row and restore original brings the raw values back', async ({ page }) => {
    test.setTimeout(240_000); // the --selftest child may take a couple of minutes

    await login(page);
    await page.goto('/');
    await pasteAndSubmit(page, EDIT_FIXTURE_URL);
    await expect(page.getByTestId('toast')).toHaveText('1 added');

    const row = page.getByTestId('track-row').first();
    await expect(row).toBeVisible();
    // The raw values come from live oEmbed — capture them instead of
    // hardcoding, so the restore assertion survives upstream title drift.
    const rawTitle = await row.getByTestId('track-title').textContent();
    const rawSubtitle = await row.getByTestId('track-subtitle').textContent();
    expect(rawTitle).toBeTruthy();
    const trackId = await row.getAttribute('data-track-id');
    expect(trackId, 'row exposes its track id for the selftest').toBeTruthy();

    const selftest = await runSelftest(trackId as string);
    expect(selftest.code, `selftest failed:\n${selftest.stdout}\n${selftest.stderr}`).toBe(0);
    await expect(row.getByTestId('track-status')).toHaveCount(0, { timeout: 30_000 });

    // Play the song to load the player bar, then open Edit details.
    await row.click();
    const editButton = page.getByTestId('player-edit');
    await expect(editButton).toBeVisible();
    await editButton.click();
    await expect(page.getByTestId('edit-dialog')).toBeVisible();

    await page.getByTestId('edit-title').fill('Edited Title');
    await page.getByTestId('edit-artist').fill('Edited Artist');
    await page.getByTestId('edit-album').fill('Edited Album');
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);

    // The library refetches: the row shows the edited values.
    const editedRow = page.getByTestId('track-row').filter({ hasText: 'Edited Title' });
    await expect(editedRow).toHaveCount(1);
    await expect(editedRow.getByTestId('track-title')).toHaveText('Edited Title');
    await expect(editedRow.getByTestId('track-subtitle')).toHaveText('Edited Artist · Edited Album');

    // Restore original: the kept raw title and channel artist come back.
    await editButton.click();
    await expect(page.getByTestId('edit-dialog')).toBeVisible();
    await page.getByTestId('edit-restore').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);

    const restoredRow = page.getByTestId('track-row').filter({ hasText: rawTitle as string });
    await expect(restoredRow).toHaveCount(1);
    await expect(restoredRow.getByTestId('track-title')).toHaveText(rawTitle as string);
    await expect(restoredRow.getByTestId('track-subtitle')).toHaveText(rawSubtitle as string);
  });

  test('a SoundCloud song adds with a clean title and a set link is rejected', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // The song goes through the same pipeline (SPEC 8.9): oEmbed metadata,
    // cleanup, cover art — the row shows the cleaned title and artist.
    await pasteAndSubmit(page, SOUNDCLOUD_SONG_URL);
    await expect(page.getByTestId('toast')).toHaveText('1 added');
    const row = page.getByTestId('track-row').filter({ hasText: 'Blinding Lights' });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('track-title')).toHaveText('Blinding Lights');
    await expect(row.getByTestId('track-subtitle')).toHaveText('The Weeknd');

    // A set link is a per-line error and adds nothing (SPEC 8.9).
    await pasteAndSubmit(page, SOUNDCLOUD_SET_URL);
    await expect(page.getByTestId('add-window')).toBeVisible();
    await expect(page.getByTestId('add-results')).toContainText(
      'Playlists from SoundCloud are not supported yet. Paste single songs.',
    );
  });

  test('five pasted music videos add with clean titles, artists and cover art', async ({ page }) => {
    test.setTimeout(120_000); // five adds, each with live metadata and cover lookups

    await login(page);
    await page.goto('/');
    await pasteAndSubmit(page, FIVE_MV_URLS);
    await expect(page.getByTestId('toast')).toHaveText('5 added', { timeout: 30_000 });

    for (const expected of FIVE_MV_EXPECTED) {
      const row = page.getByTestId('track-row').filter({ hasText: expected.title });
      await expect(row, `row for ${expected.title}`).toHaveCount(1);
      await expect(row.getByTestId('track-title')).toHaveText(expected.title);
      await expect(row.getByTestId('track-subtitle')).toContainText(expected.artist);
      // The cover matched: the row renders the artwork image, not the
      // placeholder icon (SPEC 8.5).
      await expect(row.locator('img')).toHaveCount(1);
    }
  });
});
