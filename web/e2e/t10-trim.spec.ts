import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, librarySnapshot, TONE_SECONDS, uniqueTag, type Seeded } from './helpers/library';
import { TEST_AGENT_TOKEN, WEB_ROOT } from './helpers/env';

/*
 * T10 trim checks @T10 (V2-PLAN T10). Trim is non-destructive: Edit details
 * stores a start and an end, and the player plays only that part.
 *
 * The editor checks (validation messages, Reset to automatic, Don't trim,
 * handles) run on all three projects. The playback check runs on the iphone
 * project only, like the other playback checks: Playwright's Chromium has
 * no AAC decoder for the m4a test tone (see the T2 spec).
 *
 * Songs are made ready through the real downloader API (upload-url, PUT
 * the test tone, complete), the same path as helpers/library.ts, here with
 * the optional autoTrimStartSec / autoTrimEndSec the PC sends since T10.
 */

const PLAYBACK_ONLY_WEBKIT = 'Chromium in Playwright cannot decode the AAC test tone; the iphone project (WebKit) runs this';
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

type SeedTrim = { title: string; album?: string; autoTrimStartSec?: number; autoTrimEndSec?: number };

async function seed(request: APIRequestContext, tracks: SeedTrim[]): Promise<Seeded[]> {
  const seeded = await request.post('/api/test/seed', {
    data: { tracks: tracks.map(({ title, album }) => ({ title, artist: 'Trim Band', album, albumArtist: album ? 'Trim Band' : undefined })) },
  });
  expect(seeded.status()).toBe(201);
  const created = ((await seeded.json()) as { tracks: Seeded[] }).tracks;
  for (const [i, track] of created.entries()) {
    made.trackIds.push(track.id);
    const upload = await request.post('/api/agent/upload-url', { headers: agentHeaders, data: { trackId: track.id } });
    expect(upload.status()).toBe(200);
    const { url, key } = (await upload.json()) as { url: string; key: string };
    const put = await request.put(url, { data: TONE, headers: { 'Content-Type': 'audio/mp4' } });
    expect(put.ok()).toBeTruthy();
    const { autoTrimStartSec, autoTrimEndSec } = tracks[i];
    const complete = await request.post('/api/agent/complete', {
      headers: agentHeaders,
      data: { trackId: track.id, key, bytes: TONE.length, durationSec: TONE_SECONDS, autoTrimStartSec, autoTrimEndSec },
    });
    expect(complete.status(), await complete.text()).toBe(200);
  }
  return created;
}

type TrimFields = { trimStartSec: number | null; trimEndSec: number | null; autoTrimStartSec: number | null; autoTrimEndSec: number | null };

async function trimOf(page: Page, trackId: string): Promise<TrimFields | undefined> {
  const snapshot = (await librarySnapshot(page.request)) as unknown as { tracks: ({ id: string } & TrimFields)[] };
  return snapshot.tracks.find((track) => track.id === trackId);
}

async function openEdit(page: Page, trackId: string): Promise<void> {
  await page.locator(`[data-item-id="${trackId}"]`).first().getByTestId('song-menu-button').click();
  await page.getByTestId('menu-edit').click();
  await expect(page.getByTestId('edit-dialog')).toBeVisible();
  await expect(page.getByTestId('trim-editor')).toBeVisible();
}

/** Type into a trim field and leave it, like a person would. */
async function typeTrim(page: Page, field: 'trim-start' | 'trim-end', text: string): Promise<void> {
  const input = page.getByTestId(field);
  await input.fill(text);
  await input.blur();
}

