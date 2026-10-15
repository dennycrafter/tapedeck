"use client";

/**
 * "Pick another version" (V2-PLAN T12): for songs added from the catalog.
 * Lists the copies the PC found (the one it downloaded is marked Current),
 * takes a pasted YouTube or SoundCloud link instead, or asks the PC to
 * search again. Each choice sends the song back to the PC, then closes with
 * a toast; errors stay in the dialog.
 */
import { useState } from "react";
import { pickVersion, searchAgain, type TrackDto } from "../lib/api";
import { formatDuration } from "@/lib/player/format";
import { sourceLabel, versionOptions } from "@/lib/pick-version";
import { useOverlays } from "./Overlays";
import { BTN_SECONDARY, INPUT, Modal } from "./ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PickVersionDialog({ track, onClose }: { track: TrackDto; onClose(): void }) {
  const { showToast, notifyLibraryChanged } = useOverlays();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = versionOptions(track.matchInfo, track.resolvedUrl);

  async function run(action: () => Promise<void>, done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      showToast(done);
      notifyLibraryChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const pick = (url: string) => void run(() => pickVersion(track.id, url), "Your PC will download this version");

  return (
    <Modal title="Pick another version" onClose={onClose} testId="pick-version">
      {options.length > 0 ? (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-box border border-line bg-surface">
          {options.map((option) => {
            const facts = [option.uploader, formatDuration(option.durationSec), sourceLabel(option.source)]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={option.url}>
                <button
                  type="button"
                  disabled={busy || option.current}
                  onClick={() => pick(option.url)}
                  data-testid="pick-version-item"
                  data-current={option.current ? "true" : "false"}
                  data-url={option.url}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left enabled:hover:bg-surface-2 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-silver"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{option.title}</span>
                    {facts && <span className="block truncate text-xs text-muted">{facts}</span>}
                  </span>
                  {option.current && (
                    <span
                      className="shrink-0 rounded-btn border border-line px-1.5 py-0.5 text-xs text-silver"
                      data-testid="pick-version-current"
                    >
                      Current
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted" data-testid="pick-version-empty">
          Your PC hasn&apos;t found any versions yet.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = link.trim();
          if (trimmed) pick(trimmed);
        }}
        className="mt-4"
      >
        <label htmlFor="pick-version-link" className="text-xs text-muted">
          Or paste a YouTube or SoundCloud link
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="pick-version-link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://"
            inputMode="url"
            autoComplete="off"
            data-testid="pick-version-link"
            className={`${INPUT} min-w-0`}
          />
          <button
            type="submit"
            disabled={busy || !link.trim()}
            className={`${BTN_SECONDARY} shrink-0 whitespace-nowrap`}
            data-testid="pick-version-use-link"
          >
            Use this link
          </button>
        </div>
      </form>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">None of these right?</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => searchAgain(track.id), "Your PC will search again")}
          className={BTN_SECONDARY}
          data-testid="pick-version-search"
        >
          Search again
        </button>
      </div>
    </Modal>
  );
}
