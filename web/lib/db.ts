/**
 * Database adapter (SPEC 4.1) — one `sql` tagged template used everywhere.
 *
 * Real:     `DATABASE_URL` set → `postgres` npm driver with `prepare: false`
 *           (required by the Supabase transaction pooler).
 * Stand-in: no `DATABASE_URL` → PGlite. Data lives in `web/.data/pglite`, or in
 *           memory when `TAPEDECK_TEST=1` so every test run gets a fresh database.
 *           In a production build the stand-ins are disabled: a missing
 *           `DATABASE_URL` throws `DbUnconfiguredError` and the Setup page
 *           (SPEC 8.12) takes over.
 *
 * On first start — development and PGlite — `supabase/schema.sql` is applied when
 * the `settings` table is missing. In production the schema runs from "Finish
 * setup" (8.12) instead; call `ensureSchema(db)` from there.
 *
 * The same small surface works on both drivers:
 *   await sql`select * from tracks where id = ${id}`
 *   sql.unsafe(text, params)      — parameterized query
 *   sql.exec(script)              — multi-statement script (schema bootstrap)
 *   sql.begin(async tx => ...)    — transaction; use `tx`, not `sql`, inside
 *   sql.identifier(name), sql.raw(text) — fragments for dynamic SQL
 *
 * Tagged results are also usable as nested fragments: `sql`select
 * ${sql.identifier('title')} from ${sql.raw('tracks')}``.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'

export type Row = Record<string, unknown>

export type DbMode =
  | 'postgres' // DATABASE_URL is set — Supabase Postgres via the transaction pooler
  | 'pglite-file' // dev stand-in — PGlite persisted in web/.data/pglite
  | 'pglite-memory' // test stand-in (TAPEDECK_TEST=1) — in-memory PGlite, fresh per run
  | 'unconfigured' // production build with no DATABASE_URL — Setup page territory (8.12)

export class DbUnconfiguredError extends Error {
  constructor() {
    super(
      'Database is not configured: DATABASE_URL is missing in a production build. ' +
        'Local stand-ins are disabled in production; the Setup page (SPEC 8.12) collects the variables.',
    )
    this.name = 'DbUnconfiguredError'
  }
}

/** Raw SQL text spliced into the query untouched (from `sql.raw` / `sql.identifier`). */
export interface RawSqlFragment {
  readonly kind: 'raw'
  readonly text: string
}

/** A tagged-template call captured for composition inside another template. */
export interface TemplateSqlFragment {
  readonly kind: 'template'
  readonly strings: readonly string[]
  readonly values: readonly unknown[]
}

export type SqlFragment = RawSqlFragment | TemplateSqlFragment

export interface DbExecutor {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>
  unsafe(query: string, params?: readonly unknown[]): Promise<Row[]>
  /** Run a multi-statement SQL script (used for schema bootstrap). */
  exec(script: string): Promise<void>
  /** Transaction. Inside the callback, query with the given `tx`, not the root `sql`. */
  begin<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>
  identifier(name: string): SqlFragment
  raw(text: string): SqlFragment
  /** Close the underlying client. Not usable inside `begin` transactions. */
  end(): Promise<void>
}

/** Minimal driver seam so both backends produce the same executor. */
interface Driver {
  query(text: string, params: readonly unknown[]): Promise<Row[]>
  exec(script: string): Promise<void>
  begin<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>
  end(): Promise<void>
}

// ---------------------------------------------------------------------------
// Query building: template strings + values -> $n-parameterized text.
// Fragments splice their text in without consuming a placeholder.
// ---------------------------------------------------------------------------

const FRAGMENT = Symbol('tapedeck.db.fragment')

function fragmentPayload(value: unknown): FragmentSource | null {
  if (typeof value !== 'object' || value === null || !(FRAGMENT in value)) return null
  return (value as { [FRAGMENT]: FragmentSource })[FRAGMENT]
}

