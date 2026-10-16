# MusicAPI stand-in fixtures (T13)

`responses.json` answers the MusicAPI importer under `TAPEDECK_TEST=1`
(`web/lib/importers/musicapi-standin.ts`). Tests and CI never call MusicAPI.

## Provenance

Not recorded. MusicAPI's user endpoints need an account, so on 2026-10-16 the
bodies were written by hand in the shape their public docs give
(`musicapi.com/docs/endpoints/get-users-playlists`, `get-liked-tracks`,
`get-playlist-items`): `{ results, nextParam, totalItems }`, songs with `id`,
`entryId`, `name`, `isrc`, `duration` in milliseconds, `album`, `artists`.
Re-record them from a real sandbox account once the keys exist.

## Conventions

- `user` is the made-up MusicAPI user id the fake log-in page hands back.
- `responses` is keyed by path plus the sorted query, decoded
  (`standinKey`), for example `/api/<user>/playlists?limitParam=50&nextParam=x`.
- `{ "status": 404 }` answers that status; a key that is missing answers 404.
- Pages are split small on purpose so the `nextParam` cursor is used.
- The Daft Punk songs are the ones recorded in `../import-deezer.json`, so they
  match the catalog (Harder, Better, Faster, Stronger by ISRC, the others by
  artist and title). Static Bloom by The Stand-in Trio matches nothing.
