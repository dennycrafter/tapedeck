# Apple Music link recordings (T13)

Public Apple Music playlist pages for `lib/importers/apple-link.ts`. Under
`TAPEDECK_TEST=1` (every e2e and unit test run) `lib/importers/apple-source.ts`
reads these files instead of calling Apple, so tests and CI never reach the
network. The unit tests also serve them through MSW for the live code path.

## Provenance

Fetched live on **2026-10-16** with a plain `GET` (no login, no token, no
cookies) from a Node script outside the repo.

| File | Request | What it covers |
|---|---|---|
| `daft-punk-essentials.json` | `GET https://music.apple.com/us/playlist/daft-punk-essentials/pl.74657640b88c4587a426160f7441de46` | A curated playlist, 16 songs. Veridis Quo, One More Time and Something About Us match the recorded Deezer answers in `../import-deezer.json`. |
| `shared-user-playlist.json` | `GET https://music.apple.com/us/playlist/track-star/pl.u-11zB9vyskDZ1AX` | A playlist a person shared (`pl.u-` id), 21 songs, emoji in the name. |
| `ten-years-top-songs.json` | `GET https://music.apple.com/us/playlist/10-years-of-apple-music-top-songs/pl.c125e4b2998a4015abbe6b9ae90d5479` | A 500 song playlist: the page lists only the first 300 and has `nextIntent`. |
| `missing-playlist.json` | `GET https://music.apple.com/us/playlist/pl.u-zzzzzzzzzzzzzz` | HTTP 404, verbatim body: what Apple answers for a playlist that does not exist or is not shared. |
| `changed-page.json` | none | **Hand-made**, not a recording: a 200 page without the data script, for the "Apple Music changed something" message. |

## Shape

`{ recorded, request, status, serverData }` for a 200 page, where
`serverData` is the verbatim text of the page's
`<script type="application/json" id="serialized-server-data">`, the only part
the importer reads. The fixture reader wraps it in a minimal HTML page. Error
and hand-made pages keep their whole `body` instead.

Changes from the live responses:

- Only the `serialized-server-data` script of each 200 page is kept (the rest
  of the HTML is markup, styles and scripts the importer never reads).
- In `shared-user-playlist.json` the owner's display name is replaced with
  `Playlist Owner`: it is a stranger's name and the tests do not need it.
- En and em dashes are written as `–` and `—` escapes (same text once
  parsed), because `scripts/check-repo.sh` rejects the raw characters.

## What the live pages showed

- The song list sits in the `trackLockup` section, in playlist order: title,
  `artistName`, album (`tertiaryLinks[0].title`), `duration` in milliseconds,
  Apple's song id and artwork. There is no ISRC.
- At most 300 songs per page. Adding `?offset=300` redirects back to the same
  page. The `nextIntent` of a longer playlist points at Apple's own API, which
  needs the token of Apple's web player, so the importer does not use it.
- `/library/playlist/p.xxx` links answer 200 with an empty
  `LibraryPlaylistPageIntent` page: only the logged in owner sees the songs.

## Re-recording

Fetch the pages above again (any HTTP client, no headers needed), take the
text inside the `serialized-server-data` script, and put it in `serverData`.
Keep the owner name replaced and the dashes escaped, and update the date here.
