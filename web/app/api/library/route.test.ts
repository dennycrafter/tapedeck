// Unit tests for GET /api/library (SPEC 8.8 basics, 8.3 header snapshot):
// newest-first ordering with the fields the rows render, and the downloader
// snapshot (agent_last_seen → lastSeenAt, waiting count).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, sql } from "../../../lib/db";
import { GET } from "./route";

// In-memory PGlite (TAPEDECK_TEST=1) so the route tests never touch .data/.
beforeEach(async () => {
  vi.stubEnv("TAPEDECK_TEST", "1");
  await resetDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertTrack(overrides: {
  sourceId: string;
  title?: string;
  status?: string;
  hoursAgo?: number;
}): Promise<void> {
  const sourceId = overrides.sourceId;
  const title = overrides.title ?? `Song ${sourceId}`;
  const status = overrides.status ?? "waiting";
  const hoursAgo = overrides.hoursAgo ?? 0;
  await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, artist, status, created_at)
    values (${"youtube"}, ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, ${title}, ${title},
            ${"jawed"}, ${status}, now() - make_interval(hours => ${hoursAgo}))
  `;
}

describe("GET /api/library", () => {
  it("lists every track newest first with the fields the rows render", async () => {
    await insertTrack({ sourceId: "aaaaaaaaaaa", title: "Older song", hoursAgo: 2 });
    await insertTrack({ sourceId: "bbbbbbbbbbb", title: "Newest song", status: "ready" });
    await insertTrack({ sourceId: "ccccccccccc", title: "Middle song", status: "failed" });

    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tracks: {
        id: string;
        source: string;
        sourceUrl: string;
        title: string;
        artist: string;
        album: string | null;
        coverUrl: string | null;
        durationSec: number | null;
        status: string;
        error: string;
        createdAt: string;
      }[];
    };

    expect(body.tracks.map((track) => track.title)).toEqual(["Middle song", "Newest song", "Older song"]);
    const newest = body.tracks[1];
    expect(newest.source).toBe("youtube");
    expect(newest.sourceUrl).toBe("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    expect(newest.artist).toBe("jawed");
    expect(newest.album).toBeNull();
    expect(newest.coverUrl).toBeNull();
    expect(newest.durationSec).toBeNull();
    expect(newest.status).toBe("ready");
    expect(newest.error).toBe("");
    expect(Number.isNaN(Date.parse(newest.createdAt))).toBe(false);
  });

  it("reports the downloader snapshot: last seen and waiting count", async () => {
    await insertTrack({ sourceId: "aaaaaaaaaaa" });
    await insertTrack({ sourceId: "bbbbbbbbbbb" });
    await insertTrack({ sourceId: "ccccccccccc", status: "downloading" });

    const before = await GET();
    expect(before.status).toBe(200);
    const empty = (await before.json()) as { downloader: { lastSeenAt: string | null; waitingCount: number } };
    expect(empty.downloader.lastSeenAt).toBeNull();
    expect(empty.downloader.waitingCount).toBe(2);

    await sql`update settings set agent_last_seen = now() where id = 1`;
    const after = await GET();
    const seen = (await after.json()) as { downloader: { lastSeenAt: string | null; waitingCount: number } };
    expect(seen.downloader.waitingCount).toBe(2);
    expect(seen.downloader.lastSeenAt).not.toBeNull();
    expect(Math.abs(Date.parse(seen.downloader.lastSeenAt as string) - Date.now())).toBeLessThan(60_000);
  });
});
