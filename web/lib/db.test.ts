/**
 * Unit tests for the db adapter (SPEC 4.1): both driver modes and the
 * idempotent schema bootstrap. In-memory PGlite keeps every run isolated;
 * the postgres driver is mocked (no DATABASE_URL exists in CI).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DbUnconfiguredError,
  dbMode,
  ensureSchema,
  getDb,
  resetDb,
  sql,
} from './db'

interface RecordedQuery {
  text: string
  params: unknown[]
}

const postgresState = vi.hoisted(() => ({
  clients: [] as Array<{ url: string; options: Record<string, unknown> | undefined }>,
  queries: [] as RecordedQuery[],
}))

vi.mock('postgres', () => {
  interface FakeClient {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>
    unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>
    begin<T>(cb: (tx: FakeClient) => Promise<T>): Promise<T>
    end(): Promise<void>
  }
  const makeClient = (): FakeClient =>
    Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        postgresState.queries.push({ text: strings.join('?'), params: values })
        return Promise.resolve([{ ok: 1 }])
      },
      {
        unsafe: (query: string, params: unknown[] = []) => {
          postgresState.queries.push({ text: query, params: [...params] })
          return Promise.resolve([{ ok: 1 }])
        },
        begin: async <T>(cb: (tx: FakeClient) => Promise<T>): Promise<T> => await cb(makeClient()),
        end: async () => {},
      },
    )
  return {
    default: Object.assign(
      vi.fn((url: string, options?: Record<string, unknown>) => {
        postgresState.clients.push({ url, options })
        return makeClient()
      }),
      { __state: postgresState },
    ),
  }
})

type WritableEnv = Record<string, string | undefined>
const env = process.env as WritableEnv

function setEnv(overrides: { DATABASE_URL?: string; TAPEDECK_TEST?: string; NODE_ENV?: string }) {
  delete env.DATABASE_URL
  delete env.TAPEDECK_TEST
  env.NODE_ENV = 'test'
  if (overrides.DATABASE_URL !== undefined) env.DATABASE_URL = overrides.DATABASE_URL
  if (overrides.TAPEDECK_TEST !== undefined) env.TAPEDECK_TEST = overrides.TAPEDECK_TEST
  if (overrides.NODE_ENV !== undefined) env.NODE_ENV = overrides.NODE_ENV
}

const originalEnv = {
  DATABASE_URL: env.DATABASE_URL,
  TAPEDECK_TEST: env.TAPEDECK_TEST,
  NODE_ENV: env.NODE_ENV,
}

beforeEach(async () => {
  await resetDb()
  postgresState.clients.length = 0
  postgresState.queries.length = 0
  vi.clearAllMocks()
})

afterEach(async () => {
  env.DATABASE_URL = originalEnv.DATABASE_URL
  env.TAPEDECK_TEST = originalEnv.TAPEDECK_TEST
  env.NODE_ENV = originalEnv.NODE_ENV
  await resetDb()
})

describe('dbMode', () => {
  it('prefers postgres whenever DATABASE_URL is set', () => {
    setEnv({ DATABASE_URL: 'postgresql://pooler:6543/postgres', NODE_ENV: 'production' })
    expect(dbMode()).toBe('postgres')
  })

  it('uses in-memory PGlite under TAPEDECK_TEST=1', () => {
    setEnv({ TAPEDECK_TEST: '1' })
    expect(dbMode()).toBe('pglite-memory')
  })

  it('uses the file-backed PGlite stand-in in development', () => {
    setEnv({ NODE_ENV: 'development' })
    expect(dbMode()).toBe('pglite-file')
  })

  it('is unconfigured in production without DATABASE_URL', () => {
    setEnv({ NODE_ENV: 'production' })
    expect(dbMode()).toBe('unconfigured')
  })
})

describe('unconfigured production', () => {
  it('rejects getDb and any sql use with DbUnconfiguredError', async () => {
    setEnv({ NODE_ENV: 'production' })
    await expect(getDb()).rejects.toBeInstanceOf(DbUnconfiguredError)
    await expect(sql`select 1`).rejects.toBeInstanceOf(DbUnconfiguredError)
  })
})

describe('postgres mode (mocked driver)', () => {
  const POOL_URL = 'postgresql://pooler.example.com:6543/postgres'

  it('creates the client with prepare: false and bootstraps the schema in dev', async () => {
    setEnv({ DATABASE_URL: POOL_URL, NODE_ENV: 'development' })
    await getDb()

    expect(postgresState.clients).toEqual([{ url: POOL_URL, options: { prepare: false } }])
    const texts = postgresState.queries.map((query) => query.text)
    expect(texts[0]).toContain("to_regclass('public.settings')")
    expect(texts[1]).toContain('create table settings')
  })

  it('skips the schema bootstrap in production (Finish setup owns it)', async () => {
    setEnv({ DATABASE_URL: POOL_URL, NODE_ENV: 'production' })
    await getDb()
    // Only the "is the schema there yet" check before migrations (V2-PLAN T9);
    // the fake reports no settings table, so nothing else runs.
    const texts = postgresState.queries.map((query) => query.text)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("to_regclass('public.settings')")
  })

  it('interpolates tagged templates into $n parameters', async () => {
    setEnv({ DATABASE_URL: POOL_URL })
    await sql`select * from tracks where id = ${7} and source = ${'youtube'}`
    expect(postgresState.queries.at(-1)).toEqual({
      text: 'select * from tracks where id = $1 and source = $2',
      params: [7, 'youtube'],
    })
  })

  it('splices raw and identifier fragments without placeholders', async () => {
    setEnv({ DATABASE_URL: POOL_URL })
    await sql`select ${sql.identifier('raw title')}, ${sql.raw('count(*)')} from tracks`
    expect(postgresState.queries.at(-1)?.text).toBe('select "raw title", count(*) from tracks')
  })
})

describe('in-memory PGlite (TAPEDECK_TEST=1)', () => {
  beforeEach(() => {
    setEnv({ TAPEDECK_TEST: '1' })
  })

  it('bootstraps the schema on first use and shares one instance', async () => {
    const rows = await sql`select count(*)::int as n from settings`
    expect(rows[0].n).toBe(1)

    const first = await getDb()
    const second = await getDb()
    expect(first).toBe(second)
  })

  it('passes values as parameters and reads rows back', async () => {
    const inserted = await sql`insert into playlists (name) values (${'Chill'}) returning name`
    expect(inserted[0].name).toBe('Chill')

    const rows = await sql`select name from playlists where name = ${'Chill'}`
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Chill')
  })

  it('splices identifier and raw fragments and keeps placeholder numbering', async () => {
    await sql`insert into playlists (name, position) values (${'A'}, ${1}), (${'B'}, ${2})`
    const rows = await sql`select ${sql.identifier('name')} as name from playlists
      order by ${sql.identifier('position')} desc limit ${1}`
    expect(rows[0].name).toBe('B')

    const counted = await sql`select ${sql.raw('count(*)')}::int as n from playlists`
    expect(counted[0].n).toBe(2)
  })

  it('runs multi-statement scripts via exec', async () => {
    await sql.exec('create table tmp_exec_test (id int); insert into tmp_exec_test values (5), (6);')
    const rows = await sql`select count(*)::int as n from tmp_exec_test`
    expect(rows[0].n).toBe(2)
  })

  it('commits transactions and rolls them back on failure', async () => {
    const inside = await sql.begin(async (tx) => {
      await tx`insert into playlists (name) values (${'via tx'})`
      return (await tx`select count(*)::int as n from playlists`)[0].n
    })
    expect(inside).toBe(1)

    await expect(
      sql.begin(async (tx) => {
        await tx`insert into playlists (name) values (${'boom'})`
        throw new Error('rollback please')
      }),
    ).rejects.toThrow('rollback please')

    const after = await sql`select count(*)::int as n from playlists`
    expect(after[0].n).toBe(1)
  })

  it('applies the v2 migrations at startup (V2-PLAN T9)', async () => {
    const rows = await sql`select name from schema_migrations`
    expect(rows.map((row) => row.name)).toContain('t09_v2_foundation.sql')
  })

  it('schema bootstrap is idempotent', async () => {
    await sql`select 1` // triggers the first bootstrap
    const db = await getDb()

    const appliedAgain = await ensureSchema(db)
    expect(appliedAgain).toBe(false)

    const rows = await sql`select count(*)::int as n from settings`
    expect(rows[0].n).toBe(1) // seed row not duplicated
  })

  it('resetDb starts a fresh database per run', async () => {
    await sql`insert into playlists (name) values (${'temp'})`
    await resetDb()

    const playlists = await sql`select count(*)::int as n from playlists`
    expect(playlists[0].n).toBe(0)

    const settings = await sql`select count(*)::int as n from settings`
    expect(settings[0].n).toBe(1) // bootstrap re-ran for the new instance
  })
})
