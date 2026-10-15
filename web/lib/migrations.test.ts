import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { pgliteExecutor, type DbExecutor } from './db'
import { applyMigrations, bundledMigrations } from './migrations'
import { MIGRATION_FILES } from './migrations-sql'

// V2-PLAN T9: the migration runner against a real in-memory PGlite, on top
// of the real supabase/schema.sql.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))
const SCHEMA_SQL = readFileSync(fileURLToPath(new URL('../../supabase/schema.sql', import.meta.url)), 'utf8')

async function names(db: DbExecutor): Promise<string[]> {
  return (await db`select name from schema_migrations order by name`).map((row) => String(row.name))
}

async function tableExists(db: DbExecutor, table: string): Promise<boolean> {
  const rows = await db`select to_regclass(${`public.${table}`}) as reg`
  return rows[0]?.reg != null
}

describe('migrations-sql.ts', () => {
  it('matches supabase/migrations exactly (run npm run gen:migrations)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
    expect(MIGRATION_FILES.map((file) => file.name)).toEqual(files)
    for (const file of MIGRATION_FILES) {
      const onDisk = readFileSync(`${MIGRATIONS_DIR}${file.name}`, 'utf8').replaceAll('\r\n', '\n')
      expect(file.sql, file.name).toBe(onDisk)
    }
  })

  it('names every file tNN_<name>.sql', () => {
    for (const file of MIGRATION_FILES) expect(file.name).toMatch(/^t\d{2}_[a-z0-9_]+\.sql$/)
  })
})

describe('applyMigrations on PGlite', () => {
  let db: DbExecutor

  beforeEach(async () => {
    db = pgliteExecutor(new PGlite())
    await db.exec(SCHEMA_SQL)
  })

  it('applies every bundled migration on a fresh database and records it', async () => {
    const applied = await applyMigrations(db)
    expect(applied).toEqual(bundledMigrations().map((migration) => migration.name))
    expect(await names(db)).toEqual(applied)
  })

  it('does nothing on an already migrated database', async () => {
    await applyMigrations(db)
    expect(await applyMigrations(db)).toEqual([])
    expect(await names(db)).toEqual(bundledMigrations().map((migration) => migration.name))
  })

  it('runs pending files in filename order, each once', async () => {
    const order: string[] = []
    await db`create table run_log (name text)`
    const file = (name: string) => ({ name, sql: `insert into run_log values ('${name}');` })
    order.push(...(await applyMigrations(db, [file('t02_b.sql'), file('t01_a.sql')])))
    order.push(...(await applyMigrations(db, [file('t02_b.sql'), file('t01_a.sql'), file('t03_c.sql')])))
    expect(order).toEqual(['t01_a.sql', 't02_b.sql', 't03_c.sql'])
    const log = await db`select name from run_log`
    expect(log.map((row) => row.name)).toEqual(['t01_a.sql', 't02_b.sql', 't03_c.sql'])
  })

  it('rolls back a failing migration and does not record it', async () => {
    const good = { name: 't01_good.sql', sql: 'create table good_one (id int);' }
    const bad = {
      name: 't02_bad.sql',
      sql: 'create table half_done (id int);\ninsert into no_such_table values (1);',
    }
    await expect(applyMigrations(db, [good, bad])).rejects.toThrow(/no_such_table/)

    expect(await names(db)).toEqual(['t01_good.sql'])
    expect(await tableExists(db, 'good_one')).toBe(true)
    expect(await tableExists(db, 'half_done')).toBe(false)

    // Fixed file: the next start applies only it.
    const fixed = { name: 't02_bad.sql', sql: 'create table half_done (id int);' }
    expect(await applyMigrations(db, [good, fixed])).toEqual(['t02_bad.sql'])
    expect(await tableExists(db, 'half_done')).toBe(true)
  })

  it('turns on row level security for tables a migration creates', async () => {
    await applyMigrations(db, [{ name: 't01_new_table.sql', sql: 'create table new_table (id int);' }])
    const rows = await db`select relname, relrowsecurity from pg_class
      where relname in ('new_table', 'schema_migrations') order by relname`
    expect(rows).toEqual([
      { relname: 'new_table', relrowsecurity: true },
      { relname: 'schema_migrations', relrowsecurity: true },
    ])
  })
})

describe('t09_v2_foundation.sql', () => {
  let db: DbExecutor

  beforeEach(async () => {
    db = pgliteExecutor(new PGlite())
    await db.exec(SCHEMA_SQL)
  })

  it('keeps songs saved before v2 and gives them the defaults', async () => {
    await db`insert into tracks (source, source_id, source_url, raw_title, title)
      values ('youtube', 'abc', 'https://www.youtube.com/watch?v=abc', 'Old', 'Old')`
    await applyMigrations(db)
    const rows = await db`select title, playback_rate, preserve_pitch, isrc, trim_start_sec, match_info from tracks`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Old', preserve_pitch: true, isrc: null, trim_start_sec: null, match_info: null })
    expect(Number(rows[0].playback_rate)).toBe(1)
  })

  it('allows catalog songs with no link yet and rejects unknown sources', async () => {
    await applyMigrations(db)
    await db`insert into tracks (source, source_id, source_url, raw_title, title, isrc)
      values ('catalog', 'deezer:3135556', '', 'Harder', 'Harder', 'GBDUW0000059')`
    await expect(
      db`insert into tracks (source, source_id, source_url, raw_title, title)
        values ('vimeo', 'x', 'https://vimeo.com/x', 'X', 'X')`,
    ).rejects.toThrow(/tracks_source_check/)
  })

  it('keeps playback_rate between 0.5 and 1.5', async () => {
    await applyMigrations(db)
    const insert = (rate: number) => db`insert into tracks (source, source_id, source_url, raw_title, title, playback_rate)
      values ('youtube', ${`id-${rate}`}, 'https://www.youtube.com/watch?v=x', 'X', 'X', ${rate})`
    await insert(0.5)
    await insert(1.5)
    await expect(insert(1.55)).rejects.toThrow(/tracks_playback_rate_check/)
    await expect(insert(0.45)).rejects.toThrow(/tracks_playback_rate_check/)
  })
})
