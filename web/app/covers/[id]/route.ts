// GET /covers/<track id> (T15): the cover art that came inside an uploaded
// song file, stored at covers/<id>.jpg. Served from the app's own address
// (not a presigned storage URL, which expires) so the library can keep the
// address, the browser can cache it for good (the picture behind an id
// never changes) and the service worker keeps it for offline use like the
// app's other images. Outside /api/ on purpose: the service worker never
// caches /api/*. Session-gated by the proxy like every page.
import { isUuid } from '../../api/agent/requests'
import { getStorage } from '../../../lib/storage'
import { uploadCoverKey } from '../../../lib/upload-rules'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return new Response('Not found', { status: 404 })
  try {
    const cover = await getStorage().read(uploadCoverKey(id.toLowerCase()))
    if (!cover) return new Response('Not found', { status: 404 })
    return new Response(cover.bytes as BodyInit, {
      headers: {
        'Content-Type': cover.contentType.startsWith('image/') ? cover.contentType : 'image/jpeg',
        'Content-Length': String(cover.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error('[covers] failed:', error)
    return new Response('Could not load the cover', { status: 500 })
  }
}
