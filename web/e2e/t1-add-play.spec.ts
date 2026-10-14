import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { runSelftest } from './helpers/agent';

/*
 * T1 tracer flow @T1, iphone project (SPEC 9 T1 checks): the whole journey
 * one test so the shared stand-in server sees a deterministic sequence:
 * paste the fixture link, the row appears "Waiting for your PC" with the
 * fixture title and channel; pasting it again shows "Already in your
 * library"; --selftest makes it ready and the header "Downloader online";
 * pressing play advances currentTime and sets the Media Session title.
 *
 * The desktop/android projects skip: single-project execution avoids racing
 * the shared in-memory database with the second and third copies of this
 * flow (another project's selftest would flip the row status mid-assertion).
 */

const FIXTURE_URL = 'https://youtu.be/jNQXAC9IVRw';
// From web/e2e/fixtures/youtube-oembed.json (SPEC 9: title and channel from
// the YouTube fixture).
const FIXTURE_TITLE = 'Me at the zoo';
const FIXTURE_CHANNEL = 'jawed';

async function pasteAndSubmit(page: Page, url: string): Promise<void> {
  await page.getByTestId('add-open').first().click();
  await page.getByTestId('add-input').fill(url);
  await page.getByTestId('add-submit').click();
}

test.describe('T1 add and play @T1', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'T1 UI tracer runs on the iphone project (SPEC 9)');

  test('paste link shows a waiting row, selftest makes it play with Media Session', async ({ page }) => {
    test.setTimeout(240_000); // the --selftest child may take a couple of minutes

    await login(page);
    await page.goto('/');
    // A fresh stand-in run starts empty; the empty state offers the Add button.
    await expect(page.getByTestId('library-empty')).toBeVisible();

    // Check: pasting the fixture link adds the track; the row appears with the
    // fixture title and channel (SPEC 8.2, 8.3 statuses).
    await pasteAndSubmit(page, FIXTURE_URL);
    await expect(page.getByTestId('toast')).toHaveText('1 added');
    const row = page.getByTestId('track-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('track-title')).toHaveText(FIXTURE_TITLE);
    await expect(row.getByTestId('track-subtitle')).toHaveText(FIXTURE_CHANNEL);
    await expect(row.getByTestId('track-status')).toHaveText('Waiting for your PC');
    // Waiting rows are not playable buttons yet.
    await expect(row).not.toHaveRole('button');
    const trackId = await row.getAttribute('data-track-id');
    expect(trackId, 'row exposes its track id for the selftest').toBeTruthy();

    // Check: pasting the same link again shows "Already in your library"
    // (SPEC 8.2). A duplicate is a successful line, so the window closes and
    // only the summary toast shows.
    await pasteAndSubmit(page, FIXTURE_URL);
    await expect(page.getByTestId('toast')).toHaveText('1 already in library');
    await expect(page.getByTestId('add-window')).toHaveCount(0);
    await expect(page.getByTestId('track-row')).toHaveCount(1);

    // Check: --selftest (downloader against the local test server) makes the
    // track ready and the header shows "Downloader online" (SPEC 8.3, 9 T1).
    const selftest = await runSelftest(trackId as string);
    expect(selftest.code, `selftest failed:\n${selftest.stdout}\n${selftest.stderr}`).toBe(0);

    // Ready: no dot, no label, and the row becomes a playable button.
    await expect(row.getByTestId('track-status')).toHaveCount(0, { timeout: 30_000 });
    await expect(row).toHaveRole('button');
    await expect(page.getByTestId('downloader-status')).toHaveText('Downloader online');

    // Check: pressing play makes currentTime rise and the Media Session title
    // matches the track title (SPEC 8.8, 9 T1).
    await row.click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const audio = document.querySelector('audio');
            return audio ? audio.currentTime : -1;
          }),
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBeGreaterThan(0.2);
    const mediaTitle = await page.evaluate(() => navigator.mediaSession.metadata?.title ?? null);
    expect(mediaTitle).toBe(FIXTURE_TITLE);
  });
});
