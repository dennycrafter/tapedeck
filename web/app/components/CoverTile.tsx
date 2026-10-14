"use client";

/** A cover with two lines of text under it, for the horizontal rows and grids. */
import Link from "next/link";
import { Cover } from "./Cover";
import { PlaylistCover } from "./PlaylistCover";

interface CoverTileProps {
  cover?: string | null;
  covers?: string[];
  title: string;
  subtitle: string;
  href?: string;
  onClick?(): void;
  testId?: string;
  dimmed?: boolean;
  /** Fill the grid cell instead of the fixed row width. */
  fluid?: boolean;
  round?: boolean;
}

export function CoverTile({ cover, covers, title, subtitle, href, onClick, testId, dimmed, fluid, round }: CoverTileProps) {
  const size = fluid ? "aspect-square w-full h-auto" : "h-36 w-36 sm:h-40 sm:w-40";
  const art = covers ? (
    <PlaylistCover covers={covers} sizeClass={size} />
  ) : (
    <Cover src={cover ?? null} alt="" sizeClass={`${size} ${round ? "!rounded-full" : ""}`} />
  );
  const body = (
    <>
      {art}
      <span className="mt-2 block truncate text-sm font-semibold">{title}</span>
      <span className="block truncate text-sm text-muted">{subtitle}</span>
    </>
  );
  const classes = `group block shrink-0 rounded-box p-1 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-silver ${
    fluid ? "w-full min-w-0" : "w-[9.5rem] sm:w-[10.5rem]"
  } ${dimmed ? "opacity-50" : ""}`;
  if (href) {
    return (
      <Link href={href} className={classes} data-testid={testId} title={title}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes} data-testid={testId} title={title}>
      {body}
    </button>
  );
}
