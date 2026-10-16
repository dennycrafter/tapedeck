/**
 * Apple Music link importer (V2-PLAN T13, Adapters item 3, "Apple Music link").
 *
 * STUB: unavailable (hidden in the UI) until its adapter is built. It is
 * already registered in ./index.ts, so building it means editing only this
 * file plus your own new files. The interface is in ./types.ts; the stand-in
 * ./fake.ts shows a complete importer.
 *
 * Shared playlist links (music.apple.com/.../playlist/...) from the public page.
 * Profiles cannot be listed: `hints.link` asks for playlist links, several at once.
 *
 * Your files: this one, lib/importers/apple-link.test.ts (Vitest),
 * e2e/t13-apple-link.spec.ts (Playwright, tag @T13), fixtures under
 * e2e/fixtures/import-apple-link/. Decisions go under "#### T13 Apple Music link" in
 * docs/DECISIONS.md.
 */

import { ImportUserError, type Importer } from './types'

export const appleLinkImporter: Importer = {
  id: 'apple-link',
  label: 'Apple Music link',
  services: ['apple'],
  methods: ['link'],
  isAvailable: () => false,
  async listPlaylists() {
    throw new ImportUserError('This import is not ready yet.')
  },
  async getTracks() {
    throw new ImportUserError('This import is not ready yet.')
  },
}
