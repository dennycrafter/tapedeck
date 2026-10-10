"use client";

/**
 * Cover art square (SPEC 10): 8px corners; the blank placeholder is a
 * --surface-2 square with a muted music-note icon.
 */
import { MusicNoteIcon } from "./icons";

interface CoverProps {
  src: string | null;
  alt: string;
  /** Tailwind size classes; defaults to the 44px list row cover. */
  sizeClass?: string;
}

export function Cover({ src, alt, sizeClass = "h-11 w-11" }: CoverProps) {
  const classes = `${sizeClass} shrink-0 rounded-box`;
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-surface-2 text-muted ${classes}`} aria-hidden="true">
        <MusicNoteIcon />
      </div>
    );
  }
  // Plain <img>: cover URLs come from arbitrary CDNs (iTunes, Deezer), and
  // next/image would need every host whitelisted in the shared next.config.
  // Revisit with remotePatterns when the full library lands (T2).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" className={`${classes} object-cover`} />;
}
