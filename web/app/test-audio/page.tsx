"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  OFFLINE_TEST1_KEY,
  TONES,
  clampSeekTime,
  formatBytes,
  isPositionUpdateDue,
  mediaSessionPayload,
  nextIndex,
  playbackState,
  previousAction,
} from "./tones";
import { getOfflineAudio, requestStoragePersistence, saveOfflineAudio } from "./offline-store";
import styles from "./test-audio.module.css";

type Mode = "idle" | "network" | "offline";
type SaveState = "idle" | "saving" | "saved" | "error";

const MEDIA_SESSION_ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Client-only capability: the server snapshot (true) keeps the hydration output
// stable; the note re-renders client-side when Media Session is missing.
function subscribeNoop() {
  return () => {};
}

function getMediaSessionSupported() {
  return "mediaSession" in navigator;
}

export default function TestAudioPage() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const modeRef = useRef<Mode>("idle");
  const queueIndexRef = useRef(-1);
  const objectUrlRef = useRef<string | null>(null);
  const lastPositionUpdateRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [status, setStatus] = useState("Play runs test tone 1, then test tone 2 starts by itself.");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hasOfflineCopy, setHasOfflineCopy] = useState(false);

  const mediaSessionSupported = useSyncExternalStore(subscribeNoop, getMediaSessionSupported, () => true);

  // Surface an existing offline copy on load so the owner sees it before tapping.
  useEffect(() => {
    let cancelled = false;
    getOfflineAudio(OFFLINE_TEST1_KEY)
      .then((record) => {
        if (!cancelled && record) setHasOfflineCopy(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(`Could not check the offline copy: ${errorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const playAudio = useCallback((audio: HTMLAudioElement) => {
    audio.play().catch((error: unknown) => {
      setStatus(`Playback did not start: ${errorText(error)}`);
    });
  }, []);

  // 8.9: revoke the previous object URL on track change.
  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  /**
   * Loads the tone at queue index and starts it. Synchronous up to play():
   * the ended handler must not await anything or the iPhone background
   * auto-advance breaks (SPEC 8.8 and gotchas).
   */
  const playToneAt = useCallback(
    (index: number) => {
      const audio = audioRef.current;
      const tone = TONES[index];
      if (!audio || !tone) return;
      releaseObjectUrl();
      modeRef.current = "network";
      queueIndexRef.current = index;
      audio.src = tone.src;
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata(mediaSessionPayload(tone));
      }
      setCurrentTitle(tone.title);
      setStatus(`Playing ${tone.title} from the network copy.`);
      playAudio(audio);
    },
    [playAudio, releaseObjectUrl],
  );

  const finish = useCallback(
    (message: string) => {
      modeRef.current = "idle";
      queueIndexRef.current = -1;
      setPlaying(false);
      setCurrentTitle(null);
      setStatus(message);
    },
    [],
  );

  /** Auto-advance (8.8): set the next src and play() in the same tick. */
  const advance = useCallback(() => {
    const next = nextIndex(queueIndexRef.current);
    if (next === null) {
      finish("Queue finished. Test tone 2 was the last tone.");
      return;
    }
    playToneAt(next);
  }, [finish, playToneAt]);

  const restartTone = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    playAudio(audio);
  }, [playAudio]);

  /** SPEC 8.8 previous rule, also used from the lock screen. */
  const goToPrevious = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const action = previousAction(
      audio.currentTime,
      modeRef.current === "network" ? queueIndexRef.current : -1,
    );
    if (action.kind === "previous") {
      playToneAt(action.index);
      return;
    }
    restartTone();
  }, [playToneAt, restartTone]);

  const seekToSeconds = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = clampSeekTime(audio.currentTime, seconds - audio.currentTime, audio.duration);
  }, []);

  const seekBy = useCallback((deltaSeconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = clampSeekTime(audio.currentTime, deltaSeconds, audio.duration);
  }, []);

  // 8.8: Media Session handlers, registered once (play, pause, previous, next,
  // seekto, and 10 s backward/forward).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const mediaSession = navigator.mediaSession;
    mediaSession.setActionHandler("play", () => {
      const audio = audioRef.current;
      if (audio) playAudio(audio);
    });
    mediaSession.setActionHandler("pause", () => {
      audioRef.current?.pause();
    });
    mediaSession.setActionHandler("previoustrack", () => goToPrevious());
    mediaSession.setActionHandler("nexttrack", () => advance());
    mediaSession.setActionHandler("seekto", (details) => {
      if (details.action !== "seekto") return;
      const seekTime = details.seekTime;
      if (seekTime == null) return;
      seekToSeconds(seekTime);
    });
    mediaSession.setActionHandler("seekbackward", (details) => {
      if (details.action !== "seekbackward") return;
      seekBy(-(details.seekOffset ?? 10));
    });
    mediaSession.setActionHandler("seekforward", (details) => {
      if (details.action !== "seekforward") return;
      seekBy(details.seekOffset ?? 10);
    });
    return () => {
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // Clearing handlers during teardown can be rejected by the engine; nothing to recover.
        }
      }
    };
  }, [advance, goToPrevious, playAudio, seekBy, seekToSeconds]);

  // 8.8: setPositionState on timeupdate, throttled to 1/s.
  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !("mediaSession" in navigator)) return;
    const now = Date.now();
    if (!isPositionUpdateDue(lastPositionUpdateRef.current, now)) return;
    lastPositionUpdateRef.current = now;
    const state = playbackState(audio);
    if (state) navigator.mediaSession.setPositionState(state);
  }, []);

  const handleEnded = useCallback(() => {
    if (modeRef.current === "offline") {
      finish("Offline copy finished.");
      return;
    }
    if (modeRef.current === "network") {
      advance();
      return;
    }
    finish("Playback finished.");
  }, [advance, finish]);

  const saveTest1Offline = useCallback(async () => {
    const tone = TONES[0];
    setSaveState("saving");
    try {
      // 8.9: ask for persistent storage on the first download.
      await requestStoragePersistence();
      const response = await fetch(tone.src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const record = await saveOfflineAudio(OFFLINE_TEST1_KEY, blob);
      setHasOfflineCopy(true);
      setSaveState("saved");
      setStatus(
        `Saved ${tone.title} offline (${formatBytes(record.bytes)}). It plays with no network.`,
      );
    } catch (error) {
      setSaveState("error");
      setStatus(`Could not save the offline copy: ${errorText(error)}`);
    }
  }, []);

  const playOfflineCopy = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const record = await getOfflineAudio(OFFLINE_TEST1_KEY);
      if (!record) {
        setHasOfflineCopy(false);
        setStatus("No offline copy yet. Save test1 offline first.");
        return;
      }
      releaseObjectUrl();
      const url = URL.createObjectURL(record.blob);
      objectUrlRef.current = url;
      modeRef.current = "offline";
      queueIndexRef.current = -1;
      audio.src = url;
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata(mediaSessionPayload(TONES[0]));
      }
      setCurrentTitle(TONES[0].title);
      setStatus(`Playing the offline copy of ${TONES[0].title} (${formatBytes(record.bytes)}).`);
      playAudio(audio);
    } catch (error) {
      setStatus(`Could not play the offline copy: ${errorText(error)}`);
    }
  }, [playAudio, releaseObjectUrl]);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.heading}>Test audio</h1>
        <p className={styles.intro}>
          Two three-minute test tones for checking playback on this device: automatic next track,
          lock screen controls, and an offline copy in IndexedDB.
        </p>

        <section className={styles.queue} aria-label="Test tones">
          {TONES.map((tone) => (
            <div key={tone.id} className={styles.row}>
              <span className={styles.rowTitle}>{tone.title}</span>
              <span className={styles.rowDetail}>{tone.frequencyHz} Hz tone</span>
            </div>
          ))}
        </section>

        <div className={styles.buttonList}>
          <button
            type="button"
            className={styles.playButton}
            onClick={() => playToneAt(0)}
            data-testid="play-button"
          >
            Play
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void saveTest1Offline()}
            disabled={saveState === "saving"}
            data-testid="save-offline-button"
          >
            {saveState === "saving" ? "Saving..." : "Save test1 offline"}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void playOfflineCopy()}
            disabled={!hasOfflineCopy}
            data-testid="play-offline-button"
          >
            Play offline copy
          </button>
        </div>

        <p className={styles.nowPlaying} data-testid="now-playing">
          {currentTitle
            ? `${playing ? "Playing" : "Paused"}: ${currentTitle}`
            : "Nothing playing"}
        </p>
        <p className={styles.status} data-testid="status">
          {status}
        </p>
        {!mediaSessionSupported && (
          <p className={styles.note}>
            Media Session is not supported in this browser; playback still works.
          </p>
        )}
        {!hasOfflineCopy && (
          <p className={styles.note}>Play offline copy becomes available after saving test1.</p>
        )}

        <audio
          ref={audioRef}
          preload="auto"
          playsInline
          onEnded={handleEnded}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setStatus("Audio error: the source did not load.")}
          data-testid="test-audio-player"
        />
      </div>
    </main>
  );
}
