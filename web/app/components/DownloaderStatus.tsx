"use client";

/**
 * Downloader status pill + waiting count (SPEC 8.3): "Downloader online"
 * (green) within 2 minutes of agent_last_seen, else "Downloader offline,
 * last seen <relative time>" (muted). Waiting songs show
 * "N songs waiting for your PC" beneath.
 */
import { useSyncExternalStore } from "react";
import { downloaderStatus, pluralWaiting } from "../lib/ui";
import type { DownloaderSnapshot } from "../lib/api";

const CLOCK_MS = 30_000;

function subscribeClock(onTick: () => void): () => void {
  const timer = window.setInterval(onTick, CLOCK_MS);
  return () => window.clearInterval(timer);
}

/** Coarse tick so the "x ago" text refreshes without Date.now() in render. */
function clockTick(): number {
  return Math.floor(Date.now() / CLOCK_MS);
}

function getServerTick(): number {
  return 0;
}

export function DownloaderStatus({ snapshot }: { snapshot: DownloaderSnapshot }) {
  const tick = useSyncExternalStore(subscribeClock, clockTick, getServerTick);
  const status = downloaderStatus(snapshot.lastSeenAt, tick * CLOCK_MS);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
          status.online ? "border-ok/40 text-ok" : "border-line text-muted"
        }`}
        data-testid="downloader-status"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.online ? "bg-ok" : "bg-muted"}`}
          aria-hidden="true"
        />
        {status.text}
      </span>
      {snapshot.waitingCount > 0 && (
        <span className="text-xs text-muted" data-testid="waiting-count">
          {pluralWaiting(snapshot.waitingCount)}
        </span>
      )}
    </div>
  );
}
