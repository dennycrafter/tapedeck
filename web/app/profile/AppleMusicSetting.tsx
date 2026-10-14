"use client";

/**
 * Profile > Settings (SPEC 8.6, 8.11): "Also add to Apple Music on my PC".
 * When on, the PC downloader copies every song it finishes into Apple
 * Music's "Automatically Add to Music" folder. Off by default.
 */
import { useLibrary } from "../components/LibraryProvider";
import { useOverlays } from "../components/Overlays";
import { FOCUS } from "../components/ui";

export function AppleMusicSetting() {
  const library = useLibrary();
  const { showToast } = useOverlays();
  if (!library.library) return null;
  const on = library.library.appleMusicExport;

  return (
    <section aria-labelledby="settings-heading" className="flex flex-col gap-3">
      <h2 id="settings-heading" className="mt-6 text-lg font-bold">
        Settings
      </h2>
      <div className="flex items-start justify-between gap-4 rounded-box border border-line bg-surface p-4">
        <div>
          <p className="text-sm font-semibold" id="apple-music-label">
            Also add to Apple Music on my PC
          </p>
          <p className="mt-1 text-sm text-muted">
            Your PC copies each new song into Apple Music. Keep Apple Music open on the PC, then sync your iPhone
            with the Apple Devices app.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="apple-music-label"
          data-testid="apple-music-toggle"
          onClick={() => {
            library.setAppleMusicExport(!on).catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : String(error));
            });
          }}
          className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${FOCUS} ${
            on ? "border-silver bg-silver" : "border-line bg-surface-2"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-4 w-4 rounded-full transition-transform ${on ? "translate-x-6 bg-bg" : "translate-x-1 bg-muted"}`}
          />
        </button>
      </div>
    </section>
  );
}
