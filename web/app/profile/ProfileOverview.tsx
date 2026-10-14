"use client";

/**
 * Top of the Profile page (SPEC 8.6): the display name (tap to edit), one
 * stats strip (Songs, Hours listened, Plays this month, Storage used with an
 * amber dot at 8 GB or more) and the top 5 artists this month by plays.
 * Numbers use the display font (Saira), everything else the system font.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchProfile, setDisplayName, type ProfileResponse } from "../lib/api";
import { artistHref, formatHours, formatStorage } from "../lib/library-view";
import { useLibrary } from "../components/LibraryProvider";
import { useOverlays } from "../components/Overlays";
import { BTN_QUIET, INPUT } from "../components/ui";

/** R2 free tier and warning level (SPEC 3, 8.6); mirrored from lib/library.ts. */
const STORAGE_LIMIT_BYTES = 10 * 1024 ** 3;
const STORAGE_WARN_BYTES = 8 * 1024 ** 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProfileOverview() {
  const { libraryVersion, showToast } = useOverlays();
  const library = useLibrary();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchProfile()
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryVersion]);

  async function saveName() {
    const trimmed = name.trim();
    setEditing(false);
    if (!trimmed || trimmed === profile?.displayName) return;
    try {
      const result = await setDisplayName(trimmed);
      setProfile((current) => (current ? { ...current, displayName: result.displayName } : current));
      void library.refetch(); // Home's greeting
    } catch (err) {
      showToast(errorText(err));
    }
  }

  if (error) {
    return (
      <p className="rounded-box border border-line bg-surface p-4 text-sm text-bad" data-testid="profile-stats-error">
        Could not load your stats. {error}
      </p>
    );
  }
  if (!profile) return null;

  const { stats } = profile;
  const storageWarn = stats.storageBytes >= STORAGE_WARN_BYTES;
  const cells = [
    { label: "Songs", value: stats.songs.toLocaleString("en-US"), testId: "stat-songs" },
    { label: "Hours listened", value: formatHours(stats.secondsListened), testId: "stat-hours" },
    { label: "Plays this month", value: stats.playsThisMonth.toLocaleString("en-US"), testId: "stat-plays" },
    {
      label: "Storage used",
      value: formatStorage(stats.storageBytes, STORAGE_LIMIT_BYTES),
      testId: "stat-storage",
      warn: storageWarn,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-2xl font-semibold text-silver">
          {(profile.displayName.trim()[0] ?? "?").toUpperCase()}
        </div>
        {editing ? (
          <form
            className="flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(false);
              }}
              aria-label="Your name"
              data-testid="display-name-input"
              className={`${INPUT} max-w-sm text-lg font-semibold`}
            />
          </form>
        ) : (
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold tracking-tight" data-testid="display-name">
              {profile.displayName}
            </h1>
            <button
              type="button"
              onClick={() => {
                setName(profile.displayName);
                setEditing(true);
              }}
              className={`${BTN_QUIET} -ml-2`}
              data-testid="display-name-edit"
            >
              Edit name
            </button>
          </div>
        )}
      </div>

      <dl
        className="grid grid-cols-2 gap-px overflow-hidden rounded-box border border-line bg-line md:grid-cols-4"
        data-testid="profile-stats"
      >
        {cells.map((cell) => (
          <div key={cell.label} className="flex flex-col gap-1 bg-surface p-4">
            <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{cell.label}</dt>
            <dd className="flex items-center gap-2 font-display text-3xl font-semibold tabular-nums" data-testid={cell.testId}>
              {cell.warn && <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-label="Storage almost full" />}
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="top-artists-heading">
        <h2 id="top-artists-heading" className="mb-3 text-lg font-bold">
          Top artists this month
        </h2>
        {profile.topArtists.length === 0 ? (
          <p className="text-sm text-muted">Play some songs and your top artists show up here.</p>
        ) : (
          <ol className="divide-y divide-line rounded-box border border-line bg-surface" data-testid="top-artists">
            {profile.topArtists.map((artist, index) => (
              <li key={artist.artist}>
                <Link
                  href={artistHref(artist.artist)}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver"
                >
                  <span className="w-5 font-display text-lg text-muted">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{artist.artist}</span>
                  <span className="text-sm text-muted">{artist.plays === 1 ? "1 play" : `${artist.plays} plays`}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
