"use client";

/**
 * Edit details dialog (SPEC 8.4): fix the title, artist, and album of a
 * track, or Restore original to undo a bad fix — the database keeps the raw
 * values, so restoring always returns to them. Saving updates the library
 * through the refetch bump. Rendered from the player bar for the current
 * track.
 */
import { useState } from "react";
import { editTrack, restoreTrack, type TrackDto } from "../lib/api";
import { useOverlays } from "./Overlays";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TrackEditDialogProps {
  /** Only the editable fields — the player bar passes a PlayerTrack. */
  track: Pick<TrackDto, "id" | "title" | "artist" | "album">;
  onClose(): void;
}

export function TrackEditDialog({ track, onClose }: TrackEditDialogProps) {
  const { notifyLibraryChanged } = useOverlays();
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await editTrack(track.id, { title, artist, album });
      notifyLibraryChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  async function restore() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await restoreTrack(track.id);
      notifyLibraryChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <div
      className={
        "fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 " +
        "pb-[calc(5rem+env(safe-area-inset-bottom))] sm:items-center sm:pb-0"
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-dialog-title"
        data-testid="edit-dialog"
        className="w-full max-w-md rounded-box border border-line bg-surface-2 p-4 shadow-[0_6px_16px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center justify-between">
          <h2 id="edit-dialog-title" className="text-base font-semibold">
            Edit details
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close edit details"
            data-testid="edit-close"
            className="rounded-btn p-1.5 text-muted hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          >
            ✕
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="mt-3 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              aria-label="Title"
              data-testid="edit-title"
              className="w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-silver"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Artist
            <input
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
              required
              aria-label="Artist"
              data-testid="edit-artist"
              className="w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-silver"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Album
            <input
              value={album}
              onChange={(event) => setAlbum(event.target.value)}
              placeholder="Leave empty for no album"
              aria-label="Album"
              data-testid="edit-album"
              className="w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-bad" data-testid="edit-error">
              {error}
            </p>
          )}
          <div className="mt-1 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void restore()}
              disabled={saving}
              data-testid="edit-restore"
              className="rounded-btn border border-line px-3 py-2 text-sm text-muted hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver disabled:cursor-not-allowed disabled:opacity-60"
            >
              Restore original
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                data-testid="edit-cancel"
                className="rounded-btn border border-line px-3 py-2 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-silver disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                data-testid="edit-save"
                className="rounded-btn bg-accent px-4 py-2 text-sm font-medium text-bg hover:bg-accent-ink focus:outline-2 focus:outline-offset-2 focus:outline-silver disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
