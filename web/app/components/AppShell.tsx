"use client";

/**
 * App frame (SPEC 10 layout). Desktop: left sidebar (Home, Search, Library
 * sections, New playlist, your playlists), main content with "Add" and the
 * profile circle top right, player bar at the bottom. Phone: bottom tab bar
 * (Home, Search, Library, Add) with the mini player above it. The login,
 * setup and test-audio pages render bare.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { useLibrary } from "./LibraryProvider";
import { useOffline } from "./useOffline";
import { useOverlays } from "./Overlays";
import { PhoneTabBar } from "./PhoneTabBar";
import { PlayerBar } from "./PlayerBar";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { PlaylistCover } from "./PlaylistCover";
import { NewPlaylistDialog } from "./NewPlaylistDialog";
import { HomeIcon, PlusIcon, SearchIcon } from "./icons";
import { FOCUS } from "./ui";
import { isBarePath } from "../lib/routes";


export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isBarePath(pathname)) {
    return (
      <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)]">
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    );
  }
  return (
    <>
      {/* First in the DOM so the phone's visible Add is the first "add-open". */}
      <PhoneTabBar />
      <Suspense fallback={<aside className="hidden w-60 lg:block" />}>
        <Sidebar />
      </Suspense>
      <div className="lg:pl-60">
        <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)]">
          <TopBar />
          <div className="flex flex-1 flex-col pb-40 lg:pb-28">{children}</div>
        </div>
      </div>
      <PlayerBar />
      <KeyboardShortcuts />
    </>
  );
}

function TopBar() {
  const { openAdd } = useOverlays();
  const { library } = useLibrary();
  const offline = useOffline();
  const initial = (library?.displayName.trim()[0] ?? "D").toUpperCase();
  return (
    <div className="flex h-14 items-center justify-end gap-2 pt-[env(safe-area-inset-top)]">
      {!offline.online && (
        // SPEC 8.9: a muted "Offline" pill while the library comes from the phone.
        <span
          className="mr-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted"
          data-testid="offline-pill"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden="true" />
          Offline
        </span>
      )}
      <button
        type="button"
        onClick={openAdd}
        data-testid="add-open"
        className={`hidden items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-sm font-medium text-silver hover:border-muted hover:bg-surface-2 lg:inline-flex ${FOCUS}`}
      >
        <PlusIcon width={18} height={18} /> Add
      </button>
      <Link
        href="/profile"
        aria-label="Profile"
        data-testid="profile-link"
        className={`flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-2 text-sm font-semibold text-silver hover:border-muted ${FOCUS}`}
      >
        {initial}
      </Link>
    </div>
  );
}

interface NavItem {
  href: string;
  label: string;
  active: boolean;
  icon?: ReactNode;
  testId: string;
}

function NavLink({ href, label, active, icon, testId }: NavItem) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
      className={`flex items-center gap-3 rounded-btn border-l-2 px-3 py-2 text-sm font-medium ${FOCUS} ${
        active ? "border-fg bg-surface-2 text-fg" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { playlists } = useLibrary();
  const [creating, setCreating] = useState(false);
  const tab = pathname === "/library" ? (params.get("tab") ?? "songs") : null;
  const playlistId = pathname === "/playlist" ? params.get("id") : null;

  const libraryLinks: NavItem[] = [
    { href: "/library", label: "Songs", active: tab === "songs", testId: "nav-songs" },
    { href: "/library?tab=liked", label: "Liked songs", active: tab === "liked", testId: "nav-liked" },
    { href: "/library?tab=playlists", label: "Playlists", active: tab === "playlists", testId: "nav-playlists" },
    { href: "/library?tab=albums", label: "Albums", active: tab === "albums" || pathname === "/album", testId: "nav-albums" },
    { href: "/library?tab=artists", label: "Artists", active: tab === "artists" || pathname === "/artist", testId: "nav-artists" },
    { href: "/library?tab=recent", label: "Recently played", active: tab === "recent", testId: "nav-recent" },
    { href: "/library?tab=downloaded", label: "Downloaded", active: tab === "downloaded", testId: "nav-downloaded" },
  ];

  return (
    <aside
      aria-label="Sidebar"
      data-testid="sidebar"
      className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col gap-1 overflow-y-auto border-r border-line bg-surface px-3 pb-28 pt-5 lg:flex"
    >
      <Link href="/" className={`mb-4 px-3 text-lg font-bold tracking-tight ${FOCUS}`}>
        Tapedeck
      </Link>
      <NavLink href="/" label="Home" active={pathname === "/"} icon={<HomeIcon />} testId="nav-home" />
      <NavLink href="/search" label="Search" active={pathname === "/search"} icon={<SearchIcon />} testId="nav-search" />
      <p className="mt-5 px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted">Library</p>
      {libraryLinks.map((item) => (
        <NavLink key={item.href} {...item} />
      ))}
      <div className="mt-5 flex items-center justify-between px-3 pb-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Your playlists</p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label="New playlist"
          data-testid="new-playlist"
          className={`rounded-btn p-1 text-muted hover:bg-surface-2 hover:text-fg ${FOCUS}`}
        >
          <PlusIcon width={18} height={18} />
        </button>
      </div>
      {playlists.length === 0 && <p className="px-3 text-sm text-muted">No playlists yet.</p>}
      {playlists.map((playlist) => (
        <Link
          key={playlist.id}
          href={`/playlist?id=${playlist.id}`}
          aria-current={playlistId === playlist.id ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-btn border-l-2 px-3 py-1.5 text-sm ${FOCUS} ${
            playlistId === playlist.id ? "border-fg bg-surface-2 text-fg" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          <PlaylistCover covers={playlist.covers} sizeClass="h-7 w-7" />
          <span className="truncate">{playlist.name}</span>
        </Link>
      ))}
      {creating && (
        <NewPlaylistDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => router.push(`/playlist?id=${id}`)}
        />
      )}
    </aside>
  );
}
