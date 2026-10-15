"use client";

/**
 * Loads one catalog album or artist for a page. A newer id cancels the older
 * request; `reload` runs it again after an error.
 */
import { useCallback, useEffect, useState } from "react";

interface Loaded<T> {
  key: string;
  data?: T;
  error?: string;
  status?: number;
}

export interface CatalogResource<T> {
  data: T | null;
  error: string | null;
  /** HTTP status of the failed request (404 means the catalog does not know the id). */
  errorStatus: number | null;
  loading: boolean;
  reload(): void;
}

export function useCatalogResource<T>(
  id: string | null,
  load: (id: string, signal: AbortSignal) => Promise<T>,
): CatalogResource<T> {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const key = id ? `${id}#${attempt}` : "";

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const requestKey = `${id}#${attempt}`;
    load(id, controller.signal).then(
      (data) => setLoaded({ key: requestKey, data }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
        setLoaded({ key: requestKey, error: error instanceof Error ? error.message : String(error), status });
      },
    );
    return () => controller.abort();
  }, [id, attempt, load]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = loaded && loaded.key === key ? loaded : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    errorStatus: current?.status ?? null,
    loading: Boolean(id) && !current,
    reload,
  };
}
