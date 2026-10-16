/**
 * MusicAPI login importer (V2-PLAN T13, Adapters item 1, "MusicAPI.com login").
 *
 * STUB: unavailable (hidden in the UI) until its adapter is built. It is
 * already registered in ./index.ts, so building it means editing only this
 * file plus your own new files. The interface is in ./types.ts; the stand-in
 * ./fake.ts shows a complete importer.
 *
 * Read MusicAPI's docs and pricing first and log what the free or sandbox tier allows.
 * Fill `login` (OAuth through their unified flow). The callback route is already
 * there: `/api/import/callback/musicapi` calls `login.finish`, stores the returned
 * payload (their user id, per job only) and lists the playlists.
 * Env vars `MUSICAPI_CLIENT_ID` and `MUSICAPI_CLIENT_SECRET` (optional): available
 * only when both are set, or under TAPEDECK_TEST=1 with your stand-in provider.
 * Add them to `.env.example` and the HANDOFF go-live steps as optional.
 *
 * Your files: this one, lib/importers/musicapi.test.ts (Vitest),
 * e2e/t13-musicapi.spec.ts (Playwright, tag @T13), fixtures under
 * e2e/fixtures/import-musicapi/. Decisions go under "#### T13 MusicAPI login" in
 * docs/DECISIONS.md.
 */

import { ImportUserError, type Importer } from './types'

export const musicapiImporter: Importer = {
  id: 'musicapi',
  label: 'MusicAPI login',
  services: ['spotify', 'apple', 'ytmusic', 'tidal', 'deezer'],
  methods: ['login'],
  isAvailable: () => false,
  async listPlaylists() {
    throw new ImportUserError('This import is not ready yet.')
  },
  async getTracks() {
    throw new ImportUserError('This import is not ready yet.')
  },
}
