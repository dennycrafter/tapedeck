"use client";

/**
 * Queue view (SPEC 8.8): the song playing now, then what plays next. Drag
 * to reorder (@dnd-kit, mouse, touch and keyboard), remove with the X, tap a
 * song to jump to it. A side panel on desktop, a full sheet on phones.
 */
import { createPortal } from "react-dom";
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
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { usePlayer, usePlayerState } from "./PlayerProvider";
import { Cover } from "./Cover";
import { CloseIcon, DragIcon } from "./icons";
import { ICON_BTN, POPUP, useEscape } from "./ui";
import type { PlayerTrack } from "@/lib/player/store";

interface Entry {
  key: string;
  position: number;
  track: PlayerTrack;
}

export function QueuePanel({ onClose }: { onClose(): void }) {
  const player = usePlayer();
  const state = usePlayerState();
  useEscape(onClose);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const current = state.index >= 0 ? state.queue[state.index] : undefined;
  const upcoming: Entry[] = state.queue
    .map((track, position) => ({ key: `${position}:${track.id}`, position, track }))
    .filter((entry) => entry.position > state.index);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = upcoming.find((entry) => entry.key === active.id)?.position;
    const to = upcoming.find((entry) => entry.key === over.id)?.position;
    if (from != null && to != null) player.moveInQueue(from, to);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 lg:bg-transparent"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Queue"
        data-testid="queue-panel"
        className={`absolute inset-x-0 bottom-0 top-12 flex flex-col ${POPUP} rounded-b-none lg:inset-x-auto lg:bottom-[96px] lg:right-4 lg:top-4 lg:w-[380px] lg:rounded-box`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">Queue</h2>
          <button type="button" onClick={onClose} aria-label="Close queue" className={ICON_BTN}>
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
          {current && (
            <>
              <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Now playing</p>
              <div className="flex items-center gap-3 rounded-btn px-2 py-2" data-testid="queue-current">
                <Cover src={current.coverUrl} alt="" sizeClass="h-10 w-10" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{current.title}</p>
                  <p className="truncate text-sm text-muted">{current.artist}</p>
                </div>
              </div>
            </>
          )}
          <p className="px-2 pb-1.5 pt-4 text-xs font-semibold uppercase tracking-wider text-muted">Next up</p>
          {upcoming.length === 0 ? (
            <p className="px-2 text-sm text-muted">Nothing queued after this song.</p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={upcoming.map((entry) => entry.key)} strategy={verticalListSortingStrategy}>
                <ul data-testid="queue-list">
                  {upcoming.map((entry) => (
                    <QueueItem
                      key={entry.key}
                      entry={entry}
                      onJump={() => player.jumpTo(entry.position)}
                      onRemove={() => player.removeFromQueue(entry.position)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function QueueItem({ entry, onJump, onRemove }: { entry: Entry; onJump(): void; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.key });
  const playable = entry.track.status === "ready";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1 rounded-btn ${isDragging ? "relative z-10 bg-line" : ""}`}
      data-testid="queue-item"
    >
      <button
        type="button"
        aria-label={`Reorder ${entry.track.title}`}
        className={`${ICON_BTN} cursor-grab touch-none`}
        {...attributes}
        {...listeners}
      >
        <DragIcon width={16} height={16} />
      </button>
      <button
        type="button"
        onClick={onJump}
        disabled={!playable}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-btn py-1.5 text-left hover:bg-line disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-silver"
      >
        <Cover src={entry.track.coverUrl} alt="" sizeClass="h-9 w-9" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold" data-testid="queue-item-title">
            {entry.track.title}
          </span>
          <span className="block truncate text-sm text-muted">{entry.track.artist}</span>
        </span>
      </button>
      <button type="button" onClick={onRemove} aria-label={`Remove ${entry.track.title} from queue`} className={ICON_BTN}>
        <CloseIcon width={16} height={16} />
      </button>
    </li>
  );
}
