/**
 * SoundCloud and YouTube links (on the PC) importer (V2-PLAN T13, Adapters item 4, "SoundCloud and YouTube links").
 *
 * STUB: unavailable (hidden in the UI) until its adapter is built. It is
 * already registered in ./index.ts, so building it means editing only this
 * file plus your own new files. The interface is in ./types.ts; the stand-in
 * ./fake.ts shows a complete importer.
 *
 * Listing needs yt-dlp, so it runs on the PC. `listPlaylists` returns PENDING;
 * the core then sets the job to `waiting_pc` and the UI shows "Waiting for your PC".
 * Helpers for your agent endpoints (`POST /api/agent/import/claim` and
 * `POST /api/agent/import/complete`, capability "import-listing") are in
 * lib/import-jobs.ts: claimPcJobs, releasePcJob, failPcJob. releasePcJob merges
 * what the PC sent into the job payload and wakes the browser, which calls
 * `listPlaylists` (or `getTracks`) again: read the result from ctx.job.payload.
 * Songs carry `link` (their YouTube or SoundCloud address) so they keep it.
 *
 * Your files: this one, lib/importers/pc-listing.test.ts (Vitest),
 * e2e/t13-pc-listing.spec.ts (Playwright, tag @T13), fixtures under
 * e2e/fixtures/import-pc-listing/. Decisions go under "#### T13 PC listing" in
 * docs/DECISIONS.md.
 */

import { ImportUserError, type Importer } from './types'

export const pcListingImporter: Importer = {
  id: 'pc-listing',
  label: 'SoundCloud and YouTube links (on the PC)',
  services: ['soundcloud', 'youtube'],
  methods: ['link'],
  isAvailable: () => false,
  async listPlaylists() {
    throw new ImportUserError('This import is not ready yet.')
  },
  async getTracks() {
    throw new ImportUserError('This import is not ready yet.')
  },
}
