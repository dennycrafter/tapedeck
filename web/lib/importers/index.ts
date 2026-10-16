/**
 * The importer registry (V2-PLAN T13). Every adapter is registered here
 * once, by the core; adapter builders only edit their own file (an
 * unavailable importer is hidden everywhere, so a stub can sit here safely).
 *
 * Order matters only when two available importers offer the same connect
 * method for the same service: the first one in this list fills that slot.
 */

import type { ConnectOption, ServiceId, ServiceOption } from '../import-types'
import { CONNECT_METHODS, SERVICE_IDS, SERVICE_LABELS } from '../import-types'
import type { ConnectMethod, Importer } from './types'
import { musicapiImporter } from './musicapi'
import { spotifyLinkImporter } from './spotify-link'
import { appleLinkImporter } from './apple-link'
import { pcListingImporter } from './pc-listing'
import { fileImporter } from './file-import'
import { fakeImporter } from './fake'

export const IMPORTERS: readonly Importer[] = [
  musicapiImporter,
  spotifyLinkImporter,
  appleLinkImporter,
  pcListingImporter,
  fileImporter,
  fakeImporter,
]

const DEFAULT_HINTS: Record<ConnectMethod, string> = {
  login: 'Log in and pick from all your playlists.',
  link: 'Paste profile or playlist links, one per line.',
  file: 'Upload an export file.',
}

/** An available importer by id, or null (unknown ids and stubs alike). */
export function findImporter(id: unknown, env: NodeJS.ProcessEnv = process.env, list = IMPORTERS): Importer | null {
  if (typeof id !== 'string') return null
  const importer = list.find((candidate) => candidate.id === id)
  return importer && importer.isAvailable(env) ? importer : null
}

/** The connect slots for one service: one importer per method, first available wins. */
export function connectOptions(service: ServiceId, env: NodeJS.ProcessEnv = process.env, list = IMPORTERS): ConnectOption[] {
  const options: ConnectOption[] = []
  for (const method of CONNECT_METHODS) {
    const importer = list.find(
      (candidate) =>
        candidate.services.includes(service) &&
        candidate.methods.includes(method) &&
        (method !== 'login' || candidate.login !== undefined) &&
        candidate.isAvailable(env),
    )
    if (!importer) continue
    const option: ConnectOption = { method, importer: importer.id, hint: importer.hints?.[method] ?? DEFAULT_HINTS[method] }
    if (method === 'file' && importer.fileAccept) option.accept = importer.fileAccept
    options.push(option)
  }
  return options
}

/** The services the picker shows: only those with at least one available importer. */
export function availableServices(env: NodeJS.ProcessEnv = process.env, list = IMPORTERS): ServiceOption[] {
  return SERVICE_IDS.map((id) => ({ id, label: SERVICE_LABELS[id], options: connectOptions(id, env, list) })).filter(
    (service) => service.options.length > 0,
  )
}
