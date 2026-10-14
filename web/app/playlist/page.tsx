"use client";

/**
 * Playlist page (SPEC 8.6): 2x2 cover, name, song count, Play / Shuffle,
 * Rename and Delete (with a confirm), then the songs. Drag a song by its
 * handle to reorder (@dnd-kit: mouse, touch hold, or keyboard). The new
 * order shows at once and is saved to the server.
 */
import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLibrary } from "../components/LibraryProvider";
import { useOverlays } from "../components/Overlays";
import { useCurrentTrackId } from "../components/PlayerProvider";
import { usePlayList } from "../components/TrackList";
import { TrackRow } from "../components/TrackRow";
import { PlaylistCover } from "../components/PlaylistCover";
import { ListHeader, NotFound } from "../components/ListHeader";
import { DownloadListButton } from "../components/DownloadListButton";
import { BTN_PRIMARY, BTN_SECONDARY, ConfirmDialog, ICON_BTN, INPUT, Menu, Modal } from "../components/ui";
import { DragIcon, MoreIcon } from "../components/icons";
import { listSummary } from "../lib/library-view";
import type { TrackDto } from "../lib/api";

export default function PlaylistPage() {
  return (
    <Suspense fallback={null}>
      <Playlist />
    </Suspense>
  );
}

function Playlist() {
  const id = useSearchParams().get("id") ?? "";
  const library = useLibrary();
  const router = useRouter();
  const { showToast } = useOverlays();
  const playlist = library.playlists.find((candidate) => candidate.id === id);
  const play = usePlayList(playlist?.tracks ?? []);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  if (!library.library) return null;
  if (!playlist) return <NotFound text="This playlist doesn't exist anymore." />;

  return (
    <main className="flex flex-col gap-6 pt-2" data-testid="playlist-page">
      <ListHeader
        kind="Playlist"
        title={playlist.name}
        titleTestId="playlist-name"
        summary={listSummary(playlist.tracks)}
        art={<PlaylistCover covers={playlist.covers} sizeClass="aspect-square w-full h-auto" />}
        canPlay={playlist.tracks.some((track) => track.status === "ready")}
        onPlay={() => play(null)}
        onShuffle={() => play(null, true)}
        actions={
          <>
            <DownloadListButton tracks={playlist.tracks} />
            <button
              ref={anchor}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Playlist options"
              aria-haspopup="menu"
              data-testid="playlist-options"
              className={ICON_BTN}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <Menu
                anchor={anchor}
                label="Playlist options"
                testId="playlist-menu"
                onClose={() => setMenuOpen(false)}
                items={[
                  { label: "Rename", testId: "playlist-rename", onSelect: () => setDialog("rename") },
                  { label: "Delete playlist", testId: "playlist-delete", danger: true, onSelect: () => setDialog("delete") },
                ]}
              />
            )}
          </>
        }
      />

      {playlist.tracks.length === 0 ? (
        <p className="rounded-box border border-line bg-surface p-6 text-center text-sm text-muted">
          No songs yet. Use &quot;Add to playlist&quot; in any song&apos;s menu.
        </p>
      ) : (
        <SortableTracks playlistId={playlist.id} tracks={playlist.tracks} onPlay={(track) => play(track)} />
      )}

      {dialog === "rename" && (
        <RenameDialog
          initial={playlist.name}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await library.renamePlaylist(playlist.id, name);
            showToast("Playlist renamed");
          }}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete playlist?"
          body={`"${playlist.name}" will be deleted. The songs stay in your library.`}
          confirmLabel="Delete playlist"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await library.deletePlaylist(playlist.id);
            showToast("Playlist deleted");
            router.push("/library?tab=playlists");
          }}
        />
      )}
    </main>
  );
}

function SortableTracks({
  playlistId,
  tracks,
  onPlay,
}: {
  playlistId: string;
  tracks: TrackDto[];
  onPlay(track: TrackDto): void;
}) {
  const library = useLibrary();
  const { showToast } = useOverlays();
  const currentId = useCurrentTrackId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = tracks.map((track) => track.id);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    library.reorderPlaylist(playlistId, arrayMove(ids, from, to)).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-line rounded-box border border-line bg-surface" data-testid="playlist-tracks">
          {tracks.map((track) => (
            <SortableRow
              key={track.id}
              track={track}
              playlistId={playlistId}
              current={currentId === track.id}
              onPlay={onPlay}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  track,
  playlistId,
  current,
  onPlay,
}: {
  track: TrackDto;
  playlistId: string;
  current: boolean;
  onPlay(track: TrackDto): void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 bg-surface-2 shadow-[0_6px_16px_rgba(0,0,0,0.3)]" : ""}
    >
      <TrackRow
        track={track}
        current={current}
        onPlay={onPlay}
        playlistId={playlistId}
        leading={
          <button
            type="button"
            aria-label={`Reorder ${track.title}`}
            data-testid="drag-handle"
            className={`${ICON_BTN} ml-1 cursor-grab touch-none`}
            {...attributes}
            {...listeners}
          >
            <DragIcon width={16} height={16} />
          </button>
        }
      />
    </li>
  );
}

function RenameDialog({ initial, onClose, onSave }: { initial: string; onClose(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Rename playlist" onClose={onClose} testId="rename-dialog">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          try {
            await onSave(name.trim());
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Playlist name"
          maxLength={100}
          data-testid="rename-input"
          className={INPUT}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-bad">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={BTN_PRIMARY} data-testid="rename-save">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
