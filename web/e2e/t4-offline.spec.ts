import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, dbCounts, seedReadyTracks, TONE_SECONDS, uniqueTag } from './helpers/library';
import { PROD_URL } from './helpers/env';

/*
 * T4 checks @T4 (SPEC 9 T4, 8.9, 8.10).
 *
 * The offline journey runs on every project up to playback; the playback
 * steps (all 3 songs play, auto advance, the offline play reaching
 * play_events) run on the iphone project only, because Playwright's
 * Chromium has no AAC decoder (see the T2 spec). The "Save to Files"
 * attachment check is the desktop project's, as the SPEC asks.
 *
 * The offline tests run against the e2e production server
 * (e2e/prod-server.mjs, same stand-ins), because only a production build
 * runs the service worker, and they let it run (the rest of the suite
 * blocks it).
 */

const made: { trackIds: string[]; playlistIds: string[] } = { trackIds: [], playlistIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  made.playlistIds = [];
  await login(page);
});

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  // Leave this browser's offline copies behind with the browser; the
  // server-side songs and playlists go.
  await cleanup(page.request, made);
});

/** Downloaded songs in IndexedDB (track ids only; the test page's tone is skipped). */
async function storedSongs(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('tapedeck-offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('audio')) {
            db.close();
            resolve([]);
            return;
          }
          const keys = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve((keys.result as IDBValidKey[]).map(String).filter((key) => /^[0-9a-f-]{36}$/.test(key)));
          };
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
}

async function queuedPlays(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('tapedeck-offline');
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('plays')) return resolve(0);
          const count = db.transaction('plays', 'readonly').objectStore('plays').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
        open.onerror = () => resolve(-1);
      }),
  );
}

/** Wait until the service worker controls the page, so the next loads get cached. */
async function underServiceWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

async function mediaTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
}

async function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
}

async function expectPlaying(page: Page): Promise<void> {
  const start = await audioTime(page);
  try {
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(start + 0.2);
  } catch (error) {
    // Say why: the element's state and the player's own error line.
    const state = await page.evaluate(() => {
      const audio = document.querySelector('audio') as HTMLAudioElement;
      return {
        src: audio.currentSrc.slice(0, 40),
        paused: audio.paused,
        readyState: audio.readyState,
        networkState: audio.networkState,
        error: audio.error ? `${audio.error.code} ${audio.error.message}` : null,
        playerError: document.querySelector('[data-testid="player-error"]')?.textContent ?? null,
      };
    });
    throw new Error(`audio did not play: ${JSON.stringify(state)}\n${String(error)}`);
  }
}

