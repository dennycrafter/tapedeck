# Spotify link recordings (T13)

Spotify's public pages, recorded live on **2026-10-16** for the Spotify link
importer (`web/lib/importers/spotify-link.ts`, page reading in
`spotify-pages.ts`). Under `TAPEDECK_TEST=1` the app reads these instead of
Spotify (`spotify-fixtures.ts`), and the unit tests serve the same pages
through MSW. Tests and CI never reach Spotify.

## What is in `pages.json`

| Key | Page | What it shows |
|---|---|---|
| `user/spotify` | `open.spotify.com/user/spotify`, server-rendered | the first 10 public playlists of 1519 |
| `user/0000notarealuser0000` | an unknown profile | HTTP 404 |
| `embed/playlist/5FPvD2X2jBM782H8zGgjT3` | "Daft Punk Essentials", embed page | all 49 songs |
| `embed/playlist/37i9dQZF1DX4UtSsGT1Sbe` | "All Out 80s", embed page | the first 100 of 150 songs |
| `embed/playlist/37i9dQZF1DXcBWIGoYBM5M` | "Today's Top Hits", embed page | all 50 songs |
| `embed/playlist/0000000000000000000000` | an unknown playlist | Spotify's "Page not found" embed page (HTTP 200, `status` 404); the stand-in answers every unknown embed path with it |
| `unavailable` | "Daft Punk Essentials", once during recording | Spotify's "Page not available, try again later" embed page (`status` 500) |

Each page keeps only what the adapter reads: the embed page's
`__NEXT_DATA__` `props.pageProps.state.data.entity`, and the profile page's
`initialState` `entities.items` (the page has it as base64 JSON; it is stored
decoded here and encoded again by the stand-in). The session part of both
pages holds an anonymous token and was dropped while recording. Everything
kept is verbatim.

## Notes from the recording

- The profile page is server-rendered only for a non-browser user agent.
  With a browser user agent Spotify sends an empty shell that loads
  everything with scripts. The adapter and `record.mjs` send
  `Tapedeck/2 (+https://github.com/dennycrafter/tapedeck)`.
- The embed page lists at most 100 songs and has no album and no ISRC. The
  server-rendered playlist page (`open.spotify.com/playlist/<id>`) has the
  true total (`totalCount` 150 for All Out 80s) but only 30 songs; reading
  further needs Spotify's private API with the page's session token, which
  Tapedeck does not use.
- Artists come as one string joined with a comma and a no-break space
  (U+00A0), for example `Daft Punk, Pharrell Williams`.

## Re-recording

From `web/`: `node e2e/fixtures/import-spotify-link/record.mjs <path> ...`
(paths as in the table). It updates the entries it is given and the date.
Then run `npx vitest run lib/importers/spotify-link.test.ts` and
`bash scripts/check-repo.sh`.
