"use client";

/**
 * Add floating window (SPEC 8.2, 10): paste box with the placeholder
 * "Paste YouTube or SoundCloud links, one per line.", an Add button with a
 * 1/s guard, per-line results, a summary toast on success. Closes on success
 * or Escape/backdrop; stays open when every line failed.
 */
import { useEffect, useMemo, useState } from "react";
import { addTracks, type AddLineResult } from "../lib/api";
import { summarizeAddResults } from "../lib/ui";
import { useOverlays } from "./Overlays";
import { CloseIcon } from "./icons";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultLabel(result: AddLineResult): string {
  if (result.outcome === "added") return "Added";
  if (result.outcome === "already") return "Already in your library";
  return result.message ?? "Could not add this link";
}

function resultClass(result: AddLineResult): string {
  if (result.outcome === "added") return "text-ok";
  if (result.outcome === "already") return "text-muted";
  return "text-bad";
}

export function AddWindow({ onClose }: { onClose: () => void }) {
  const { showToast, notifyLibraryChanged } = useOverlays();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<AddLineResult[] | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const urls = useMemo(
    () =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    [text],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleAdd() {
    if (submitting || urls.length === 0) return;
    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await addTracks(urls);
      setResults(response.results);
      const summary = summarizeAddResults(response.results);
      const everyLineFailed = response.results.every((r) => r.outcome === "error");
      if (!everyLineFailed && summary) {
        // Success: toast + close (SPEC 8.2). The list refetches via the bump.
        showToast(summary);
        notifyLibraryChanged();
        onClose();
      }
    } catch (error) {
      setRequestError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={
        "fixed inset-0 z-40 flex items-end justify-center bg-black/60 px-4 " +
        "pb-[calc(5rem+env(safe-area-inset-bottom))] sm:items-center sm:pb-0"
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-window-title"
        data-testid="add-window"
        className="w-full max-w-md rounded-box border border-line bg-surface-2 p-4 shadow-[0_6px_16px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center justify-between">
          <h2 id="add-window-title" className="text-base font-semibold">
            Add songs
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="add-close"
            className="rounded-btn p-1.5 text-muted hover:text-fg focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          >
            <CloseIcon />
          </button>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder="Paste YouTube or SoundCloud links, one per line."
          aria-label="Links to add"
          data-testid="add-input"
          className={
            "mt-3 w-full resize-none rounded-btn border border-line bg-bg px-3 py-2 text-sm " +
            "placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          }
        />
        {requestError && (
          <p role="alert" className="mt-2 text-sm text-bad" data-testid="add-request-error">
            {requestError}
          </p>
        )}
        {results && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="add-results">
            {results.map((result, index) => (
              <li key={`${result.url}-${index}`} className="flex flex-col">
                <span className={`text-sm ${resultClass(result)}`}>{resultLabel(result)}</span>
                <span className="truncate text-xs text-muted">{result.url}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={submitting || urls.length === 0}
          data-testid="add-submit"
          className={
            "mt-3 w-full rounded-btn bg-accent px-3 py-2 font-medium text-bg hover:bg-accent-ink " +
            "disabled:cursor-not-allowed disabled:opacity-60 focus:outline-2 focus:outline-offset-2 focus:outline-silver"
          }
        >
          {submitting ? "Adding..." : "Add"}
        </button>
        <p className="mt-2 text-xs text-muted">Paste YouTube or SoundCloud links, one per line.</p>
      </div>
    </div>
  );
}
