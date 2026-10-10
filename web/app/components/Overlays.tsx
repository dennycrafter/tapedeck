"use client";

/**
 * App-wide overlays (SPEC 8.2, 10): the Add floating window opener, the
 * summary toast, and a library version counter that pages subscribe to so a
 * successful add or retry refetches the list (including pages under other
 * navigation stacks later).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AddWindow } from "./AddWindow";

interface OverlaysApi {
  openAdd(): void;
  showToast(text: string): void;
  /** Bump when an action changes library data so pages refetch. */
  notifyLibraryChanged(): void;
  libraryVersion: number;
}

const OverlaysContext = createContext<OverlaysApi | null>(null);

export function useOverlays(): OverlaysApi {
  const api = useContext(OverlaysContext);
  if (!api) throw new Error("useOverlays must be used inside OverlaysProvider");
  return api;
}

const TOAST_MS = 4000;

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((text: string) => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    // Clear the pending timer when the provider unmounts.
    return () => {
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const api = useMemo<OverlaysApi>(
    () => ({
      openAdd: () => setAddOpen(true),
      showToast,
      notifyLibraryChanged: () => setLibraryVersion((version) => version + 1),
      libraryVersion,
    }),
    [showToast, libraryVersion],
  );

  return (
    <OverlaysContext.Provider value={api}>
      {children}
      {addOpen && <AddWindow onClose={() => setAddOpen(false)} />}
      {toast && (
        <div
          role="status"
          data-testid="toast"
          className={
            "fixed bottom-[calc(7.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 " +
            "rounded-box border border-line bg-surface-2 px-4 py-2 text-sm shadow-[0_6px_16px_rgba(0,0,0,0.3)] lg:bottom-24"
          }
        >
          {toast}
        </div>
      )}
    </OverlaysContext.Provider>
  );
}
