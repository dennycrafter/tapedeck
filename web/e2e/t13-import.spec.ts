import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { TEST_AGENT_TOKEN, WEB_ROOT } from './helpers/env';
import { TONE_SECONDS } from './helpers/library';

/*
 * T13 checks @T13 (V2-PLAN T13), the core flow with the stand-in importer
 * (web/lib/importers/fake.ts, the "Test music service") and the recorded
 * Deezer answers (e2e/fixtures/import-deezer.json): pick the service, paste
 * a link, the checklist, import two playlists, the progress screen, a song
 * that needs a look fixed with Pick another version, Skip, and the
 * "Imported before" marks on a second import. The log-in and file slots are
 * checked with the stand-in too. The adapters' own checks (MusicAPI login,
 * Spotify fixture, ...) come with those adapters.
 *
 * Songs become ready through the real downloader API (upload-url, PUT the
 * test tone, complete). "The PC gave up" is set through the test-only
 * /api/test/fail-track route. Everything the import made is deleted in
 * afterEach: the three projects share one in-memory database.
 */

const TONE = readFileSync(path.join(WEB_ROOT, 'public', 'test-audio', 'test1.m4a'));
const agentHeaders = { Authorization: `Bearer ${TEST_AGENT_TOKEN}` };

const LIKED = 'Liked songs from Test music service';
const ROAD_TRIP = 'Road trip';
const PLAYLIST_NAMES = [LIKED, ROAD_TRIP, 'Chill'];
const SONG_TITLES = [
  'Harder, Better, Faster, Stronger',
  'Something About Us',
  'Paper Lanterns',
  'Veridis Quo',
  'One More Time',
  'Night Drive',
  'Slow Morning',
];

type LibraryTrack = { id: string; title: string; status: string; resolvedUrl: string | null };
type Library = { tracks: LibraryTrack[]; playlists: { id: string; name: string; trackIds: string[] }[] };

async function library(request: APIRequestContext): Promise<Library> {
  const response = await request.get('/api/library');
  expect(response.status()).toBe(200);
  return (await response.json()) as Library;
}

async function trackId(request: APIRequestContext, title: string): Promise<string> {
  const track = (await library(request)).tracks.find((candidate) => candidate.title === title);
  if (!track) throw new Error(`no imported song called ${title}`);
  return track.id;
}

/** Deletes every playlist and song the stand-in import can make. */
async function cleanupImport(request: APIRequestContext): Promise<void> {
  const snapshot = await library(request);
  for (const playlist of snapshot.playlists.filter((p) => PLAYLIST_NAMES.includes(p.name))) {
    await request.delete(`/api/playlists/${playlist.id}`);
  }
  for (const track of snapshot.tracks.filter((t) => SONG_TITLES.includes(t.title))) {
    await request.delete(`/api/tracks/${track.id}`);
  }
}

async function makeReady(request: APIRequestContext, id: string): Promise<void> {
  const upload = await request.post('/api/agent/upload-url', { headers: agentHeaders, data: { trackId: id } });
  expect(upload.status()).toBe(200);
  const { url, key } = (await upload.json()) as { url: string; key: string };
  const put = await request.put(url, { data: TONE, headers: { 'Content-Type': 'audio/mp4' } });
  expect(put.ok()).toBeTruthy();
  const complete = await request.post('/api/agent/complete', {
    headers: agentHeaders,
    data: { trackId: id, key, bytes: TONE.length, durationSec: TONE_SECONDS },
  });
  expect(complete.status(), await complete.text()).toBe(200);
}

const ALTERNATIVE = {
  title: 'Paper Lanterns (Audio)',
  uploader: 'The Fixture Band',
  durationSec: 202,
  url: 'https://soundcloud.com/the-fixture-band/paper-lanterns',
  score: 0.6,
  source: 'soundcloud',
};

async function pcGaveUp(request: APIRequestContext, id: string, withAlternative: boolean): Promise<void> {
  const response = await request.post('/api/test/fail-track', {
    data: { trackId: id, matchInfo: withAlternative ? { chosen: null, score: 0.6, alternatives: [ALTERNATIVE] } : undefined },
  });
  expect(response.status(), 'the fail-track test route is on (TAPEDECK_TEST=1)').toBe(200);
}

