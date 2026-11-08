"use client";

/**
 * Upload your own songs (T15): the queue behind the Add window's Upload tab.
 * It lives above the window, so closing the window does not stop an upload;
 * reopening it shows where each file is. Files go up one at a time (kind to
 * the phone's memory and connection), each with its own progress bar, and a
 * summary toast follows when the queue is empty.
 *
 * On PC, dropping files anywhere on the page adds them too and opens the
 * Upload tab; a full-page hint shows while files are dragged over.
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
import { usePathname } from "next/navigation";
import { uploadProblem } from "../../lib/upload-rules";
import { isBarePath } from "../lib/routes";
import { summarizeUploads, UploadFailure, uploadSong, type UploadStage } from "../lib/upload";
import { UploadIcon } from "./icons";

export type UploadItemStage = "queued" | UploadStage | "added" | "already" | "error";

export interface UploadItem {
  key: string;
  fileName: string;
  /** The title from the file's tags, once read. */
  title: string | null;
  stage: UploadItemStage;
  /** 0 to 1 while uploading. */
  progress: number;
  /** The error to show when stage is "error". */
  message: string;
}

interface UploadsApi {
  items: UploadItem[];
  /** True while a file is waiting or on its way. */
  busy: boolean;
  addFiles(files: Iterable<File>): void;
  clearFinished(): void;
}

const UploadsContext = createContext<UploadsApi | null>(null);

export function useUploads(): UploadsApi {
  const api = useContext(UploadsContext);
  if (!api) throw new Error("useUploads must be used inside UploadsProvider");
  return api;
}

const FINISHED: ReadonlySet<UploadItemStage> = new Set(["added", "already", "error"]);

export function isFinished(item: UploadItem): boolean {
  return FINISHED.has(item.stage);
}

let nextKey = 0;

function errorMessage(error: unknown): string {
  if (error instanceof UploadFailure) return error.message;
  return "Upload failed. Try again.";
}

/** True when a drag carries files (not text or a link dragged inside the page). */
function draggingFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function UploadsProvider({
  children,
  openUpload,
  showToast,
  notifyLibraryChanged,
}: {
  children: ReactNode;
  openUpload(): void;
  showToast(text: string): void;
  notifyLibraryChanged(): void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<string, File>());
  const running = useRef(false);
  const counts = useRef({ added: 0, already: 0, failed: 0 });
  // The queue reads the latest list without waiting for a render.
  const itemsRef = useRef<UploadItem[]>([]);

  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    itemsRef.current = itemsRef.current.map((item) => (item.key === key ? { ...item, ...patch } : item));
    setItems(itemsRef.current);
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((item) => item.stage === "queued");
        if (!next) break;
        const file = files.current.get(next.key);
        if (!file) {
          update(next.key, { stage: "error", message: "Upload failed. Try again." });
          continue;
        }
        try {
          const outcome = await uploadSong(file, (stage, progress, title) =>
            update(next.key, { stage, progress, ...(title ? { title } : {}) }),
          );
          update(next.key, { stage: outcome.status, progress: 1, ...(outcome.title ? { title: outcome.title } : {}) });
          counts.current[outcome.status] += 1;
          if (outcome.status === "added") notifyLibraryChanged();
        } catch (error) {
          update(next.key, { stage: "error", message: errorMessage(error) });
          counts.current.failed += 1;
        } finally {
          files.current.delete(next.key);
        }
      }
    } finally {
      running.current = false;
    }
    const summary = summarizeUploads(counts.current);
    counts.current = { added: 0, already: 0, failed: 0 };
    if (summary) showToast(summary);
  }, [notifyLibraryChanged, showToast, update]);

  const addFiles = useCallback(
    (incoming: Iterable<File>) => {
      const added: UploadItem[] = [];
      for (const file of incoming) {
        const key = `upload-${++nextKey}`;
        // Wrong kind or too big: say so right away, nothing is sent.
        const problem = uploadProblem(file);
        if (problem) {
          counts.current.failed += 1;
          added.push({ key, fileName: file.name, title: null, stage: "error", progress: 0, message: problem });
          continue;
        }
        files.current.set(key, file);
        added.push({ key, fileName: file.name, title: null, stage: "queued", progress: 0, message: "" });
      }
      if (added.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...added];
      setItems(itemsRef.current);
      if (added.some((item) => item.stage === "queued")) {
        void pump();
      } else if (!running.current) {
        const summary = summarizeUploads(counts.current);
        counts.current = { added: 0, already: 0, failed: 0 };
        if (summary) showToast(summary);
      }
    },
    [pump, showToast],
  );

  const clearFinished = useCallback(() => {
    itemsRef.current = itemsRef.current.filter((item) => !isFinished(item));
    setItems(itemsRef.current);
  }, []);

  const busy = items.some((item) => !isFinished(item));

  // Leaving the page would cut an upload off: the browser asks first.
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // Drag and drop onto the page (PC). Not on the login and setup pages.
  const pathname = usePathname();
  const dropAllowed = !isBarePath(pathname);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!dropAllowed) return;
    const onEnter = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (dropped.length === 0) return;
      openUpload();
      addFiles(dropped);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      depth.current = 0;
      setDragging(false);
    };
  }, [addFiles, dropAllowed, openUpload]);

  const api = useMemo<UploadsApi>(() => ({ items, busy, addFiles, clearFinished }), [items, busy, addFiles, clearFinished]);

  return (
    <UploadsContext.Provider value={api}>
      {children}
      {dragging && (
        <div
          aria-hidden="true"
          data-testid="upload-drop-hint"
          className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
        >
          <div className="flex flex-col items-center gap-2 rounded-box border border-dashed border-muted bg-surface-2 px-10 py-8 text-center shadow-[0_6px_16px_rgba(0,0,0,0.3)]">
            <UploadIcon width={28} height={28} className="text-silver" />
            <p className="text-base font-semibold">Drop to upload</p>
            <p className="text-sm text-muted">MP3, M4A, WAV or FLAC</p>
          </div>
        </div>
      )}
    </UploadsContext.Provider>
  );
}
