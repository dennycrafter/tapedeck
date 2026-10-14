"use client";

/**
 * Search (SPEC 10 nav): the top box filters your own library as you type
 * (songs, albums, artists; free, no quota). Below it, the YouTube search
 * (SPEC 8.7) finds new songs to add and only runs on Enter or the button.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLibrary } from "../components/LibraryProvider";
import { TrackList } from "../components/TrackList";
import { CoverTile } from "../components/CoverTile";
import { SearchBox } from "../components/SearchBox";
import { SEARCH_INPUT_ID } from "../components/KeyboardShortcuts";
import { SearchIcon } from "../components/icons";
import { SectionHeader } from "../components/ui";
import { albumHref, artistHref, filterTracks } from "../lib/library-view";

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <Search />
    </Suspense>
  );
}

function Search() {
  const params = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const { library, albums, artists } = useLibrary();

  useEffect(() => {
    if (params.get("focus") === "1" || window.matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, [params]);

  const q = query.trim().toLowerCase();
  const songs = q ? filterTracks(library?.tracks ?? [], q).slice(0, 50) : [];
  const albumHits = q
    ? albums.filter((album) => `${album.album} ${album.albumArtist}`.toLowerCase().includes(q)).slice(0, 12)
    : [];
  const artistHits = q ? artists.filter((artist) => artist.artist.toLowerCase().includes(q)).slice(0, 12) : [];
  const nothing = q && songs.length === 0 && albumHits.length === 0 && artistHits.length === 0;

  return (
    <main className="flex flex-col gap-8 pt-2">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Search</h1>
        <label className="relative block max-w-2xl">
          <span className="sr-only">Search your library</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={input}
            id={SEARCH_INPUT_ID}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, albums or artists in your library"
            autoComplete="off"
            data-testid="library-search"
            className="w-full rounded-btn border border-line bg-bg py-2.5 pl-10 pr-3 text-base placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          />
        </label>
      </div>

      {nothing && (
        <p className="text-sm text-muted" data-testid="library-search-empty">
          Nothing in your library matches &quot;{query.trim()}&quot;. Try YouTube below.
        </p>
      )}

      {artistHits.length > 0 && (
        <section>
          <SectionHeader title="Artists" />
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
            {artistHits.map((artist) => (
              <CoverTile
                key={artist.artist}
                round
                cover={artist.coverUrl}
                title={artist.artist}
                subtitle="Artist"
                href={artistHref(artist.artist)}
              />
            ))}
          </div>
        </section>
      )}

      {albumHits.length > 0 && (
        <section>
          <SectionHeader title="Albums" />
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
            {albumHits.map((album) => (
              <CoverTile
                key={album.key}
                cover={album.coverUrl}
                title={album.album}
                subtitle={album.albumArtist}
                href={albumHref(album.album, album.albumArtist)}
              />
            ))}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section>
          <SectionHeader title="Songs" />
          <TrackList tracks={songs} testId="search-songs" />
        </section>
      )}

      <section className="max-w-3xl">
        <SectionHeader title="Find new songs on YouTube" />
        <div className="rounded-box border border-line bg-surface p-4">
          <SearchBox />
        </div>
      </section>
    </main>
  );
}
