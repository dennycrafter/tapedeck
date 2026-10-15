"use client";

/**
 * The song "..." menu (SPEC 10): Play next, Add to queue, Add to playlist,
 * Like/Unlike, Go to album, Go to artist, Edit details, Restore original,
 * Download / Remove download and Save to Files (SPEC 8.9, 8.10), Retry
 * (failed only), Add to Apple Music (SPEC 8.11), Delete. On a playlist
 * page it also offers "Remove from this playlist".
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { restoreTrack, type TrackDto } from "../lib/api";
import {
  albumArtistOf,
  albumHref,
  artistHref,
  toPlayerTrack,
} from "../lib/library-view";
import { useLibrary } from "./LibraryProvider";
import { useOverlays } from "./Overlays";
import { usePlayer } from "./PlayerProvider";
import { TrackEditDialog } from "./TrackEditDialog";
import { AddToPlaylistDialog } from "./AddToPlaylistDialog";
import { PickVersionDialog } from "./PickVersionDialog";
import { ConfirmDialog, ICON_BTN, Menu, type MenuItem } from "./ui";
import { MoreIcon } from "./icons";
import { useOffline } from "./useOffline";
import {
  attachmentUrl,
  downloadTracks,
  removeDownload,
  songBlob,
} from "../lib/offline";
import { saveToFiles } from "../lib/save-to-files";

/** Touch phones save through the share sheet; a PC gets a normal download. */
function isPhone(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * The last song fetched for the share sheet. iPhone only opens the sheet
 * right after a tap; when fetching took too long, the second tap shares
 * this copy straight away.
 */
let sharedBlob: { id: string; blob: Blob } | null = null;

async function blobForShare(trackId: string): Promise<Blob> {
  if (sharedBlob?.id === trackId) return sharedBlob.blob;
  const blob = await songBlob(trackId);
  sharedBlob = { id: trackId, blob };
  return blob;
}

function startDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SongMenuProps {
  track: TrackDto;
  /** Set on a playlist page: adds "Remove from this playlist". */
  playlistId?: string;
  /** Extra classes for the trigger button. */
  className?: string;
}

type Dialog = "playlist" | "edit" | "delete" | "pick" | null;

export function SongMenu({ track, playlistId, className = "" }: SongMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const router = useRouter();
  const player = usePlayer();
  const library = useLibrary();
  const { showToast, notifyLibraryChanged } = useOverlays();
  const ready = track.status === "ready";
  const offline = useOffline();
  const downloaded = offline.downloaded.has(track.id);
  const downloading = offline.progress.has(track.id);

  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      if (done) showToast(done);
    } catch (error) {
      showToast(errorText(error));
    }
  }

  const items: (MenuItem | "divider")[] = [
    {
      label: "Play next",
      testId: "menu-play-next",
      disabled: !ready,
      onSelect: () => {
        player.playNext(toPlayerTrack(track));
        showToast("Playing next");
      },
    },
    {
      label: "Add to queue",
      testId: "menu-add-queue",
      disabled: !ready,
      onSelect: () => {
        player.addToQueue(toPlayerTrack(track));
        showToast("Added to queue");
      },
    },
    {
      label: "Add to playlist",
      testId: "menu-add-playlist",
      onSelect: () => setDialog("playlist"),
    },
    ...(playlistId
      ? [
          {
            label: "Remove from this playlist",
            testId: "menu-remove-playlist",
            onSelect: () =>
              void run(
                () => library.removeFromPlaylist(playlistId, track.id),
                "Removed from playlist",
              ),
          },
        ]
      : []),
    {
      label: track.liked ? "Unlike" : "Like",
      testId: "menu-like",
      onSelect: () => void run(() => library.setLiked(track, !track.liked)),
    },
    "divider",
    ...(track.album
      ? [
          {
            label: "Go to album",
            testId: "menu-go-album",
            onSelect: () =>
              router.push(
                albumHref(track.album as string, albumArtistOf(track)),
              ),
          },
        ]
      : []),
    ...(track.artist
      ? [
          {
            label: "Go to artist",
            testId: "menu-go-artist",
            onSelect: () => router.push(artistHref(track.artist)),
          },
        ]
      : []),
    "divider",
    downloaded
      ? {
          label: "Remove download",
          testId: "menu-remove-download",
          onSelect: () =>
            void run(() => removeDownload(track.id), "Download removed"),
        }
      : {
          label: downloading ? "Downloading..." : "Download",
          testId: "menu-download",
          disabled: !ready || downloading || !offline.online,
          onSelect: () =>
            void run(async () => {
              const failed = await downloadTracks([track]);
              if (failed > 0)
                throw new Error(
                  "Download failed. Try again when you have signal.",
                );
            }, "Downloaded"),
        },
    {
      label: "Save to Files",
      testId: "menu-save-files",
      disabled: !ready || (!offline.online && !downloaded),
      onSelect: () =>
        void run(async () => {
          try {
            await saveToFiles(track, {
              getBlob: blobForShare,
              getAttachmentUrl: attachmentUrl,
              openUrl: startDownload,
              isPhone,
              canShare:
                typeof navigator !== "undefined" && navigator.canShare
                  ? (data) => navigator.canShare(data)
                  : undefined,
              share:
                typeof navigator !== "undefined" && navigator.share
                  ? (data) => navigator.share(data)
                  : undefined,
            });
          } catch (error) {
            if (error instanceof Error && error.name === "NotAllowedError") {
              throw new Error("The file is ready. Tap Save to Files again.");
            }
            throw error;
          }
        }),
    },
    // SPEC 8.11: for single songs when the "Also add to Apple Music" setting
    // is off (with it on, the PC adds every new song by itself).
    ...(!track.appleMusic && track.status !== "failed"
      ? [
          {
            label: "Add to Apple Music",
            testId: "menu-apple-music",
            onSelect: () =>
              void run(
                () => library.addToAppleMusic(track),
                "Your PC will add it to Apple Music the next time it runs",
              ),
          },
        ]
      : []),
    "divider",
    {
      label: "Edit details",
      testId: "menu-edit",
      onSelect: () => setDialog("edit"),
    },
    {
      label: "Restore original",
      testId: "menu-restore",
      onSelect: () =>
        void run(async () => {
          await restoreTrack(track.id);
          notifyLibraryChanged();
        }, "Original title restored"),
    },
    ...(track.source === "catalog"
      ? [{ label: "Pick another version", testId: "menu-pick-version", onSelect: () => setDialog("pick") }]
      : []),
    ...(track.status === "failed"
      ? [
          {
            label: "Retry",
            testId: "menu-retry",
            onSelect: () =>
              void run(() => library.retryTrack(track), "Retry queued"),
          },
        ]
      : []),
    {
      label: "Delete",
      testId: "menu-delete",
      danger: true,
      onSelect: () => setDialog("delete"),
    },
  ];

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`More options for ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="song-menu-button"
        onClick={() => setOpen((value) => !value)}
        className={`${ICON_BTN} ${className}`}
      >
        <MoreIcon />
      </button>
      {open && (
        <Menu
          anchor={anchor}
          items={items}
          onClose={() => setOpen(false)}
          label={`Options for ${track.title}`}
        />
      )}
      {dialog === "playlist" && (
        <AddToPlaylistDialog
          trackIds={[track.id]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "edit" && (
        <TrackEditDialog track={track} onClose={() => setDialog(null)} />
      )}
      {dialog === "pick" && <PickVersionDialog track={track} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete song?"
          body={`"${track.title}" will be removed from your library and its file deleted. This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await library.deleteTrack(track);
            showToast("Song deleted");
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
