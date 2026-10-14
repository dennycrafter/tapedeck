"use client";

/**
 * Profile > This device (SPEC 8.6, 8.9): how much the offline songs take on
 * this phone or computer, and "Remove all downloads" (with a confirm).
 */
import { useState } from "react";
import { downloadedBytes, removeAllDownloads } from "../lib/offline";
import { useOffline } from "../components/useOffline";
import { useOverlays } from "../components/Overlays";
import { BTN_SECONDARY, ConfirmDialog } from "../components/ui";

export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function DeviceStorage() {
  const offline = useOffline();
  const { showToast } = useOverlays();
  const [confirming, setConfirming] = useState(false);
  const count = offline.downloaded.size;

  return (
    <section aria-labelledby="device-heading" className="flex flex-col gap-3">
      <h2 id="device-heading" className="mt-6 text-lg font-bold">
        This device
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-line bg-surface p-4">
        <div>
          <p className="text-sm font-semibold">Offline songs</p>
          <p className="text-sm text-muted" data-testid="offline-storage">
            {count === 0
              ? "Nothing downloaded on this device"
              : `${count === 1 ? "1 song" : `${count} songs`} · ${formatMegabytes(downloadedBytes(offline))}`}
          </p>
        </div>
        {count > 0 && (
          <button type="button" onClick={() => setConfirming(true)} className={BTN_SECONDARY} data-testid="remove-all-downloads">
            Remove all downloads
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Remove all downloads?"
          body="Songs stay in your library. They just won't play offline on this device until you download them again."
          confirmLabel="Remove all"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await removeAllDownloads();
            showToast("Downloads removed");
          }}
        />
      )}
    </section>
  );
}
