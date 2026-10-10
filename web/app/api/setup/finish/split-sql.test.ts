import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { splitStatements } from "./split-sql";
import { SCHEMA_SQL } from "./schema-sql";

// The embedded copy Finish setup ships to Vercel must be byte-identical to
// supabase/schema.sql — the file stays the single source of truth (SPEC 6).
describe("schema-sql.ts", () => {
  it("matches supabase/schema.sql exactly", () => {
    const fileSql = readFileSync(
      fileURLToPath(new URL("../../../../../supabase/schema.sql", import.meta.url)),
      "utf8",
    );
    expect(SCHEMA_SQL).toBe(fileSql);
  });
});

describe("splitStatements on supabase/schema.sql", () => {
  const statements = splitStatements(SCHEMA_SQL);
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Apply the schema the same way the production route does: one split
    // statement at a time (postgres.js rejects multi-statement strings).
    for (const statement of statements) {
      await db.exec(statement);
    }
  });

  it("produces exactly the schema's 10 top-level statements", () => {
    expect(statements).toHaveLength(10);
    for (const statement of statements) {
      expect(statement.startsWith(";")).toBe(false);
      expect(statement.endsWith(";")).toBe(false);
    }
  });

  it("keeps the dollar-quoted do block intact as one statement", () => {
    // The statement carries its leading -- comment lines, hence includes.
    const doBlocks = statements.filter((statement) => statement.includes("do $$"));
    expect(doBlocks).toHaveLength(1);
    expect(doBlocks[0].endsWith("end $$")).toBe(true);
  });

  it("applies cleanly: all 7 tables exist", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual([
      "album_favorites",
      "play_events",
      "playlist_tracks",
      "playlists",
      "search_cache",
      "settings",
      "tracks",
    ]);
  });

  it("applies cleanly: the settings seed row is present", async () => {
    const { rows } = await db.query<{ id: number; display_name: string }>(
      "select id, display_name from settings",
    );
    expect(rows).toEqual([{ id: 1, display_name: "Denis" }]);
  });
});

describe("splitStatements edge cases", () => {
  it("does not split on semicolons inside strings, comments or dollar quotes", () => {
    const sqlText = [
      "insert into t values ('a;b');",
      "-- a comment; with a semicolon\nselect 1;",
      "do $$ begin\n  perform 1;\nend $$;",
      "select 'it''s; fine' as x;",
    ].join("\n");
    expect(splitStatements(sqlText)).toEqual([
      "insert into t values ('a;b')",
      "-- a comment; with a semicolon\nselect 1",
      "do $$ begin\n  perform 1;\nend $$",
      "select 'it''s; fine' as x",
    ]);
  });
});
