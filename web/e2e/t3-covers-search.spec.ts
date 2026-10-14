import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { BASE_URL, TEST_AGENT_TOKEN } from './helpers/env';
import { skipWithoutNet } from './helpers/net';
import { restoreOriginalArtist } from '../lib/clean-title';

/*
 * T3 covers, cleanup and search @T3, iphone project (SPEC 9 T3 checks):
 * the Add window's YouTube search box runs only on submit and shows the
 * SPEC's no-key message; Edit details and Restore original round-trip
 * against the database's kept originals; a SoundCloud song adds with a
 * clean title while a set link is rejected; five pasted music videos come
 * out with clean titles, channel-based artists and matched cover art.
 *
 * The e2e app server runs keyless (helpers/env.ts), so cleanup here is the
 * deterministic rule cleaner and search stays off; the fixture-AI and
 * keyed-search paths are covered by the vitest suites with MSW. Adds make
 * real no-key calls server-side (oEmbed, iTunes, Deezer), so the network
 * tests carry @net.
 *
 * The edit test readies its track through the agent complete API instead
 * of a downloader --selftest: two selftests in one battery race the claim
 * queue (`for update skip locked` hands the oldest waiting rows to one of
 * them and the other's track sticks in `downloading` until the 15-minute
 * stale reset). The complete route is a single UPDATE by id; it never
 * touches the queue, so the T1 tracer keeps its claim lane to itself.
 * Rows are always scoped by data-track-id: the library list is shared
 * between tests, so `.first()`-by-position and hasText filters can match
 * another test's row.
 */

// One stable video per test: a shared in-memory database means every test
// adds a distinct song (a duplicate answers "already in your library").
const EDIT_FIXTURE_URL = 'https://youtu.be/dQw4w9WgXcQ';
const SOUNDCLOUD_SONG_URL = 'https://soundcloud.com/theweeknd/blinding-lights';
const SOUNDCLOUD_SET_URL = 'https://soundcloud.com/theweeknd/sets/house-of-balloons';

// The five recorded music videos (e2e/fixtures/youtube-oembed.json) with
// their rule-cleaner results, captured by running cleanTitleRules on the
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
  { title: 'GANGNAM STYLE (강남스타일)', artist: 'PSY' },
  { title: 'See You Again (feat. Charlie Puth)', artist: 'Wiz Khalifa' },
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

    // Count every request to /api/search from here on (SPEC 8.7: search
    // runs only on Enter or the Search button, never while typing).
    let searchRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/search') searchRequests++;
    });

    // Under two characters the Search button stays disabled: no request.
    const input = page.getByTestId('search-input');
    const submit = page.getByTestId('search-submit');
    await expect(submit).toBeDisabled();
    await input.fill('g');
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId('search-message')).toHaveCount(0);

    // Typing a full query key by key, without Enter or the button, sends nothing.
    await input.fill('');
    await input.pressSequentially('get lucky', { delay: 30 });
    await expect(submit).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(searchRequests, 'typing alone sent no /api/search request').toBe(0);
    await expect(page.getByTestId('search-message')).toHaveCount(0);

    // Submitting sends the search; without a key the SPEC message appears.
    await submit.click();
    await expect(page.getByTestId('search-message')).toHaveText('Add a YouTube key to turn on search');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
    expect(searchRequests, 'the button sent exactly one search').toBe(1);
  });
});

