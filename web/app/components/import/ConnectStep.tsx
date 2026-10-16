"use client";

/**
 * Step 2 of the playlist import (V2-PLAN T13): connect. Up to three slots,
 * each shown only when an import for this service supports it: "Log in",
 * "Paste a link" (several, one per line) and a file upload. The first slot's
 * button is the screen's one accent action.
 */
import { useState } from "react";
import type { ConnectOption, ImportJobView, ServiceOption } from "@/lib/import-types";
import { createFileImport, createLinkImport, createLoginImport } from "../../lib/import-api";
import { pastedLines } from "../../lib/import-view";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from "../ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Props {
  service: ServiceOption;
  onJob(job: ImportJobView): void;
}

export function ConnectStep({ service, onJob }: Props) {
  const [links, setLinks] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<ConnectOption["method"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = service.options[0]?.method;
  const button = (method: ConnectOption["method"]) => `${method === first ? BTN_PRIMARY : BTN_SECONDARY} min-h-11`;

  async function run(method: ConnectOption["method"], action: () => Promise<void>) {
    if (busy) return;
    setBusy(method);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  }

  const login = service.options.find((option) => option.method === "login");
  const link = service.options.find((option) => option.method === "link");
  const upload = service.options.find((option) => option.method === "file");
  const lines = pastedLines(links);

  return (
    <div className="flex flex-col gap-4" data-testid="import-connect">
      {error && (
        <p role="alert" className="rounded-box border border-bad/40 bg-surface p-3 text-sm text-bad" data-testid="import-error">
          {error}
        </p>
      )}

      {login && (
        <section className="rounded-box border border-line bg-surface p-4" data-testid="import-slot-login">
          <h2 className="text-base font-semibold">Log in</h2>
          <p className="mt-1 text-sm text-muted">{login.hint}</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("login", async () => {
                const { redirectUrl } = await createLoginImport(service.id);
                if (!redirectUrl) throw new Error("The log in page did not open. Try again.");
                window.location.assign(redirectUrl);
              })
            }
            className={`${button("login")} mt-3 w-full sm:w-auto`}
            data-testid="import-login"
          >
            {busy === "login" ? "Opening..." : `Log in to ${service.label}`}
          </button>
        </section>
      )}

      {link && (
        <section className="rounded-box border border-line bg-surface p-4" data-testid="import-slot-link">
          <h2 className="text-base font-semibold">Paste a link</h2>
          <label htmlFor="import-links" className="mt-1 block text-sm text-muted">
            {link.hint}
          </label>
          <textarea
            id="import-links"
            value={links}
            onChange={(event) => setLinks(event.target.value)}
            rows={3}
            placeholder="https://"
            autoComplete="off"
            className={`${INPUT} mt-3 resize-y text-base sm:text-sm`}
            data-testid="import-links"
          />
          <button
            type="button"
            disabled={busy !== null || lines.length === 0}
            onClick={() => void run("link", async () => onJob((await createLinkImport(service.id, lines)).job))}
            className={`${button("link")} mt-3 w-full sm:w-auto`}
            data-testid="import-find"
          >
            {busy === "link" ? "Looking..." : "Find playlists"}
          </button>
        </section>
      )}

      {upload && (
        <section className="rounded-box border border-line bg-surface p-4" data-testid="import-slot-file">
          <h2 className="text-base font-semibold">Upload a file</h2>
          <label htmlFor="import-file" className="mt-1 block text-sm text-muted">
            {upload.hint}
          </label>
          <input
            id="import-file"
            type="file"
            accept={upload.accept}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="mt-3 block w-full text-sm text-muted file:mr-3 file:min-h-11 file:rounded-btn file:border file:border-line file:bg-surface-2 file:px-3 file:text-sm file:font-medium file:text-silver"
            data-testid="import-file"
          />
          <button
            type="button"
            disabled={busy !== null || !file}
            onClick={() => void run("file", async () => {
              if (file) onJob((await createFileImport(service.id, file)).job);
            })}
            className={`${button("file")} mt-3 w-full sm:w-auto`}
            data-testid="import-upload"
          >
            {busy === "file" ? "Reading..." : "Upload"}
          </button>
        </section>
      )}
    </div>
  );
}
