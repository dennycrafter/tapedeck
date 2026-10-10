import type { ServiceCheck, SetupDb } from "./finish";

/** Storage surface Finish setup needs (implemented over `web/lib/storage.ts`). */
interface SetupStorage {
  setCors(): Promise<void>;
}

/**
 * The service checks Finish setup runs (SPEC 8.12: "checks every service
 * like /api/health"). Probes mirror T0 step 6: database (select settings),
 * storage (setCors / PutBucketCors), youtube (videos.list, 1 unit),
 * soundcloud (oEmbed), anthropic (GET /v1/models), itunes and deezer (one
 * search each). Unset keys return NOT_SET, never an error.
 *
 * `fetchJson` is injected: `route.ts` passes the shared `httpJson` wrapper
 * (web/lib/http.ts) so timeouts stay uniform and MSW can intercept these
 * calls in tests (SPEC 4.1, 9.0).
 */
export type FetchJson = <T>(
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<T>;

export const YOUTUBE_PROBE_VIDEO_ID = "jNQXAC9IVRw";
const SOUNDCLOUD_PROBE_TRACK = "https://soundcloud.com/forss/flickermood";
const PROBE_SEARCH_TERM = "daft punk get lucky";

export function databaseCheck(db: SetupDb): ServiceCheck {
  return {
    name: "database",
    required: true,
    run: async () => {
      await db.ping();
      return {
        name: "database",
        status: "OK",
        detail: "Connected; the settings table is in place.",
      };
    },
  };
}

export function storageCheck(storage: SetupStorage): ServiceCheck {
  return {
    name: "storage",
    required: true,
    run: async () => {
      // PutBucketCors doubles as the bucket check: it only succeeds with
      // working credentials and an existing bucket (SPEC 7.2).
      await storage.setCors();
      return {
        name: "storage",
        status: "OK",
        detail: "Bucket reachable; CORS rules applied.",
      };
    },
  };
}

export function youtubeCheck(
  apiKey: string | undefined,
  fetchJson: FetchJson,
): ServiceCheck {
  return {
    name: "youtube",
    required: false,
    run: async () => {
      if (!apiKey) {
        return {
          name: "youtube",
          status: "NOT_SET",
          detail: "Search stays off until YOUTUBE_API_KEY is set (optional).",
        };
      }
      await fetchJson<{ items?: unknown[] }>(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${YOUTUBE_PROBE_VIDEO_ID}&key=${encodeURIComponent(apiKey)}`,
      );
      return {
        name: "youtube",
        status: "OK",
        detail: "The YouTube Data API answered the test call.",
      };
    },
  };
}

export function soundcloudCheck(fetchJson: FetchJson): ServiceCheck {
  return {
    name: "soundcloud",
    required: false,
    run: async () => {
      const data = await fetchJson<{ title?: string }>(
        `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(SOUNDCLOUD_PROBE_TRACK)}`,
      );
      if (!data.title) throw new Error("The oEmbed response had no title.");
      return {
        name: "soundcloud",
        status: "OK",
        detail: "SoundCloud oEmbed answered the test call.",
      };
    },
  };
}

export function anthropicCheck(
  apiKey: string | undefined,
  fetchJson: FetchJson,
): ServiceCheck {
  return {
    name: "anthropic",
    required: false,
    run: async () => {
      if (!apiKey) {
        return {
          name: "anthropic",
          status: "NOT_SET",
          detail: "AI title cleanup stays rule-based until ANTHROPIC_API_KEY is set (optional).",
        };
      }
      await fetchJson<unknown>("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      return {
        name: "anthropic",
        status: "OK",
        detail: "The Anthropic API answered the test call.",
      };
    },
  };
}

export function itunesCheck(fetchJson: FetchJson): ServiceCheck {
  return {
    name: "itunes",
    required: false,
    run: async () => {
      await fetchJson<unknown>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(PROBE_SEARCH_TERM)}&entity=song&limit=5&country=US`,
      );
      return {
        name: "itunes",
        status: "OK",
        detail: "The iTunes Search API answered the test call.",
      };
    },
  };
}

export function deezerCheck(fetchJson: FetchJson): ServiceCheck {
  return {
    name: "deezer",
    required: false,
    run: async () => {
      await fetchJson<unknown>(
        `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"Daft Punk" track:"Get Lucky"`)}&limit=5`,
      );
      return {
        name: "deezer",
        status: "OK",
        detail: "The Deezer API answered the test call.",
      };
    },
  };
}
