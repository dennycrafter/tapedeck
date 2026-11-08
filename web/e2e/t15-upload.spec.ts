import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers/login';
import { cleanup, librarySnapshot, uniqueTag } from './helpers/library';
import { mp3Silence, pngSolid, wavTone } from './helpers/audio-fixtures';
import { agentApi } from './helpers/agent';
import { BASE_URL } from './helpers/env';

/*
 * T15 upload your own songs @T15. Made-up files built in memory (helpers/
 * audio-fixtures.ts), titles made unique per run so reruns and the shared
 * library never collide; every song and playlist made here is deleted after.
 *
 * desktop: the Upload button with several files at once (tags, cover art,
 * a file named after itself, a rejected non-song, progress bars, the toast),
 * then the songs play, queue and go into a playlist like any other; the same
 * file again is "Already in your library". Drag and drop onto the page,
 * and "Choose a folder" with an album folder (songs only, in track order).
 * iphone (WebKit): the Upload button and playback on the phone layout.
 */

const made: { trackIds: string[]; playlistIds: string[] } = { trackIds: [], playlistIds: [] };

test.afterEach(async ({ page }) => {
  // Skipped projects made nothing and never reached the app.
  if (made.trackIds.length > 0 || made.playlistIds.length > 0) await cleanup(page.request, made);
  made.trackIds = [];
  made.playlistIds = [];
});

function onlyOn(project: string) {
  test.skip(test.info().project.name !== project, `runs on the ${project} project`);
}

async function openUploadTab(page: Page): Promise<void> {
  await page.getByTestId('add-open').filter({ visible: true }).first().click();
  await page.getByTestId('add-tab-upload').click();
  await expect(page.getByTestId('upload-choose')).toBeVisible();
}

/** Ids of library songs whose title contains `tag`, for checks and cleanup. */
async function songsTagged(page: Page, tag: string): Promise<{ id: string; title: string; coverUrl: string | null }[]> {
  const snapshot = await librarySnapshot(page.request);
  const tracks = (snapshot as unknown as { tracks: { id: string; title: string; coverUrl: string | null }[] }).tracks;
  return tracks.filter((track) => track.title.includes(tag));
}

async function expectPlaying(page: Page, title: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1), {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBeGreaterThan(0.2);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title ?? null)).toBe(title);
}

