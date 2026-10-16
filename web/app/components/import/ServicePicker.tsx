"use client";

/**
 * Step 1 of the playlist import (V2-PLAN T13): pick a service. Only the
 * services with an import that works right now are listed (the stand-in
 * "Test music service" only in tests). Below it, "Your imports" links back
 * to recent imports and their progress. Used in the Add window's Import
 * tab and on the /import page.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ImportJobSummary, ServiceId, ServiceOption } from "@/lib/import-types";
import { fetchImportJobs, fetchImportServices } from "../../lib/import-api";
import { jobStatusText, progressSentence } from "../../lib/import-view";
import { FOCUS } from "../ui";

const METHOD_WORDS = { login: "Log in", link: "Paste a link", file: "Upload a file" } as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Props {
  onPick(service: ServiceId): void;
  /** Called when a "Your imports" link is followed (the Add window closes). */
  onOpenJob?(): void;
}

export function ServicePicker({ onPick, onOpenJob }: Props) {
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [jobs, setJobs] = useState<ImportJobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchImportServices()
      .then((list) => live && setServices(list))
      .catch((err) => live && setError(errorText(err)));
    fetchImportJobs()
      .then((list) => live && setJobs(list))
      .catch(() => {}); // "Your imports" is a nice extra; the picker works without it
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-5" data-testid="import-services">
      <div>
        <p className="text-sm text-muted">Bring your playlists over. Where are they now?</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-bad">
            Could not load the list. {error}
          </p>
        )}
        {!services && !error && <p className="mt-3 text-sm text-muted">Loading...</p>}
        {services && services.length === 0 && (
          <p className="mt-3 text-sm text-muted" data-testid="import-services-empty">
            No imports are set up yet.
          </p>
        )}
        {services && services.length > 0 && (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
            {services.map((service) => (
              <li key={service.id}>
                <button
                  type="button"
                  onClick={() => onPick(service.id)}
                  data-testid="import-service"
                  data-service={service.id}
                  className={`flex min-h-12 w-full flex-col justify-center px-3 py-2 text-left hover:bg-surface-2 ${FOCUS}`}
                >
                  <span className="text-sm font-semibold">{service.label}</span>
                  <span className="text-xs text-muted">{service.options.map((option) => METHOD_WORDS[option.method]).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {jobs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Your imports</h3>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-box border border-line bg-surface">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/import?job=${job.id}`}
                  onClick={onOpenJob}
                  data-testid="import-recent"
                  className={`flex min-h-12 flex-col justify-center px-3 py-2 hover:bg-surface-2 ${FOCUS}`}
                >
                  <span className="truncate text-sm font-semibold">
                    {job.playlistNames.length > 0 ? job.playlistNames.join(", ") : job.serviceLabel}
                  </span>
                  <span className="text-xs text-muted">
                    {[job.serviceLabel, job.progress && job.progress.total > 0 ? progressSentence({ ...job.progress, pending: 0 }) : jobStatusText(job.status)].join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
