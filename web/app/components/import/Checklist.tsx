"use client";

/**
 * Step 3 of the playlist import (V2-PLAN T13): the checklist of every
 * playlist found, Liked songs first. Cover, name, song count, Select all,
 * and playlists imported before are marked (and not ticked at first:
 * importing one again adds its new songs to the same Tapedeck playlist).
 */
import { useState } from "react";
import type { ImportJobView } from "@/lib/import-types";
import { startImportJob } from "../../lib/import-api";
import { defaultSelection, importButtonLabel, songCount } from "../../lib/import-view";
import { Cover } from "../Cover";
import { BTN_PRIMARY } from "../ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CHECKBOX = "h-5 w-5 shrink-0 accent-[var(--silver)]";

export function Checklist({ job, onStarted }: { job: ImportJobView; onStarted(job: ImportJobView): void }) {
  const playlists = job.playlists ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelection(playlists)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allTicked = playlists.length > 0 && playlists.every((playlist) => selected.has(playlist.ref));
  const anyImported = playlists.some((playlist) => playlist.importedPlaylistId);

  function toggle(ref: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  async function start() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Keep the checklist's order, not the order of the taps.
      onStarted(await startImportJob(job.id, playlists.filter((p) => selected.has(p.ref)).map((p) => p.ref)));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="import-checklist">
      <p className="text-sm text-muted">
        {playlists.length === 1 ? "1 playlist" : `${playlists.length} playlists`} found on {job.serviceLabel}. Tick the ones you want.
      </p>
      <div className="overflow-hidden rounded-box border border-line bg-surface">
        <label className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-line px-3 py-2">
          <input
            type="checkbox"
            checked={allTicked}
            onChange={() => setSelected(allTicked ? new Set() : new Set(playlists.map((playlist) => playlist.ref)))}
            className={CHECKBOX}
            data-testid="import-select-all"
          />
          <span className="text-sm font-semibold">Select all</span>
        </label>
        <ul className="divide-y divide-line">
          {playlists.map((playlist) => {
            const facts = [
              songCount(playlist.trackCount),
              playlist.importedPlaylistId ? "Imported before" : "",
            ].filter(Boolean);
            return (
              <li key={playlist.ref}>
                <label
                  className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2"
                  data-testid="import-playlist"
                  data-ref={playlist.ref}
                  data-imported={playlist.importedPlaylistId ? "true" : "false"}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(playlist.ref)}
                    onChange={() => toggle(playlist.ref)}
                    className={CHECKBOX}
                    data-testid="import-playlist-check"
                  />
                  <Cover src={playlist.coverUrl} alt="" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold" data-testid="import-playlist-name">
                      {playlist.name}
                    </span>
                    {facts.length > 0 && (
                      <span className="block truncate text-xs text-muted" data-testid="import-playlist-facts">
                        {facts.join(" · ")}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      {anyImported && (
        <p className="text-xs text-muted">Importing a playlist again adds its new songs to the same playlist here.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy || selected.size === 0}
        className={`${BTN_PRIMARY} min-h-11 w-full sm:w-auto sm:self-start`}
        data-testid="import-start"
      >
        {busy ? "Starting..." : importButtonLabel(selected.size)}
      </button>
    </div>
  );
}