async function saveEdit(page: Page, trackId: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/api/tracks/${trackId}`) && response.request().method() === 'PATCH',
  );
  await page.getByTestId('edit-save').click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
}

async function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
}

async function mediaTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
}

test.describe('T10 trim @T10', () => {
  test('Edit details: automatic trim, validation messages, Reset to automatic and Don\'t trim', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seed(page.request, [{ title: `Trim edit ${tag}`, autoTrimStartSec: 4.2, autoTrimEndSec: 170 }]);
    await page.goto('/');
    await openEdit(page, song.id);

    // What the PC suggested is shown, with the amounts cut.
    await expect(page.getByTestId('trim-status')).toHaveText('Trimmed automatically: 4.2 s cut from the start, 10.0 s cut from the end');
    await expect(page.getByTestId('trim-start')).toHaveValue('0:04.2');
    await expect(page.getByTestId('trim-end')).toHaveValue('2:50.0');

    // Validation messages, live and on Save.
    await typeTrim(page, 'trim-end', '0:10');
    await expect(page.getByTestId('trim-error')).toHaveText('Keep at least 10 seconds of the song.');
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('edit-error')).toHaveText('Keep at least 10 seconds of the song.');
    await expect(page.getByTestId('edit-dialog')).toBeVisible();
    await typeTrim(page, 'trim-end', '3:05');
    await expect(page.getByTestId('trim-error')).toHaveText("The end can't be past the end of the song.");
    await typeTrim(page, 'trim-end', '1:00');
    await typeTrim(page, 'trim-start', '2:00');
    await expect(page.getByTestId('trim-error')).toHaveText('The start must be before the end.');
    await typeTrim(page, 'trim-start', 'soon');
    await expect(page.getByTestId('trim-error')).toHaveText('Enter the start as m:ss.s, for example 0:12.5.');
    await expect(page.getByTestId('trim-play-start')).toBeDisabled();

    // Reset to automatic brings back the suggestion and clears the errors.
    await page.getByTestId('trim-reset').click();
    await expect(page.getByTestId('trim-error')).toHaveCount(0);
    await expect(page.getByTestId('trim-start')).toHaveValue('0:04.2');
    await expect(page.getByTestId('trim-end')).toHaveValue('2:50.0');
    await expect(page.getByTestId('trim-status')).toContainText('Trimmed automatically');

    // The handles move by keyboard (and by touch or mouse, below).
    await page.getByTestId('trim-handle-end').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('trim-end')).toHaveValue('2:49.0');
    await expect(page.getByTestId('trim-status')).toHaveText('Trimmed: 4.2 s cut from the start, 11.0 s cut from the end');

    // Don't trim: start 0 and the full length, saved as hand values.
    await page.getByTestId('trim-none').click();
    await expect(page.getByTestId('trim-status')).toHaveText('Not trimmed');
    await expect(page.getByTestId('trim-start')).toHaveValue('0:00.0');
    await expect(page.getByTestId('trim-end')).toHaveValue('3:00.0');
    await saveEdit(page, song.id);
    await expect.poll(async () => (await trimOf(page, song.id))?.trimStartSec).toBe(0);
    expect(await trimOf(page, song.id)).toMatchObject({ trimStartSec: 0, trimEndSec: 180, autoTrimStartSec: 4.2, autoTrimEndSec: 170 });

    // Reset to automatic clears the hand values again.
    await openEdit(page, song.id);
    await expect(page.getByTestId('trim-status')).toHaveText('Not trimmed');
    await page.getByTestId('trim-reset').click();
    await saveEdit(page, song.id);
    await expect.poll(async () => (await trimOf(page, song.id))?.trimStartSec).toBeNull();
    expect(await trimOf(page, song.id)).toMatchObject({ trimStartSec: null, trimEndSec: null });

    // The server checks the same rule.
    const bad = await page.request.patch(`/api/tracks/${song.id}`, { data: { trimStartSec: 100, trimEndSec: 105 } });
    expect(bad.status()).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('Keep at least 10 seconds of the song.');
  });

  test('Edit details: dragging a handle sets the trim', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seed(page.request, [{ title: `Trim drag ${tag}` }]);
    await page.goto('/');
    await openEdit(page, song.id);
    await expect(page.getByTestId('trim-status')).toHaveText('Not trimmed');

    const bar = await page.getByTestId('trim-bar').boundingBox();
    const handle = await page.getByTestId('trim-handle-start').boundingBox();
    expect(bar && handle).toBeTruthy();
    if (!bar || !handle) return;
    // Drag the start handle to about a quarter of the song (45 s of 180).
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.25, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    const start = Number((await page.getByTestId('trim-handle-start').getAttribute('aria-valuenow')) ?? '0');
    expect(start).toBeGreaterThan(40);
    expect(start).toBeLessThan(50);
    await expect(page.getByTestId('trim-status')).toContainText('cut from the start');
    await saveEdit(page, song.id);
    await expect.poll(async () => (await trimOf(page, song.id))?.trimStartSec).toBe(start);
  });

  test('playback starts at the trim start and the next song starts at the trim end', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', PLAYBACK_ONLY_WEBKIT);
    const tag = uniqueTag();
    const album = `Trim album ${tag}`;
    const [first, second] = await seed(page.request, [
      { title: `Trim one ${tag}`, album },
      { title: `Trim two ${tag}`, album },
    ]);

    // Trim the first song by hand: 0:20.0 to 2:30.0 (2:10 left).
    await page.goto('/');
    await openEdit(page, first.id);
    await typeTrim(page, 'trim-start', '0:20');
    await typeTrim(page, 'trim-end', '2:30');
    await expect(page.getByTestId('trim-status')).toHaveText('Trimmed: 20.0 s cut from the start, 30.0 s cut from the end');
    await saveEdit(page, first.id);
    await expect.poll(async () => (await trimOf(page, first.id))?.trimEndSec).toBe(150);

    await page.goto(`/album?name=${encodeURIComponent(album)}&artist=${encodeURIComponent('Trim Band')}`);
    await page.getByTestId('list-play').click();
    await expect.poll(() => mediaTitle(page), { timeout: 15_000 }).toBe(first.title);

    // It starts at the trim start, and the player shows the trimmed length.
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(20.2);
    expect(await audioTime(page)).toBeLessThan(30);
    await expect(page.getByTestId('player-duration').first()).toHaveText('2:10');
    await expect(page.getByTestId('seek-slider').first()).toHaveAttribute('max', '130');

    // Close to the trim end, the next song starts by itself (well before the file's own end at 3:00).
    await page.evaluate(() => {
      (document.querySelector('audio') as HTMLAudioElement).currentTime = 148.5;
    });
    await expect.poll(() => mediaTitle(page), { timeout: 10_000 }).toBe(second.title);
    // The untrimmed second song plays from its beginning.
    const start = await audioTime(page);
    expect(start).toBeLessThan(10);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(start + 0.2);
    await expect(page.getByTestId('player-duration').first()).toHaveText('3:00');
  });
});
