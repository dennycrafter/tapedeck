"use client";

/**
 * Edit details dialog (SPEC 8.4): fix the title, artist, album and cover
 * (keep, remove or paste an image link) of a song, or Restore original to
 * undo a bad fix. The database keeps the raw values, so restoring always
 * returns to them. Saving refreshes the library. Opened from the song's
 * "..." menu.
 */
import { useState } from "react";
import { editTrack, restoreTrack, type TrackDto } from "../lib/api";
import { useOverlays } from "./Overlays";
import { Cover } from "./Cover";
import { parseCoverInput } from "../lib/ui";

/** Cover choice (SPEC 8.4): keep the current one, remove it, or paste an image URL. */
type CoverMode = "keep" | "remove" | "url";

const COVER_MODES: { value: CoverMode; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "remove", label: "Remove" },
  { value: "url", label: "Paste URL" },
];



function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TrackEditDialogProps {
  /** Only the editable fields, plus the current cover for the preview. */
  track: Pick<TrackDto, "id" | "title" | "artist" | "album"> & { coverUrl?: string | null };
  onClose(): void;
}

export function TrackEditDialog({ track, onClose }: TrackEditDialogProps) {
  const { notifyLibraryChanged } = useOverlays();
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album ?? "");
  const [coverMode, setCoverMode] = useState<CoverMode>("keep");
  const [coverInput, setCoverInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    let coverUrl: string | null | undefined;
    if (coverMode === "remove") coverUrl = null;
    if (coverMode === "url") {
      coverUrl = parseCoverInput(coverInput);
      if (!coverUrl) {
        setError("Paste a full image link starting with https://");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await editTrack(track.id, { title, artist, album, ...(coverMode === "keep" ? {} : { coverUrl }) });
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
          <fieldset className="flex flex-col gap-2 text-sm" data-testid="edit-cover">
            <legend className="mb-1">Cover</legend>
            <div className="flex items-center gap-3">
              <Cover
                src={coverMode === "keep" ? (track.coverUrl ?? null) : coverMode === "url" ? parseCoverInput(coverInput) : null}
                alt=""
                sizeClass="h-14 w-14"
              />
              <div role="radiogroup" aria-label="Cover" className="flex overflow-hidden rounded-btn border border-line">
                {COVER_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    role="radio"
                    aria-checked={coverMode === mode.value}
                    data-testid={`edit-cover-${mode.value}`}
                    onClick={() => setCoverMode(mode.value)}
                    className={
                      "border-l border-line px-3 py-1.5 text-sm first:border-l-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver " +
                      (coverMode === mode.value ? "bg-line text-fg" : "text-muted hover:text-fg")
                    }
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            {coverMode === "url" && (
              <input
                value={coverInput}
                onChange={(event) => setCoverInput(event.target.value)}
                placeholder="https://... image link"
                inputMode="url"
                aria-label="Cover image link"
                data-testid="edit-cover-link"
                className="w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
              />
            )}
          </fieldset>
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
