import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { WEB_ROOT } from './helpers/env';

/*
 * T13 File upload checks @T13 (V2-PLAN T13, adapter 5,
 * web/lib/importers/file-import.ts): upload an Exportify "Export All" zip on
 * Spotify, an Apple Music Library.xml on Apple Music and a TuneMyMusic CSV,
 * see the checklist, import a playlist from each of the first two, and get a
 * plain message for a file that is none of these. The files are hand-made
 * fixtures (e2e/fixtures/import-file-import/); the zip is built here from
 * the Exportify CSVs. Matching uses the recorded Deezer answers
 * (e2e/fixtures/import-deezer.json): Harder, Better, Faster, Stronger by
 * ISRC, Veridis Quo and Something About Us by search, the rest unmatched.
 * Everything the imports made is deleted in afterEach: the three projects
 * share one in-memory database.
 */

const FIXTURES = path.join(WEB_ROOT, 'e2e', 'fixtures', 'import-file-import');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

const PLAYLIST_NAMES = [
  'Liked songs from Spotify',
  'Road trip',
  'Chill',
  'Late Night Drive',
  'Liked songs from Apple Music',
  'Sunday Morning',
  'Road Trip',
  'Only Daft Punk',
];
const SONG_TITLES = [
  'Harder, Better, Faster, Stronger',
  'Something About Us',
  'Veridis Quo',
  'Paper Lanterns',
  'Kitchen Radio',
  'Slow Morning',
  'September Haze',
  'Café & Rain',
];

type Library = {
  tracks: { id: string; title: string }[];
  playlists: { id: string; name: string; trackIds: string[] }[];
};

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

async function playlistTitles(request: APIRequestContext, name: string): Promise<(string | undefined)[] | undefined> {
  const snapshot = await library(request);
  const playlist = snapshot.playlists.find((p) => p.name === name);
  return playlist?.trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)?.title);
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

async function openService(page: Page, service: 'spotify' | 'apple', label: string): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  await page.locator(`[data-testid="import-service"][data-service="${service}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/import\\?service=${service}$`));
  await expect(page.getByTestId('import-title')).toHaveText(`Import from ${label}`);
  await expect(page.getByTestId('import-slot-file')).toContainText('Exportify');
}

async function uploadFile(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page.getByTestId('import-file').setInputFiles({ name, mimeType, buffer });
  await page.getByTestId('import-upload').click();
}

function playlistRow(page: Page, ref: string) {
  return page.locator(`[data-testid="import-playlist"][data-ref="${ref}"]`);
}

/** Unticks everything, ticks one playlist, imports it and waits for the progress to finish. */
async function importOne(page: Page, ref: string): Promise<void> {
  const selectAll = page.getByTestId('import-select-all');
  if (await selectAll.isChecked()) await selectAll.click();
  await playlistRow(page, ref).getByTestId('import-playlist-check').click();
  await expect(page.getByTestId('import-start')).toHaveText('Import 1 playlist');
  await page.getByTestId('import-start').click();
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await cleanup(page.request);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request);
});

test.describe('T13 File upload @T13', () => {
  test('an Exportify zip on Spotify lists every playlist and imports one in order', async ({ page }) => {
    test.setTimeout(90_000);
    await openService(page, 'spotify', 'Spotify');
    const zip = zipSync({
      'liked.csv': fixture('liked.csv'),
      'road_trip.csv': fixture('road_trip.csv'),
      'chill.csv': fixture('chill.csv'),
    });
    await uploadFile(page, 'spotify_playlists.zip', 'application/zip', Buffer.from(zip));

    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Liked songs', 'Road trip', 'Chill']);
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-facts')).toHaveText('2 songs');
    // The podcast episode in the file is not a song.
    await expect(playlistRow(page, 'file:road-trip').getByTestId('import-playlist-facts')).toHaveText('4 songs');

    await importOne(page, 'file:road-trip');
    await expect(page.getByTestId('import-progress-text')).toHaveText('0 of 4 ready, 4 waiting');
    await expect(page.getByTestId('import-progress-playlist')).toHaveText(['Road trip']);
    expect(await playlistTitles(page.request, 'Road trip')).toEqual([
      'Veridis Quo',
      'Harder, Better, Faster, Stronger',
      'Paper Lanterns',
      'Kitchen Radio',
    ]);
  });

  test('an Apple Music Library.xml offers only the playlists made by the owner', async ({ page }) => {
    test.setTimeout(90_000);
    await openService(page, 'apple', 'Apple Music');
    await uploadFile(page, 'Library.xml', 'text/xml', fixture('Library.xml'));

    await expect(page.getByTestId('import-checklist')).toBeVisible();
    // Library, Music, Downloaded, Purchased, Podcasts, the "Mixes" folder and the
    // ready-made "Recently Added" are left out; the loved song is the liked list.
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Loved songs', 'Sunday Morning', 'Road Trip', 'Only Daft Punk']);
    await expect(playlistRow(page, 'apple:7C1D2E3F4051627A').getByTestId('import-playlist-facts')).toHaveText('3 songs');

    await importOne(page, 'apple:7C1D2E3F4051627A');
    await expect(page.getByTestId('import-progress-text')).toHaveText('0 of 3 ready, 3 waiting');
    expect(await playlistTitles(page.request, 'Sunday Morning')).toEqual(['Slow Morning', 'Something About Us', 'Café & Rain']);
  });

  test('a TuneMyMusic CSV lists its playlists, and an unknown file gets a plain message', async ({ page }) => {
    await openService(page, 'spotify', 'Spotify');
    await uploadFile(page, 'My Spotify library.csv', 'text/csv', fixture('tunemymusic.csv'));
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Favorite Songs', 'Late Night Drive']);
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-facts')).toHaveText('2 songs');
    await expect(playlistRow(page, 'file:late-night-drive').getByTestId('import-playlist-facts')).toHaveText('3 songs');

    await page.goto('/import?service=spotify');
    await uploadFile(page, 'notes.txt', 'text/plain', Buffer.from('Buy milk\nCall mum\n'));
    await expect(page.getByTestId('import-error')).toHaveText(
      "Tapedeck can't read that file. Upload an Exportify CSV or zip, a TuneMyMusic CSV, or a Library.xml from the Music app.",
    );
    await page.getByTestId('import-again').click();
    await expect(page.getByTestId('import-connect')).toBeVisible();
  });
});
