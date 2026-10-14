"use client";

import { useSyncExternalStore } from "react";
import { getServerOfflineState, offlineStore, type OfflineState } from "../lib/offline";

/** The phone's offline state (SPEC 8.9): online or not, downloads and progress. */
export function useOffline(): OfflineState {
  return useSyncExternalStore(offlineStore.subscribe, offlineStore.getState, getServerOfflineState);
}
