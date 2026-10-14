"use client";

/**
 * Artist page (SPEC 8.6): every song by the artist (exact name match),
 * newest first, and their albums. Play and Shuffle play the songs.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLibrary } from "../components/LibraryProvider";
import { TrackList, usePlayList } from "../components/TrackList";
import { Cover } from "../components/Cover";
import { CoverTile } from "../components/CoverTile";
import { ListHeader, NotFound } from "../components/ListHeader";
import { DownloadListButton } from "../components/DownloadListButton";
import { SectionHeader } from "../components/ui";
import { albumHref, listSummary } from "../lib/library-view";

export default function ArtistPage() {
  return (
    <Suspense fallback={null}>
      <Artist />
    </Suspense>
  );
}

function Artist() {
  const name = useSearchParams().get("name") ?? "";
  const library = useLibrary();
  const artist = library.artists.find((candidate) => candidate.artist === name);
  const play = usePlayList(artist?.tracks ?? []);

  if (!library.library) return null;
  if (!artist) return <NotFound text="No songs by this artist in your library." />;

  return (
    <main className="flex flex-col gap-8 pt-2" data-testid="artist-page">
      <ListHeader
        kind="Artist"
        title={artist.artist}
        titleTestId="artist-name"
        summary={listSummary(artist.tracks)}
        art={<Cover src={artist.coverUrl} alt="" sizeClass="aspect-square w-full h-auto !rounded-full" />}
        canPlay={artist.tracks.some((track) => track.status === "ready")}
        onPlay={() => play(null)}
        onShuffle={() => play(null, true)}
        actions={<DownloadListButton tracks={artist.tracks} />}
      />
      <section>
        <SectionHeader title="Songs" />
        <TrackList tracks={artist.tracks} testId="artist-tracks" />
      </section>
      {artist.albums.length > 0 && (
        <section>
          <SectionHeader title="Albums" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {artist.albums.map((album) => (
              <CoverTile
                key={album.key}
                fluid
                cover={album.coverUrl}
                title={album.album}
                subtitle={album.tracks.length === 1 ? "1 song" : `${album.tracks.length} songs`}
                href={albumHref(album.album, album.albumArtist)}
                testId="album-tile"
              />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
