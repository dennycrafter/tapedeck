"use client";

/**
 * Catalog search while typing (V2-PLAN T11: debounced 300 ms; the catalog
 * is free, unlike YouTube's quota). A newer query cancels the request in
 * flight, so an old, slow answer never replaces a newer one. The previous
 * results stay on screen while the next ones load.
 */
import { useEffect, useState } from "react";
import type { CatalogSearchResponse } from "@/lib/catalog-types";
import { searchCatalog } from "../../lib/catalog-api";
import { CATALOG_DEBOUNCE_MS, CATALOG_MIN_QUERY } from "../../lib/catalog-view";

interface Answer {
  q: string;
  data?: CatalogSearchResponse;
  error?: string;
}

export interface CatalogSearchState {
  /** The query the shown results belong to. */
  q: string;
  data: CatalogSearchResponse | null;
  error: string | null;
  /** True while the results on screen are not yet for the current query. */
  loading: boolean;
  /** False when the query is too short to search the catalog. */
  active: boolean;
}

export function useCatalogSearch(query: string): CatalogSearchState {
  const q = query.trim();
  const active = q.length >= CATALOG_MIN_QUERY;
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (q.length < CATALOG_MIN_QUERY) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchCatalog(q, controller.signal).then(
        (data) => setAnswer({ q, data }),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer({ q, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }, CATALOG_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  if (!active) return { q, data: null, error: null, loading: false, active };
  const current = answer?.q === q;
  return {
    q: answer?.q ?? q,
    data: answer?.data ?? null,
    error: current ? (answer?.error ?? null) : null,
    loading: !current,
    active,
  };
}
