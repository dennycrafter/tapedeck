"use client";

/**
 * Search box (SPEC 8.7): a YouTube search inside the Add window. It runs
 * only when the owner presses Enter or the Search button — never while
 * typing — to save the daily quota, and shows the SPEC's note about the
 * free daily limit under the box. Results carry thumbnail, raw title,
 * channel and duration; "Add" runs the same pipeline as a pasted link,
 * "In library" replaces the button for owned songs, and "Open on YouTube"
 * is the plain text link out.
 */
import { useState } from "react";
import { addTracks, searchYouTube, type SearchHit } from "../lib/api";
import { formatDuration } from "@/lib/player/format";
import { useOverlays } from "./Overlays";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SearchBox() {
  const { showToast, notifyLibraryChanged } = useOverlays();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [addingVideoId, setAddingVideoId] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function runSearch() {
    const q = query.trim();
    if (searching || q.length < 2) return;
    setSearching(true);
    setRequestError(null);
    setMessage(null);
    try {
      const response = await searchYouTube(q);
      setHits(response.results);
      setMessage(response.message ?? null);
    } catch (error) {
      setRequestError(errorText(error));
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  /** "Add" on a result runs the same pipeline as a pasted link (SPEC 8.2). */
  async function addResult(hit: SearchHit) {
    if (addingVideoId) return;
    setAddingVideoId(hit.videoId);
    setRequestError(null);
    try {
      const response = await addTracks([`https://www.youtube.com/watch?v=${hit.videoId}`]);
      const result = response.results[0];
      if (result && result.status === "error") {
        setRequestError(result.message);
      } else {
        showToast(result?.message ?? "1 added");
        notifyLibraryChanged();
      }
    } catch (error) {
      setRequestError(errorText(error));
    } finally {
      setAddingVideoId(null);
    }
  }

  return (
    <section aria-label="Search YouTube" className="mt-4 border-t border-line pt-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
        className="flex gap-2"
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search YouTube"
          aria-label="Search YouTube"
          data-testid="search-input"
          className="w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
        />
        <button
          type="submit"
          disabled={searching || query.trim().length < 2}
          data-testid="search-submit"
          className="rounded-btn border border-line px-3 py-2 text-sm font-medium hover:bg-bg focus:outline-2 focus:outline-offset-2 focus:outline-silver disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </form>
      <p className="mt-1.5 text-xs text-muted" data-testid="search-note">
        Search uses YouTube&apos;s free daily limit (about 100 searches a day).
      </p>

      {message && (
        <p className="mt-2 text-sm text-muted" data-testid="search-message">
          {message}
        </p>
      )}
      {requestError && (
        <p role="alert" className="mt-2 text-sm text-bad" data-testid="search-request-error">
          {requestError}
        </p>
      )}
      {hits && hits.length > 0 && (
        <ul className="mt-2 flex flex-col gap-3" data-testid="search-results">
          {hits.map((hit) => (
            <li key={hit.videoId} className="flex items-center gap-3">
              {hit.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote YouTube thumbnails, next/image has no loader configured for them
                <img
                  src={hit.thumbnailUrl}
                  alt=""
                  width={64}
                  height={36}
                  className="h-9 w-16 flex-none rounded-btn object-cover"
                />
              ) : (
                <div className="h-9 w-16 flex-none rounded-btn bg-bg" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" data-testid="search-result-title">
                  {hit.title}
                </p>
                <p className="truncate text-xs text-muted" data-testid="search-result-subtitle">
                  {hit.channel}
                  {hit.durationSec !== null ? ` - ${formatDuration(hit.durationSec)}` : ""}
                </p>
              </div>
              {hit.inLibrary ? (
                <span className="flex-none text-xs text-muted" data-testid="search-result-in-library">
                  In library
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void addResult(hit)}
                  disabled={addingVideoId !== null}
                  data-testid={`search-result-add-${hit.videoId}`}
                  className="flex-none rounded-btn border border-line px-2.5 py-1 text-sm hover:bg-bg focus:outline-2 focus:outline-offset-2 focus:outline-silver disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {addingVideoId === hit.videoId ? "Adding..." : "Add"}
                </button>
              )}
              <a
                href={`https://www.youtube.com/watch?v=${hit.videoId}`}
                target="_blank"
                rel="noreferrer"
                data-testid={`search-result-open-${hit.videoId}`}
                className="flex-none text-xs text-muted underline hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver"
              >
                Open on YouTube
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
