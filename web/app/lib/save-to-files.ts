/**
 * "Save to Files" (SPEC 8.10). On the iPhone: build a File named
 * "<Artist> - <Title>.m4a" (type audio/mp4) from the downloaded copy, or
 * fetch it, and hand it to the share sheet, where the owner picks "Save to
 * Files". Elsewhere (PC): open the presigned URL with ?download=1, which
 * answers with an attachment of the same name. The file already carries its
 * title, artist, album and cover tags from the downloader.
 */

export interface SaveDeps {
  /** The song's audio: the offline copy if there is one, else fetched. */
  getBlob(trackId: string): Promise<Blob>;
  /** Presigned GET with the attachment disposition. */
  getAttachmentUrl(trackId: string): Promise<string>;
  /** Start a normal browser download of a URL. */
  openUrl(url: string): void;
  /** True on touch phones, where the share sheet is the way to save a file. */
  isPhone(): boolean;
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
}

/** "<Artist> - <Title>.m4a"; path characters become "_" so it is a valid file name. */
export function songFileName(track: { title: string; artist: string }): string {
  const title = track.title.trim() || "Untitled";
  const artist = track.artist.trim();
  const base = artist ? `${artist} - ${title}` : title;
  return `${base.replace(/[\\/:*?"<>|]+/g, "_")}.m4a`;
}

export function songFile(blob: Blob, track: { title: string; artist: string }): File {
  return new File([blob], songFileName(track), { type: "audio/mp4" });
}

export type SaveOutcome = "shared" | "downloaded" | "cancelled";

export async function saveToFiles(
  track: { id: string; title: string; artist: string },
  deps: SaveDeps,
): Promise<SaveOutcome> {
  if (deps.isPhone() && deps.canShare && deps.share) {
    const file = songFile(await deps.getBlob(track.id), track);
    if (deps.canShare({ files: [file] })) {
      try {
        await deps.share({ files: [file] });
        return "shared";
      } catch (error) {
        // Closing the share sheet is not an error worth showing.
        if (error instanceof Error && error.name === "AbortError") return "cancelled";
        throw error;
      }
    }
  }
  deps.openUrl(await deps.getAttachmentUrl(track.id));
  return "downloaded";
}
