"use client";

/**
 * Playlist cover (SPEC 8.6): a 2x2 grid of the first 4 distinct covers, the
 * single cover when there is only one, else the blank placeholder.
 */
import { Cover } from "./Cover";

export function PlaylistCover({ covers, sizeClass = "h-11 w-11" }: { covers: string[]; sizeClass?: string }) {
  if (covers.length < 4) return <Cover src={covers[0] ?? null} alt="" sizeClass={sizeClass} />;
  return (
    <div className={`${sizeClass} grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-box`} aria-hidden="true">
      {covers.slice(0, 4).map((src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ))}
    </div>
  );
}
