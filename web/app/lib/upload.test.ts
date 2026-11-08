import { parseBuffer } from "music-metadata";
import { describe, expect, it } from "vitest";
import { mp3Silence, pngSolid, wavTone } from "../../e2e/helpers/audio-fixtures";
import { fingerprint, summarizeUploads, tagsFromMetadata, UploadFailure, type ParsedMetadata } from "./upload";

async function parse(bytes: Uint8Array, mimeType: string): Promise<ParsedMetadata> {
  return (await parseBuffer(bytes, { mimeType }, { duration: false })) as unknown as ParsedMetadata;
}

describe("tagsFromMetadata on real files (T15)", () => {
  it("reads title, artist, album, album artist and cover art from an MP3's ID3 tag", async () => {
    const cover = pngSolid(4, [200, 40, 40]);
    const bytes = mp3Silence({
      tags: { title: "Night Drive", artist: "The Made Ups", album: "Test Pressing", albumArtist: "Various", cover },
    });
    const tags = tagsFromMetadata(await parse(bytes, "audio/mpeg"));
    expect(tags).toMatchObject({
      title: "Night Drive",
      artist: "The Made Ups",
      album: "Test Pressing",
      albumArtist: "Various",
    });
    expect(tags.picture?.format).toBe("image/png");
    expect(Array.from(tags.picture?.data ?? [])).toEqual(Array.from(cover));
    // 200 frames of 1152 samples at 44.1 kHz.
    expect(tags.durationSec).toBeGreaterThan(4.5);
    expect(tags.durationSec).toBeLessThan(6);
  });

  it("reads tags from a WAV's id3 chunk, and the length from its header", async () => {
    const bytes = wavTone({ seconds: 2, tags: { title: "Tone Study", artist: "Lab Band" } });
    const tags = tagsFromMetadata(await parse(bytes, "audio/wav"));
    expect(tags).toMatchObject({ title: "Tone Study", artist: "Lab Band", album: null, picture: null });
    expect(tags.durationSec).toBeCloseTo(2, 1);
  });

  it("gives nulls for a file without tags (the file name becomes the title later)", async () => {
    const tags = tagsFromMetadata(await parse(wavTone({ seconds: 1 }), "audio/wav"));
    expect(tags).toMatchObject({ title: null, artist: null, album: null, albumArtist: null, picture: null });
    expect(tags.durationSec).toBeCloseTo(1, 1);
  });

  it("refuses something that is not audio, even with a song's extension", async () => {
    const text = new TextEncoder().encode("Shopping list: eggs, milk, bread. ".repeat(40));
    let meta: ParsedMetadata | null = null;
    try {
      meta = await parse(text, "audio/mpeg");
    } catch {
      meta = null; // the reader gave up: also "not a song"
    }
    if (meta) expect(() => tagsFromMetadata(meta as ParsedMetadata)).toThrow(UploadFailure);
  });
});

describe("tagsFromMetadata rules", () => {
  it("joins several artists and trims stray NULs and spaces", () => {
    const tags = tagsFromMetadata({
      format: { codec: "MPEG 1 Layer 3", duration: 61.2 },
      common: { title: " Song\0 ", artists: ["A", "B"] },
    });
    expect(tags.title).toBe("Song");
    expect(tags.artist).toBe("A, B");
    expect(tags.durationSec).toBe(61.2);
  });

  it("throws the friendly message when nothing says audio", () => {
    expect(() => tagsFromMetadata({ format: {}, common: { title: "x" } })).toThrow(
      "This file doesn't look like a song. Upload MP3, M4A, WAV or FLAC.",
    );
  });
});

describe("fingerprint", () => {
  it("is a SHA-256 hex digest that changes when the file changes", async () => {
    const a = await fingerprint(new Blob([wavTone({ seconds: 1, frequency: 440 }) as BlobPart]));
    const b = await fingerprint(new Blob([wavTone({ seconds: 1, frequency: 441 }) as BlobPart]));
    const again = await fingerprint(new Blob([wavTone({ seconds: 1, frequency: 440 }) as BlobPart]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
  });

  it("covers the end of big files too", async () => {
    const size = 3 * 1024 * 1024;
    const one = new Uint8Array(size);
    const two = new Uint8Array(size);
    two[size - 1] = 1;
    expect(await fingerprint(new Blob([one]))).not.toBe(await fingerprint(new Blob([two])));
  });
});

describe("summarizeUploads", () => {
  it("uses the same toast copy as pasted links", () => {
    expect(summarizeUploads({ added: 2, already: 1, failed: 1 })).toBe("2 added, 1 already in library, 1 failed");
    expect(summarizeUploads({ added: 1, already: 0, failed: 0 })).toBe("1 added");
    expect(summarizeUploads({ added: 0, already: 0, failed: 0 })).toBeNull();
  });
});