async function openTestService(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="add-open"]:visible').first().click();
  await page.getByTestId('add-tab-import').click();
  await page.locator('[data-testid="import-service"][data-service="test"]').click();
  await expect(page).toHaveURL(/\/import\?service=test$/);
  await expect(page.getByTestId('import-title')).toHaveText('Import from Test music service');
}

async function pasteLink(page: Page, link: string): Promise<void> {
  await page.getByTestId('import-links').fill(link);
  await page.getByTestId('import-find').click();
}

function playlistRow(page: Page, ref: string) {
  return page.locator(`[data-testid="import-playlist"][data-ref="${ref}"]`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanupImport(page.request);
});

test.describe('T13 Playlist import @T13', () => {
  test('Home offers the import while the library is empty', async ({ page }) => {
    await page.goto('/');
    const empty = page.getByTestId('library-empty');
    await expect(empty.or(page.getByTestId('home-recently-added')).first()).toBeVisible();
    test.skip(!(await empty.isVisible()), 'another spec left songs in the shared library');
    await expect(page.getByTestId('home-import-card')).toContainText('Bring your music');
    await page.getByTestId('home-import-open').click();
    await expect(page).toHaveURL(/\/import$/);
    await expect(page.locator('[data-testid="import-service"][data-service="test"]')).toBeVisible();
  });

  test('import two playlists, follow the progress, fix a song with Pick another version', async ({ page }) => {
    test.setTimeout(120_000);
    await openTestService(page);
    // The stand-in fills all three connect slots.
    for (const slot of ['login', 'link', 'file']) await expect(page.getByTestId(`import-slot-${slot}`)).toBeVisible();

    // Checklist: Liked songs first, song counts, Select all.
    await pasteLink(page, 'https://example.com/test-music/denis');
    await expect(page).toHaveURL(/\/import\?job=/);
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Liked songs', 'Road trip', 'Chill']);
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-facts')).toHaveText('3 songs');
    await expect(playlistRow(page, 'pl-chill').getByTestId('import-playlist-facts')).toHaveText('1 song');
    const selectAll = page.getByTestId('import-select-all');
    await expect(selectAll).toBeChecked();
    await selectAll.click();
    await expect(page.getByTestId('import-playlist-check')).toHaveCount(3);
    for (const box of await page.getByTestId('import-playlist-check').all()) await expect(box).not.toBeChecked();
    await expect(page.getByTestId('import-start')).toBeDisabled();
    await playlistRow(page, 'liked').getByTestId('import-playlist-check').click();
    await playlistRow(page, 'pl-road-trip').getByTestId('import-playlist-check').click();
    await expect(page.getByTestId('import-start')).toHaveText('Import 2 playlists');

    // Import: the browser drives the chunks until the server says done.
    await page.getByTestId('import-start').click();
    const progress = page.getByTestId('import-progress');
    await expect(progress).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(page.getByTestId('import-progress-title')).toHaveText('Imported');
    await expect(page.getByTestId('import-progress-text')).toHaveText('0 of 6 ready, 6 waiting');
    await expect(page.getByTestId('import-progress-playlist')).toHaveText([LIKED, ROAD_TRIP]);

    // Same names, same order, one library song for the song in both playlists.
    const snapshot = await library(page.request);
    const titlesOf = (name: string) => {
      const playlist = snapshot.playlists.find((p) => p.name === name);
      return playlist?.trackIds.map((id) => snapshot.tracks.find((t) => t.id === id)?.title);
    };
    expect(titlesOf(LIKED)).toEqual(['Harder, Better, Faster, Stronger', 'Something About Us', 'Paper Lanterns']);
    expect(titlesOf(ROAD_TRIP)).toEqual(['Veridis Quo', 'Harder, Better, Faster, Stronger', 'One More Time', 'Night Drive']);
    expect(snapshot.tracks.filter((t) => SONG_TITLES.includes(t.title))).toHaveLength(6);

    // The PC finishes one song and gives up on another: live counts, one needs a look.
    await makeReady(page.request, await trackId(page.request, 'Veridis Quo'));
    const paper = await trackId(page.request, 'Paper Lanterns');
    await pcGaveUp(page.request, paper, true);
    await expect(page.getByTestId('import-progress-text')).toHaveText('1 of 6 ready, 4 waiting, 1 needs a look', {
      timeout: 15_000,
    });
    const look = page.getByTestId('import-look-song');
    await expect(look).toHaveCount(1);
    await expect(look).toContainText('Paper Lanterns');
    await expect(look).toContainText("Couldn't find a matching version");

    // Pick another version (T12): the PC is asked for exactly that copy.
    await look.getByTestId('import-look-pick').click();
    const dialog = page.getByTestId('pick-version');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('pick-version-item').filter({ hasText: ALTERNATIVE.title }).click();
    await expect(page.getByTestId('toast')).toContainText('Your PC will download this version');
    await expect(page.getByTestId('import-progress-text')).toHaveText('1 of 6 ready, 5 waiting');
    await expect(page.getByTestId('import-needs-look')).toHaveCount(0);
    const picked = (await library(page.request)).tracks.find((t) => t.id === paper);
    expect(picked).toMatchObject({ status: 'waiting', resolvedUrl: ALTERNATIVE.url });

    // Skip: the song leaves the import, its playlists and the library.
    const oneMore = await trackId(page.request, 'One More Time');
    await pcGaveUp(page.request, oneMore, false);
    await expect(page.getByTestId('import-look-song')).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('import-look-song').getByTestId('import-look-skip').click();
    await expect(page.getByTestId('import-progress-text')).toHaveText('1 of 5 ready, 4 waiting');
    expect((await library(page.request)).tracks.find((t) => t.id === oneMore)).toBeUndefined();

    // A second import marks the playlists imported before, and leaves them unticked.
    await page.goto('/import?service=test');
    await pasteLink(page, 'https://example.com/test-music/denis');
    await expect(page.getByTestId('import-checklist')).toBeVisible();
    await expect(playlistRow(page, 'liked')).toHaveAttribute('data-imported', 'true');
    await expect(playlistRow(page, 'pl-road-trip')).toHaveAttribute('data-imported', 'true');
    await expect(playlistRow(page, 'pl-chill')).toHaveAttribute('data-imported', 'false');
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-facts')).toHaveText('3 songs · Imported before');
    await expect(playlistRow(page, 'liked').getByTestId('import-playlist-check')).not.toBeChecked();
    await expect(playlistRow(page, 'pl-chill').getByTestId('import-playlist-check')).toBeChecked();
    await expect(page.getByTestId('import-start')).toHaveText('Import 1 playlist');

    // "Your imports" in the Add window leads back to the progress.
    await page.locator('[data-testid="add-open"]:visible').first().click();
    await page.getByTestId('add-tab-import').click();
    await expect(page.getByTestId('import-recent').first()).toContainText(`${LIKED}, ${ROAD_TRIP}`);
    await expect(page.getByTestId('import-recent').first()).toContainText('1 of 5 ready, 4 waiting');
  });

  test('the log-in and file slots list the playlists too, and errors read plainly', async ({ page }) => {
    await openTestService(page);
    // Log in: the stand-in sends the browser straight back through the callback.
    await page.getByTestId('import-login').click();
    await expect(page).toHaveURL(/\/import\?job=/);
    await expect(page.getByTestId('import-playlist-name')).toHaveText(['Liked songs', 'Road trip', 'Chill']);

    // File upload.
    await page.goto('/import?service=test');
    await page.getByTestId('import-file').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('Playlist,Song\n') });
    await page.getByTestId('import-upload').click();
    await expect(page.getByTestId('import-checklist')).toBeVisible();

    // A link the source cannot read: the adapter's own words, and a way back.
    await page.goto('/import?service=test');
    await pasteLink(page, 'https://example.com/broken');
    await expect(page.getByTestId('import-error')).toHaveText("That link didn't work. Check it and try again.");
    await page.getByTestId('import-again').click();
    await expect(page.getByTestId('import-connect')).toBeVisible();
  });
});
