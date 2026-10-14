"use client";

/**
 * "Add to playlist" (SPEC 8.6): pick an existing playlist, or name a new one
 * and the songs go straight into it. Closes with a toast on success.
 */
import { useState } from "react";
import { useLibrary } from "./LibraryProvider";
import { useOverlays } from "./Overlays";
import { PlaylistCover } from "./PlaylistCover";
import { BTN_SECONDARY, INPUT, Modal } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AddToPlaylistDialog({ trackIds, onClose }: { trackIds: string[]; onClose(): void }) {
  const library = useLibrary();
  const { showToast } = useOverlays();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(playlistId: string, playlistName: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const added = await library.addToPlaylist(playlistId, trackIds);
      showToast(added === 0 ? `Already in ${playlistName}` : `Added to ${playlistName}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await library.createPlaylist(trimmed, trackIds);
      showToast(`Added to ${trimmed}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add to playlist" onClose={onClose} testId="playlist-picker">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex gap-2"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New playlist name"
          aria-label="New playlist name"
          data-testid="playlist-picker-name"
          className={INPUT}
        />
        <button type="submit" disabled={busy || !name.trim()} className={BTN_SECONDARY} data-testid="playlist-picker-create">
          Create
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
      {library.playlists.length > 0 && (
        <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-box border border-line bg-surface">
          {library.playlists.map((playlist) => {
            const has = trackIds.every((id) => playlist.trackIds.includes(id));
            return (
              <li key={playlist.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void add(playlist.id, playlist.name)}
                  data-testid="playlist-picker-item"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver"
                >
                  <PlaylistCover covers={playlist.covers} sizeClass="h-9 w-9" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{playlist.name}</span>
                  <span className="text-xs text-muted">{has ? "Added" : `${playlist.tracks.length} songs`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