function rawFragment(text: string): RawSqlFragment {
  // The payload under FRAGMENT is the fragment itself; the symbol marks it as
  // splicable so plain row objects with a "kind" field are never mistaken for one.
  const payload: RawSqlFragment = { kind: 'raw', text }
  return Object.defineProperty(payload, FRAGMENT, { value: payload }) as RawSqlFragment
}

type FragmentSource = RawSqlFragment | TemplateSqlFragment

function buildQuery(strings: readonly string[], values: readonly unknown[]): {
  text: string
  params: unknown[]
} {
  const params: unknown[] = []
  let text = ''
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) text += appendValue(values[i], params)
  }
  return { text, params }
}

function appendValue(value: unknown, params: unknown[]): string {
  const fragment = fragmentPayload(value)
  if (fragment?.kind === 'raw') return fragment.text
  if (fragment?.kind === 'template') {
    const nested = buildQuery(fragment.strings, fragment.values)
    params.push(...nested.params)
    return nested.text
  }
  params.push(value)
  return `$${params.length}`
}

function quoteIdentifier(name: string): RawSqlFragment {
  return rawFragment(`"${name.replaceAll('"', '""')}"`)
}

/** Attach fragment payload to a query promise so it can compose inside another template. */
function asFragment<P extends Promise<Row[]>>(
  promise: P,
  source: FragmentSource,
): P {
  return Object.defineProperty(promise, FRAGMENT, { value: source }) as P
}

function createExecutor(driver: Driver): DbExecutor {
  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, params } = buildQuery(strings, values)
    return asFragment(driver.query(text, params), {
      kind: 'template',
      strings,
      values,
    })
  }
  return Object.assign(tagged, {
    unsafe: (query: string, params: readonly unknown[] = []) => driver.query(query, params),
    exec: (script: string) => driver.exec(script),
    begin: <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> => driver.begin(fn),
    identifier: (name: string) => quoteIdentifier(name),
    raw: (text: string) => rawFragment(text),
    end: () => driver.end(),
  })
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** Operations that make no sense on a transaction-scoped handle. */
function unsupportedBegin(): Promise<never> {
  return Promise.reject(new Error('Cannot call begin inside a transaction; use the tx handle'))
}

function unsupportedEnd(): Promise<never> {
  return Promise.reject(new Error('Cannot end a connection from inside a transaction'))
}

function postgresRunner(client: postgres.Sql | postgres.TransactionSql): Pick<Driver, 'query' | 'exec'> {
  return {
    query: async (text, params) => await client.unsafe(text, params as never[]),
    // No parameters → postgres.js uses the simple query protocol, which
    // accepts multi-statement scripts (the whole schema.sql, DO block included).
    exec: async (script) => {
      await client.unsafe(script)
    },
  }
}

function postgresDriver(client: postgres.Sql): Driver {
  return {
    ...postgresRunner(client),
    // postgres.js hands the callback a TransactionSql; wrap it as a DbExecutor
    // that cannot begin/end. The cast narrows UnwrapPromiseArray<Promise<T>>.
    begin: <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
      client.begin((tx) =>
        fn(createExecutor(postgresTxDriver(tx))),
      ) as Promise<T>,
    end: () => client.end(),
  }
}

function postgresTxDriver(client: postgres.TransactionSql): Driver {
  return {
    ...postgresRunner(client),
    begin: unsupportedBegin,
    end: unsupportedEnd,
  }
}

