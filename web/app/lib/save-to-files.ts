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

/**
 * The file extension for a song's type: .m4a for the downloader's files,
 * the uploaded format for songs uploaded from a device (T15).
 */
export function songFileExtension(type: string): string {
  const main = type.split(";")[0]!.trim().toLowerCase();
  if (main === "audio/mpeg" || main === "audio/mp3") return "mp3";
  if (main === "audio/wav" || main === "audio/x-wav" || main === "audio/wave") return "wav";
  if (main === "audio/flac" || main === "audio/x-flac") return "flac";
  return "m4a";
}

/** "<Artist> - <Title>.m4a"; path characters become "_" so it is a valid file name. */
export function songFileName(track: { title: string; artist: string }, type = "audio/mp4"): string {
  const title = track.title.trim() || "Untitled";
  const artist = track.artist.trim();
  const base = artist ? `${artist} - ${title}` : title;
  return `${base.replace(/[\\/:*?"<>|]+/g, "_")}.${songFileExtension(type)}`;
}

export function songFile(blob: Blob, track: { title: string; artist: string }): File {
  const type = blob.type && blob.type.startsWith("audio/") ? blob.type : "audio/mp4";
  return new File([blob], songFileName(track, type), { type });
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
