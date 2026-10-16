"use client";

/**
 * Home (SPEC 10): "Hey {name}", a status line (downloader status and songs
 * waiting), Recently played (a row of covers), Favourite albums, Your
 * playlists and Recently added (song rows). A brand new library shows the
 * empty state with the Add button instead.
 */
import Link from "next/link";
import { useLibrary } from "./components/LibraryProvider";
import { useOverlays } from "./components/Overlays";
import { DownloaderStatus } from "./components/DownloaderStatus";
import { TrackList, usePlayList } from "./components/TrackList";
import { CoverTile } from "./components/CoverTile";
import { PlaylistCover } from "./components/PlaylistCover";
import { BringYourMusic } from "./components/import/BringYourMusic";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, SectionHeader } from "./components/ui";
import { albumHref, greeting } from "./lib/library-view";

/** Recently added rows on Home; the rest is under Library > Songs. */
const RECENT_ADDS = 30;

export default function HomePage() {
  const { library, loading, error, recent, albums, playlists, refetch } = useLibrary();
  const { openAdd } = useOverlays();
  const tracks = library?.tracks ?? [];
  const playRecent = usePlayList(recent);
  const favorites = albums.filter((album) => album.favorite);

  return (
    <main className="flex flex-col gap-9 pt-2">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="home-greeting">
          {greeting(library?.displayName)}
        </h1>
        {library && <DownloaderStatus snapshot={library.downloader} />}
      </header>

      {loading && !library && (
        <p className="text-sm text-muted" data-testid="library-loading">
          Loading your library...
        </p>
      )}

      {!library && !loading && error && (
        <div className="rounded-box border border-line bg-surface p-4" data-testid="library-error">
          <p className="text-sm text-bad">Could not load your library. {error}</p>
          <button type="button" onClick={() => void refetch()} className={`${BTN_SECONDARY} mt-3`}>
            Try again
          </button>
        </div>
      )}

      {library && tracks.length === 0 && (
        <div className="rounded-box border border-line bg-surface p-8 text-center" data-testid="library-empty">
          <p className="text-lg font-semibold">No songs yet.</p>
          <p className="mt-1 text-sm text-muted">Paste a YouTube or SoundCloud link to add your first song.</p>
          <button type="button" onClick={openAdd} data-testid="add-open-empty" className={`${BTN_PRIMARY} mt-5`}>
            Add songs
          </button>
        </div>
      )}

      {/* V2-PLAN T13: while the library is empty, offer to import playlists. */}
      {library && tracks.length === 0 && <BringYourMusic />}

      {recent.length > 0 && (
        <section data-testid="home-recently-played">
          <SectionHeader
            title="Recently played"
            action={
              <Link href="/library?tab=recent" className={BTN_QUIET}>
                Show all
              </Link>
            }
          />
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
            {recent.slice(0, 12).map((track) => (
              <CoverTile
                key={track.id}
                cover={track.coverUrl}
                title={track.title}
                subtitle={track.artist}
                onClick={() => playRecent(track)}
                testId="recent-tile"
                dimmed={track.status !== "ready"}
              />
            ))}
          </div>
        </section>
      )}

      {favorites.length > 0 && (
        <section data-testid="home-favorite-albums">
          <SectionHeader
            title="Favourite albums"
            action={
              <Link href="/library?tab=albums" className={BTN_QUIET}>
                Show all
              </Link>
            }
          />
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
            {favorites.map((album) => (
              <CoverTile
                key={album.key}
                cover={album.coverUrl}
                title={album.album}
                subtitle={album.albumArtist}
                href={albumHref(album.album, album.albumArtist)}
                testId="album-tile"
              />
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section data-testid="home-playlists">
          <SectionHeader
            title="Your playlists"
            action={
              <Link href="/library?tab=playlists" className={BTN_QUIET}>
                Show all
              </Link>
            }
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {playlists.slice(0, 6).map((playlist) => (
              <Link
                key={playlist.id}
                href={`/playlist?id=${playlist.id}`}
                className="flex items-center gap-3 rounded-box border border-line bg-surface p-2 pr-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-silver"
              >
                <PlaylistCover covers={playlist.covers} sizeClass="h-12 w-12" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{playlist.name}</span>
                  <span className="block text-sm text-muted">
                    {playlist.tracks.length === 1 ? "1 song" : `${playlist.tracks.length} songs`}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {tracks.length > 0 && (
        <section data-testid="home-recently-added">
          <SectionHeader
            title="Recently added"
            action={
              tracks.length > RECENT_ADDS ? (
                <Link href="/library" className={BTN_QUIET}>
                  All {tracks.length} songs
                </Link>
              ) : undefined
            }
          />
          <TrackList tracks={tracks.slice(0, RECENT_ADDS)} />
        </section>
      )}
    </main>
  );
}
