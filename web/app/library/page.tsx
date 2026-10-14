"use client";

/**
 * Library (SPEC 8.6): tabs for Songs (sortable, choice remembered on this
 * device), Liked songs, Playlists, Albums (favourites first), Artists and
 * Recently played. The tab lives in the URL (?tab=) so the sidebar can link
 * straight to each one.
 */
import Link from "next/link";
import { Suspense, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLibrary } from "../components/LibraryProvider";
import { TrackList } from "../components/TrackList";
import { CoverTile } from "../components/CoverTile";
import { NewPlaylistDialog } from "../components/NewPlaylistDialog";
import { BTN_SECONDARY, FOCUS, Menu } from "../components/ui";
import { ChevronDownIcon, PlusIcon } from "../components/icons";
import { SONG_SORTS, albumHref, artistHref, sortSongs, type SongSort } from "../lib/library-view";

const TABS = [
  { id: "songs", label: "Songs" },
  { id: "liked", label: "Liked songs" },
  { id: "playlists", label: "Playlists" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
  { id: "recent", label: "Recently played" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SORT_KEY = "tapedeck.songSort.v1";
const sortListeners = new Set<() => void>();

function readSort(): SongSort {
  try {
    const value = window.localStorage.getItem(SORT_KEY);
    if (value === "title" || value === "artist" || value === "recent") return value;
  } catch {
    // Private mode or blocked storage: fall back to the default.
  }
  return "recent";
}

function writeSort(value: SongSort): void {
  try {
    window.localStorage.setItem(SORT_KEY, value);
  } catch {
    // Remembering the sort is a nicety.
  }
  sortListeners.forEach((listener) => listener());
}

function useSongSort(): [SongSort, (value: SongSort) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      sortListeners.add(listener);
      return () => sortListeners.delete(listener);
    },
    readSort,
    () => "recent" as SongSort,
  );
  return [value, writeSort];
}

export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryTabs />
    </Suspense>
  );
}

function LibraryTabs() {
  const params = useSearchParams();
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "songs";

  return (
    <main className="flex flex-col gap-5 pt-2">
      <h1 className="text-3xl font-bold tracking-tight">Library</h1>
      <nav aria-label="Library sections" className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <div className="flex min-w-max gap-1 border-b border-line">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={t.id === "songs" ? "/library" : `/library?tab=${t.id}`}
              aria-current={tab === t.id ? "page" : undefined}
              data-testid={`library-tab-${t.id}`}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${FOCUS} ${
                tab === t.id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>
      {tab === "songs" && <SongsTab />}
      {tab === "liked" && <LikedTab />}
      {tab === "playlists" && <PlaylistsTab />}
      {tab === "albums" && <AlbumsTab />}
      {tab === "artists" && <ArtistsTab />}
      {tab === "recent" && <RecentTab />}
    </main>
  );
}

function Empty({ text, testId }: { text: string; testId?: string }) {
  return (
    <p className="rounded-box border border-line bg-surface p-6 text-center text-sm text-muted" data-testid={testId}>
      {text}
    </p>
  );
}

function SongsTab() {
  const { library } = useLibrary();
  const [sort, setSort] = useSongSort();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const tracks = sortSongs(library?.tracks ?? [], sort);
  const label = SONG_SORTS.find((option) => option.value === sort)?.label ?? "";
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">{tracks.length === 1 ? "1 song" : `${tracks.length} songs`}</p>
        <button
          ref={anchor}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="song-sort"
          className={BTN_SECONDARY}
        >
          Sort: {label} <ChevronDownIcon width={16} height={16} />
        </button>
        {open && (
          <Menu
            anchor={anchor}
            label="Sort songs"
            testId="sort-menu"
            onClose={() => setOpen(false)}
            items={SONG_SORTS.map((option) => ({
              label: option.label,
              testId: `sort-${option.value}`,
              onSelect: () => setSort(option.value),
            }))}
          />
        )}
      </div>
      {tracks.length === 0 ? <Empty text="No songs yet." /> : <TrackList tracks={tracks} testId="songs-list" />}
    </section>
  );
}

function LikedTab() {
  const { liked } = useLibrary();
  return liked.length === 0 ? (
    <Empty text="Tap the heart on any song and it shows up here." testId="liked-empty" />
  ) : (
    <TrackList tracks={liked} testId="liked-list" />
  );
}

function PlaylistsTab() {
  const { playlists } = useLibrary();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <button type="button" onClick={() => setCreating(true)} className={BTN_SECONDARY} data-testid="new-playlist-tab">
          <PlusIcon width={18} height={18} /> New playlist
        </button>
      </div>
      {playlists.length === 0 ? (
        <Empty text="No playlists yet." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6" data-testid="playlist-grid">
          {playlists.map((playlist) => (
            <CoverTile
              key={playlist.id}
              fluid
              covers={playlist.covers}
              title={playlist.name}
              subtitle={playlist.tracks.length === 1 ? "1 song" : `${playlist.tracks.length} songs`}
              href={`/playlist?id=${playlist.id}`}
              testId="playlist-tile"
            />
          ))}
        </div>
      )}
      {creating && (
        <NewPlaylistDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/playlist?id=${id}`)} />
      )}
    </section>
  );
}

function AlbumsTab() {
  const { albums } = useLibrary();
  if (albums.length === 0) return <Empty text="Songs with an album show up here, grouped." />;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6" data-testid="album-grid">
      {albums.map((album) => (
        <CoverTile
          key={album.key}
          fluid
          cover={album.coverUrl}
          title={album.album}
          subtitle={album.favorite ? `Favourite · ${album.albumArtist}` : album.albumArtist}
          href={albumHref(album.album, album.albumArtist)}
          testId="album-tile"
        />
      ))}
    </div>
  );
}

function ArtistsTab() {
  const { artists } = useLibrary();
  if (artists.length === 0) return <Empty text="No artists yet." />;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6" data-testid="artist-grid">
      {artists.map((artist) => (
        <CoverTile
          key={artist.artist}
          fluid
          round
          cover={artist.coverUrl}
          title={artist.artist}
          subtitle={artist.tracks.length === 1 ? "1 song" : `${artist.tracks.length} songs`}
          href={artistHref(artist.artist)}
          testId="artist-tile"
        />
      ))}
    </div>
  );
}

function RecentTab() {
  const { recent } = useLibrary();
  return recent.length === 0 ? (
    <Empty text="Songs you play show up here." />
  ) : (
    <TrackList tracks={recent} testId="recent-list" />
  );
}