test.describe('T15 upload songs from this device @T15', () => {
  test('Upload button: several files, tags and cover, errors, then play, queue and playlist', async ({ page }) => {
    onlyOn('desktop');
    test.setTimeout(120_000);
    const tag = uniqueTag();
    const mp3Title = `Night Drive ${tag}`;
    const wavTitle = `Field Recording ${tag}`;
    const mp3 = mp3Silence({
      frames: 400,
      tags: { title: mp3Title, artist: 'The Made Ups', album: `Test Pressing ${tag}`, cover: pngSolid(64, [220, 90, 30]) },
    });
    const wav = wavTone({ seconds: 6, frequency: 300 + Math.floor(Math.random() * 400) });

    await login(page);
    await page.goto('/library');
    await openUploadTab(page);
    // PC layout: the drop area shows, and the picker takes several song files.
    await expect(page.getByText('Drop songs or folders here')).toBeVisible();
    const input = page.getByTestId('upload-input');
    await expect(input).toHaveAttribute('multiple', '');
    expect(await input.getAttribute('accept')).toContain('.flac');

    // Slow the file PUTs down a little so the progress bars can be seen.
    await page.route('**/api/local-storage/**', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });
    await input.setInputFiles([
      { name: '01 night drive.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(mp3) },
      { name: `${wavTitle}.wav`, mimeType: 'audio/wav', buffer: Buffer.from(wav) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a song') },
    ]);

    const rows = page.getByTestId('upload-item');
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole('progressbar').first()).toBeVisible();
    // The non-song is refused straight away with a friendly message.
    const bad = rows.filter({ hasText: 'notes' });
    await expect(bad.getByTestId('upload-item-status')).toHaveText('Failed');
    await expect(bad.getByTestId('upload-item-error')).toHaveText('Not a song file. Upload MP3, M4A, WAV or FLAC.');
    // The MP3 is named from its tags (its file name shows under it), the WAV after its file.
    const mp3Row = rows.filter({ hasText: mp3Title });
    await expect(mp3Row.getByTestId('upload-item-status')).toHaveText('Added', { timeout: 30_000 });
    await expect(mp3Row).toContainText('01 night drive.mp3');
    const wavRow = rows.filter({ hasText: wavTitle });
    await expect(wavRow.getByTestId('upload-item-status')).toHaveText('Added', { timeout: 30_000 });
    await expect(page.getByTestId('toast')).toHaveText('2 added, 1 failed');
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await page.unroute('**/api/local-storage/**');

    const songs = await songsTagged(page, tag);
    made.trackIds.push(...songs.map((song) => song.id));
    expect(songs.map((song) => song.title).sort()).toEqual([wavTitle, mp3Title].sort());
    const mp3Song = songs.find((song) => song.title === mp3Title)!;
    const wavSong = songs.find((song) => song.title === wavTitle)!;

    // In the library like any song: tags as the subtitle, the file's cover art.
    await page.getByTestId('add-close').click();
    const mp3Item = page.locator(`[data-item-id="${mp3Song.id}"]`).first();
    await expect(mp3Item.getByTestId('track-title')).toHaveText(mp3Title);
    await expect(mp3Item.getByTestId('track-subtitle')).toHaveText(`The Made Ups · Test Pressing ${tag}`);
    expect(mp3Song.coverUrl).toBe(`/covers/${mp3Song.id}`);
    const cover = mp3Item.locator(`img[src="/covers/${mp3Song.id}"]`);
    await expect(cover).toBeVisible();
    await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // It plays.
    const wavItem = page.locator(`[data-item-id="${wavSong.id}"]`).first();
    await wavItem.click();
    await expectPlaying(page, wavTitle);

    // It queues.
    await mp3Item.getByTestId('song-menu-button').click();
    await page.getByTestId('menu-add-queue').click();
    await expect(page.getByTestId('toast')).toHaveText('Added to queue');
    await page.getByTestId('queue-open').click();
    await expect(page.getByTestId('queue-panel').getByText(mp3Title)).toBeVisible();
    await page.keyboard.press('Escape');

    // It goes into a playlist.
    const playlistName = `Uploads ${tag}`;
    const created = await page.request.post('/api/playlists', { data: { name: playlistName } });
    expect(created.status()).toBe(201);
    const playlistId = ((await created.json()) as { id: string }).id;
    made.playlistIds.push(playlistId);
    await page.reload();
    await mp3Item.getByTestId('song-menu-button').click();
    await page.getByTestId('menu-add-playlist').click();
    await page.getByTestId('playlist-picker-item').filter({ hasText: playlistName }).click();
    await expect(page.getByTestId('toast')).toHaveText(`Added to ${playlistName}`);
    await page.goto(`/playlist?id=${playlistId}`);
    await expect(page.getByTestId('playlist-tracks').getByTestId('track-title')).toHaveText([mp3Title]);

    // The same file again is not stored twice.
    await openUploadTab(page);
    await page.getByTestId('upload-input').setInputFiles([
      { name: 'copy.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(mp3) },
    ]);
    await expect(page.getByTestId('upload-item').getByTestId('upload-item-status')).toHaveText('Already in your library');
    await expect(page.getByTestId('toast')).toHaveText('1 already in library');
    expect(await songsTagged(page, tag)).toHaveLength(2);
  });

  test('drag and drop files onto the page uploads them', async ({ page }) => {
    onlyOn('desktop');
    const tag = uniqueTag();
    const title = `Dropped ${tag}`;
    const wav = wavTone({ seconds: 2, frequency: 500 + Math.floor(Math.random() * 300), tags: { title, artist: 'Drag Act' } });

    await login(page);
    await page.goto('/library');
    await page.evaluate(
      ({ bytes }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'dropped.wav', { type: 'audio/wav' }));
        (window as unknown as { __drop: DataTransfer }).__drop = data;
        document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      },
      { bytes: Array.from(wav) },
    );
    await expect(page.getByTestId('upload-drop-hint')).toBeVisible();
    await expect(page.getByTestId('upload-drop-hint')).toContainText('Drop to upload');
    await page.evaluate(() => {
      const data = (window as unknown as { __drop: DataTransfer }).__drop;
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('upload-drop-hint')).toHaveCount(0);

    // The Add window opens on the Upload tab and the file goes up.
    await expect(page.getByTestId('add-tab-upload')).toHaveAttribute('aria-selected', 'true');
    const row = page.getByTestId('upload-item').filter({ hasText: title });
    await expect(row.getByTestId('upload-item-status')).toHaveText('Added', { timeout: 30_000 });
    await expect(page.getByTestId('toast')).toHaveText('1 added');
    const songs = await songsTagged(page, tag);
    made.trackIds.push(...songs.map((song) => song.id));
    expect(songs).toHaveLength(1);
  });

  test('Choose a folder uploads the songs inside it in track order and skips the rest', async ({ page }) => {
    onlyOn('desktop');
    test.setTimeout(90_000);
    const tag = uniqueTag();
    // An album folder as it comes off a CD rip: songs, a cover, a text file,
    // a hidden Mac file and a second disc in its own folder.
    const album = test.info().outputPath(`Album ${tag}`);
    mkdirSync(join(album, 'Disc 2'), { recursive: true });
    const write = (name: string, bytes: Uint8Array | string) => writeFileSync(join(album, name), bytes);
    write('02 Second.wav', wavTone({ seconds: 2, frequency: 300 + Math.floor(Math.random() * 300), tags: { title: `Second ${tag}`, artist: 'Folder Band' } }));
    write('01 First.mp3', mp3Silence({ frames: 100, tags: { title: `First ${tag}`, artist: 'Folder Band' } }));
    write(join('Disc 2', '01 Third.wav'), wavTone({ seconds: 2, frequency: 600 + Math.floor(Math.random() * 300), tags: { title: `Third ${tag}`, artist: 'Folder Band' } }));
    write('cover.png', pngSolid(16, [10, 120, 200]));
    write('notes.txt', 'ripped by me');
    write('.DS_Store', 'mac');

    await login(page);
    await page.goto('/library');
    await openUploadTab(page);
    await expect(page.getByTestId('upload-panel')).toContainText('Drop songs or folders here');
    await expect(page.getByTestId('upload-choose-folder')).toBeVisible();
    await page.getByTestId('upload-folder-input').setInputFiles(album);

    // Only the three songs get rows, in track order; the other files are left out quietly.
    const rows = page.getByTestId('upload-item');
    await expect(rows).toHaveCount(3);
    await expect(rows.getByTestId('upload-item-status')).toHaveText(['Added', 'Added', 'Added'], { timeout: 45_000 });
    await expect(rows.getByTestId('upload-item-name')).toHaveText([`First ${tag}`, `Second ${tag}`, `Third ${tag}`]);
    await expect(page.getByTestId('upload-item-error')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveText('3 added');
    const songs = await songsTagged(page, tag);
    made.trackIds.push(...songs.map((song) => song.id));
    expect(songs).toHaveLength(3);

    // A folder with no songs says so instead of uploading anything.
    const pictures = test.info().outputPath(`Pictures ${tag}`);
    mkdirSync(pictures, { recursive: true });
    writeFileSync(join(pictures, 'photo.png'), pngSolid(8, [0, 0, 0]));
    await page.getByTestId('upload-folder-input').setInputFiles(pictures);
    await expect(page.getByTestId('toast')).toHaveText('No songs in that folder. Upload MP3, M4A, WAV or FLAC.');
    await expect(rows).toHaveCount(3);
  });

  test('on the iPhone layout the Upload button adds a song that plays', async ({ page }) => {
    onlyOn('iphone');
    test.setTimeout(90_000);
    const tag = uniqueTag();
    const title = `Pocket Tone ${tag}`;
    const wav = wavTone({ seconds: 6, frequency: 200 + Math.floor(Math.random() * 600), tags: { title, artist: 'Phone Band' } });

    await login(page);
    await page.goto('/library');
    await openUploadTab(page);
    // No drop area on the phone: the hint says what can be picked instead.
    await expect(page.getByText('Drop songs or folders here')).toBeHidden();
    await expect(page.getByTestId('upload-choose-folder')).toBeHidden();
    await expect(page.getByText(/MP3, M4A, WAV or FLAC, up to 200 MB each\. You can pick several at once\./)).toBeVisible();

    await page.getByTestId('upload-input').setInputFiles([
      { name: 'voice memo.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) },
    ]);
    const row = page.getByTestId('upload-item').filter({ hasText: title });
    await expect(row.getByTestId('upload-item-status')).toHaveText('Added', { timeout: 30_000 });
    const songs = await songsTagged(page, tag);
    made.trackIds.push(...songs.map((song) => song.id));
    expect(songs).toHaveLength(1);

    await page.getByTestId('add-close').click();
    await page.locator(`[data-item-id="${songs[0]!.id}"]`).first().click();
    await expectPlaying(page, title);
  });

  // Add to Apple Music on an uploaded song: it stays ready, and the PC gets a
  // copy with a link to the stored file (agent/apple_music_uploads.py does
  // the rest, covered by pytest).
  test('Add to Apple Music on an uploaded song hands the PC a link to the file', async ({ page }) => {
    onlyOn('desktop');
    const tag = uniqueTag();
    const title = `Apple Upload ${tag}`;
    const wav = wavTone({ seconds: 2, frequency: 200 + Math.floor(Math.random() * 600), tags: { title, artist: 'Orchard' } });

    await login(page);
    await page.goto('/library');
    await openUploadTab(page);
    await page.getByTestId('upload-input').setInputFiles([{ name: 'apple.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) }]);
    await expect(page.getByTestId('upload-item').filter({ hasText: title }).getByTestId('upload-item-status')).toHaveText('Added', {
      timeout: 30_000,
    });
    const [song] = await songsTagged(page, tag);
    made.trackIds.push(song!.id);
    await page.getByTestId('add-close').click();

    const item = page.locator(`[data-item-id="${song!.id}"]`).first();
    await item.getByTestId('song-menu-button').click();
    await page.getByTestId('menu-apple-music').click();
    await expect(page.getByTestId('toast')).toContainText('Apple Music');
    // Still ready to play: nothing for the PC to download.
    await expect(item.getByTestId('track-status')).toHaveCount(0);

    const claim = await agentApi('/api/agent/apple-music-copies', { method: 'POST', body: '{}' });
    expect(claim.status).toBe(200);
    const { copies } = (await claim.json()) as { copies: { id: string; title: string; format: string; audioUrl: string }[] };
    const copy = copies.find((entry) => entry.id === song!.id);
    expect(copy).toMatchObject({ title, format: 'wav' });
    const file = await fetch(new URL(copy!.audioUrl, BASE_URL));
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(wav.byteLength);

    // The PC reports it done: the menu no longer offers it.
    expect((await agentApi('/api/agent/apple-music-done', { method: 'POST', body: JSON.stringify({ trackId: song!.id }) })).status).toBe(200);
    await page.reload();
    await item.getByTestId('song-menu-button').click();
    await expect(page.getByTestId('menu-add-queue')).toBeVisible();
    await expect(page.getByTestId('menu-apple-music')).toHaveCount(0);
  });
});
