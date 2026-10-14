"use client";

/**
 * Profile page (SPEC 8.6): name, stats strip and top artists (see
 * ProfileOverview), then downloader status and the "Downloader setup" panel
 * showing APP_URL and AGENT_TOKEN, each with a Copy button.
 */
import { useEffect, useState } from "react";
import { DownloaderStatus } from "../components/DownloaderStatus";
import { fetchDownloaderSetup, type DownloaderSetupResponse } from "../lib/api";
import { ProfileOverview } from "./ProfileOverview";
import { DeviceStorage } from "./DeviceStorage";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clipboard with the execCommand fallback (plain file:// / older WebKit). */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

type ValueKey = "appUrl" | "agentToken";

export default function ProfilePage() {
  const [data, setData] = useState<DownloaderSetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<ValueKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDownloaderSetup()
      .then((response) => {
        if (!cancelled) {
          setData(response);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy(value: string, which: ValueKey) {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(which);
    window.setTimeout(() => setCopied(null), 2000);
  }

  return (
    <main className="flex w-full max-w-4xl flex-col gap-4 pt-2">
      <ProfileOverview />
      <DeviceStorage />
      <h2 className="mt-6 text-lg font-bold">Downloader</h2>

      {loading && (
        <p className="text-sm text-muted" data-testid="profile-loading">
          Loading...
        </p>
      )}

      {!loading && error && (
        <div className="rounded-box border border-line bg-surface p-4" data-testid="profile-error">
          <p className="text-sm text-bad">Could not load the profile. {error}</p>
        </div>
      )}

      {data && (
        <>
          {data.lastSeenAt !== undefined && (
            <section aria-label="Downloader status" className="rounded-box border border-line bg-surface p-4">
              <h3 className="text-base font-semibold">Status</h3>
              <div className="mt-2">
                <DownloaderStatus
                  snapshot={{ lastSeenAt: data.lastSeenAt, waitingCount: data.waitingCount }}
                />
              </div>
            </section>
          )}

          <section
            aria-labelledby="downloader-setup-heading"
            className="rounded-box border border-line bg-surface p-4"
            data-testid="downloader-setup"
          >
            <h3 id="downloader-setup-heading" className="text-base font-semibold">
              Downloader setup
            </h3>
            <p className="mt-1 text-sm text-muted">
              Copy these two values into the downloader .env on your PC, then start the downloader.
            </p>
            <ValueRow
              label="APP_URL"
              value={data.appUrl}
              copied={copied === "appUrl"}
              onCopy={() => void copy(data.appUrl, "appUrl")}
            />
            <ValueRow
              label="AGENT_TOKEN"
              value={data.agentToken}
              copied={copied === "agentToken"}
              onCopy={() => void copy(data.agentToken, "agentToken")}
            />
          </section>
        </>
      )}
    </main>
  );
}

function ValueRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy(): void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1" data-testid="setup-value">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-btn border border-line bg-bg px-2.5 py-1.5 font-mono text-sm text-silver">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          data-testid={copied ? "copy-done" : "copy-button"}
          className={
            "shrink-0 rounded-btn border px-3 py-1.5 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-silver " +
            (copied ? "border-ok/50 text-ok" : "border-line text-silver hover:border-muted")
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
