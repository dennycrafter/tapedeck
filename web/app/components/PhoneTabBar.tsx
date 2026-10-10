"use client";

/**
 * Phone tab bar (SPEC 10 layout): Library, Add (opens the window), Profile.
 * Fixed to the bottom with the safe-area inset; the active tab uses --fg
 * with a 2px top bar. Hidden at lg where the sidebar layout takes over.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOverlays } from "./Overlays";
import { LibraryIcon, PlusIcon, ProfileIcon } from "./icons";

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
        "flex flex-1 flex-col items-center justify-center gap-0.5 border-t-2 pt-2 focus:outline-2 focus:outline-silver " +
        (active ? "border-fg text-fg" : "border-transparent text-muted")
      }
    >
      {children}
      <span className="text-xs">{label}</span>
    </Link>
  );
}

export function PhoneTabBar() {
  const pathname = usePathname();
  const { openAdd } = useOverlays();
  return (
    <nav
      aria-label="Main"
      data-testid="tab-bar"
      className={
        "fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-line bg-surface " +
        "pb-[env(safe-area-inset-bottom)] lg:hidden"
      }
    >
      <TabLink href="/" label="Library" active={pathname === "/"}>
        <LibraryIcon />
      </TabLink>
      <button
        type="button"
        onClick={openAdd}
        aria-label="Add songs"
        data-testid="add-open"
        className="flex flex-1 flex-col items-center justify-center gap-0.5 text-muted hover:text-fg focus:outline-2 focus:outline-silver"
      >
        <PlusIcon />
        <span className="text-xs">Add</span>
      </button>
      <TabLink href="/profile" label="Profile" active={pathname.startsWith("/profile")}>
        <ProfileIcon />
      </TabLink>
    </nav>
  );
}
