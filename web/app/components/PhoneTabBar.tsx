"use client";

/**
 * Phone tab bar (SPEC 10 layout): Home, Search, Library, Add (opens the
 * window). Fixed to the bottom with the safe-area inset; the active tab uses
 * --fg with a 2px top bar. Hidden at lg where the sidebar takes over.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOverlays } from "./Overlays";
import { HomeIcon, LibraryIcon, PlusIcon, SearchIcon } from "./icons";

interface TabLinkProps {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}

function TabLink({ href, label, active, children }: TabLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-testid={`tab-${label.toLowerCase()}`}
      className={
        "flex flex-1 flex-col items-center justify-center gap-0.5 border-t-2 pt-1.5 focus-visible:outline-2 focus-visible:outline-silver " +
        (active ? "border-fg text-fg" : "border-transparent text-muted")
      }
    >
      {children}
      <span className="text-xs">{label}</span>
    </Link>
  );
}

const LIBRARY_PATHS = ["/library", "/playlist", "/album", "/artist"];

export function PhoneTabBar() {
  const pathname = usePathname();
  const { openAdd } = useOverlays();
  return (
    <nav
      aria-label="Main"
      data-testid="tab-bar"
      className={
        "fixed inset-x-0 bottom-0 z-30 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-stretch border-t border-line bg-surface " +
        "pb-[env(safe-area-inset-bottom)] lg:hidden"
      }
    >
      <TabLink href="/" label="Home" active={pathname === "/"}>
        <HomeIcon />
      </TabLink>
      <TabLink href="/search" label="Search" active={pathname === "/search"}>
        <SearchIcon />
      </TabLink>
      <TabLink href="/library" label="Library" active={LIBRARY_PATHS.some((p) => pathname.startsWith(p))}>
        <LibraryIcon />
      </TabLink>
      <button
        type="button"
        onClick={openAdd}
        aria-label="Add songs"
        data-testid="add-open"
        className="flex flex-1 flex-col items-center justify-center gap-0.5 border-t-2 border-transparent pt-1.5 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-silver"
      >
        <PlusIcon />
        <span className="text-xs">Add</span>
      </button>
    </nav>
  );
}
