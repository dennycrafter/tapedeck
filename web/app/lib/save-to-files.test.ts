import { describe, expect, it, vi } from "vitest";
import { saveToFiles, songFileName, type SaveDeps } from "./save-to-files";

const track = { id: "11111111-1111-4111-8111-111111111111", title: "Get Lucky", artist: "Daft Punk" };

function deps(over: Partial<SaveDeps> = {}): SaveDeps & {
  share: ReturnType<typeof vi.fn>;
  canShare: ReturnType<typeof vi.fn>;
  openUrl: ReturnType<typeof vi.fn>;
} {
  return {
    getBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" })),
    getAttachmentUrl: vi.fn(async () => "https://storage.example/tracks/x.m4a?download=1"),
    openUrl: vi.fn(),
    isPhone: () => true,
    canShare: vi.fn(() => true),
    share: vi.fn(async () => undefined),
    ...over,
  } as never;
}

describe("Save to Files (SPEC 8.10)", () => {
  it("on the phone builds '<Artist> - <Title>.m4a' as audio/mp4 and shares it when canShare is true", async () => {
    const d = deps();
    await expect(saveToFiles(track, d)).resolves.toBe("shared");
    expect(d.share).toHaveBeenCalledTimes(1);
    const shared = d.share.mock.calls[0]?.[0] as ShareData;
    const file = shared.files?.[0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("Daft Punk - Get Lucky.m4a");
    expect(file.type).toBe("audio/mp4");
    expect(file.size).toBe(3);
    expect(d.canShare).toHaveBeenCalledWith({ files: [file] });
    expect(d.openUrl).not.toHaveBeenCalled();
  });

  it("falls back to the attachment download when the phone can not share files", async () => {
    const d = deps({ canShare: vi.fn(() => false) });
    await expect(saveToFiles(track, d)).resolves.toBe("downloaded");
    expect(d.share).not.toHaveBeenCalled();
    expect(d.openUrl).toHaveBeenCalledWith("https://storage.example/tracks/x.m4a?download=1");
  });

  it("on a PC opens the attachment URL and never fetches the file itself", async () => {
    const d = deps({ isPhone: () => false });
    await expect(saveToFiles(track, d)).resolves.toBe("downloaded");
    expect(d.getBlob).not.toHaveBeenCalled();
    expect(d.share).not.toHaveBeenCalled();
    expect(d.openUrl).toHaveBeenCalledTimes(1);
  });

  it("closing the share sheet is a quiet cancel", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const d = deps({ share: vi.fn(async () => Promise.reject(abort)) });
    await expect(saveToFiles(track, d)).resolves.toBe("cancelled");
  });

  it("file names drop path characters and handle a blank artist", () => {
    expect(songFileName({ title: "AC/DC: Live?", artist: "" })).toBe("AC_DC_ Live_.m4a");
    expect(songFileName({ title: "Song", artist: "  " })).toBe("Song.m4a");
  });
});
