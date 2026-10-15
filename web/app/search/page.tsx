"use client";

/**
 * Search (SPEC 10 nav, V2-PLAN T11). One box searches two places as you
 * type: your own library (instant, shown first in the Top tab) and the free
 * music catalog (debounced 300 ms). Tabs: Top, Songs, Artists, Albums, and
 * YouTube, the old YouTube search for remixes, live versions and anything
 * the catalog lacks (still Enter or the button only, with its quota note).
 * The query and tab live in the address, so Back from a catalog artist or
 * album page comes back to the same results.
 */
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLibrary } from "../components/LibraryProvider";
import { TrackList } from "../components/TrackList";
import { CoverTile } from "../components/CoverTile";
import { SearchBox } from "../components/SearchBox";
import { SEARCH_INPUT_ID } from "../components/KeyboardShortcuts";
import { SearchIcon } from "../components/icons";
import { FOCUS, SectionHeader } from "../components/ui";
import { CatalogAlbumTiles, CatalogArtistTiles, CatalogTrackList } from "../components/catalog/CatalogViews";
import { useCatalogAdd } from "../components/catalog/useCatalogAdd";
import { useCatalogSearch, type CatalogSearchState } from "../components/catalog/useCatalogSearch";
import { albumHref, artistHref, filterTracks } from "../lib/library-view";
import { parseSearchTab, SEARCH_TABS, searchPageUrl, type SearchTab } from "../lib/catalog-view";

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <Search />
    </Suspense>
  );
}

const TOP_SONGS = 5;
const TOP_TILES = 8;

