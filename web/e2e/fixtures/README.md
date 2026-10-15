# Recorded fixtures (SPEC 4.1, 9.0)

Response bodies for the MSW handlers in `../mocks/handlers.ts`. Tests run with
`TAPEDECK_TEST=1` and never reach the network: every external call is answered
from these files. Nothing here contains a secret.

## Provenance

Recorded live on **2026-10-10** (no API keys needed for the sources below):

| File | Source | Recorded with |
|---|---|---|
| `youtube-oembed.json` | `GET https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&format=json` | `curl` |
| `youtube-oembed.json` → `unknown` | same endpoint, video id `00000000000` → HTTP 404, plain-text body `Not Found` | `curl` |
| `youtube-videos-list.json` | values from the watch page `https://www.youtube.com/watch?v=jNQXAC9IVRw` (`ytInitialPlayerResponse.videoDetails`: title, author, channelId, shortDescription, lengthSeconds; publishDate from microformat). YouTube Data API needs a key, so the envelope is composed by the handler. | `curl` + extract `ytInitialPlayerResponse` |
| `youtube-search.json` | composed from the same verified video values (search.list needs a key); envelope/etag synthetic | n/a |
| `itunes-search.json` | `GET https://itunes.apple.com/search?term=daft punk get lucky&entity=song&limit=5&country=US` (verbatim body) and `term=zzqx no such song xyz` (recorded empty result) | `curl` |
| `deezer-search.json` | `GET https://api.deezer.com/search?q=daft punk get lucky&limit=5` (verbatim body) | `curl` |
| `anthropic-messages.json` | Anthropic needs a key, so the body is synthetic but shaped exactly per SPEC 7.5 (`content[0].text` is the JSON string the app parses). `id`/`usage` are invented; the cleanup result itself is hand-written to match the recorded "Me at the zoo" metadata. | n/a |

Notes from the recording session:

- **Deezer strict form.** The SPEC 7.6 query form `artist:"X" track:"Y"` returned
  zero results on the record date; the recorded body was captured with the
  equivalent plain-terms query `daft punk get lucky`. `deezerQueryKey` in
  `../mocks/handlers.ts` collapses both forms to the same lookup key, so the
  app's documented call still resolves to real recorded data.
- **YouTube oEmbed `author_name`** is `jawed` (lowercase), because that is what the
  live endpoint returned; it is recorded verbatim, not normalised.
- **The watch page description** served on the record date is recorded
  verbatim into `youtube-videos-list.json` and `youtube-search.json`.

## File structure and conventions

| File | Shape | Unknown-key behaviour |
|---|---|---|
| `youtube-oembed.json` | `{ videos: {videoId: body}, unknown: {status, contentType, body} }` | recorded 404 `Not Found` |
| `youtube-videos-list.json` | `{ videoId: {snippet, contentDetails} }` | id omitted from `items` |
| `youtube-search.json` | `{ queries: {query: body}, empty: body }` | 200 with `items: []` |
| `itunes-search.json` | `{ terms: {term: body}, empty: body }` | recorded empty result |
| `deezer-search.json` | `{ queries: {query: body}, empty: body }` | 200 with `data: [], total: 0` |
| `anthropic-messages.json` | `{ default: body }` | same recorded exchange for every request |

- Lookup keys are normalised: trimmed, lowercased, whitespace collapsed
  (`normalizeQueryKey`). Deezer additionally collapses the strict
  `artist:"X" track:"Y"` form to `x y` (`deezerQueryKey`).
- Synthetic envelope values (etags, Anthropic `id`/`usage`) use the marker
  value `fixture` / `msg_fixture_default` so they can never be mistaken for
  recorded data.
- `contentDetails.duration` uses ISO 8601 (`PT19S`) as the app consumes it
  (SPEC 7.3).

## Re-recording

Raw captures live outside the repo. To refresh a fixture, repeat the matching
`curl` above, paste the body into the file, and note the new date here. Keep
bodies verbatim (do not "clean them up") and keep lookup keys consistent
with the handlers' normalisation.

## Catalog fixtures (T11)

`catalog-deezer.json` and `catalog-itunes.json` back the catalog search (V2-PLAN
T11). Unlike the files above they are read by the app itself: with
`TAPEDECK_TEST=1` (every e2e run) `web/lib/catalog-fixtures.ts` answers every
Deezer and iTunes catalog call from them, so tests never reach either service.
Unit tests serve the same files through MSW (`../mocks/catalog-handlers.ts`).

Recorded live on **2026-10-15** with a one-off script (no keys needed):

| File | Requests recorded |
|---|---|
| `catalog-deezer.json` | `/search?q=daft punk&limit=25`, `/search/album?q=daft punk&limit=25`, `/search/artist?q=daft punk&limit=10`, `/artist/27`, `/artist/27/top?limit=10`, `/artist/27/albums?limit=100`, `/album/6575789` and `/album/302127` with `/tracks?limit=200`, `/track/:id` for the 10 top songs; `unknown` is the live answer for `/album/0` (HTTP 200, `{"error":{"code":800}}`) |
| `catalog-itunes.json` | `/search?term=daft punk&country=US` with `entity=song` (25), `album` (25), `musicArtist` (10); `/lookup?id=5468295` (Daft Punk) with `entity=album&limit=100` and `entity=song&limit=10`; `/lookup?id=617154241&entity=song&limit=200` (Random Access Memories) |

- Shape: `{ recordedAt, responses: { "<path>?<sorted query>": body }, empty, unknown? }`.
  Keys come from `fixtureKey` in `web/lib/catalog-fixtures.ts`: the path plus
  the query sorted by name, with `q` / `term` lowercased and spaces collapsed.
- Unknown searches answer `empty`; unknown Deezer ids answer `unknown` (the
  recorded "no data" error).
- Bodies are verbatim except: Deezer preview links have their `hmac=` value
  replaced with `fixture` and `track_token` is `fixture` (signed, expiring
  values that `scripts/check-repo.sh` would flag as 64-character hex), and
  the files are written with `\uXXXX` escapes for non-ASCII text so no raw
  en or em dash lands in the repo.
- Offline development: `CATALOG_SOURCE=fixtures npm run dev` uses these files
  instead of the network (only "daft punk", its artist page and two albums
  are recorded).
