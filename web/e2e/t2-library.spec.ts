import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, dbCounts, seedReadyTracks, TONE_SECONDS, uniqueTag, type Seeded } from './helpers/library';
import { trackFileExists } from './helpers/db';

/*
 * T2 checks @T2 (SPEC 9 T2), on all three projects, with seeded ready songs
 * that have made-up titles. Each test cleans up its songs, playlists and
 * favourites (afterEach), because the projects share one in-memory database
 * and the iphone T1 check expects an empty library.
 *
 * The queue logic check is unit tested in web/lib/player/queue.test.ts.
 *
 * Playback checks run on the iphone project only: Playwright's Chromium
 * has no AAC decoder, so the m4a test tone never plays on desktop or
 * android (same reason the T1 play check is iphone only). CI runs WebKit.
 */

const PLAYBACK_ONLY_WEBKIT = 'Chromium in Playwright cannot decode the AAC test tone; the iphone project (WebKit) runs this';

const made: { trackIds: string[]; playlistIds: string[] } = { trackIds: [], playlistIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  made.playlistIds = [];
  // Record Media Session handlers so the test can call them like the lock
  // screen would (SPEC 8.8: nexttrack and previoustrack exist and work).
  await page.addInitScript(() => {
    if (typeof MediaSession === 'undefined') return;
    const handlers: Record<string, ((details: unknown) => void) | null> = {};
    (window as unknown as { __mediaHandlers: typeof handlers }).__mediaHandlers = handlers;
    // Patch the prototype, not the instance: WebKit may ignore an own
    // property set on navigator.mediaSession.
    const proto = MediaSession.prototype;
    const original = proto.setActionHandler;
    proto.setActionHandler = function (action, handler) {
      handlers[action] = handler as ((details: unknown) => void) | null;
      return original.call(this, action, handler);
    };
  });
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

async function seed(page: Page, tracks: Parameters<typeof seedReadyTracks>[1]): Promise<Seeded[]> {
  const seeded = await seedReadyTracks(page.request, tracks);
  made.trackIds.push(...seeded.map((track) => track.id));
  return seeded;
}

function item(page: Page, trackId: string) {
  return page.locator(`[data-item-id="${trackId}"]`);
}

async function openSongMenu(page: Page, trackId: string, testId: string): Promise<void> {
  await item(page, trackId).first().getByTestId('song-menu-button').click();
  await page.getByTestId(testId).click();
}

/** Like or unlike through the song menu and wait for the server to save it. */
async function toggleLike(page: Page, trackId: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/api/tracks/${trackId}/like`) && response.request().method() === 'PUT',
  );
  await openSongMenu(page, trackId, 'menu-like');
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
}

async function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
}

async function mediaTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
}

async function expectPlaying(page: Page): Promise<void> {
  const start = await audioTime(page);
  await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(start + 0.2);
}

test.describe('T2 library and player @T2', () => {
  test('playlist: create, add 3 songs, drag to reorder, order survives a reload', async ({ page }) => {
    const tag = uniqueTag();
    const songs = await seed(page, [
      { title: `First ${tag}`, artist: 'Seed Artist' },
      { title: `Second ${tag}`, artist: 'Seed Artist' },
      { title: `Third ${tag}`, artist: 'Seed Artist' },
    ]);

    // Create the playlist from Library > Playlists.
    await page.goto('/library?tab=playlists');
    await page.getByTestId('new-playlist-tab').click();
    const name = `Mix ${tag}`;
    await page.getByTestId('new-playlist-name').fill(name);
    await page.getByTestId('new-playlist-create').click();
    await expect(page).toHaveURL(/\/playlist\?id=/);
    await expect(page.getByTestId('playlist-name')).toHaveText(name);
    const playlistId = new URL(page.url()).searchParams.get('id') as string;
    made.playlistIds.push(playlistId);

    // Add the three songs, in order, from Home through each song's menu.
    await page.goto('/');
    for (const song of songs) {
      await openSongMenu(page, song.id, 'menu-add-playlist');
      await page.getByTestId('playlist-picker-item').filter({ hasText: name }).click();
      await expect(page.getByTestId('toast')).toHaveText(`Added to ${name}`);
    }

    await page.goto(`/playlist?id=${playlistId}`);
    const titles = page.getByTestId('playlist-tracks').getByTestId('track-title');
    await expect(titles).toHaveText(songs.map((song) => song.title));

    // Drag the first song to the bottom with the keyboard handle (dnd-kit:
    // Space picks up, arrows move, Space drops).
    const saved = page.waitForResponse(
      (response) => response.url().includes(`/api/playlists/${playlistId}/tracks`) && response.request().method() === 'PUT',
    );
    const handle = page.getByTestId('drag-handle').first();
    await handle.focus();
    // dnd-kit measures between moves; give each key a beat to settle.
    for (const key of ['Space', 'ArrowDown', 'ArrowDown', 'Space']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
    }
    expect((await saved).status()).toBe(200);
    const reordered = [songs[1].title, songs[2].title, songs[0].title];
    await expect(titles).toHaveText(reordered);

    await page.reload();
    await expect(page.getByTestId('playlist-tracks').getByTestId('track-title')).toHaveText(reordered);
  });

  test('liked songs: the newest like is first', async ({ page }) => {
    const tag = uniqueTag();
    const [one, two] = await seed(page, [{ title: `Liked one ${tag}` }, { title: `Liked two ${tag}` }]);
    await page.goto('/');
    await toggleLike(page, one.id);
    await expect(item(page, one.id).getByTestId('track-liked')).toBeVisible();
    await toggleLike(page, two.id);
    await expect(item(page, two.id).getByTestId('track-liked')).toBeVisible();

    await page.goto('/library?tab=liked');
    await expect(page.getByTestId('liked-list').getByTestId('track-title').first()).toHaveText(two.title);

    // Liking the first again after an unlike moves it back on top.
    await toggleLike(page, one.id); // Unlike
    await expect(item(page, one.id)).toHaveCount(0);
    await page.goto('/');
    await toggleLike(page, one.id);
    await page.goto('/library?tab=liked');
    await expect(page.getByTestId('liked-list').getByTestId('track-title').first()).toHaveText(one.title);
  });

  test('albums: same album and album artist group into one, favouriting moves it first', async ({ page }) => {
    const tag = uniqueTag();
    const album = `Zz Album ${tag}`;
    await seed(page, [
      { title: `Track A ${tag}`, artist: 'Band', album, albumArtist: 'Band' },
      { title: `Track B ${tag}`, artist: 'Band feat. Guest', album, albumArtist: 'Band' },
      { title: `Track C ${tag}`, artist: 'Other', album: `Aa Album ${tag}`, albumArtist: 'Other' },
    ]);

    await page.goto('/library?tab=albums');
    const tiles = page.getByTestId('album-grid').getByTestId('album-tile');
    await expect(tiles.filter({ hasText: album })).toHaveCount(1);
    await expect(tiles.first()).not.toContainText(album);

    await tiles.filter({ hasText: album }).click();
    await expect(page.getByTestId('album-name')).toHaveText(album);
    await expect(page.getByTestId('album-tracks').getByTestId('track-row')).toHaveCount(2);
    const saved = page.waitForResponse(
      (response) => response.url().includes('/api/albums/favorite') && response.request().method() === 'PUT',
    );
    await page.getByTestId('album-favorite').click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId('album-favorite')).toHaveAttribute('aria-pressed', 'true');

    await page.goto('/library?tab=albums');
    await expect(page.getByTestId('album-grid').getByTestId('album-tile').first()).toContainText(album);
  });

  test('auto advance updates Media Session; nexttrack and previoustrack work', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const album = `Advance ${tag}`;
    const [first, second] = await seed(page, [
      { title: `Advance one ${tag}`, artist: 'Band', album, albumArtist: 'Band' },
      { title: `Advance two ${tag}`, artist: 'Band', album, albumArtist: 'Band' },
    ]);

    await page.goto(`/album?name=${encodeURIComponent(album)}&artist=Band`);
    await page.getByTestId('list-play').click();
    await expectPlaying(page);
    expect(await mediaTitle(page)).toBe(first.title);

    // Jump to 1.5 seconds before the end: the next song starts by itself.
    await page.evaluate((end) => {
      const audio = document.querySelector('audio') as HTMLAudioElement;
      audio.currentTime = end - 1.5;
    }, TONE_SECONDS);
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(second.title);
    await expectPlaying(page);

    const handlers = await page.evaluate(() =>
      Object.keys((window as unknown as { __mediaHandlers: Record<string, unknown> }).__mediaHandlers ?? {}),
    );
    expect(handlers).toEqual(expect.arrayContaining(['nexttrack', 'previoustrack', 'play', 'pause', 'seekto']));

    // Under 3 seconds in, previous goes back a song (SPEC 8.8).
    await page.evaluate(() => {
      const audio = document.querySelector('audio') as HTMLAudioElement;
      audio.currentTime = 0;
      (window as unknown as { __mediaHandlers: Record<string, (d: unknown) => void> }).__mediaHandlers.previoustrack({
        action: 'previoustrack',
      });
    });
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(first.title);
    await page.evaluate(() =>
      (window as unknown as { __mediaHandlers: Record<string, (d: unknown) => void> }).__mediaHandlers.nexttrack({
        action: 'nexttrack',
      }),
    );
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(second.title);
    await expectPlaying(page);
  });

  test('reload mid-song: same song, same position, paused', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const [song] = await seed(page, [{ title: `Resume ${tag}`, artist: 'Band' }]);
    await page.goto('/');
    await item(page, song.id).getByTestId('track-row').click();
    await expectPlaying(page);
    await page.evaluate(() => {
      (document.querySelector('audio') as HTMLAudioElement).currentTime = 60;
    });
    await expect.poll(() => audioTime(page)).toBeGreaterThan(60.5);
    // The position is saved every 5 seconds (SPEC 8.8).
    await page.waitForTimeout(6_000);
    const before = await audioTime(page);
    await page.reload();

    await expect(page.getByTestId('player-title').first()).toHaveText(song.title);
    await expect(page.getByTestId('player-toggle').first()).toHaveAttribute('aria-label', 'Play');
    const restored = Number(await page.getByTestId('seek-slider').first().inputValue());
    expect(restored).toBeGreaterThanOrEqual(before - 5);
    expect(restored).toBeLessThanOrEqual(before + 1);
    expect(await page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).paused)).toBe(true);
  });

  test('30 seconds of listening records one play; profile stats match the database', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const [song] = await seed(page, [{ title: `Counted ${tag}`, artist: `Counter ${tag}` }]);
    expect((await dbCounts(page.request, song.id)).playEventsForTrack).toBe(0);

    await page.goto('/');
    // Play at 4x so 30 listened seconds take about 8 (the player counts
    // listened time from timeupdate steps, not wall time).
    await page.evaluate(() => {
      const audio = document.querySelector('audio') as HTMLAudioElement;
      audio.defaultPlaybackRate = 4;
      audio.playbackRate = 4;
    });
    await item(page, song.id).getByTestId('track-row').click();
    await expectPlaying(page);
    await expect.poll(async () => (await dbCounts(page.request, song.id)).playEventsForTrack, { timeout: 30_000 }).toBe(1);
    // Listening on does not count the same start twice.
    await page.waitForTimeout(3_000);
    expect((await dbCounts(page.request, song.id)).playEventsForTrack).toBe(1);
    await page.getByTestId('player-toggle').first().click();

    const counts = await dbCounts(page.request);
    await page.goto('/profile');
    await expect(page.getByTestId('stat-songs')).toHaveText(counts.tracks.toLocaleString('en-US'));
    await expect(page.getByTestId('stat-plays')).toHaveText(counts.playsThisMonth.toLocaleString('en-US'));
    const hours = counts.secondsListened / 3600;
    await expect(page.getByTestId('stat-hours')).toHaveText(hours < 10 ? hours.toFixed(1) : String(Math.round(hours)));
    await expect(page.getByTestId('top-artists')).toContainText(`Counter ${tag}`);
  });

  test('delete a song: row gone, stored file gone', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seed(page, [{ title: `Doomed ${tag}` }]);
    const key = `tracks/${song.id}.m4a`;
    expect(await trackFileExists(key)).toBe(true);
    const before = await dbCounts(page.request);

    await page.goto('/');
    await openSongMenu(page, song.id, 'menu-delete');
    await expect(page.getByTestId('confirm-dialog')).toContainText(song.title);
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('toast')).toHaveText('Song deleted');
    await expect(item(page, song.id)).toHaveCount(0);

    expect((await dbCounts(page.request)).tracks).toBe(before.tracks - 1);
    expect(await trackFileExists(key)).toBe(false);
    await page.reload();
    await expect(item(page, song.id)).toHaveCount(0);
  });
});