/** Structural subset of the PGlite client (and its transaction handle) we rely on. */
interface PgliteCore {
  query<T = Row>(query: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(query: string): Promise<unknown>
}

function pgliteDriver(client: PgliteCore, lifecycle: { begin: Driver['begin']; end: Driver['end'] }): Driver {
  return {
    query: async (text, params) => {
      const result = await client.query(text, [...params])
      return result.rows
    },
    exec: async (script) => {
      await client.exec(script)
    },
    begin: lifecycle.begin,
    end: lifecycle.end,
  }
}

function pgliteRootDriver(pg: PGlite): Driver {
  return pgliteDriver(pg, {
    // PGlite's Transaction handle exposes only query/exec — no nesting.
    begin: <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
      pg.transaction(async (tx) => fn(createExecutor(pgliteDriver(tx, {
        begin: unsupportedBegin,
        end: unsupportedEnd,
      })))),
    end: () => pg.close(),
  })
}

// ---------------------------------------------------------------------------
// Mode selection, schema bootstrap, singleton
// ---------------------------------------------------------------------------

export function dbMode(): DbMode {
  if (process.env.DATABASE_URL?.trim()) return 'postgres'
  if (process.env.TAPEDECK_TEST === '1') return 'pglite-memory'
  if (process.env.NODE_ENV === 'production') return 'unconfigured'
  return 'pglite-file'
}

/** Locate supabase/schema.sql from the usual working directories (web/, repo root). */
function readSchemaSql(): string {
  const candidates = ['../supabase/schema.sql', 'supabase/schema.sql', '../../supabase/schema.sql']
    .map((relative) => join(process.cwd(), relative))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`supabase/schema.sql not found (looked in: ${candidates.join(', ')})`)
  }
  return readFileSync(found, 'utf8')
}

/**
 * Apply supabase/schema.sql when the `settings` table is missing.
 * Idempotent: the existence check is the guard, so calling twice is a no-op.
 * Returns whether the schema was applied.
 */
export async function ensureSchema(db: DbExecutor, schemaSql?: string): Promise<boolean> {
  const rows = await db`select to_regclass('public.settings') as reg`
  if ((rows[0]?.['reg'] as string | null | undefined) != null) return false
  await db.exec(schemaSql ?? readSchemaSql())
  return true
}

let cachedExecutor: DbExecutor | null = null
let driverEnd: (() => Promise<void>) | null = null
let initPromise: Promise<DbExecutor> | null = null

/** The shared executor; the client (and schema bootstrap) initializes lazily on first use. */
export function getDb(): Promise<DbExecutor> {
  if (cachedExecutor) return Promise.resolve(cachedExecutor)
  if (!initPromise) {
    initPromise = init().then((executor) => {
      cachedExecutor = executor
      return executor
    })
    // A failed init (bad url, missing schema file) must not poison future calls.
    initPromise.catch(() => {
      initPromise = null
    })
  }
  return initPromise
}

async function init(): Promise<DbExecutor> {
  const mode = dbMode()
  if (mode === 'unconfigured') throw new DbUnconfiguredError()

  if (mode === 'postgres') {
    const client = postgres(process.env.DATABASE_URL!.trim(), { prepare: false })
    const executor = createExecutor(postgresDriver(client))
    driverEnd = () => client.end()
    if (process.env.NODE_ENV !== 'production') await ensureSchema(executor)
    return executor
  }

  const pg =
    mode === 'pglite-memory'
      ? new PGlite()
      : new PGlite(join(process.cwd(), '.data', 'pglite'))
  const executor = createExecutor(pgliteRootDriver(pg))
  driverEnd = () => pg.close()
  // PGlite only runs in dev/test, so bootstrap always applies here.
  await ensureSchema(executor)
  return executor
}

/** Close the current client and forget it — the next use builds a fresh one. Tests use this. */
export async function resetDb(): Promise<void> {
  const end = driverEnd
  cachedExecutor = null
  driverEnd = null
  initPromise = null
  if (end) await end()
}

/**
 * The one database handle the app imports (SPEC 4.1). All calls forward lazily
 * to `getDb()`, so merely importing this module never opens a connection.
 */
export const sql: DbExecutor = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) =>
    getDb().then((db) => db(strings, ...values)),
  {
    unsafe: (query: string, params: readonly unknown[] = []) =>
      getDb().then((db) => db.unsafe(query, params)),
    exec: (script: string) => getDb().then((db) => db.exec(script)),
    begin: <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
      getDb().then((db) => db.begin(fn)),
    identifier: (name: string) => quoteIdentifier(name),
    raw: (text: string) => rawFragment(text),
    end: async () => {
      const db = await getDb()
      cachedExecutor = null
      driverEnd = null
      initPromise = null
      await db.end()
    },
  },
)
