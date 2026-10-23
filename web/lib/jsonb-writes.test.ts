// Guard for the jsonb double-encoding bug (t14_fix_jsonb_strings.sql).
// The tests run on PGlite, which stores `${JSON.stringify(x)}::jsonb` fine,
// but the real `postgres` driver stringifies that string again and Postgres
// keeps a JSON string. Writes must cast through text: `::text::jsonb`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = [join(__dirname), join(__dirname, '..', 'app')]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'migrations-sql.ts' ? [path] : []
  })
}

describe('jsonb writes', () => {
  it('cast parameters through text, never straight to ::jsonb', () => {
    const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        // a template parameter `${...}` or an unsafe parameter `$1` followed directly by ::jsonb
        .filter(({ line }) => /(\}|\$\d+)::jsonb/.test(line))
        .map(({ at }) => at),
    )
    expect(offenders).toEqual([])
  })
})
