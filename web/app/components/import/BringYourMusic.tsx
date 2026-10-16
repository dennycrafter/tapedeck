"use client";

/**
 * "Bring your music" (V2-PLAN T13): the Home card while the library is
 * empty. It shows only when at least one import works, and names those
 * services. The empty state's "Add songs" stays the screen's accent action,
 * so this button is the plain kind.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ServiceOption } from "@/lib/import-types";
import { fetchImportServices } from "../../lib/import-api";
import { serviceNames } from "../../lib/import-view";
import { BTN_SECONDARY } from "../ui";

export function BringYourMusic() {
  const [services, setServices] = useState<ServiceOption[]>([]);

  useEffect(() => {
    let live = true;
    fetchImportServices()
      .then((list) => live && setServices(list))
      .catch(() => {}); // no card without the list; Add songs still works
    return () => {
      live = false;
    };
  }, []);

  if (services.length === 0) return null;
  return (
    <section className="rounded-box border border-line bg-surface p-5" data-testid="home-import-card">
      <h2 className="text-lg font-semibold">Bring your music</h2>
      <p className="mt-1 text-sm text-muted">
        Import your playlists from {serviceNames(services)}. Tick the ones you want and your PC fetches the songs.
      </p>
      <Link href="/import" className={`${BTN_SECONDARY} mt-4 min-h-11`} data-testid="home-import-open">
        Import playlists
      </Link>
    </section>
  );
}
