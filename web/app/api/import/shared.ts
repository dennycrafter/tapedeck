// Shared plumbing for the /api/import routes (V2-PLAN T13). Session-gated
// like every /api route (the proxy's cookie check is the guard).
import { isUuid, jsonError } from '../agent/requests'
import { getJob, type ImportJob } from '../../../lib/import-jobs'
import { findImporter } from '../../../lib/importers'
import type { Importer } from '../../../lib/importers/types'

export const NOT_AVAILABLE = 'This import is not available any more.'

/** The job and its importer, or the error response to send. */
export async function jobAndImporter(id: string): Promise<{ job: ImportJob; importer: Importer } | { response: Response }> {
  if (!isUuid(id)) return { response: jsonError(400, 'Import id must be a UUID') }
  const job = await getJob(id)
  if (!job) return { response: jsonError(404, 'Import not found') }
  const importer = findImporter(job.importer)
  if (!importer) return { response: jsonError(409, NOT_AVAILABLE) }
  return { job, importer }
}

export const NO_STORE = { 'Cache-Control': 'no-store' }
