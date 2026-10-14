"use client";

/**
 * Inbox-style list of songs (SPEC 10): one box, thin dividers. Tapping a
 * ready song plays this list from that song (SPEC 8.8).
 */
import { useCallback } from "react";
import type { TrackDto } from "../lib/api";
import { queueFrom } from "../lib/library-view";
import { useCurrentTrackId, usePlayer } from "./PlayerProvider";
import { useOffline } from "./useOffline";
import { canPlayNow } from "../lib/offline";
import { TrackRow } from "./TrackRow";

interface TrackListProps {
  tracks: readonly TrackDto[];
  testId?: string;
  playlistId?: string;
  /** Play order when it differs from the shown order. */
  queue?: readonly TrackDto[];
}

export function usePlayList(list: readonly TrackDto[]) {
  const player = usePlayer();
  const offline = useOffline();
  return useCallback(
    (start: TrackDto | null, shuffle = false) => {
      const queue = queueFrom(list, start, (track) => canPlayNow(track, offline));
      if (!queue) return;
      if (shuffle) {
        // Shuffle play: shuffle on, start from a random ready song. Plain
        // play keeps whatever shuffle setting the owner chose.
        if (!player.getState().shuffle) player.toggleShuffle();
        queue.index = Math.floor(Math.random() * queue.tracks.length);
      }
      player.playTracks(queue.tracks, queue.index);
    },
    [list, player, offline],
  );
}

export function TrackList({ tracks, testId = "track-list", playlistId, queue }: TrackListProps) {
  const currentId = useCurrentTrackId();
  const play = usePlayList(queue ?? tracks);
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-surface" data-testid={testId}>
      {tracks.map((track) => (
        <li key={track.id}>
          <TrackRow track={track} onPlay={(t) => play(t)} current={currentId === track.id} playlistId={playlistId} />
        </li>
      ))}
    </ul>
  );
}