test.describe('T4 offline @T4', () => {
  test.use({ serviceWorkers: 'allow', baseURL: PROD_URL });

  test('download a playlist, go offline, reload: snapshot, Offline pill, greyed songs, playback and plays', async ({
    page,
    context,
    browserName,
  }) => {
    test.setTimeout(180_000);
    const tag = uniqueTag();
    const songs = await seedReadyTracks(page.request, [
      { title: `Offline one ${tag}`, artist: 'Band' },
      { title: `Offline two ${tag}`, artist: 'Band' },
      { title: `Offline three ${tag}`, artist: 'Band' },
      { title: `Not downloaded ${tag}`, artist: 'Band' },
    ]);
    made.trackIds.push(...songs.map((song) => song.id));
    const [one, two, three, extra] = songs;
    const created = await page.request.post('/api/playlists', { data: { name: `Flight ${tag}` } });
    const playlist = (await created.json()) as { id: string };
    made.playlistIds.push(playlist.id);
    await page.request.post(`/api/playlists/${playlist.id}/tracks`, { data: { trackIds: [one.id, two.id, three.id] } });

    // Online: open Home and the playlist under the service worker so both
    // pages (and the app code) are cached for later.
    await page.goto('/');
    await underServiceWorker(page);
    await page.goto('/');
    await expect(page.locator(`[data-item-id="${extra.id}"]`).first()).toBeVisible();
    await page.goto(`/playlist?id=${playlist.id}`);
    await expect(page.getByTestId('playlist-tracks').getByTestId('track-row')).toHaveCount(3);

    // Check: "Download" on the playlist stores 3 blobs and marks each song.
    await page.getByTestId('list-download').click();
    // A failed download says so in a toast: fail fast with its text.
    await expect(page.getByTestId('list-downloaded').or(page.getByText('could not download'))).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('list-downloaded')).toBeVisible();
    expect((await storedSongs(page)).sort()).toEqual([one.id, two.id, three.id].sort());
    await expect(page.getByTestId('playlist-tracks').getByTestId('track-downloaded')).toHaveCount(3);

    // Check: offline, reload. The app opens from the service worker, the
    // library comes from the snapshot and the Offline pill shows.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('offline-pill')).toBeVisible();
    await expect(page.getByTestId('playlist-name')).toHaveText(`Flight ${tag}`);
    await expect(page.getByTestId('playlist-tracks').getByTestId('track-downloaded')).toHaveCount(3);

    // Check: songs not downloaded are greyed and not playable.
    await page.goto('/');
    await expect(page.getByTestId('offline-pill')).toBeVisible();
    // Wait for Home itself (from the saved library) before looking at rows.
    await expect(page.getByTestId('home-recently-added')).toBeVisible();
    const extraRow = page.locator(`[data-item-id="${extra.id}"]`).first().getByTestId('track-row');
    await expect(extraRow).toHaveAttribute('data-unavailable-offline', 'true');
    await expect(extraRow).not.toHaveRole('button');
    await expect(page.locator(`[data-item-id="${one.id}"]`).first().getByTestId('track-row')).toHaveRole('button');

    if (browserName !== 'webkit') {
      test.info().annotations.push({ type: 'note', description: 'Offline playback steps run on the iphone project (no AAC in Chromium).' });
      return;
    }

    // Check (iphone): all 3 songs play offline, and auto advance works.
    await page.goto(`/playlist?id=${playlist.id}`);
    await page.getByTestId('list-play').click();
    await expectPlaying(page);
    expect(await mediaTitle(page)).toBe(one.title);
    for (const next of [two, three]) {
      await page.evaluate((end) => {
        const audio = document.querySelector('audio') as HTMLAudioElement;
        audio.currentTime = end - 1.5;
      }, TONE_SECONDS);
      await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(next.title);
      await expectPlaying(page);
    }

    // Check (iphone): the plays made offline wait in IndexedDB, then reach
    // play_events once back online (a song that ends counts as a play).
    expect(await queuedPlays(page)).toBeGreaterThanOrEqual(2);
    expect((await dbCounts(page.request, one.id)).playEventsForTrack).toBe(0);
    await context.setOffline(false);
    await expect.poll(async () => (await dbCounts(page.request, one.id)).playEventsForTrack, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await dbCounts(page.request, two.id)).playEventsForTrack, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => queuedPlays(page)).toBe(0);
    await page.getByTestId('player-toggle').first().click();
  });

  test('remove downloads: one from the song menu, the rest from the profile', async ({ page }) => {
    const tag = uniqueTag();
    const songs = await seedReadyTracks(page.request, [{ title: `Keep ${tag}` }, { title: `Drop ${tag}` }]);
    made.trackIds.push(...songs.map((song) => song.id));
    await page.goto('/');
    for (const song of songs) {
      await page.locator(`[data-item-id="${song.id}"]`).first().getByTestId('song-menu-button').click();
      await page.getByTestId('menu-download').click();
      await expect(page.locator(`[data-item-id="${song.id}"]`).first().getByTestId('track-downloaded')).toBeVisible({
        timeout: 30_000,
      });
    }
    expect(await storedSongs(page)).toEqual(expect.arrayContaining(songs.map((song) => song.id)));

    await page.locator(`[data-item-id="${songs[1].id}"]`).first().getByTestId('song-menu-button').click();
    await page.getByTestId('menu-remove-download').click();
    await expect(page.locator(`[data-item-id="${songs[1].id}"]`).first().getByTestId('track-downloaded')).toHaveCount(0);
    expect(await storedSongs(page)).not.toContain(songs[1].id);

    await page.goto('/library?tab=downloaded');
    await expect(page.getByTestId('downloaded-list').getByTestId('track-title')).toContainText([songs[0].title]);

    await page.goto('/profile');
    await expect(page.getByTestId('offline-storage')).toContainText('song');
    await page.getByTestId('remove-all-downloads').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('offline-storage')).toHaveText('Nothing downloaded on this device');
    expect(await storedSongs(page)).toEqual([]);
  });
});

test.describe('T4 Save to Files @T4', () => {
  test('desktop: Save to Files downloads "<Artist> - <Title>.m4a" as an attachment', async ({ page, browserName, isMobile }) => {
    test.skip(browserName !== 'chromium' || isMobile, 'SPEC 9 T4: the desktop project checks the PC download');
    const tag = uniqueTag();
    const [song] = await seedReadyTracks(page.request, [{ title: `Save Me ${tag}`, artist: 'Seed Band' }]);
    made.trackIds.push(song.id);
    const expected = `Seed Band - Save Me ${tag}.m4a`;

    // The response itself carries the attachment disposition.
    const urlResponse = await page.request.get(`/api/tracks/${song.id}/url?download=1`);
    expect(urlResponse.status()).toBe(200);
    const { url } = (await urlResponse.json()) as { url: string };
    const file = await page.request.get(url);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-disposition']).toBe(`attachment; filename="${expected}"`);

    // And the song menu item starts that download in the browser.
    await page.goto('/');
    await page.locator(`[data-item-id="${song.id}"]`).first().getByTestId('song-menu-button').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('menu-save-files').click();
    expect((await download).suggestedFilename()).toBe(expected);
  });
});
