/**
 * Migration runner (V2-PLAN T9). Every v2 database change is one file in
 * supabase/migrations, named `tNN_<name>.sql`; supabase/schema.sql stays as
 * the v1 base and is never edited.
 *
 * Pending files run in filename order, each once, each in its own
 * transaction, and are recorded in `schema_migrations`. A file that fails
 * rolls back completely and is not recorded, so the next start retries it.
 *
 * Where they run:
 *   - Finish setup, right after schema.sql (SetupDb.applyMigrations).
 *   - The PGlite stand-in, at startup (db.ts init).
 *   - The real database, once per server instance on first use (db.ts init
 *     is a module-level promise), only when the schema is already there.
 *
 * Two server instances starting together both take a transaction-scoped
 * advisory lock and re-check the table inside it, so a file never runs twice.
 */

import type { DbExecutor } from './db'
import { MIGRATION_FILES } from './migrations-sql'
import { splitStatements } from '../app/api/setup/finish/split-sql'

export interface Migration {
  /** The file name, for example `t09_v2_foundation.sql`. */
  name: string
  sql: string
}

/** Any fixed number works; every instance just has to use the same one. */
const MIGRATION_LOCK_KEY = 74_757_464

const CREATE_MIGRATIONS_TABLE = `create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)`

// Same rule as the end of schema.sql: every public table has RLS on (no
// policies) and, on Supabase, is granted to service_role. Re-run after
// migrations so tables they create follow it without each file repeating it.
const SECURE_TABLES = `do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on table %I to service_role', t);
    end if;
  end loop;
end $$`

/** The embedded migration files, in the order they apply. */
export function bundledMigrations(): Migration[] {
  return [...MIGRATION_FILES].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Run each statement on its own, so both drivers accept it (see split-sql.ts). */
async function runScript(db: DbExecutor, script: string): Promise<void> {
  for (const statement of splitStatements(script)) {
    await db.unsafe(statement)
  }
}

/**
 * Apply every pending migration. Returns the names applied by this call
 * (empty when the database was already up to date). Throws on the first
 * failing file, after rolling it back; files before it stay applied.
 */
export async function applyMigrations(
  db: DbExecutor,
  migrations: readonly Migration[] = bundledMigrations(),
): Promise<string[]> {
  await db.unsafe(CREATE_MIGRATIONS_TABLE)
  const done = new Set((await db`select name from schema_migrations`).map((row) => String(row.name)))
  const pending = [...migrations]
    .filter((migration) => !done.has(migration.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (pending.length === 0) return []

  const applied: string[] = []
  for (const migration of pending) {
    const ran = await db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
      // Another instance may have applied it while this one waited for the lock.
      const already = await tx`select 1 from schema_migrations where name = ${migration.name}`
      if (already.length > 0) return false
      await runScript(tx, migration.sql)
      await tx`insert into schema_migrations (name) values (${migration.name})`
      return true
    })
    if (ran) applied.push(migration.name)
  }
  if (applied.length > 0) await db.unsafe(SECURE_TABLES)
  return applied
}
