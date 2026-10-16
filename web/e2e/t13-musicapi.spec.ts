import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';

/*
 * T13 MusicAPI login @T13 (V2-PLAN T13, "login flow (fake provider)"): the
 * MusicAPI importer with its stand-in (TAPEDECK_TEST=1), so nothing reaches
 * MusicAPI. "Log in to Spotify" opens the fake MusicAPI page
 * (/api/test/musicapi-login), "Allow" comes back through
 * /api/import/callback/musicapi with the signed state, and the fixture
 * library (e2e/fixtures/import-musicapi/responses.json) fills the checklist:
 * Liked songs and two playlists, read page by page. Two playlists are
 * imported; the Daft Punk songs match the recorded Deezer answers
 * (e2e/fixtures/import-deezer.json). Cancelling and a changed state come back
 * with plain messages. Everything the import made is deleted in afterEach:
 * the three projects share one in-memory database.
 */

const LIKED = 'Liked songs from Spotify';
const NIGHT = 'Night drive mix';
const PLAYLIST_NAMES = [LIKED, NIGHT, 'Old mixtape', 'Liked songs from Deezer'];
const SONG_TITLES = ['Harder, Better, Faster, Stronger', 'Something About Us', 'Static Bloom', 'Veridis Quo'];

type LibraryTrack = { id: string; title: string; artist: string; album: string | null; source: string };
type Library = { tracks: LibraryTrack[]; playlists: { id: string; name: string; trackIds: string[] }[] };

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const snapshot = await library(request);
  for (const playlist of snapshot.playlists.filter((p) => PLAYLIST_NAMES.includes(p.name))) {
    await request.delete(`/api/playlists/${playlist.id}`);
  }
  for (const track of snapshot.tracks.filter((t) => SONG_TITLES.includes(t.title))) {
    await request.delete(`/api/tracks/${track.id}`);
  }
}

async function openService(page: Page, service: string, label: string): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  await page.locator(`[data-testid="import-service"][data-service="${service}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/import\\?service=${service}$`));
  await expect(page.getByTestId('import-title')).toHaveText(`Import from ${label}`);
}

function playlistRow(page: Page, ref: string) {
  return page.locator(`[data-testid="import-playlist"][data-ref="${ref}"]`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request);
});

test.describe('T13 MusicAPI login @T13', () => {
  test('log in to Spotify through MusicAPI, pick playlists, import them', async ({ page }) => {
    test.setTimeout(90_000);
    await openService(page, 'spotify', 'Spotify');
    const slot = page.getByTestId('import-slot-login');
    await expect(slot).toContainText('Log in and pick from all your playlists and liked songs.');

    // The fake MusicAPI page, then back through the callback.
    await page.getByTestId('import-login').click();
    await expect(page).toHaveURL(/\/api\/test\/musicapi-login\?/);
    await expect(page.getByTestId('musicapi-standin-title')).toHaveText('Log in to Spotify');
    await page.getByTestId('musicapi-allow').click();
    await expect(page).toHaveURL(/\/import\?job=/);

    // Every page of playlists, Liked songs first, with counts.
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Liked songs', NIGHT, 'Old mixtape']);
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-facts')).toHaveText('3 songs');
    await expect(playlistRow(page, 'mapi-pl-night').getByTestId('import-playlist-facts')).toHaveText('2 songs');
    await playlistRow(page, 'mapi-pl-gone').getByTestId('import-playlist-check').click();
    await expect(page.getByTestId('import-start')).toHaveText('Import 2 playlists');

    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-progress')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    // Harder, Better, Faster, Stronger is in both playlists: it counts once.
    await expect(page.getByTestId('import-progress-text')).toHaveText('0 of 4 ready, 4 waiting');
    await expect(page.getByTestId('import-progress-playlist')).toHaveText([LIKED, NIGHT]);

    // Same order as MusicAPI's pages; the ISRC song matched the catalog, the unknown one kept its own details.
    const snapshot = await library(page.request);
    const titlesOf = (name: string) =>
      snapshot.playlists.find((p) => p.name === name)?.trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)?.title);
    expect(titlesOf(LIKED)).toEqual(['Harder, Better, Faster, Stronger', 'Something About Us', 'Static Bloom']);
    expect(titlesOf(NIGHT)).toEqual(['Veridis Quo', 'Harder, Better, Faster, Stronger']);
    const byTitle = (title: string) => snapshot.tracks.find((t) => t.title === title);
    expect(byTitle('Harder, Better, Faster, Stronger')).toMatchObject({ source: 'catalog', artist: 'Daft Punk', album: 'Discovery' });
    expect(byTitle('Static Bloom')).toMatchObject({ source: 'catalog', artist: 'The Stand-in Trio, Fixture Friend', album: 'Stand-in Songs' });
  });

  test('a cancelled log in and a changed link come back with plain messages', async ({ page }) => {
    await openService(page, 'deezer', 'Deezer');
    await page.getByTestId('import-login').click();
    await expect(page.getByTestId('musicapi-standin-title')).toHaveText('Log in to Deezer');
    await page.getByTestId('musicapi-cancel').click();
    await expect(page).toHaveURL(/\/import\?error=/);
    await expect(page.getByTestId('import-error')).toHaveText('The log in was cancelled or did not work. Try again.');

    // A return address whose job id was changed is refused.
    await page.locator('[data-testid="import-service"][data-service="deezer"]').click();
    await page.getByTestId('import-login').click();
    await expect(page.getByTestId('musicapi-allow')).toBeVisible();
    const allow = new URL((await page.getByTestId('musicapi-allow').getAttribute('href')) ?? '');
    const [, expiry, signature] = (allow.searchParams.get('state') ?? '').split('.');
    allow.searchParams.set('state', `00000000-0000-4000-8000-000000000000.${expiry}.${signature}`);
    await page.goto(allow.toString());
    await expect(page).toHaveURL(/\/import\?error=/);
    await expect(page.getByTestId('import-error')).toHaveText('That log in has expired. Start again.');
  });
});
