"use client";

/**
 * Building blocks of the catalog screens (V2-PLAN T11): the song list
 * (inbox-style rows with "Add" or "In library"), album and artist tile
 * grids, and the page header. Catalog songs are not playable until added
 * and downloaded, so rows have no play action (SPEC 8.8: search results
 * are not playable until added).
 */
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type {
  CatalogAlbumResult,
  CatalogArtistResult,
  CatalogRecordType,
  CatalogTrackResult,
} from "@/lib/catalog-types";
import { formatDuration } from "@/lib/player/format";
import { Cover } from "../Cover";
import { CoverTile } from "../CoverTile";
import { FOCUS } from "../ui";
import { catalogAlbumHref, catalogArtistHref } from "../../lib/catalog-api";
import type { CatalogAddApi } from "./useCatalogAdd";

const ADD_BUTTON = `inline-flex min-h-9 min-w-16 items-center justify-center rounded-btn border border-line px-3 text-sm font-medium text-silver hover:border-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;
const QUIET_LINK = `hover:text-fg hover:underline ${FOCUS}`;

interface TrackListProps {
  tracks: readonly CatalogTrackResult[];
  adder: CatalogAddApi;
  testId?: string;
  /** Album page: track numbers instead of covers, no album name in the subtitle. */
  numbered?: boolean;
}

export function CatalogTrackList({ tracks, adder, testId = "catalog-tracks", numbered = false }: TrackListProps) {
  const discs = numbered ? new Set(tracks.map((track) => track.discNumber ?? 1)) : new Set([1]);
  const showDiscs = discs.size > 1;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-surface" data-testid={testId}>
      {tracks.map((track, index) => {
        const disc = track.discNumber ?? 1;
        const newDisc = showDiscs && (index === 0 || (tracks[index - 1].discNumber ?? 1) !== disc);
        return (
          <Fragment key={track.id}>
            {newDisc && (
              <li className="bg-surface-2/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Disc {disc}
              </li>
            )}
            <CatalogTrackRow track={track} adder={adder} number={numbered ? (track.trackNumber ?? index + 1) : null} />
          </Fragment>
        );
      })}
    </ul>
  );
}

function CatalogTrackRow({ track, adder, number }: { track: CatalogTrackResult; adder: CatalogAddApi; number: number | null }) {
  const owned = adder.owned(track);
  const busy = adder.adding.has(track.id);
  return (
    <li className="flex items-center gap-3 py-2.5 pl-3 pr-2" data-testid="catalog-track" data-catalog-id={track.id}>
      {number !== null ? (
        <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{number}</span>
      ) : (
        <Cover src={track.thumbUrl ?? track.coverUrl} alt="" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" data-testid="catalog-track-title">
          {track.title}
        </p>
        <p className="truncate text-sm text-muted" data-testid="catalog-track-subtitle">
          {track.artistId ? (
            <Link href={catalogArtistHref(track.artistId)} className={QUIET_LINK}>
              {track.artist}
            </Link>
          ) : (
            track.artist
          )}
          {number === null && track.album && (
            <>
              {" · "}
              {track.albumId ? (
                <Link href={catalogAlbumHref(track.albumId)} className={QUIET_LINK}>
                  {track.album}
                </Link>
              ) : (
                track.album
              )}
            </>
          )}
        </p>
      </div>
      <span className="shrink-0 text-sm tabular-nums text-muted">{formatDuration(track.durationSec)}</span>
      <div className="flex w-20 shrink-0 justify-end">
        {owned ? (
          <span className="text-xs text-muted" data-testid="catalog-in-library">
            In library
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void adder.add([track])}
            disabled={busy}
            aria-label={`Add ${track.title}`}
            data-testid="catalog-add"
            className={ADD_BUTTON}
          >
            {busy ? "Adding..." : "Add"}
          </button>
        )}
      </div>
    </li>
  );
}

const RECORD_TYPE: Record<CatalogRecordType, string> = {
  album: "Album",
  single: "Single",
  ep: "EP",
  compile: "Compilation",
};

export function recordTypeLabel(type: CatalogRecordType): string {
  return RECORD_TYPE[type];
}

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6";
const ROW = "-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none]";

function albumSubtitle(album: CatalogAlbumResult, showArtist: boolean): string {
  const parts = [showArtist ? album.artist : null, album.year, album.inLibrary ? "In library" : null];
  return parts.filter(Boolean).join(" · ") || recordTypeLabel(album.recordType);
}

/** Album tiles: a grid on full lists, a sideways row in the Top tab. */
export function CatalogAlbumTiles({
  albums,
  showArtist = true,
  row = false,
  testId = "catalog-albums",
}: {
  albums: readonly CatalogAlbumResult[];
  showArtist?: boolean;
  row?: boolean;
  testId?: string;
}) {
  return (
    <div className={row ? ROW : GRID} data-testid={testId}>
      {albums.map((album) => (
        <CoverTile
          key={album.id}
          fluid={!row}
          cover={album.thumbUrl ?? album.coverUrl}
          title={album.title}
          subtitle={albumSubtitle(album, showArtist)}
          href={catalogAlbumHref(album.id)}
          testId="catalog-album-tile"
        />
      ))}
    </div>
  );
}

export function CatalogArtistTiles({
  artists,
  row = false,
  testId = "catalog-artists",
}: {
  artists: readonly CatalogArtistResult[];
  row?: boolean;
  testId?: string;
}) {
  return (
    <div className={row ? ROW : GRID} data-testid={testId}>
      {artists.map((artist) => (
        <CoverTile
          key={artist.id}
          round
          fluid={!row}
          cover={artist.thumbUrl ?? artist.pictureUrl}
          title={artist.name}
          subtitle={artist.inLibrary ? "Artist · In library" : "Artist"}
          href={catalogArtistHref(artist.id)}
          testId="catalog-artist-tile"
        />
      ))}
    </div>
  );
}

/** Header of the catalog album and artist pages: art, kind, name, summary, actions. */
export function CatalogHeader({
  kind,
  title,
  art,
  summary,
  actions,
}: {
  kind: string;
  title: string;
  art: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
      <div className="w-40 shrink-0 sm:w-52">{art}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{kind}</p>
          <h1 className="mt-1 break-words text-3xl font-bold tracking-tight sm:text-4xl" data-testid="catalog-title">
            {title}
          </h1>
          {summary && <div className="mt-1.5 text-sm text-muted">{summary}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Loading, error and not-found states shared by the catalog pages. */
export function CatalogNotice({ text, onRetry, testId }: { text: string; onRetry?: () => void; testId?: string }) {
  return (
    <main className="pt-6">
      <div
        className="flex flex-col items-center gap-3 rounded-box border border-line bg-surface p-6 text-center text-sm text-muted"
        data-testid={testId}
      >
        <p role={onRetry ? "alert" : undefined}>{text}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className={ADD_BUTTON}>
            Try again
          </button>
        )}
      </div>
    </main>
  );
}
