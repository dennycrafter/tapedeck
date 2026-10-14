"use client";

import { useState } from "react";
import { useLibrary } from "./LibraryProvider";
import { useOverlays } from "./Overlays";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, Modal } from "./ui";

/** "New playlist" (SPEC 10 sidebar): name it, then open it. */
export function NewPlaylistDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const library = useLibrary();
  const { showToast } = useOverlays();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const playlist = await library.createPlaylist(trimmed);
      showToast(`Created ${playlist.name}`);
      onClose();
      onCreated(playlist.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New playlist" onClose={onClose} testId="new-playlist-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Playlist name"
          aria-label="Playlist name"
          maxLength={100}
          data-testid="new-playlist-name"
          className={INPUT}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-bad">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={BTN_PRIMARY} data-testid="new-playlist-create">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
