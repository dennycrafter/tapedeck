"use client";

/**
 * Catalog artist page (V2-PLAN T11): /catalog/artist?id=deezer:27. Picture,
 * name, popular songs with "Add", and every release split into Albums,
 * Singles and EPs, and Compilations, each linking to its catalog album page.
 * The library's own artist page (/artist) is unchanged.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { isCatalogId } from "@/lib/catalog-types";
import { Cover } from "../../components/Cover";
import { SectionHeader } from "../../components/ui";
import {
  CatalogAlbumTiles,
  CatalogHeader,
  CatalogNotice,
  CatalogTrackList,
} from "../../components/catalog/CatalogViews";
import { useCatalogAdd } from "../../components/catalog/useCatalogAdd";
import { useCatalogResource } from "../../components/catalog/useCatalogResource";
import { fetchCatalogArtist } from "../../lib/catalog-api";
import { groupReleases } from "../../lib/catalog-view";

export default function CatalogArtistPage() {
  return (
    <Suspense fallback={null}>
      <CatalogArtist />
    </Suspense>
  );
}

function CatalogArtist() {
  const raw = useSearchParams().get("id");
  const id = isCatalogId(raw) ? raw : null;
  const { data, error, errorStatus, loading, reload } = useCatalogResource(id, fetchCatalogArtist);
  const adder = useCatalogAdd();

  if (!id) return <CatalogNotice text="This artist isn't in the catalog." testId="not-found" />;
  if (loading) return <CatalogNotice text="Loading artist..." testId="catalog-loading" />;
  if (error || !data) {
    return errorStatus === 404 ? (
      <CatalogNotice text={error ?? "This artist isn't in the catalog."} testId="not-found" />
    ) : (
      <CatalogNotice text={error ?? "Could not load this artist."} onRetry={reload} testId="catalog-error" />
    );
  }

  const { artist, topTracks, albums } = data;
  const groups = groupReleases(albums);
  const summary = [
    artist.albumCount ? (artist.albumCount === 1 ? "1 release" : `${artist.albumCount} releases`) : null,
    artist.inLibrary ? "In your library" : null,
  ].filter(Boolean);

  return (
    <main className="flex flex-col gap-8 pt-2" data-testid="catalog-artist-page">
      <CatalogHeader
        kind="Artist"
        title={artist.name}
        art={<Cover src={artist.pictureUrl} alt="" sizeClass="aspect-square w-full h-auto !rounded-full" />}
        summary={summary.length > 0 ? summary.join(" · ") : undefined}
      />
      {topTracks.length > 0 && (
        <section>
          <SectionHeader title="Popular songs" />
          <CatalogTrackList tracks={topTracks} adder={adder} testId="catalog-artist-top" />
        </section>
      )}
      {groups.map((group) => (
        <section key={group.title}>
          <SectionHeader title={group.title} />
          <CatalogAlbumTiles albums={group.albums} showArtist={false} testId={group.testId} />
        </section>
      ))}
      {topTracks.length === 0 && groups.length === 0 && (
        <p className="text-sm text-muted">The catalog has no songs for this artist yet.</p>
      )}
    </main>
  );
}
