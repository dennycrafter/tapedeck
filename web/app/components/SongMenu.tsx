"use client";

/**
 * The song "..." menu (SPEC 10): Play next, Add to queue, Add to playlist,
 * Like/Unlike, Go to album, Go to artist, Edit details, Restore original,
 * Retry (failed only), Delete. Download, Save to Files (T4) and Add to Apple
 * Music (T6) join later. On a playlist page it also offers "Remove from
 * this playlist".
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { restoreTrack, type TrackDto } from "../lib/api";
import { albumArtistOf, albumHref, artistHref, toPlayerTrack } from "../lib/library-view";
import { useLibrary } from "./LibraryProvider";
import { useOverlays } from "./Overlays";
import { usePlayer } from "./PlayerProvider";
import { TrackEditDialog } from "./TrackEditDialog";
import { AddToPlaylistDialog } from "./AddToPlaylistDialog";
import { ConfirmDialog, ICON_BTN, Menu, type MenuItem } from "./ui";
import { MoreIcon } from "./icons";

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

type Dialog = "playlist" | "edit" | "delete" | null;

export function SongMenu({ track, playlistId, className = "" }: SongMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const router = useRouter();
  const player = usePlayer();
  const library = useLibrary();
  const { showToast, notifyLibraryChanged } = useOverlays();
  const ready = track.status === "ready";

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
    { label: "Add to playlist", testId: "menu-add-playlist", onSelect: () => setDialog("playlist") },
    ...(playlistId
      ? [
          {
            label: "Remove from this playlist",
            testId: "menu-remove-playlist",
            onSelect: () => void run(() => library.removeFromPlaylist(playlistId, track.id), "Removed from playlist"),
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
            onSelect: () => router.push(albumHref(track.album as string, albumArtistOf(track))),
          },
        ]
      : []),
    ...(track.artist
      ? [{ label: "Go to artist", testId: "menu-go-artist", onSelect: () => router.push(artistHref(track.artist)) }]
      : []),
    "divider",
    { label: "Edit details", testId: "menu-edit", onSelect: () => setDialog("edit") },
    {
      label: "Restore original",
      testId: "menu-restore",
      onSelect: () =>
        void run(async () => {
          await restoreTrack(track.id);
          notifyLibraryChanged();
        }, "Original title restored"),
    },
    ...(track.status === "failed"
      ? [{ label: "Retry", testId: "menu-retry", onSelect: () => void run(() => library.retryTrack(track), "Retry queued") }]
      : []),
    { label: "Delete", testId: "menu-delete", danger: true, onSelect: () => setDialog("delete") },
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
      {open && <Menu anchor={anchor} items={items} onClose={() => setOpen(false)} label={`Options for ${track.title}`} />}
      {dialog === "playlist" && <AddToPlaylistDialog trackIds={[track.id]} onClose={() => setDialog(null)} />}
      {dialog === "edit" && <TrackEditDialog track={track} onClose={() => setDialog(null)} />}
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
