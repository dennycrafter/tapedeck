/**
 * File upload importer (V2-PLAN T13, Adapters item 5, "File upload" (low priority, last)).
 *
 * STUB: unavailable (hidden in the UI) until its adapter is built. It is
 * already registered in ./index.ts, so building it means editing only this
 * file plus your own new files. The interface is in ./types.ts; the stand-in
 * ./fake.ts shows a complete importer.
 *
 * Exportify CSV or zip, Apple Music Library.xml, TuneMyMusic CSV. The file
 * arrives in `listPlaylists({ method: "file", file })` (multipart upload, so
 * mind Vercel's 4.5 MB request limit). The file is gone after that request:
 * return the parsed songs in `payload` and read them back in `getTracks`
 * from ctx.job.payload. Set `fileAccept`.
 *
 * Your files: this one, lib/importers/file-import.test.ts (Vitest),
 * e2e/t13-file-import.spec.ts (Playwright, tag @T13), fixtures under
 * e2e/fixtures/import-file-import/. Decisions go under "#### T13 File upload" in
 * docs/DECISIONS.md.
 */

import { ImportUserError, type Importer } from './types'

export const fileImporter: Importer = {
  id: 'file-import',
  label: 'File upload',
  services: ['spotify', 'apple'],
  methods: ['file'],
  isAvailable: () => false,
  async listPlaylists() {
    throw new ImportUserError('This import is not ready yet.')
  },
  async getTracks() {
    throw new ImportUserError('This import is not ready yet.')
  },
}
