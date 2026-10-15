import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { TEST_AGENT_TOKEN, WEB_ROOT } from './helpers/env';
import { cleanup, seedReadyTracks, TONE_SECONDS, uniqueTag, type Seeded } from './helpers/library';

/*
 * T12 checks @T12 (V2-PLAN T12, item 7), app side: a catalog song the PC
 * completed with a chosen copy and alternatives shows as ready, and "Pick
 * another version" lists the copies and sends the song back to the PC. The
 * finder itself (searching, scoring) is covered by pytest in agent/tests.
 *
 * Catalog songs are inserted through the test-only /api/test/seed-catalog
 * route, then made ready through the real downloader API (upload-url, PUT
 * the test tone, complete with resolvedUrl and matchInfo), the same path
 * helpers/library.ts seedReadyTracks takes. Every song is deleted in
 * afterEach: the three projects share one in-memory database, and a
 * leftover waiting catalog row would be claimed by other tests' downloader runs.
 */

const TONE = readFileSync(path.join(WEB_ROOT, 'public', 'test-audio', 'test1.m4a'));
const agentHeaders = { Authorization: `Bearer ${TEST_AGENT_TOKEN}` };

const made: { trackIds: string[] } = { trackIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

/** Made-up copies: 11-character video ids that never exist on YouTube. */
function matchInfoFor(tag: string) {
  const id = (n: number) => `T12${n}${tag}`.replace(/[^A-Za-z0-9]/g, 'x').padEnd(11, 'x').slice(0, 11);
  const chosen = {
    title: `Finder Song ${tag} (Official Audio)`,
    uploader: 'Finder Band - Topic',
    durationSec: 180,
    url: `https://www.youtube.com/watch?v=${id(1)}`,
    score: 0.95,
    source: 'ytmusic',
  };
  const alternatives = [
    {
      title: `Finder Song ${tag}`,
      uploader: 'finderband',
      durationSec: 181,
      url: `https://soundcloud.com/finderband/finder-song-${tag}`,
      score: 0.8,
      source: 'soundcloud',
    },
    {
      title: `Finder Song ${tag} (Lyrics)`,
      uploader: 'Lyric Channel',
      durationSec: 199,
      url: `https://www.youtube.com/watch?v=${id(2)}`,
      score: 0.6,
      source: 'youtube',
    },
    {
      title: `Finder Song ${tag} (Live)`,
      uploader: 'Finder Band',
      durationSec: 245,
      url: `https://www.youtube.com/watch?v=${id(3)}`,
      score: 0.4,
      source: 'youtube',
    },
  ];
  return { chosen, score: 0.95, alternatives };
}

type MatchInfo = ReturnType<typeof matchInfoFor>;

async function seedReadyCatalogSong(request: APIRequestContext, title: string, matchInfo: MatchInfo): Promise<Seeded> {
  const seeded = await request.post('/api/test/seed-catalog', {
    data: { tracks: [{ title, artist: 'Finder Band', durationSec: TONE_SECONDS }] },
  });
  expect(seeded.status(), 'the catalog seed route is on (TAPEDECK_TEST=1)').toBe(201);
  const [track] = ((await seeded.json()) as { tracks: Seeded[] }).tracks;
  made.trackIds.push(track.id);
  const upload = await request.post('/api/agent/upload-url', { headers: agentHeaders, data: { trackId: track.id } });
  expect(upload.status()).toBe(200);
  const { url, key } = (await upload.json()) as { url: string; key: string };
  const put = await request.put(url, { data: TONE, headers: { 'Content-Type': 'audio/mp4' } });
  expect(put.ok(), `PUT the test tone for ${title}`).toBeTruthy();
  const complete = await request.post('/api/agent/complete', {
    headers: agentHeaders,
    data: {
      trackId: track.id,
      key,
      bytes: TONE.length,
      durationSec: TONE_SECONDS,
      resolvedUrl: matchInfo.chosen.url,
      matchInfo,
    },
  });
  expect(complete.status(), await complete.text()).toBe(200);
  return track;
}

type LibraryTrack = { id: string; source: string; status: string; resolvedUrl: string | null };

async function libraryTrack(page: Page, id: string): Promise<LibraryTrack | undefined> {
  const response = await page.request.get('/api/library');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { tracks: LibraryTrack[] }).tracks.find((track) => track.id === id);
}

function item(page: Page, trackId: string) {
  return page.locator(`[data-item-id="${trackId}"]`).first();
}

async function openPickDialog(page: Page, trackId: string) {
  await item(page, trackId).getByTestId('song-menu-button').click();
  await page.getByTestId('menu-pick-version').click();
  const dialog = page.getByTestId('pick-version');
  await expect(dialog).toBeVisible();
  return dialog;
}

