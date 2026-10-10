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
| `youtube-search.json` | composed from the same verified video values (search.list needs a key); envelope/etag synthetic | — |
| `itunes-search.json` | `GET https://itunes.apple.com/search?term=daft punk get lucky&entity=song&limit=5&country=US` (verbatim body) and `term=zzqx no such song xyz` (recorded empty result) | `curl` |
| `deezer-search.json` | `GET https://api.deezer.com/search?q=daft punk get lucky&limit=5` (verbatim body) | `curl` |
| `anthropic-messages.json` | Anthropic needs a key, so the body is synthetic but shaped exactly per SPEC 7.5 (`content[0].text` is the JSON string the app parses). `id`/`usage` are invented; the cleanup result itself is hand-written to match the recorded "Me at the zoo" metadata. | — |

Notes from the recording session:

- **Deezer strict form.** The SPEC 7.6 query form `artist:"X" track:"Y"` returned
  zero results on the record date; the recorded body was captured with the
  equivalent plain-terms query `daft punk get lucky`. `deezerQueryKey` in
  `../mocks/handlers.ts` collapses both forms to the same lookup key, so the
  app's documented call still resolves to real recorded data.
- **YouTube oEmbed `author_name`** is `jawed` (lowercase) — that is what the
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
bodies verbatim — do not "clean them up" — and keep lookup keys consistent
with the handlers' normalisation.
