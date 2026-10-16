// GET /api/import/services (V2-PLAN T13): the services the picker shows,
// each with its connect slots (log in, paste a link, file). Only services
// with at least one available importer are listed.
import { availableServices } from '../../../../lib/importers'
import { NO_STORE } from '../shared'

export async function GET(request: Request): Promise<Response> {
  // Reading the request keeps Cache Components from freezing this answer at
  // build time: availability depends on the runtime environment.
  new URL(request.url)
  return Response.json({ services: availableServices() }, { headers: NO_STORE })
}
