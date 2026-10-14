"use client";

/**
 * "Download" for a whole list (SPEC 8.9): playlist, album, artist, and
 * "Download all" on Liked songs. Shows how far along it is, and a quiet
 * "Downloaded" once every ready song in the list is on this device.
 */
import type { TrackDto } from "../lib/api";
import { downloadTracks } from "../lib/offline";
import { DownloadIcon, DownloadedIcon } from "./icons";
import { useOverlays } from "./Overlays";
import { useOffline } from "./useOffline";
import { BTN_SECONDARY } from "./ui";

export function DownloadListButton({ tracks, label = "Download" }: { tracks: readonly TrackDto[]; label?: string }) {
  const offline = useOffline();
  const { showToast } = useOverlays();
  const ready = tracks.filter((track) => track.status === "ready");
  if (ready.length === 0) return null;
  const have = ready.filter((track) => offline.downloaded.has(track.id)).length;
  const busy = ready.filter((track) => offline.progress.has(track.id)).length;

  if (have === ready.length) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 text-sm text-silver" data-testid="list-downloaded">
        <DownloadedIcon width={18} height={18} /> Downloaded
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={busy > 0 || !offline.online}
      data-testid="list-download"
      onClick={() => {
        downloadTracks(ready).then(
          (failed) => showToast(failed > 0 ? `${failed} could not download. Try again.` : "Downloaded for offline"),
          (error: unknown) => showToast(error instanceof Error ? error.message : String(error)),
        );
      }}
      className={BTN_SECONDARY}
    >
      <DownloadIcon width={18} height={18} />
      {busy > 0 ? `Downloading ${have + 1} of ${ready.length}` : label}
    </button>
  );
}
