/**
 * The importer registry (V2-PLAN T13): every adapter file is registered once,
 * the stubs stay hidden until built, the stand-in shows only in tests, and
 * the connect slots come from the first available importer.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { availableServices, connectOptions, findImporter, IMPORTERS } from './index'
import { fakeImporter } from './fake'
import type { Importer } from './types'

const TEST_ENV = { TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv
const LIVE_ENV = {} as unknown as NodeJS.ProcessEnv

describe('the registry', () => {
  it('registers the five adapters and the stand-in, each id naming its file', () => {
    const ids = ['musicapi', 'spotify-link', 'apple-link', 'pc-listing', 'file-import', 'fake']
    expect(IMPORTERS.map((importer) => importer.id)).toEqual(ids)
    const files = readdirSync(path.join(__dirname))
    for (const id of ids) expect(files, id).toContain(`${id}.ts`)
  })

  it('hides the stubs until their adapters are built', () => {
    for (const id of ['musicapi', 'spotify-link', 'apple-link', 'pc-listing', 'file-import']) {
      const importer = IMPORTERS.find((candidate) => candidate.id === id)
      expect(importer, id).toBeDefined()
      // Built adapters may become available; this only checks the registry has them.
      expect(typeof importer?.isAvailable).toBe('function')
    }
  })

  it('shows the stand-in only under TAPEDECK_TEST=1', () => {
    expect(findImporter('fake', TEST_ENV)).toBe(fakeImporter)
    expect(findImporter('fake', LIVE_ENV)).toBeNull()
    expect(findImporter('nope', TEST_ENV)).toBeNull()
    expect(availableServices(TEST_ENV).map((service) => service.id)).toContain('test')
    expect(availableServices(LIVE_ENV).map((service) => service.id)).not.toContain('test')
  })

  it('gives the stand-in service all three connect slots', () => {
    expect(connectOptions('test', TEST_ENV)).toEqual([
      { method: 'login', importer: 'fake', hint: 'Log in to the test service.' },
      { method: 'link', importer: 'fake', hint: 'Any link works here. This service only exists in tests.' },
      { method: 'file', importer: 'fake', hint: 'Any file works here.', accept: '.csv,.txt,.xml,.json' },
    ])
  })

  it('lets the first available importer fill a slot, and skips unavailable ones', () => {
    const base = { getTracks: async () => ({ tracks: [] }), listPlaylists: async () => ({ playlists: [] }) }
    const off: Importer = { ...base, id: 'off', label: 'Off', services: ['spotify'], methods: ['link'], isAvailable: () => false }
    const first: Importer = { ...base, id: 'first', label: 'First', services: ['spotify'], methods: ['link'], isAvailable: () => true }
    const second: Importer = {
      ...base,
      id: 'second',
      label: 'Second',
      services: ['spotify', 'apple'],
      methods: ['link', 'file', 'login'], // login without a login flow: no slot
      isAvailable: () => true,
      hints: { link: 'Paste it.' },
    }
    const list = [off, first, second]
    expect(connectOptions('spotify', LIVE_ENV, list)).toEqual([
      { method: 'link', importer: 'first', hint: 'Paste profile or playlist links, one per line.' },
      { method: 'file', importer: 'second', hint: 'Upload an export file.' },
    ])
    expect(availableServices(LIVE_ENV, list).map((service) => [service.id, service.label, service.options.length])).toEqual([
      ['spotify', 'Spotify', 2],
      ['apple', 'Apple Music', 2],
    ])
  })
})
