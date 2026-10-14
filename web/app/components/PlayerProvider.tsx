"use client";

/**
 * Binds the single <audio> element (SPEC 8.8) to the player store and hands
 * the store to the component tree. The element is rendered once here and is
 * never re-created across navigations: the ref just re-binds on remounts.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { playerStore, type PlayerState, type PlayerStoreApi } from "@/lib/player/store";

const PlayerContext = createContext<PlayerStoreApi | null>(null);

export function usePlayer(): PlayerStoreApi {
  const store = useContext(PlayerContext);
  if (!store) throw new Error("usePlayer must be used inside PlayerProvider");
  return store;
}

/** The player state, re-rendering on every change. */
export function usePlayerState(): PlayerState {
  const player = usePlayer();
  return useSyncExternalStore(player.subscribe, player.getState, player.getState);
}

/** Only the current track id, so long lists re-render on track changes, not every tick. */
export function useCurrentTrackId(): string | null {
  const player = usePlayer();
  const read = () => {
    const state = player.getState();
    return state.index >= 0 ? (state.queue[state.index]?.id ?? null) : null;
  };
  return useSyncExternalStore(player.subscribe, read, () => null);
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  return (
    <PlayerContext.Provider value={playerStore}>
      {children}
      <audio
        id="tapedeck-audio"
        data-testid="app-audio"
        preload="auto"
        // iPhone needs playsinline so playback never hijacks the screen (SPEC 8.8).
        playsInline
        ref={(element) => {
          playerStore.attachAudio(element);
        }}
      />
    </PlayerContext.Provider>
  );
}
