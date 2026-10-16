// POST /api/agent/import/claim (V2-PLAN T13, adapter 4): the downloader asks
// for a playlist listing job. Same bearer auth as every /api/agent route (the
// proxy exempts /api/agent/, so this check is the only guard).
//
// Body: { capabilities: string[] }. Only a downloader that sends
// "import-listing" gets jobs; anything else gets an empty list, so a mistaken
// call never takes a job it cannot do.
//
// Answer: { jobs: [{ id, service, targets: [{ link, kind, url }], maxSongs }] }.
// At most one job per poll (listing can take minutes). A job is claimed for
// 15 minutes; a PC that dies mid-way gives it back by itself
// (lib/import-jobs.ts claimPcJobs, 3 attempts).
//
// Reading `request` keeps the handler per-request (Cache Components).

import { agentAuthorized } from '../../auth'
import { jsonError, readJsonObject } from '../../requests'
import { parseCapabilities } from '../../v2-fields'
import { claimPcJobs, failPcJob } from '../../../../../lib/import-jobs'
import { pcListingImporter } from '../../../../../lib/importers/pc-listing'
import { checkLinks, type PcTarget } from '../../../../../lib/importers/pc-listing-links'
import { MAX_SONGS } from '../../../../../lib/importers/pc-listing-result'

const IMPORT_LISTING_CAPABILITY = 'import-listing'

interface ClaimedListing {
  id: string
  service: string
  targets: PcTarget[]
  maxSongs: number
}

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) return jsonError(401, 'Unauthorized')
  try {
    const capabilities = parseCapabilities(await readJsonObject(request))
    if (!capabilities.includes(IMPORT_LISTING_CAPABILITY)) return Response.json({ jobs: [] })
    const jobs: ClaimedListing[] = []
    for (const job of await claimPcJobs(pcListingImporter.id, 1)) {
      const links = Array.isArray(job.payload.links) ? job.payload.links.filter((link): link is string => typeof link === 'string') : []
      const checked = checkLinks(links, job.service)
      if ('error' in checked) {
        // Checked when the job was made, so only a changed rule lands here.
        await failPcJob(job.id, checked.error)
        continue
      }
      jobs.push({ id: job.id, service: job.service, targets: checked.targets, maxSongs: MAX_SONGS })
    }
    return Response.json({ jobs })
  } catch (error) {
    console.error('[agent/import/claim] failed:', error)
    return jsonError(500, 'Claim failed')
  }
}
