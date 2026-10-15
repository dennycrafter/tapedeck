import { test, expect, type Locator, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { librarySnapshot, seedReadyTracks } from './helpers/library';

/*
 * T11 catalog search @T11 (V2-PLAN T11 item 8), on every project. The e2e
 * app server runs with TAPEDECK_TEST=1, so the catalog answers from the
 * recorded Deezer responses (e2e/fixtures/catalog-deezer.json) and never
 * calls Deezer or iTunes. Cover images still load from Deezer's CDN in the
 * browser, like library covers do (helpers/net.ts).
 *
 * The flow: search "daft punk" (debounced while typing), the Top, Songs and
 * Artists tabs, open the artist, open an album, Add one song, Add album,
 * the "In library" flags (one from a library song with the same title and
 * artist), the catalog waiting label in the library, and the YouTube tab
 * (Enter or button only, quota note kept). Every song a test creates is
 * deleted afterwards: the three projects share one database and later
 * tickets expect it clean.
 */

const ARTIST_ID = 'deezer:27';
const ALBUM_ID = 'deezer:6575789'; // Random Access Memories, 13 songs
const FIRST_SONG = 'deezer:67238728'; // Give Life Back to Music
const INSTANT_CRUSH = 'deezer:67238732';
// The dev server compiles a page and its API route on first visit; that can take
// well over the default 10 s on a busy machine.
const FIRST_LOAD = 45_000;

let before = new Set<string>();

test.beforeEach(async ({ page }) => {
  await login(page);
  before = new Set((await librarySnapshot(page.request)).tracks.map((track) => track.id));
});

test.afterEach(async ({ page }) => {
  const now = await librarySnapshot(page.request);
  for (const track of now.tracks) {
    if (!before.has(track.id)) await page.request.delete(`/api/tracks/${track.id}`);
  }
});

async function noSidewaysScroll(page: Page, where: string): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${where}: no sideways scroll`).toBeLessThanOrEqual(innerWidth);
}

/** React owns the box: a fill before hydration is wiped (WebKit hydrates slower, see helpers/login.ts). */
async function waitForSearchBox(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="library-search"]');
    return node != null && Object.keys(node).some((key) => key.startsWith('__reactProps$'));
  });
}

// Next keeps the pages you came from in the DOM, hidden, for Back; scope every
// lookup to the page on screen.
function catalogRow(scope: Locator, id: string) {
  return scope.locator(`[data-testid="catalog-track"][data-catalog-id="${id}"]`);
}

test.describe('T11 catalog search @T11', () => {
  test('search, artist, album, Add one song, Add album and the In library flags', async ({ page }) => {
    test.setTimeout(240_000);
    // A library song with the same title and artist as a catalog song (8.5 rules).
    await seedReadyTracks(page.request, [{ title: 'Instant Crush', artist: 'Daft Punk' }]);

    let searches = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/catalog/search') searches++;
    });

    await page.goto('/search');
    const search = page.getByTestId('search-page');
    const box = search.getByTestId('library-search');
    await expect(box).toBeVisible();
    await expect(search.getByTestId('search-hint')).toBeVisible();
    await waitForSearchBox(page);
    await box.pressSequentially('daft punk', { delay: 40 });

    // Top tab: the library match first, then catalog artists, songs, albums.
    const topSongs = search.getByTestId('catalog-top-songs');
    await expect(topSongs.getByTestId('catalog-track')).toHaveCount(5, { timeout: FIRST_LOAD });
    expect(searches, 'typing searched once after the pause, not per key').toBeLessThanOrEqual(2);
    await expect(search.getByTestId('search-library')).toContainText('Instant Crush');
    await expect(search.getByTestId('catalog-top-artists').locator(`a[href="/catalog/artist?id=${encodeURIComponent(ARTIST_ID)}"]`)).toBeVisible();
    await expect(search.getByTestId('catalog-top-albums').getByTestId('catalog-album-tile').first()).toBeVisible();
    await expect(catalogRow(search, INSTANT_CRUSH).getByTestId('catalog-in-library')).toHaveText('In library');
    await expect(catalogRow(search, INSTANT_CRUSH).getByTestId('catalog-add')).toHaveCount(0);
    await noSidewaysScroll(page, 'search top');

    // Songs tab: the full list.
    await search.getByTestId('search-tab-songs').click();
    await expect(search.getByTestId('catalog-songs').getByTestId('catalog-track')).toHaveCount(25);
    await expect(page).toHaveURL(/\/search\?q=daft\+punk&tab=songs/);

    // Artists tab, open the artist.
    await search.getByTestId('search-tab-artists').click();
    await search.getByTestId('catalog-artists').locator(`a[href="/catalog/artist?id=${encodeURIComponent(ARTIST_ID)}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/artist\\?id=${encodeURIComponent(ARTIST_ID)}`));
    const artistPage = page.getByTestId('catalog-artist-page');
    await expect(artistPage.getByTestId('catalog-title')).toHaveText('Daft Punk', { timeout: FIRST_LOAD });
    await expect(artistPage.getByTestId('catalog-artist-top').getByTestId('catalog-track')).toHaveCount(10);
    await expect(artistPage.getByTestId('catalog-artist-singles')).toBeVisible();
    await noSidewaysScroll(page, 'catalog artist');

    // Open the album.
    await artistPage.getByTestId('catalog-artist-albums').locator('a[title="Random Access Memories"]').click();
    await expect(page).toHaveURL(new RegExp(`/catalog/album\\?id=${encodeURIComponent(ALBUM_ID)}`));
    const albumPage = page.getByTestId('catalog-album-page');
    await expect(albumPage.getByTestId('catalog-title')).toHaveText('Random Access Memories', { timeout: FIRST_LOAD });
    await expect(albumPage.getByTestId('catalog-album-artist')).toHaveText('Daft Punk');
    const tracks = albumPage.getByTestId('catalog-album-tracks').getByTestId('catalog-track');
    await expect(tracks).toHaveCount(13);
    await expect(catalogRow(albumPage, INSTANT_CRUSH).getByTestId('catalog-in-library')).toBeVisible();
    await noSidewaysScroll(page, 'catalog album');

    // Add one song.
    await catalogRow(albumPage, FIRST_SONG).getByTestId('catalog-add').click();
    await expect(page.getByTestId('toast')).toHaveText('1 added');
    await expect(catalogRow(albumPage, FIRST_SONG).getByTestId('catalog-in-library')).toBeVisible();
    await expect(albumPage.getByTestId('catalog-album-owned')).toHaveText('2 songs already in your library');

    // Add album: the 11 songs still missing.
    const addAlbum = albumPage.getByTestId('catalog-add-album');
    await expect(addAlbum).toHaveText('Add album');
    await addAlbum.click();
    await expect(page.getByTestId('toast')).toHaveText('11 added');
    await expect(addAlbum).toHaveText('All in library');
    await expect(addAlbum).toBeDisabled();
    await expect(albumPage.getByTestId('catalog-album-tracks').getByTestId('catalog-add')).toHaveCount(0);

    // The flags come from the server after a reload too.
    await page.reload();
    await expect(albumPage.getByTestId('catalog-album-tracks').getByTestId('catalog-in-library')).toHaveCount(13);

    // The songs wait in the library with the catalog label, with the catalog's clean values.
    const snapshot = await librarySnapshot(page.request);
    const added = snapshot.tracks.filter((track) => !before.has(track.id) && track.album === 'Random Access Memories');
    expect(added).toHaveLength(12);
    await page.goto('/library');
    const item = page.locator('[data-testid="track-item"]').filter({ hasText: 'Give Life Back to Music' });
    await expect(item.getByTestId('track-status')).toHaveText('Waiting for your PC to find it');
    await expect(item.getByTestId('track-subtitle')).toHaveText('Daft Punk · Random Access Memories');

    // Back in search, the added songs show In library.
    await page.goto('/search?q=daft+punk&tab=songs');
    await expect(catalogRow(page.getByTestId('search-page'), 'deezer:67238735').getByTestId('catalog-in-library')).toBeVisible(); // Get Lucky
  });

  test('the YouTube tab still searches only on Enter or the button, with the quota note', async ({ page }) => {
    let youtubeSearches = 0;
    let youtubeQuery: string | null = null;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname !== '/api/search') return;
      youtubeSearches++;
      youtubeQuery = url.searchParams.get('q');
    });
    await page.goto('/search');
    await waitForSearchBox(page);
    await page.getByTestId('library-search').fill('get lucky');
    await page.getByTestId('search-tab-youtube').click();

    const box = page.getByTestId('search-input');
    await expect(box).toHaveValue('get lucky');
    await expect(page.getByTestId('search-note')).toHaveText(
      "Search uses YouTube's free daily limit (about 100 searches a day).",
    );
    await box.fill('');
    await box.pressSequentially('get lucky live', { delay: 30 });
    await page.waitForTimeout(800);
    expect(youtubeSearches, 'typing alone sent no YouTube search').toBe(0);
    // The cursor stayed in the YouTube box the whole time.
    await expect(box).toHaveValue('get lucky live');
    await expect(page.getByTestId('library-search')).toHaveValue('get lucky');

    await box.press('Enter');
    // The e2e server has no YouTube key, so the search answers with the stand-in message.
    await expect(page.getByTestId('search-message')).toHaveText('Add a YouTube key to turn on search', { timeout: FIRST_LOAD });
    expect(youtubeSearches).toBe(1);
    expect(youtubeQuery).toBe('get lucky live');
  });

  test('unknown catalog ids show a not-found message', async ({ page }) => {
    await page.goto('/catalog/album?id=deezer:999');
    await expect(page.getByTestId('not-found')).toHaveText("This album isn't in the catalog.", { timeout: FIRST_LOAD });
    await page.goto('/catalog/artist?id=not-an-id');
    await expect(page.getByTestId('not-found')).toHaveText("This artist isn't in the catalog.");
  });
});
