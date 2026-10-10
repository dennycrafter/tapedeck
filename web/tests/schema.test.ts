import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Schema smoke test (SPEC 9.0): the real supabase/schema.sql must apply
// cleanly to PGlite, the local stand-in driver (SPEC 4.1), with its seed
// row and column defaults intact. The same file runs on Supabase at go
// live (SPEC 5.3), so any drift between the two shows up here first.

const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("../../supabase/schema.sql", import.meta.url)),
  "utf8",
);

// The 7 tables from SPEC 6, asserted by name so a dropped or extra table
// fails loudly rather than just miscounting.
const SPEC_TABLES = [
  "album_favorites",
  "play_events",
  "playlist_tracks",
  "playlists",
  "search_cache",
  "settings",
  "tracks",
];

describe("supabase/schema.sql on PGlite", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SCHEMA_SQL);
  });

  it("creates exactly the 7 tables", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual(SPEC_TABLES);
  });

  it("seeds the single settings row with the SPEC 6 defaults", async () => {
    const { rows } = await db.query<{
      id: number;
      display_name: string;
      apple_music_export: boolean;
      agent_last_seen: string | null;
      agent_version: string;
    }>(
      "select id, display_name, apple_music_export, agent_last_seen, agent_version from settings",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      display_name: "Denis",
      apple_music_export: false,
      agent_last_seen: null,
      agent_version: "",
    });
  });

  it("applies the waiting/0/liked-false defaults on a fresh track insert", async () => {
    const { rows } = await db.query<{ status: string; attempts: number; liked: boolean }>(
      `insert into tracks (source, source_id, source_url, raw_title, title)
       values ('youtube', 'jNQXAC9IVRw', 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
               'Me at the zoo', 'Me at the zoo')
       returning status, attempts, liked`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ status: "waiting", attempts: 0, liked: false });
  });
});
