import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, librarySnapshot, seedReadyTracks, uniqueTag, type SeedInput, type Seeded } from './helpers/library';

/*
 * T14 speed and pitch checks @T14 (V2-PLAN T14). Each song stores a speed
 * (0.5x to 1.5x) and "Keep original pitch"; the player puts both on the
 * audio element at every track start.
 *
 * The Edit details and Now Playing chip checks run on all three projects:
 * the element's settings can be read even where Chromium cannot decode the
 * m4a test tone. The playback checks (the next song, a track change keeping
 * the speed, the speed really running) need real playback and run on the
 * iphone project (WebKit) only, like the other playback checks. Plan item 4
 * asks whether WebKit keeps `preservesPitch = false` and `playbackRate`
 * across a track change: the second playback check answers it.
 */

const PLAYBACK_ONLY_WEBKIT = 'Chromium in Playwright cannot decode the AAC test tone; the iphone project (WebKit) runs this';

const made: { trackIds: string[] } = { trackIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

async function seed(page: Page, tracks: SeedInput[]): Promise<Seeded[]> {
  const created = await seedReadyTracks(page.request, tracks);
  made.trackIds.push(...created.map((track) => track.id));
  return created;
}

type SpeedFields = { playbackRate: number; preservePitch: boolean };

async function speedOf(page: Page, trackId: string): Promise<SpeedFields | undefined> {
  const snapshot = (await librarySnapshot(page.request)) as unknown as { tracks: ({ id: string } & SpeedFields)[] };
  const track = snapshot.tracks.find((t) => t.id === trackId);
  return track ? { playbackRate: track.playbackRate, preservePitch: track.preservePitch } : undefined;
}

async function setSpeed(page: Page, trackId: string, fields: Partial<SpeedFields>): Promise<void> {
  const response = await page.request.patch(`/api/tracks/${trackId}`, { data: fields });
  expect(response.status(), await response.text()).toBe(200);
}

type ElementSpeed = { rate: number; defaultRate: number; pitch: boolean; webkitPitch: boolean | null };

async function elementSpeed(page: Page): Promise<ElementSpeed> {
  return page.evaluate(() => {
    const audio = document.querySelector('audio') as HTMLAudioElement & { webkitPreservesPitch?: boolean };
    return {
      rate: audio.playbackRate,
      defaultRate: audio.defaultPlaybackRate,
      pitch: audio.preservesPitch,
      webkitPitch: typeof audio.webkitPreservesPitch === 'boolean' ? audio.webkitPreservesPitch : null,
    };
  });
}

async function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
}

async function mediaTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
}

/** Media seconds played per wall second over about 3 seconds. */
async function measuredRate(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const audio = document.querySelector('audio') as HTMLAudioElement;
        const media0 = audio.currentTime;
        const wall0 = performance.now();
        window.setTimeout(() => resolve((audio.currentTime - media0) / ((performance.now() - wall0) / 1000)), 3000);
      }),
  );
}

function row(page: Page, trackId: string) {
  return page.locator(`[data-item-id="${trackId}"]`).first();
}

async function openEdit(page: Page, trackId: string): Promise<void> {
  await row(page, trackId).getByTestId('song-menu-button').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-dialog')).toBeVisible();
  await expect(page.getByTestId('speed-editor')).toBeVisible();
}

