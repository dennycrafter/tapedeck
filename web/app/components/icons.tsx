/**
 * Inline SVG icons (SPEC 10: aria labels live on the icon buttons, not here).
 * Stroke icons inherit currentColor.
 */
import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

export function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
    </svg>
  );
}

export function MusicNoteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M9 18.5V6.2c0-.5.35-.93.84-1L18.3 4v12.3" />
      <circle cx="6.6" cy="18.5" r="2.4" />
      <circle cx="15.9" cy="16.3" r="2.4" />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function LibraryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 5.5h6M4 12h6M4 18.5h6" />
      <path d="M15.5 5.5c2.6.9 4.5 3.4 4.5 6.5s-1.9 5.6-4.5 6.5" />
    </svg>
  );
}

export function ProfileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c1.2-3.2 3.9-4.8 7-4.8s5.8 1.6 7 4.8" />
    </svg>
  );
}