function pickResponse(page: Page, trackId: string) {
  return page.waitForResponse(
    (response) => response.url().includes(`/api/tracks/${trackId}/pick`) && response.request().method() === 'POST',
  );
}

test.describe('T12 Best-copy finder @T12', () => {
  test('a finished catalog song is ready, and picking another version re-queues it', async ({ page }) => {
    const tag = uniqueTag();
    const info = matchInfoFor(tag);
    const song = await seedReadyCatalogSong(page.request, `Finder ${tag}`, info);
    expect(await libraryTrack(page, song.id)).toMatchObject({
      source: 'catalog',
      status: 'ready',
      resolvedUrl: info.chosen.url,
    });

    // Shows as ready: a length, no waiting status.
    await page.goto('/');
    await expect(item(page, song.id).getByTestId('track-duration')).toHaveText('3:00');
    await expect(item(page, song.id).getByTestId('track-status')).toHaveCount(0);

    // The dialog lists the chosen copy first (Current) and every alternative with its source.
    const dialog = await openPickDialog(page, song.id);
    const rows = dialog.getByTestId('pick-version-item');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText(info.chosen.title);
    await expect(rows.nth(0)).toContainText('YouTube Music');
    await expect(rows.nth(0)).toHaveAttribute('data-current', 'true');
    await expect(rows.nth(0)).toBeDisabled();
    await expect(rows.nth(0).getByTestId('pick-version-current')).toHaveText('Current');
    await expect(rows.nth(1)).toContainText(info.alternatives[0].title);
    await expect(rows.nth(1)).toContainText('finderband');
    await expect(rows.nth(1)).toContainText('3:01');
    await expect(rows.nth(1)).toContainText('SoundCloud');
    await expect(rows.nth(2)).toContainText(info.alternatives[1].title);
    await expect(rows.nth(2)).toContainText('YouTube');
    await expect(rows.nth(3)).toContainText(info.alternatives[2].title);
    for (const n of [1, 2, 3]) await expect(rows.nth(n)).toHaveAttribute('data-current', 'false');
    await expect(dialog.getByTestId('pick-version-current')).toHaveCount(1);

    // Pick the SoundCloud copy: toast, dialog closes, the PC is asked for exactly that copy.
    const picked = pickResponse(page, song.id);
    await rows.nth(1).click();
    expect((await picked).status()).toBe(200);
    await expect(page.getByTestId('toast')).toContainText('Your PC will download this version');
    await expect(dialog).toHaveCount(0);
    expect(await libraryTrack(page, song.id)).toMatchObject({
      status: 'waiting',
      resolvedUrl: info.alternatives[0].url,
    });
    await expect(item(page, song.id).getByTestId('track-status')).toBeVisible();

    // The picked copy is now the current one.
    const again = await openPickDialog(page, song.id);
    await expect(again.locator('[data-current="true"]')).toHaveAttribute('data-url', info.alternatives[0].url);
  });

  test('a pasted link is checked, and Search again clears the pick', async ({ page }) => {
    const tag = uniqueTag();
    const info = matchInfoFor(tag);
    const song = await seedReadyCatalogSong(page.request, `Finder Again ${tag}`, info);

    await page.goto('/');
    const dialog = await openPickDialog(page, song.id);

    // A link that is not a song: the error shows in the dialog, which stays open.
    const link = dialog.getByTestId('pick-version-link');
    await link.fill('https://example.com/not-a-song');
    let response = pickResponse(page, song.id);
    await dialog.getByTestId('pick-version-use-link').click();
    expect((await response).status()).toBe(400);
    await expect(dialog.getByRole('alert')).toHaveText('Not a YouTube or SoundCloud song link');
    expect(await libraryTrack(page, song.id)).toMatchObject({ status: 'ready', resolvedUrl: info.chosen.url });

    // Search again: the pick is cleared so the PC searches afresh.
    response = pickResponse(page, song.id);
    await dialog.getByTestId('pick-version-search').click();
    expect((await response).status()).toBe(200);
    await expect(page.getByTestId('toast')).toContainText('Your PC will search again');
    await expect(dialog).toHaveCount(0);
    expect(await libraryTrack(page, song.id)).toMatchObject({ status: 'waiting', resolvedUrl: null });
  });

  test('songs added from a YouTube link have no "Pick another version"', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seedReadyTracks(page.request, [{ title: `Finder YouTube ${tag}`, artist: 'Band' }]);
    made.trackIds.push(song.id);

    await page.goto('/');
    await item(page, song.id).getByTestId('song-menu-button').click();
    await expect(page.getByTestId('menu-restore')).toBeVisible();
    await expect(page.getByTestId('menu-pick-version')).toHaveCount(0);
  });
});
