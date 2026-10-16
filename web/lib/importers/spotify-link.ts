/**
 * Spotify link importer (V2-PLAN T13, Adapters item 2, "Spotify link").
 *
 * STUB: unavailable (hidden in the UI) until its adapter is built. It is
 * already registered in ./index.ts, so building it means editing only this
 * file plus your own new files. The interface is in ./types.ts; the stand-in
 * ./fake.ts shows a complete importer.
 *
 * A profile link lists the public playlists; a playlist link gives the songs.
 * Read Spotify's public web or embed pages server side (unofficial: keep all of
 * it in this file, keep fixtures). When parsing fails, throw
 * ImportUserError("Spotify changed something, try the login option").
 * Public playlists only; say so in `hints.link`.
 *
 * Your files: this one, lib/importers/spotify-link.test.ts (Vitest),
 * e2e/t13-spotify-link.spec.ts (Playwright, tag @T13), fixtures under
 * e2e/fixtures/import-spotify-link/. Decisions go under "#### T13 Spotify link" in
 * docs/DECISIONS.md.
 */

import { ImportUserError, type Importer } from './types'

export const spotifyLinkImporter: Importer = {
  id: 'spotify-link',
  label: 'Spotify link',
  services: ['spotify'],
  methods: ['link'],
  isAvailable: () => false,
  async listPlaylists() {
    throw new ImportUserError('This import is not ready yet.')
  },
  async getTracks() {
    throw new ImportUserError('This import is not ready yet.')
  },
}
