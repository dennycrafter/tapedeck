"use client";

/**
 * Binds the single <audio> element (SPEC 8.8) to the player store and hands
 * the store to the component tree. The element is rendered once here and is
 * never re-created across navigations: the ref just re-binds on remounts.
 */
import { createContext, useContext, type ReactNode } from "react";
import { playerStore, type PlayerStoreApi } from "@/lib/player/store";

const PlayerContext = createContext<PlayerStoreApi | null>(null);

export function usePlayer(): PlayerStoreApi {
  const store = useContext(PlayerContext);
  if (!store) throw new Error("usePlayer must be used inside PlayerProvider");
  return store;
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
