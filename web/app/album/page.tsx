"use client";

/**
 * Album page (SPEC 8.6): cover, name, artist, songs in added order, the
 * "Favourite album" heart, Play, Shuffle and Download. The album is named
 * in the URL: /album?name=&artist=.
 */
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLibrary } from "../components/LibraryProvider";
import { useOverlays } from "../components/Overlays";
import { TrackList, usePlayList } from "../components/TrackList";
import { Cover } from "../components/Cover";
import { ListHeader, NotFound } from "../components/ListHeader";
import { DownloadListButton } from "../components/DownloadListButton";
import { HeartIcon } from "../components/icons";
import { BTN_SECONDARY } from "../components/ui";
import { albumKey, artistHref, listSummary } from "../lib/library-view";

export default function AlbumPage() {
  return (
    <Suspense fallback={null}>
      <Album />
    </Suspense>
  );
}

function Album() {
  const params = useSearchParams();
  const name = params.get("name") ?? "";
  const artist = params.get("artist") ?? "";
  const library = useLibrary();
  const { showToast } = useOverlays();
  const album = library.albums.find(
    (candidate) => candidate.key === albumKey(name, artist),
  );
  const play = usePlayList(album?.tracks ?? []);

  if (!library.library) return null;
  if (!album) return <NotFound text="This album isn't in your library." />;

  return (
    <main className="flex flex-col gap-6 pt-2" data-testid="album-page">
      <ListHeader
        kind="Album"
        title={album.album}
        titleTestId="album-name"
        summary={
          <>
            <Link
              href={artistHref(album.albumArtist)}
              className="font-semibold text-fg hover:underline"
            >
              {album.albumArtist}
            </Link>
            {" · "}
            {listSummary(album.tracks)}
          </>
        }
        art={
          <Cover
            src={album.coverUrl}
            alt=""
            sizeClass="aspect-square w-full h-auto"
          />
        }
        canPlay={album.tracks.some((track) => track.status === "ready")}
        onPlay={() => play(null)}
        onShuffle={() => play(null, true)}
        actions={
          <>
            <DownloadListButton tracks={album.tracks} />
            <button
              type="button"
              aria-pressed={album.favorite}
              data-testid="album-favorite"
              onClick={() => {
                library
                  .setAlbumFavorite(album, !album.favorite)
                  .catch((error: unknown) => {
                    showToast(
                      error instanceof Error ? error.message : String(error),
                    );
                  });
              }}
              className={`${BTN_SECONDARY} ${album.favorite ? "border-silver text-fg" : ""}`}
            >
              <HeartIcon filled={album.favorite} width={18} height={18} />
              {album.favorite ? "Favourite album" : "Add to favourites"}
            </button>
          </>
        }
      />
      <TrackList tracks={album.tracks} testId="album-tracks" />
    </main>
  );
}
