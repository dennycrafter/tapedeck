// Records Spotify's public pages into pages.json (V2-PLAN T13, Spotify link).
// Run by hand only, never from tests or CI:
//
//   node e2e/fixtures/import-spotify-link/record.mjs <path> [<path> ...]
//
// <path> is a page path without the host: `embed/playlist/<id>` or `user/<id>`.
// Only the parts the adapter reads are kept: the embed page's
// `__NEXT_DATA__` entity, or the profile page's `initialState` entities.
// The session part of each page (it holds an anonymous token) is dropped
// before anything is written. En and em dashes are written as \u2013 and
// \u2014 escapes (scripts/check-repo.sh bans the raw characters).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages.json')
const UA = 'Tapedeck/2 (+https://github.com/dennycrafter/tapedeck)' // same as lib/importers/spotify-pages.ts

const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { recorded: '', pages: {} }
out.recorded = new Date().toISOString().slice(0, 10)

for (const pagePath of process.argv.slice(2)) {
  const res = await fetch(`https://open.spotify.com/${pagePath}`, { headers: { 'user-agent': UA, 'accept-language': 'en' } })
  const html = await res.text()
  if (!res.ok) {
    out.pages[pagePath] = { status: res.status }
  } else if (pagePath.startsWith('embed/')) {
    const body = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1]
    const pageProps = body ? JSON.parse(body)?.props?.pageProps ?? {} : {}
    const entity = pageProps.state?.data?.entity
    out.pages[pagePath] = entity
      ? { status: res.status, nextData: { props: { pageProps: { state: { data: { entity } } } } } }
      : // Spotify's error page: only its status and wording.
        { status: res.status, nextData: { props: { pageProps: { status: pageProps.status, title: pageProps.title, description: pageProps.description } } } }
  } else {
    const body = /<script id="initialState" type="text\/plain">([^<]*)<\/script>/.exec(html)?.[1]
    const state = body ? JSON.parse(Buffer.from(body, 'base64').toString('utf8')) : {}
    out.pages[pagePath] = { status: res.status, initialState: { entities: { items: state.entities?.items ?? {} } } }
  }
  console.log(pagePath, res.status)
}

const text = JSON.stringify(out, null, 1).replace(/\u2013/g, '\\u2013').replace(/\u2014/g, '\\u2014')
writeFileSync(OUT, `${text}\n`)
console.log('wrote', OUT)
