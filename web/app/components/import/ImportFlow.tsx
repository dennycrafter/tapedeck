"use client";

/**
 * The playlist import screen (V2-PLAN T13), /import. The address holds the
 * step, so a reload or a "Your imports" link lands in the right place:
 *
 *   /import                 pick a service
 *   /import?service=spotify connect (log in, paste a link, upload a file)
 *   /import?job=<id>        the job: finding playlists, waiting for the PC,
 *                           the checklist, importing, then live progress
 *   /import?error=...       a log in that came back with a problem
 *
 * The browser drives the import: it asks /chunk for the next 50 songs until
 * the server says done, then polls the job for the live counts while the
 * PC downloads.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isServiceId, type ImportJobView, type ServiceOption } from "@/lib/import-types";
import { fetchImportJob, fetchImportServices, listImportJob, runImportChunk } from "../../lib/import-api";
import { useOverlays } from "../Overlays";
import { BTN_QUIET, BTN_SECONDARY } from "../ui";
import { ChevronLeftIcon } from "../icons";
import { Checklist } from "./Checklist";
import { ConnectStep } from "./ConnectStep";
import { ImportProgress } from "./ImportProgress";
import { ServicePicker } from "./ServicePicker";

const PC_POLL_MS = 3_000;
const PROGRESS_POLL_MS = 5_000;
const BUSY_RETRY_MS = 2_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ImportFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const { notifyLibraryChanged } = useOverlays();
  const jobId = params.get("job");
  const serviceParam = params.get("service");
  const loginError = params.get("error");

  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runAttempt, setRunAttempt] = useState(0);

  // The service list, for the connect step.
  useEffect(() => {
    if (!serviceParam) return;
    let live = true;
    fetchImportServices()
      .then((list) => live && setServices(list))
      .catch((err) => live && setLoadError(errorText(err)));
    return () => {
      live = false;
    };
  }, [serviceParam]);

  // The job named in the address.
  useEffect(() => {
    if (!jobId || job?.id === jobId) return;
    let live = true;
    fetchImportJob(jobId)
      .then((found) => {
        if (!live) return;
        setLoadError(null);
        setJob(found);
      })
      .catch((err) => live && setLoadError(errorText(err)));
    return () => {
      live = false;
    };
  }, [jobId, job?.id]);

  const refresh = () => {
    if (!jobId) return;
    fetchImportJob(jobId)
      .then(setJob)
      .catch(() => {}); // the next poll tries again
  };

  const status = job?.id === jobId ? job?.status : undefined;
  const stillDownloading = job?.progress ? job.progress.waiting + job.progress.pending > 0 : false;

  // `new`: the PC answered (or the log in came back); list the playlists.
  useEffect(() => {
    if (status !== "new" || !jobId) return;
    let live = true;
    listImportJob(jobId)
      .then((listed) => live && setJob(listed))
      .catch((err) => live && setLoadError(errorText(err)));
    return () => {
      live = false;
    };
  }, [status, jobId]);

  // Waiting for the PC, or the PC downloading: poll for news.
  useEffect(() => {
    const wait = status === "waiting_pc" ? PC_POLL_MS : status === "done" && stillDownloading ? PROGRESS_POLL_MS : null;
    if (!wait || !jobId) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      fetchImportJob(jobId)
        .then(setJob)
        .catch(() => {}); // the next poll tries again
    }, wait);
    return () => window.clearInterval(timer);
  }, [status, stillDownloading, jobId]);

  // Importing: drive the chunks until the server says done.
  useEffect(() => {
    if (status !== "importing" || !jobId) return;
    let live = true;
    void (async () => {
      while (live) {
        try {
          const step = await runImportChunk(jobId);
          if (!live) return;
          setJob(step.job);
          if (step.job.status !== "importing") {
            if (step.job.status === "done") notifyLibraryChanged();
            return;
          }
          if (step.busy) await sleep(BUSY_RETRY_MS);
        } catch (err) {
          if (live) setRunError(errorText(err));
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [status, jobId, runAttempt, notifyLibraryChanged]);

  const openJob = (next: ImportJobView) => {
    setJob(next);
    router.replace(`/import?job=${next.id}`);
  };

  const service = serviceParam && isServiceId(serviceParam) ? services?.find((option) => option.id === serviceParam) : undefined;
  const backToServices = (
    <Link href="/import" className={`${BTN_QUIET} -ml-2 min-h-11 self-start`} data-testid="import-back">
      <ChevronLeftIcon />
      All services
    </Link>
  );

  let title = "Import playlists";
  let body: React.ReactNode;
  if (jobId) {
    if (loadError && !job) {
      body = (
        <p role="alert" className="text-sm text-bad" data-testid="import-error">
          {loadError}
        </p>
      );
    } else if (!job || job.id !== jobId) {
      body = <p className="text-sm text-muted">Loading...</p>;
    } else if (job.status === "failed") {
      body = (
        <div className="flex flex-col gap-3">
          <p role="alert" className="rounded-box border border-bad/40 bg-surface p-3 text-sm text-bad" data-testid="import-error">
            {job.error || "That didn't work."}
          </p>
          <Link href={`/import?service=${job.service}`} className={`${BTN_SECONDARY} min-h-11 self-start`} data-testid="import-again">
            Try again
          </Link>
        </div>
      );
    } else if (job.status === "login") {
      body = (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Waiting for you to finish logging in.</p>
          <Link href={`/import?service=${job.service}`} className={`${BTN_SECONDARY} min-h-11 self-start`}>
            Start again
          </Link>
        </div>
      );
    } else if (job.status === "new" || (job.status === "waiting_pc" && !job.playlists && !job.progress)) {
      title = `Import from ${job.serviceLabel}`;
      body = (
        <div className="rounded-box border border-line bg-surface p-4" data-testid="import-finding">
          <h2 className="text-base font-semibold">{job.status === "waiting_pc" ? "Waiting for your PC" : "Finding your playlists..."}</h2>
          {job.status === "waiting_pc" && (
            <p className="mt-1 text-sm text-muted">
              Your PC lists these playlists. Keep the downloader running; this page updates by itself.
            </p>
          )}
        </div>
      );
    } else if (job.status === "listed") {
      title = `Import from ${job.serviceLabel}`;
      body = <Checklist job={job} onStarted={setJob} />;
    } else {
      title = `Import from ${job.serviceLabel}`;
      body = (
        <ImportProgress
          job={job}
          onRefresh={refresh}
          onJob={setJob}
          runError={runError}
          onRetryRun={() => {
            setRunError(null);
            setRunAttempt((n) => n + 1);
          }}
        />
      );
    }
  } else if (serviceParam) {
    if (loadError) {
      body = (
        <p role="alert" className="text-sm text-bad">
          {loadError}
        </p>
      );
    } else if (!services) {
      body = <p className="text-sm text-muted">Loading...</p>;
    } else if (!service) {
      body = (
        <>
          {backToServices}
          <p className="text-sm text-muted">Importing from there isn&apos;t set up.</p>
        </>
      );
    } else {
      title = `Import from ${service.label}`;
      body = (
        <>
          {backToServices}
          <ConnectStep service={service} onJob={openJob} />
        </>
      );
    }
  } else {
    body = (
      <>
        {loginError && (
          <p role="alert" className="rounded-box border border-bad/40 bg-surface p-3 text-sm text-bad" data-testid="import-error">
            {loginError}
          </p>
        )}
        <ServicePicker onPick={(id) => router.push(`/import?service=${id}`)} />
      </>
    );
  }

  return (
    <main className="flex w-full max-w-2xl flex-col gap-4 pt-2" data-testid="import-page">
      <h1 className="text-2xl font-bold tracking-tight" data-testid="import-title">
        {title}
      </h1>
      {body}
    </main>
  );
}
