"use client";

/**
 * Catalog album page (V2-PLAN T11): /catalog/album?id=deezer:302127. Cover,
 * name, artist, the full tracklist with lengths, "Add" per song, and "Add
 * album" for every song not yet in the library (the page's one accent
 * action). Added songs wait for the PC to find a copy. The library's own
 * album page (/album) is unchanged.
 */
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { isCatalogId } from "@/lib/catalog-types";
import { Cover } from "../../components/Cover";
import { BTN_PRIMARY } from "../../components/ui";
import {
  CatalogHeader,
  CatalogNotice,
  CatalogTrackList,
  recordTypeLabel,
} from "../../components/catalog/CatalogViews";
import { useCatalogAdd } from "../../components/catalog/useCatalogAdd";
import { useCatalogResource } from "../../components/catalog/useCatalogResource";
import { catalogArtistHref, fetchCatalogAlbum } from "../../lib/catalog-api";
import { catalogSummary, songsToAdd } from "../../lib/catalog-view";

export default function CatalogAlbumPage() {
  return (
    <Suspense fallback={null}>
      <CatalogAlbum />
    </Suspense>
  );
}

function CatalogAlbum() {
  const raw = useSearchParams().get("id");
  const id = isCatalogId(raw) ? raw : null;
  const { data, error, errorStatus, loading, reload } = useCatalogResource(id, fetchCatalogAlbum);
  const adder = useCatalogAdd();

  if (!id) return <CatalogNotice text="This album isn't in the catalog." testId="not-found" />;
  if (loading) return <CatalogNotice text="Loading album..." testId="catalog-loading" />;
  if (error || !data) {
    return errorStatus === 404 ? (
      <CatalogNotice text={error ?? "This album isn't in the catalog."} testId="not-found" />
    ) : (
      <CatalogNotice text={error ?? "Could not load this album."} onRetry={reload} testId="catalog-error" />
    );
  }

  const { album, tracks } = data;
  const missing = songsToAdd(tracks, adder.owned);
  const busy = missing.some((track) => adder.adding.has(track.id));
  const owned = tracks.length - missing.length;

  return (
    <main className="flex flex-col gap-6 pt-2" data-testid="catalog-album-page">
      <CatalogHeader
        kind={recordTypeLabel(album.recordType)}
        title={album.title}
        art={<Cover src={album.coverUrl} alt="" sizeClass="aspect-square w-full h-auto" />}
        summary={
          <>
            {album.artistId ? (
              <Link href={catalogArtistHref(album.artistId)} className="font-semibold text-fg hover:underline" data-testid="catalog-album-artist">
                {album.artist}
              </Link>
            ) : (
              <span className="font-semibold text-fg">{album.artist}</span>
            )}
            {album.year ? ` · ${album.year}` : ""}
            {" · "}
            {catalogSummary(tracks)}
          </>
        }
        actions={
          <>
            <button
              type="button"
              disabled={missing.length === 0 || busy}
              onClick={() => void adder.add(missing)}
              data-testid="catalog-add-album"
              className={BTN_PRIMARY}
            >
              {busy ? "Adding..." : missing.length === 0 ? "All in library" : "Add album"}
            </button>
            {owned > 0 && missing.length > 0 && (
              <span className="text-sm text-muted" data-testid="catalog-album-owned">
                {owned === 1 ? "1 song already in your library" : `${owned} songs already in your library`}
              </span>
            )}
          </>
        }
      />
      <CatalogTrackList tracks={tracks} adder={adder} numbered pageArtist={album.artist} testId="catalog-album-tracks" />
      <p className="text-xs text-muted">
        Added songs wait until your PC finds the best free copy of each one.
      </p>
    </main>
  );
}
