"use client";

/**
 * "Add" and "Add album" for catalog songs (V2-PLAN T11): posts the songs
 * (50 per request), shows the usual summary toast ("12 added, 1 already in
 * library"), tells the library to refetch, and remembers which songs this
 * page has added so their buttons turn into "In library" straight away.
 */
import { useCallback, useState } from "react";
import type { CatalogTrack } from "@/lib/catalog-types";
import { addCatalogTracks } from "../../lib/catalog-api";
import { summarizeAddResults } from "../../lib/ui";
import { useOverlays } from "../Overlays";

export interface CatalogAddApi {
  add(tracks: readonly CatalogTrack[]): Promise<void>;
  /** Songs with a request in flight. */
  adding: ReadonlySet<string>;
  /** True when the song was in the library already or was added here. */
  owned(track: CatalogTrack & { inLibrary?: boolean }): boolean;
}

export function useCatalogAdd(): CatalogAddApi {
  const { showToast, notifyLibraryChanged } = useOverlays();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const add = useCallback(
    async (tracks: readonly CatalogTrack[]) => {
      if (tracks.length === 0) return;
      const ids = tracks.map((track) => track.id);
      setAdding((previous) => new Set([...previous, ...ids]));
      try {
        const results = await addCatalogTracks(tracks);
        const owned = results
          .filter((result) => result.status !== "error")
          .map((result) => tracks[result.index]?.id)
          .filter((id): id is string => Boolean(id));
        setAdded((previous) => new Set([...previous, ...owned]));
        const failed = results.find((result) => result.status === "error");
        const summary = summarizeAddResults(results) ?? "Nothing added";
        showToast(failed && results.length === 1 ? failed.message : summary);
        if (results.some((result) => result.status === "added")) notifyLibraryChanged();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        setAdding((previous) => {
          const next = new Set(previous);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [showToast, notifyLibraryChanged],
  );

  const owned = useCallback(
    (track: CatalogTrack & { inLibrary?: boolean }) => Boolean(track.inLibrary) || added.has(track.id),
    [added],
  );

  return { add, adding, owned };
}
