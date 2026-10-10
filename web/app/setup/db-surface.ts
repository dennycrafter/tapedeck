import type { DbExecutor } from "@/lib/db";
import type { SetupDb } from "../api/setup/finish/finish";

/**
 * The bridge between the Setup flow and the sibling-owned database adapter
 * (`web/lib/db.ts` — SPEC 4.1). Importing is safe: the adapter connects
 * lazily on first use, so the Setup page always renders and a missing or
 * wrong configuration surfaces as a failed check, never a crash.
 */

/**
 * True when the `settings` table exists — the marker of a finished setup
 * (SPEC 7.2: "it skips when `settings` exists"). No table yet, so this runs
 * before the schema and must not assume it. Throws when the database is
 * unreachable or unconfigured; callers catch and treat as "not finished".
 */
export async function settingsTableExists(db: DbExecutor): Promise<boolean> {
  const rows = await db`select to_regclass('public.settings') as reg`;
  return rows.length > 0 && (rows[0]?.reg as string | null | undefined) != null;
}

/** Build the SetupDb Finish setup runs on, over the shared `sql` handle. */
export function toSetupDb(db: DbExecutor): SetupDb {
  return {
    settingsExists: () => settingsTableExists(db),

    // DbExecutor.exec runs a multi-statement SQL script (its documented use
    // is schema bootstrap), so the schema file goes through as one call.
    applySchema: (schemaSql) => db.exec(schemaSql),

    ping: async () => {
      const rows = await db`select 1 from settings limit 1`;
      if (rows.length !== 1) throw new Error("the settings row is missing");
    },
  };
}
