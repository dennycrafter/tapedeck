import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';

/*
 * T13 Spotify link @T13 (V2-PLAN T13, Adapters item 2, and the plan's e2e
 * item "paste a Spotify link (fixture)"). The app server runs with
 * TAPEDECK_TEST=1, so the adapter reads Spotify's public pages from the
 * recordings in e2e/fixtures/import-spotify-link/pages.json and never
 * reaches Spotify; song matching uses the recorded Deezer answers.
 *
 * Everything the import made is deleted in afterEach (songs that were in the
 * library before the test stay): the three projects share one database.
 */

const ESSENTIALS = '5FPvD2X2jBM782H8zGgjT3';
const ESSENTIALS_LINK = `https://open.spotify.com/playlist/${ESSENTIALS}?si=e2e`;
const PLAYLIST_NAME = 'Daft Punk Essentials';

type Library = {
  tracks: { id: string; title: string; status: string }[];
  playlists: { id: string; name: string; trackIds: string[] }[];
};

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

let before = new Set<string>();

async function openSpotify(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  // A cold dev server can still be hydrating the Add window on the first
  // test of a run: repeat the tap until the import page opens.
  await expect(async () => {
    if (!/\/import\?service=spotify$/.test(page.url())) {
      await page.locator('[data-testid="import-service"][data-service="spotify"]').click({ timeout: 5_000 });
    }
    await expect(page).toHaveURL(/\/import\?service=spotify$/, { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByTestId('import-title')).toHaveText('Import from Spotify');
}

async function pasteLinks(page: Page, ...links: string[]): Promise<void> {
  await page.getByTestId('import-links').fill(links.join('\n'));
  await page.getByTestId('import-find').click();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  before = new Set((await library(page.request)).tracks.map((track) => track.id));
});

test.afterEach(async ({ page }) => {
  const snapshot = await library(page.request);
  for (const playlist of snapshot.playlists.filter((p) => p.name === PLAYLIST_NAME)) {
    await page.request.delete(`/api/playlists/${playlist.id}`);
  }
  for (const track of snapshot.tracks.filter((t) => !before.has(t.id))) {
    await page.request.delete(`/api/tracks/${track.id}`);
  }
});

test.describe('T13 Spotify link @T13', () => {
  test('paste a Spotify playlist link (fixture) and import it', async ({ page }) => {
    test.setTimeout(120_000);
    await openSpotify(page);
    // Only the link slot, with the limits in plain words.
    await expect(page.getByTestId('import-slot-link')).toContainText('Public playlists only');
    await expect(page.getByTestId('import-slot-link')).toContainText('first 100 songs');

    await pasteLinks(page, ESSENTIALS_LINK);
    await expect(page).toHaveURL(/\/import\?job=/);
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText([PLAYLIST_NAME]);
    const row = page.locator(`[data-testid="import-playlist"][data-ref="${ESSENTIALS}"]`);
    await expect(row.getByTestId('import-playlist-facts')).toHaveText('49 songs');
    await expect(row.getByTestId('import-playlist-check')).toBeChecked();
    await expect(page.getByTestId('import-start')).toHaveText('Import 1 playlist');

    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-progress')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(page.getByTestId('import-progress-playlist')).toHaveText([PLAYLIST_NAME]);
    // 49 songs, 47 in the playlist: two "Drumless Edition" songs count as
    // their album versions (the core's "already in your library" rule).
    await expect(page.getByTestId('import-progress-text')).toHaveText(/^\d+ of 47 ready/);

    // Same name and order; matched songs take the catalog's names, the rest keep Spotify's.
    const snapshot = await library(page.request);
    const playlist = snapshot.playlists.find((p) => p.name === PLAYLIST_NAME);
    expect(playlist?.trackIds).toHaveLength(47);
    const titles = (playlist?.trackIds ?? []).map((id) => snapshot.tracks.find((t) => t.id === id)?.title);
    expect(titles.slice(0, 5)).toEqual([
      'One More Time',
      'Veridis Quo',
      'Human After All',
      'Harder, Better, Faster, Stronger',
      'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
    ]);
  });

  test('a profile link lists its public playlists', async ({ page }) => {
    await openSpotify(page);
    await pasteLinks(page, 'https://open.spotify.com/user/spotify', ESSENTIALS_LINK);
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    const names = page.getByTestId('import-playlist-name');
    await expect(names).toHaveCount(11);
    await expect(names.first()).toHaveText('Today’s Top Hits');
    await expect(names.nth(1)).toHaveText('RapCaviar');
    await expect(names.last()).toHaveText(PLAYLIST_NAME);
  });

  test('links Spotify cannot give read plainly', async ({ page }) => {
    await openSpotify(page);
    await pasteLinks(page, 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc');
    await expect(page.getByTestId('import-error')).toHaveText(
      'This is a Spotify album link. Paste a playlist or profile link instead: https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc',
    );
    await page.getByTestId('import-again').click();
    await expect(page.getByTestId('import-connect')).toBeVisible();

    const missing = 'https://open.spotify.com/playlist/0000000000000000000000';
    await pasteLinks(page, missing);
    await expect(page.getByTestId('import-error')).toHaveText(
      `Couldn't open this playlist. Check the link, and that the playlist is public: ${missing}`,
    );
  });
});
