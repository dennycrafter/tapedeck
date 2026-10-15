import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor } from "../../../../lib/db";
import { applyMigrations } from "../../../../lib/migrations";
import { runFinish, type SetupDb } from "./finish";
import { SCHEMA_SQL } from "./schema-sql";
import { databaseCheck, storageCheck, youtubeCheck, type FetchJson } from "./services";
import { splitStatements } from "./split-sql";

// VERIFIED DONE for T0c-w4 (SPEC 8.12, T0 step 4): run the real Finish-setup
// orchestration against a real in-memory PGlite with the real
// supabase/schema.sql: schema applied, the real password enforced (the dev
// default no longer works), and a second call rejected once setup completed.

const REAL_PASSWORD = "correct-horse-battery-staple";
const DEV_DEFAULT_PASSWORD = "tapedeck-dev";

/** SetupDb over PGlite, applying the schema exactly like production does:
 * split into single statements, executed one by one. */
function pgliteDb(db: PGlite): SetupDb {
  return {
    settingsExists: async () => {
      const { rows } = await db.query<{ reg: string | null }>(
        "select to_regclass('public.settings') as reg",
      );
      return rows.length > 0 && rows[0].reg != null;
    },
    applySchema: async (schemaSql) => {
      for (const statement of splitStatements(schemaSql)) {
        await db.exec(statement);
      }
    },
    applyMigrations: () => applyMigrations(pgliteExecutor(db)),
    ping: async () => {
      const { rows } = await db.query("select 1 from settings limit 1");
      if (rows.length !== 1) throw new Error("the settings row is missing");
    },
  };
}

// Never called (the youtube check short-circuits without a key). Throws if it
// ever is: Promise<never> satisfies FetchJson's generic return type.
const noopFetchJson: FetchJson = async () => {
  throw new Error("youtubeCheck ran a probe without an API key");
};

/** The exact check list the route builds, with the R2 driver faked out. */
function routeChecks(db: SetupDb, setCorsCalls: string[]) {
  return [
    databaseCheck(db),
    storageCheck({
      setCors: async () => {
        setCorsCalls.push("PutBucketCors");
      },
    }),
    youtubeCheck(undefined, noopFetchJson),
  ];
}

async function tableNames(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  return rows.map((row) => row.tablename);
}

describe("runFinish against PGlite", () => {
  let db: PGlite;
  let setupDb: SetupDb;
  let setCorsCalls: string[];

  beforeAll(() => {
    db = new PGlite();
    setupDb = pgliteDb(db);
  });

  it("applies the schema and reports success", async () => {
    setCorsCalls = [];

    const outcome = await runFinish({
      password: REAL_PASSWORD,
      env: { appPassword: REAL_PASSWORD },
      db: setupDb,
      checks: routeChecks(setupDb, setCorsCalls),
      schemaSql: SCHEMA_SQL,
    });

    expect(outcome).toEqual({
      ok: true,
      rejected: null,
      schemaApplied: true,
      services: [
        { name: "database", status: "OK", detail: expect.any(String) },
        { name: "storage", status: "OK", detail: expect.any(String) },
        {
          name: "youtube",
          status: "NOT_SET",
          detail: "Search stays off until YOUTUBE_API_KEY is set (optional).",
        },
      ],
    });
    expect(setCorsCalls).toHaveLength(1);

    // The schema is really in: all 7 tables plus the seeded settings row.
    expect(await tableNames(db)).toEqual([
      "album_favorites",
      "play_events",
      "playlist_tracks",
      "playlists",
      "schema_migrations",
      "search_cache",
      "settings",
      "tracks",
    ]);
    const { rows } = await db.query<{ id: number }>("select id from settings");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("applied the v2 migrations after the schema (V2-PLAN T9)", async () => {
    const { rows } = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((row) => row.name)).toContain("t09_v2_foundation.sql");
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'tracks'",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["isrc", "match_info", "trim_start_sec", "playback_rate", "preserve_pitch"]),
    );
  });

  it("rejects the dev default once the real password is set", async () => {
    const outcome = await runFinish({
      password: DEV_DEFAULT_PASSWORD,
      env: { appPassword: REAL_PASSWORD },
      db: setupDb,
      checks: [],
      schemaSql: SCHEMA_SQL,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.rejected).toBe("password");
    // Nothing ran: no tables were created by the rejected call.
    expect(outcome.schemaApplied).toBe(false);
  });

  it("rejects the second call after setup completes", async () => {
    setCorsCalls = [];
    const corsCallsBefore = setCorsCalls.length;

    const outcome = await runFinish({
      password: REAL_PASSWORD,
      env: { appPassword: REAL_PASSWORD },
      db: setupDb,
      checks: routeChecks(setupDb, setCorsCalls),
      schemaSql: SCHEMA_SQL,
    });

    expect(outcome.rejected).toBe("already-finished");
    expect(outcome.ok).toBe(false);
    // The schema was NOT applied again (it already existed).
    expect(outcome.schemaApplied).toBe(false);
    // Every service was still verified before refusing.
    expect(outcome.services.map((service) => service.status)).not.toContain("ERROR");
    expect(setCorsCalls.length).toBeGreaterThan(corsCallsBefore);
  });

  it("reports optional-service failures without blocking, then a retry confirms completion", async () => {
    const retryDb = pgliteDb(new PGlite());
    let deezerUp = false;
    const checks = () => [
      databaseCheck(retryDb),
      storageCheck({ setCors: async () => {} }),
      {
        name: "deezer",
        required: false,
        run: async () => {
          if (!deezerUp) throw new Error("Deezer is down right now.");
          return { name: "deezer", status: "OK" as const, detail: "answered" };
        },
      },
    ];

    // Deezer is down, but it is optional: required services pass, the schema
    // and CORS run, and the outcome stays ok. The page shows the warning
    // with a Continue-to-login link instead of blocking go-live.
    const first = await runFinish({
      password: REAL_PASSWORD,
      env: { appPassword: REAL_PASSWORD },
      db: retryDb,
      checks: checks(),
      schemaSql: SCHEMA_SQL,
    });
    expect(first.ok).toBe(true);
    expect(first.rejected).toBeNull();
    expect(first.schemaApplied).toBe(true);
    expect(first.services).toContainEqual({
      name: "deezer",
      status: "ERROR",
      detail: "Deezer is down right now.",
    });

    // A later retry (after the service recovered) hits the already-finished
    // guard: setup is done and the page offers the login link.
    deezerUp = true;
    const second = await runFinish({
      password: REAL_PASSWORD,
      env: { appPassword: REAL_PASSWORD },
      db: retryDb,
      checks: checks(),
      schemaSql: SCHEMA_SQL,
    });
    expect(second.ok).toBe(false);
    expect(second.rejected).toBe("already-finished");
  });

  it("refuses to run without APP_PASSWORD set", async () => {
    const outcome = await runFinish({
      password: REAL_PASSWORD,
      env: {},
      db: setupDb,
      checks: [],
      schemaSql: SCHEMA_SQL,
    });
    expect(outcome.rejected).toBe("config");
    expect(outcome.ok).toBe(false);
  });
});
