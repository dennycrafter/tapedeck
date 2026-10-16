// /api/import/jobs (V2-PLAN T13).
//
// GET   recent imports ("Your imports"), newest first, with their counts.
// POST  start an import for one service and one connect method:
//   JSON      { service, method: 'link', links: string[] }   (one per line, up to 50)
//   JSON      { service, method: 'login' }   -> { job, redirectUrl }: send the browser there
//   multipart service, method=file, file      (up to 4 MB, Vercel's request limit)
// The importer is the one the connect step showed for that slot
// (lib/importers/index.ts connectOptions). Links and files are listed right
// away: the answer is the job, listed, waiting for the PC, or failed with
// a plain message. Session-gated like every /api route.
import { jsonError } from '../../agent/requests'
import { createJob } from '../../../../lib/import-jobs'
import { jobView, recentJobSummaries } from '../../../../lib/import-progress'
import { runListing } from '../../../../lib/import-run'
import { connectOptions, findImporter } from '../../../../lib/importers'
import { isConnectMethod, isServiceId, type ConnectMethod, type CreateJobResponse, type ServiceId } from '../../../../lib/import-types'
import type { ImportFile, Importer } from '../../../../lib/importers/types'
import { NO_STORE } from '../shared'

export const maxDuration = 60

const MAX_LINKS = 50
const MAX_LINK_LENGTH = 2_000
const MAX_FILE_BYTES = 4 * 1024 * 1024

export async function GET(request: Request): Promise<Response> {
  new URL(request.url) // per request, never frozen at build time (Cache Components)
  try {
    return Response.json({ jobs: await recentJobSummaries() }, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/jobs] list failed:', error)
    return jsonError(500, 'Could not load your imports')
  }
}

interface CreateInput {
  service: ServiceId
  method: ConnectMethod
  links: string[]
  file: ImportFile | null
}

function fileInput(file: File, bytes: Uint8Array): ImportFile {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    text: async () => new TextDecoder().decode(bytes),
    bytes: async () => bytes,
  }
}

async function readInput(request: Request): Promise<CreateInput | string> {
  const type = request.headers.get('content-type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return 'Could not read that upload.'
    }
    const service = form.get('service')
    const file = form.get('file')
    if (!isServiceId(service)) return 'Pick a service first.'
    if (!(file instanceof File) || file.size === 0) return 'Choose a file to upload.'
    if (file.size > MAX_FILE_BYTES) return 'That file is too big (4 MB at most).'
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { service, method: 'file', links: [], file: fileInput(file, bytes) }
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return 'Expected a JSON body.'
  }
  const input = (body ?? {}) as Record<string, unknown>
  if (!isServiceId(input.service)) return 'Pick a service first.'
  if (!isConnectMethod(input.method) || input.method === 'file') return 'Pick how to connect.'
  if (input.method === 'login') return { service: input.service, method: 'login', links: [], file: null }
  const raw = Array.isArray(input.links) ? input.links : typeof input.links === 'string' ? input.links.split('\n') : []
  const links = raw
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (links.length === 0) return 'Paste at least one link.'
  if (links.length > MAX_LINKS) return `Paste at most ${MAX_LINKS} links at once.`
  if (links.some((link) => link.length > MAX_LINK_LENGTH)) return 'One of those links is too long.'
  return { service: input.service, method: 'link', links, file: null }
}

function importerFor(service: ServiceId, method: ConnectMethod): Importer | null {
  const option = connectOptions(service).find((candidate) => candidate.method === method)
  return option ? findImporter(option.importer) : null
}

export async function POST(request: Request): Promise<Response> {
  const input = await readInput(request)
  if (typeof input === 'string') return jsonError(400, input)
  const importer = importerFor(input.service, input.method)
  if (!importer) return jsonError(400, "That way of connecting isn't available for this service.")

  try {
    if (input.method === 'login') {
      if (!importer.login) return jsonError(400, "That way of connecting isn't available for this service.")
      const job = await createJob({ service: input.service, importer: importer.id, method: 'login', status: 'login' })
      const callbackUrl = new URL(`/api/import/callback/${importer.id}`, request.url).toString()
      const { redirectUrl } = await importer.login.start({ jobId: job.id, service: input.service, callbackUrl })
      const body: CreateJobResponse = { job: await jobView(job), redirectUrl }
      return Response.json(body, { status: 201, headers: NO_STORE })
    }
    const job = await createJob({
      service: input.service,
      importer: importer.id,
      method: input.method,
      payload: input.method === 'link' ? { links: input.links } : {},
    })
    const listed = await runListing(
      job,
      importer,
      input.method === 'link' ? { method: 'link', links: input.links } : { method: 'file', file: input.file },
    )
    const body: CreateJobResponse = { job: await jobView(listed) }
    return Response.json(body, { status: 201, headers: NO_STORE })
  } catch (error) {
    console.error('[import/jobs] create failed:', error)
    return jsonError(500, 'Could not start the import')
  }
}