async function saveEdit(page: Page, trackId: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/api/tracks/${trackId}`) && response.request().method() === 'PATCH',
  );
  await page.getByTestId('edit-save').click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
}

async function playAlbum(page: Page, album: string, artist: string): Promise<void> {
  await page.goto(`/album?name=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`);
  await page.getByTestId('list-play').click();
}

test.describe('T14 speed and pitch @T14', () => {
  test('Edit details: presets, slider, pitch switch, saved and shown in the list', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seed(page, [{ title: `Speed edit ${tag}`, artist: 'Speed Band' }]);
    await page.goto('/');
    await expect(row(page, song.id).getByTestId('track-speed')).toHaveCount(0);
    await openEdit(page, song.id);

    // Starts at normal speed with the pitch kept.
    await expect(page.getByTestId('speed-value')).toHaveText('1x');
    await expect(page.getByTestId('speed-preset-normal')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('speed-keep-pitch')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('speed-length')).toHaveCount(0);

    // The slider moves in 0.05 steps; no preset matches 0.5x.
    await page.getByTestId('speed-slider').fill('0.5');
    await expect(page.getByTestId('speed-value')).toHaveText('0.5x');
    await expect(page.getByTestId('speed-length')).toHaveText('Plays in 6:00 instead of 3:00');
    await expect(page.locator('[data-testid^="speed-preset-"][aria-checked="true"]')).toHaveCount(0);

    // Sped up with the pitch off: the classic sped up sound.
    await page.getByTestId('speed-preset-sped-up').click();
    await expect(page.getByTestId('speed-value')).toHaveText('1.25x');
    await expect(page.getByTestId('speed-slider')).toHaveValue('1.25');
    await expect(page.getByTestId('speed-length')).toHaveText('Plays in 2:24 instead of 3:00');
    await page.getByTestId('speed-keep-pitch').click();
    await expect(page.getByTestId('speed-keep-pitch')).toHaveAttribute('aria-checked', 'false');
    await saveEdit(page, song.id);
    await expect.poll(async () => (await speedOf(page, song.id))?.playbackRate).toBe(1.25);
    expect(await speedOf(page, song.id)).toEqual({ playbackRate: 1.25, preservePitch: false });

    // The list shows the speed next to the length.
    await expect(row(page, song.id).getByTestId('track-speed')).toHaveText('1.25x');

    // It opens again as saved; Normal takes the speed back.
    await openEdit(page, song.id);
    await expect(page.getByTestId('speed-value')).toHaveText('1.25x');
    await expect(page.getByTestId('speed-keep-pitch')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('speed-preset-normal').click();
    await saveEdit(page, song.id);
    await expect.poll(async () => (await speedOf(page, song.id))?.playbackRate).toBe(1);
    await expect(row(page, song.id).getByTestId('track-speed')).toHaveCount(0);

    // The server checks the range and the steps.
    const tooFast = await page.request.patch(`/api/tracks/${song.id}`, { data: { playbackRate: 2 } });
    expect(tooFast.status()).toBe(400);
    expect(((await tooFast.json()) as { error: string }).error).toBe('Speed must be between 0.5x and 1.5x.');
    const offStep = await page.request.patch(`/api/tracks/${song.id}`, { data: { playbackRate: 1.12 } });
    expect(offStep.status()).toBe(400);
  });

  test('Now Playing chip: presets and pitch change the playing song at once', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seed(page, [{ title: `Speed chip ${tag}`, artist: 'Speed Band' }]);
    await page.goto('/');
    await row(page, song.id).getByTestId('track-row').click();
    await expect(page.getByTestId('player-title').filter({ visible: true }).first()).toHaveText(song.title);
    // The song's file is on the element (the chip changes the loaded song).
    await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('audio')?.src)), { timeout: 15_000 }).toBe(true);
    await page.getByRole('button', { name: 'Open now playing' }).filter({ visible: true }).first().click();
    await expect(page.getByTestId('now-playing')).toBeVisible();

    const chip = page.getByTestId('now-playing-speed');
    await expect(chip).toHaveText('1x');
    await chip.click();
    await expect(page.getByTestId('speed-popover')).toBeVisible();
    await expect(page.getByTestId('chip-preset-normal')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('chip-preset-slowed').click();
    await expect(chip).toHaveText('0.85x');
    await expect.poll(async () => (await speedOf(page, song.id))?.playbackRate).toBe(0.85);
    await expect.poll(async () => (await elementSpeed(page)).rate).toBe(0.85);

    await page.getByTestId('chip-keep-pitch').click();
    await expect(page.getByTestId('chip-keep-pitch')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await speedOf(page, song.id))?.preservePitch).toBe(false);
    await expect.poll(async () => (await elementSpeed(page)).pitch).toBe(false);

    // Escape closes the presets, not Now Playing.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('speed-popover')).toHaveCount(0);
    await expect(page.getByTestId('now-playing')).toBeVisible();
  });

  test('Sped up with pitch off plays that way, shown times divide by the speed, the next song plays at 1x', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const album = `Speed album ${tag}`;
    const [first, second] = await seed(page, [
      { title: `Speed one ${tag}`, artist: 'Speed Band', album, albumArtist: 'Speed Band' },
      { title: `Speed two ${tag}`, artist: 'Speed Band', album, albumArtist: 'Speed Band' },
    ]);

    // Set Sped up with the pitch off through Edit details.
    await page.goto('/');
    await openEdit(page, first.id);
    await page.getByTestId('speed-preset-sped-up').click();
    await page.getByTestId('speed-keep-pitch').click();
    await saveEdit(page, first.id);
    await expect.poll(async () => (await speedOf(page, first.id))?.preservePitch).toBe(false);

    await playAlbum(page, album, 'Speed Band');
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(first.title);
    const start = await audioTime(page);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(start + 0.2);
    const sped = await elementSpeed(page);
    expect(sped.rate).toBe(1.25);
    expect(sped.pitch).toBe(false);
    if (sped.webkitPitch !== null) expect(sped.webkitPitch).toBe(false);

    // A 3:00 song at 1.25x takes 2:24, and the scrubber runs in those seconds.
    await expect(page.getByTestId('player-duration').first()).toHaveText('2:24');
    await expect(page.getByTestId('seek-slider').first()).toHaveAttribute('max', '144');
    // It really plays faster than normal.
    expect(await measuredRate(page)).toBeGreaterThan(1.1);

    // Near the end the next song starts by itself, back at 1x with the pitch kept.
    await page.evaluate(() => {
      (document.querySelector('audio') as HTMLAudioElement).currentTime = 178.5;
    });
    await expect.poll(() => mediaTitle(page), { timeout: 10_000 }).toBe(second.title);
    const next = await audioTime(page);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(next + 0.2);
    const normal = await elementSpeed(page);
    expect(normal.rate).toBe(1);
    expect(normal.defaultRate).toBe(1);
    expect(normal.pitch).toBe(true);
    if (normal.webkitPitch !== null) expect(normal.webkitPitch).toBe(true);
    await expect(page.getByTestId('player-duration').first()).toHaveText('3:00');
  });

  test('WebKit keeps the speed and pitch off across a track change', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const album = `Speed keep ${tag}`;
    const [first, second] = await seed(page, [
      { title: `Keep one ${tag}`, artist: 'Speed Band', album, albumArtist: 'Speed Band' },
      { title: `Keep two ${tag}`, artist: 'Speed Band', album, albumArtist: 'Speed Band' },
    ]);
    await setSpeed(page, first.id, { playbackRate: 1.25, preservePitch: false });
    await setSpeed(page, second.id, { playbackRate: 0.85, preservePitch: false });

    await playAlbum(page, album, 'Speed Band');
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(first.title);
    const start = await audioTime(page);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(start + 0.2);
    expect(await elementSpeed(page)).toMatchObject({ rate: 1.25, pitch: false });

    // The track change goes through a new src; the second song's own settings must hold once it plays.
    await page.evaluate(() => {
      (document.querySelector('audio') as HTMLAudioElement).currentTime = 178.5;
    });
    await expect.poll(() => mediaTitle(page), { timeout: 10_000 }).toBe(second.title);
    const next = await audioTime(page);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(next + 0.5);
    const kept = await elementSpeed(page);
    expect(kept).toMatchObject({ rate: 0.85, defaultRate: 0.85, pitch: false });
    if (kept.webkitPitch !== null) expect(kept.webkitPitch).toBe(false);
    const measured = await measuredRate(page);
    expect(measured).toBeLessThan(0.95);
    expect(measured).toBeGreaterThan(0.6);
    await expect(page.getByTestId('player-duration').first()).toHaveText('3:31');

    // Pause and play (as the lock screen does) keeps them too.
    await page.getByTestId('player-toggle').first().click();
    await expect(page.getByTestId('player-toggle').first()).toHaveAttribute('aria-label', 'Play');
    await page.getByTestId('player-toggle').first().click();
    await expect(page.getByTestId('player-toggle').first()).toHaveAttribute('aria-label', 'Pause');
    expect(await elementSpeed(page)).toMatchObject({ rate: 0.85, pitch: false });
  });
});