test.describe('T3 adds with cleanup and covers @T3', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'T3 checks run on the iphone project like the T1 tracer');
  skipWithoutNet();
  // The tests share one library list, so run them in order so one test's
  // fresh row (`.first()` right after its toast) is never another test's.
  test.describe.configure({ mode: 'serial' });

  test('edit details changes the row and restore original brings the raw values back', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // The raw values the app will keep: live oEmbed for the fixture, the
    // same upstream the add pipeline reads seconds later. The row right
    // after an add shows the CLEANED title, so raw values can only come
    // from here; restore's contract (8.5) is to bring them back.
    const oembedResponse = await page.request.get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(EDIT_FIXTURE_URL)}&format=json`,
    );
    expect(oembedResponse.status(), 'oEmbed answered for the fixture').toBe(200);
    const oembed = (await oembedResponse.json()) as { title: string; author_name: string };
    const rawTitle = oembed.title;
    const restoredArtist = restoreOriginalArtist(oembed.author_name);

    // A retry finds the first attempt's song still there: remove it first so
    // the add below creates a fresh row.
    const existing = (await (await page.request.get(`${BASE_URL}/api/library`)).json()) as {
      tracks: { id: string; sourceUrl: string }[];
    };
    const videoId = new URL(EDIT_FIXTURE_URL).pathname.slice(1);
    for (const track of existing.tracks.filter((t) => t.sourceUrl.includes(videoId))) {
      await page.request.delete(`${BASE_URL}/api/tracks/${track.id}`);
    }

    // Add through the same API the UI posts to (the session cookie rides
    // on the request context), then ready the track over the agent API.
    const addResponse = await page.request.post(`${BASE_URL}/api/tracks`, {
      data: { urls: [EDIT_FIXTURE_URL] },
    });
    expect(addResponse.status(), 'the add request succeeded').toBe(200);
    const addBody = (await addResponse.json()) as {
      results: Array<{ status: string; track?: { id: string } }>;
    };
    const trackId = addBody.results[0]?.track?.id;
    if (!trackId) throw new Error(`the add response carried no track: ${JSON.stringify(addBody)}`);

    // The complete route is a single UPDATE by id (no claim-queue contact;
    // see the file header); the key is the one storage layout (SPEC 4).
    const completeResponse = await page.request.post(`${BASE_URL}/api/agent/complete`, {
      headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
      data: { trackId, key: `tracks/${trackId}.m4a`, bytes: 1_000_000 },
    });
    expect(completeResponse.status(), 'the agent complete accepted the track').toBe(200);

    await page.reload();
    const row = page.locator(`[data-track-id="${trackId}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('track-status')).toHaveCount(0);

    // The add cleaned the title: the row never shows the raw title before
    // the edit (five-video test pins the cleaner's exact outputs).
    const shownTitle = await row.getByTestId('track-title').textContent();
    expect(shownTitle, 'cleanup stripped the junk from the raw title').not.toBe(rawTitle);

    // Open Edit details from the song's "..." menu (SPEC 10), which sits
    // beside the row button.
    const editButton = {
      click: async () => {
        await page.locator(`[data-item-id="${trackId}"]`).getByTestId('song-menu-button').click();
        await page.getByTestId('menu-edit').click();
      },
    };
    await editButton.click();
    await expect(page.getByTestId('edit-dialog')).toBeVisible();

    await page.getByTestId('edit-title').fill('Edited Title');
    await page.getByTestId('edit-artist').fill('Edited Artist');
    await page.getByTestId('edit-album').fill('Edited Album');
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);

    // The library refetches: the row shows the edited values.
    await expect(row.getByTestId('track-title')).toHaveText('Edited Title');
    await expect(row.getByTestId('track-subtitle')).toHaveText('Edited Artist · Edited Album');

    // Restore original: the kept raw title and suffix-stripped raw artist
    // come back, and the edited album clears.
    await editButton.click();
    await expect(page.getByTestId('edit-dialog')).toBeVisible();
    await page.getByTestId('edit-restore').click();
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);

    await expect(row.getByTestId('track-title')).toHaveText(rawTitle);
    await expect(row.getByTestId('track-subtitle')).toHaveText(restoredArtist);
  });

  test('a SoundCloud song adds with a clean title and a set link is rejected', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // The song goes through the same pipeline (SPEC 8.9): oEmbed metadata,
    // cleanup, cover art. The row shows the cleaned title and artist.
    const before = await page.getByTestId('track-row').first().getAttribute('data-track-id').catch(() => null);
    await pasteAndSubmit(page, SOUNDCLOUD_SONG_URL);
    await expect(page.getByTestId('toast')).toHaveText('1 added');
    // The list refreshes a moment after the toast: wait for the new top row,
    // then scope every assertion to it (a second "Blinding Lights" row exists
    // once the five-video test has run).
    const row = page.getByTestId('track-row').first();
    await expect.poll(() => row.getAttribute('data-track-id'), { timeout: 15_000 }).not.toBe(before);
    const trackId = await row.getAttribute('data-track-id');
    if (!trackId) throw new Error('the new row did not expose its track id');
    const songRow = page.locator(`[data-track-id="${trackId}"]`);
    await expect(songRow.getByTestId('track-title')).toHaveText('Blinding Lights');
    // The subtitle carries the cover-matched album after the artist when
    // one matched, so assert the artist rather than the exact line.
    await expect(songRow.getByTestId('track-subtitle')).toContainText('The Weeknd');

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

    const coverUrls: string[] = [];
    for (const expected of FIVE_MV_EXPECTED) {
      // `.first()`: the SoundCloud test added a same-titled "Blinding
      // Lights" earlier; the '5 added' toast already proves these five
      // are new, and the duplicated title's rows carry identical values.
      const row = page.getByTestId('track-row').filter({ hasText: expected.title }).first();
      await expect(row, `row for ${expected.title}`).toBeVisible();
      await expect(row.getByTestId('track-title')).toHaveText(expected.title);
      await expect(row.getByTestId('track-subtitle')).toContainText(expected.artist);
      // A matched cover renders the artwork image, not the placeholder
      // icon (SPEC 8.5); a live miss is allowed for one of the five.
      const image = row.locator('img');
      if ((await image.count()) > 0) {
        const src = await image.first().getAttribute('src');
        if (src) coverUrls.push(src);
      }
    }

    // SPEC T3: "at least 4 of 5 get a 600x600 cover from live iTunes or Deezer".
    expect(coverUrls.length, `covers shown: ${coverUrls.join(', ')}`).toBeGreaterThanOrEqual(4);
    for (const src of coverUrls) {
      // iTunes covers are the 600x600bb artwork (SPEC 7.6); Deezer's
      // cover_xl is resized to its 600x600 CDN variant (lib/cover-art.ts).
      if (src.includes('mzstatic.com')) expect(src, 'iTunes cover is 600x600').toContain('/600x600bb.');
      if (src.includes('dzcdn.net')) expect(src, 'Deezer cover is 600x600').toContain('/600x600-');
    }
  });
});
