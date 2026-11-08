import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, seedReadyTracks, uniqueTag } from './helpers/library';

/*
 * T16 lyrics @T16. The lyrics stand-in (lib/lyrics-fixtures.ts) answers for
 * made-up songs: "Paper Lanterns" has timed lines at 0.4, 1.4, 2.4 and 30 s,
 * "Radio Edit" only fits a shorter copy (words only here), "Quiet Piece" is
 * instrumental. Seeded songs are the 180 s test tone. Every song made here
 * is deleted after.
 */

const made: { trackIds: string[] } = { trackIds: [] };

test.beforeEach(async ({ page }) => {
  made.trackIds = [];
  await login(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page.request, made);
});

async function openNowPlaying(page: Page, id: string, title: string): Promise<void> {
  await page.goto('/');
  await page.locator(`[data-item-id="${id}"]`).first().getByTestId('track-row').click();
  await expect(page.getByTestId('player-title').filter({ visible: true }).first()).toHaveText(title);
  await page.getByRole('button', { name: 'Open now playing' }).filter({ visible: true }).first().click();
  await expect(page.getByTestId('now-playing')).toBeVisible();
}

function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
}

test.describe('T16 lyrics @T16', () => {
  test('timed lyrics light up the line being sung, and a tapped line plays from there', async ({ page }) => {
    const tag = uniqueTag();
    const [song] = await seedReadyTracks(page.request, [{ title: `Paper Lanterns ${tag}`, artist: 'The Made Ups' }]);
    made.trackIds.push(song.id);
    await openNowPlaying(page, song.id, song.title);
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(0.1);

    const toggle = page.getByTestId('now-playing-lyrics');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const lines = page.getByTestId('lyrics-line');
    await expect(lines).toHaveText([
      'Paper lanterns on the water',
      'Carry every word we said',
      'Light them one more time',
      'Until the river runs to red',
    ]);
    await expect(page.getByTestId('lyrics')).toContainText('Lyrics from LRCLIB');

    // Tap the third line (2.4 s): the song jumps there and that line is lit until 30 s.
    await lines.nth(2).click();
    await expect.poll(() => audioTime(page)).toBeGreaterThanOrEqual(2.3);
    await expect(lines.nth(2)).toHaveAttribute('data-active', 'true');
    await expect(lines.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(lines.nth(0)).toHaveAttribute('data-active', 'false');
    await lines.nth(3).click();
    await expect(lines.nth(3)).toHaveAttribute('data-active', 'true');
    expect(await audioTime(page)).toBeGreaterThanOrEqual(29.9);

    // Lyrics stay on: closing and opening Now Playing shows them again.
    await page.getByTestId('now-playing-close').click();
    await expect(page.getByTestId('now-playing')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open now playing' }).filter({ visible: true }).first().click();
    await expect(page.getByTestId('lyrics-line')).toHaveCount(4);
    // The button brings the cover back.
    await page.getByTestId('now-playing-lyrics').click();
    await expect(page.getByTestId('lyrics')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-lyrics')).toHaveAttribute('aria-pressed', 'false');
  });

  test('words only for another copy, instrumental, and nothing found', async ({ page }) => {
    const tag = uniqueTag();
    const seeded = await seedReadyTracks(page.request, [
      { title: `Radio Edit ${tag}`, artist: 'The Made Ups' },
      { title: `Quiet Piece ${tag}`, artist: 'The Made Ups' },
      { title: `Nobody Wrote This ${tag}`, artist: 'The Made Ups' },
    ]);
    made.trackIds.push(...seeded.map((song) => song.id));
    const [radio, quiet, nothing] = seeded;

    await openNowPlaying(page, radio!.id, radio!.title);
    await page.getByTestId('now-playing-lyrics').click();
    await expect(page.getByTestId('lyrics-plain')).toHaveText('Short and sweet\nCut for the radio');
    await expect(page.getByTestId('lyrics-line')).toHaveCount(0);

    // The button stays on for the next songs.
    await openNowPlaying(page, quiet!.id, quiet!.title);
    await expect(page.getByTestId('lyrics-message')).toHaveText('Instrumental');
    await openNowPlaying(page, nothing!.id, nothing!.title);
    await expect(page.getByTestId('lyrics-message')).toHaveText('No lyrics found for this song.');
  });
});