function Search() {
  const params = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [tab, setTab] = useState<SearchTab>(() => parseSearchTab(params.get("tab")));
  const catalog = useCatalogSearch(query);
  const adder = useCatalogAdd();

  // Focus once on arrival. Not on later address changes: the query sync below
  // updates the address, and focusing then would pull the cursor out of the
  // YouTube box while the owner types there.
  const focusOnArrival = useRef(params.get("focus") === "1");
  useEffect(() => {
    if (focusOnArrival.current || window.matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);

  // Keep the address in step (replace, not push: typing must not fill the history).
  useEffect(() => {
    const timer = window.setTimeout(() => window.history.replaceState(null, "", searchPageUrl(query, tab)), 300);
    return () => window.clearTimeout(timer);
  }, [query, tab]);

  return (
    <main className="flex flex-col gap-6 pt-2">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Search</h1>
        <label className="relative block max-w-2xl">
          <span className="sr-only">Search songs, artists and albums</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={input}
            id={SEARCH_INPUT_ID}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, artists or albums"
            autoComplete="off"
            data-testid="library-search"
            className="w-full rounded-btn border border-line bg-bg py-2.5 pl-10 pr-3 text-base placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          />
        </label>
      </div>

      <div
        role="tablist"
        aria-label="Search results"
        className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none]"
      >
        {SEARCH_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`search-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="search-panel"
            onClick={() => setTab(item.id)}
            data-testid={`search-tab-${item.id}`}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold ${FOCUS} ${
              tab === item.id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id="search-panel" role="tabpanel" aria-labelledby={`search-tab-${tab}`} className="flex flex-col gap-8">
        {tab === "youtube" ? (
          <section className="max-w-3xl" data-testid="search-youtube">
            <p className="text-sm text-muted">
              For remixes, live versions and anything the catalog does not have. Adds the exact video you pick.
            </p>
            <div className="mt-3 rounded-box border border-line bg-surface p-4 [&>section]:mt-0 [&>section]:border-t-0 [&>section]:pt-0">
              <SearchBox initialQuery={query.trim()} />
            </div>
          </section>
        ) : (
          <CatalogPanel tab={tab} query={query} catalog={catalog} adder={adder} onTab={setTab} />
        )}
      </div>
    </main>
  );
}

interface PanelProps {
  tab: Exclude<SearchTab, "youtube">;
  query: string;
  catalog: CatalogSearchState;
  adder: ReturnType<typeof useCatalogAdd>;
  onTab(tab: SearchTab): void;
}

function CatalogPanel({ tab, query, catalog, adder, onTab }: PanelProps) {
  const q = query.trim();
  if (!q) {
    return (
      <p className="max-w-2xl text-sm text-muted" data-testid="search-hint">
        Type to search your library and the music catalog. Add any song and your PC finds a free copy of it.
      </p>
    );
  }
  const data = catalog.data;
  const status = catalog.error ? (
    <p role="alert" className="text-sm text-bad" data-testid="catalog-error">
      {catalog.error}
    </p>
  ) : catalog.loading && !data && catalog.active ? (
    <p className="text-sm text-muted" data-testid="catalog-loading">
      Searching the catalog...
    </p>
  ) : null;
  const nothing =
    data && !catalog.loading && data.tracks.length === 0 && data.albums.length === 0 && data.artists.length === 0;

  const showAll = (target: SearchTab) => (
    <button type="button" onClick={() => onTab(target)} className={`text-sm font-semibold text-muted hover:text-fg ${FOCUS}`}>
      Show all
    </button>
  );

  return (
    <>
      {tab === "top" && <LibraryMatches query={q} />}
      {status}
      {nothing && (
        <p className="text-sm text-muted" data-testid="catalog-empty">
          The catalog has nothing for &quot;{catalog.q}&quot;. Try the YouTube tab for remixes, live versions and rare songs.
        </p>
      )}
      {data && tab === "top" && (
        <>
          {data.artists.length > 0 && (
            <section>
              <SectionHeader title="Artists" action={data.artists.length > 1 ? showAll("artists") : undefined} />
              <CatalogArtistTiles artists={data.artists.slice(0, TOP_TILES)} row testId="catalog-top-artists" />
            </section>
          )}
          {data.tracks.length > 0 && (
            <section>
              <SectionHeader title="Songs" action={data.tracks.length > TOP_SONGS ? showAll("songs") : undefined} />
              <CatalogTrackList tracks={data.tracks.slice(0, TOP_SONGS)} adder={adder} testId="catalog-top-songs" />
            </section>
          )}
          {data.albums.length > 0 && (
            <section>
              <SectionHeader title="Albums" action={data.albums.length > TOP_TILES ? showAll("albums") : undefined} />
              <CatalogAlbumTiles albums={data.albums.slice(0, TOP_TILES)} row testId="catalog-top-albums" />
            </section>
          )}
        </>
      )}
      {data && tab === "songs" && data.tracks.length > 0 && (
        <CatalogTrackList tracks={data.tracks} adder={adder} testId="catalog-songs" />
      )}
      {data && tab === "artists" && data.artists.length > 0 && <CatalogArtistTiles artists={data.artists} />}
      {data && tab === "albums" && data.albums.length > 0 && <CatalogAlbumTiles albums={data.albums} />}
      {data && !nothing && (
        <p className="text-xs text-muted">
          Not finding the right version?{" "}
          <button type="button" onClick={() => onTab("youtube")} className={`underline hover:text-fg ${FOCUS}`}>
            Search YouTube
          </button>
        </p>
      )}
    </>
  );
}

/** Songs, albums and artists already in your library that match (free, instant). */
function LibraryMatches({ query }: { query: string }) {
  const { library, albums, artists } = useLibrary();
  const q = query.toLowerCase();
  const songs = filterTracks(library?.tracks ?? [], q).slice(0, TOP_SONGS);
  const albumHits = albums.filter((album) => `${album.album} ${album.albumArtist}`.toLowerCase().includes(q)).slice(0, 12);
  const artistHits = artists.filter((artist) => artist.artist.toLowerCase().includes(q)).slice(0, 12);
  if (songs.length === 0 && albumHits.length === 0 && artistHits.length === 0) return null;
  return (
    <section data-testid="search-library">
      <SectionHeader
        title="In your library"
        action={
          <Link href="/library" className={`text-sm font-semibold text-muted hover:text-fg ${FOCUS}`}>
            Open library
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        {(artistHits.length > 0 || albumHits.length > 0) && (
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
            {artistHits.map((artist) => (
              <CoverTile
                key={`artist-${artist.artist}`}
                round
                cover={artist.coverUrl}
                title={artist.artist}
                subtitle="Artist"
                href={artistHref(artist.artist)}
              />
            ))}
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
        )}
        {songs.length > 0 && <TrackList tracks={songs} testId="search-songs" />}
      </div>
    </section>
  );
}
