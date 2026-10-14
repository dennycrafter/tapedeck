import { describe, expect, it } from "vitest";
import type { TrackDto } from "./api";
import {
  albumHref,
  albumKey,
  artistHref,
  filterTracks,
  formatHours,
  formatStorage,
  greeting,
  groupAlbums,
  groupArtists,
  likedSongs,
  listSummary,
  normalizeLibrary,
  playlistCovers,
  playlistViews,
  queueFrom,
  recentlyPlayed,
  sortSongs,
} from "./library-view";

let seq = 0;
function track(over: Partial<TrackDto> = {}): TrackDto {
  seq += 1;
  return {
    id: `t${seq}`,
    source: "youtube",
    sourceUrl: `https://youtu.be/${seq}`,
    title: `Song ${seq}`,
    artist: "Artist",
    album: null,
    albumArtist: null,
    coverUrl: null,
    durationSec: 180,
    status: "ready",
    error: "",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    liked: false,
    likedAt: null,
    ...over,
  };
}

describe("sortSongs", () => {
  const a = track({ title: "banana", artist: "Zed", createdAt: "2026-01-01T00:00:00Z" });
  const b = track({ title: "Apple", artist: "amy", createdAt: "2026-01-03T00:00:00Z" });
  const c = track({ title: "cherry", artist: "Amy", createdAt: "2026-01-02T00:00:00Z" });

  it("recent is newest first", () => {
    expect(sortSongs([a, b, c], "recent").map((t) => t.id)).toEqual([b.id, c.id, a.id]);
  });
  it("title is A to Z ignoring case", () => {
    expect(sortSongs([a, b, c], "title").map((t) => t.title)).toEqual(["Apple", "banana", "cherry"]);
  });
  it("artist is A to Z, then title", () => {
    expect(sortSongs([a, b, c], "artist").map((t) => t.id)).toEqual([b.id, c.id, a.id]);
  });
  it("does not mutate the input", () => {
    const list = [a, b, c];
    sortSongs(list, "title");
    expect(list).toEqual([a, b, c]);
  });
});

describe("likedSongs", () => {
  it("keeps liked songs only, newest like first", () => {
    const old = track({ liked: true, likedAt: "2026-01-01T00:00:00Z" });
    const fresh = track({ liked: true, likedAt: "2026-02-01T00:00:00Z" });
    const not = track();
    expect(likedSongs([old, not, fresh]).map((t) => t.id)).toEqual([fresh.id, old.id]);
  });
});

describe("groupAlbums", () => {
  it("groups by album and album artist, in added order, cover from the first song with one", () => {
    const first = track({ album: "Discovery", albumArtist: "Daft Punk", createdAt: "2026-01-02T00:00:00Z" });
    const second = track({
      album: "Discovery",
      albumArtist: "Daft Punk",
      coverUrl: "https://img/x.jpg",
      createdAt: "2026-01-03T00:00:00Z",
    });
    const other = track({ album: "Discovery", albumArtist: "Someone Else" });
    const loose = track({ album: null });
    const albums = groupAlbums([second, other, loose, first]);
    expect(albums).toHaveLength(2);
    const daft = albums.find((album) => album.albumArtist === "Daft Punk");
    expect(daft?.tracks.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(daft?.coverUrl).toBe("https://img/x.jpg");
  });

  it("falls back to the song artist when album artist is empty", () => {
    const one = track({ album: "Mixtape", albumArtist: null, artist: "Kid" });
    const two = track({ album: "Mixtape", albumArtist: "  ", artist: "Kid" });
    const albums = groupAlbums([one, two]);
    expect(albums).toHaveLength(1);
    expect(albums[0]?.albumArtist).toBe("Kid");
  });

  it("puts favourites first in favourite order, then the rest A to Z", () => {
    const z = track({ album: "Zulu", albumArtist: "A" });
    const m = track({ album: "Mike", albumArtist: "A" });
    const b = track({ album: "Bravo", albumArtist: "A" });
    const albums = groupAlbums([z, m, b], [{ album: "Zulu", albumArtist: "A", createdAt: null }]);
    expect(albums.map((album) => album.album)).toEqual(["Zulu", "Bravo", "Mike"]);
    expect(albums[0]?.favorite).toBe(true);
    expect(albums[1]?.favorite).toBe(false);
  });
});

describe("groupArtists", () => {
  it("groups by exact artist, newest songs first, with their albums", () => {
    const old = track({ artist: "Daft Punk", album: "Discovery", albumArtist: "Daft Punk", createdAt: "2026-01-01T00:00:00Z" });
    const fresh = track({ artist: "Daft Punk", createdAt: "2026-03-01T00:00:00Z" });
    const lower = track({ artist: "daft punk" });
    const blank = track({ artist: "" });
    const albums = groupAlbums([old, fresh, lower, blank]);
    const artists = groupArtists([old, fresh, lower, blank], albums);
    // Exact strings: different capitalisation is a different artist; blank is skipped.
    expect(artists.map((artist) => artist.artist).sort()).toEqual(["Daft Punk", "daft punk"]);
    const daft = artists.find((artist) => artist.artist === "Daft Punk");
    expect(daft?.tracks.map((t) => t.id)).toEqual([fresh.id, old.id]);
    expect(daft?.albums.map((album) => album.album)).toEqual(["Discovery"]);
  });
});

describe("playlists", () => {
  it("covers are the first 4 distinct ones in order", () => {
    const list = ["a", "b", "a", null, "c", "d", "e"].map((cover) => track({ coverUrl: cover }));
    expect(playlistCovers(list)).toEqual(["a", "b", "c", "d"]);
  });

  it("resolves track ids and drops ones no longer in the library", () => {
    const one = track({ coverUrl: "x" });
    const two = track();
    const byId = new Map([one, two].map((t) => [t.id, t] as const));
    const [view] = playlistViews(
      [{ id: "p", name: "Mix", description: "", position: 0, createdAt: null, updatedAt: null, trackIds: [two.id, "gone", one.id] }],
      byId,
    );
    expect(view?.tracks.map((t) => t.id)).toEqual([two.id, one.id]);
    expect(view?.covers).toEqual(["x"]);
  });

  it("recently played keeps order and skips deleted songs", () => {
    const one = track();
    const byId = new Map([[one.id, one] as const]);
    expect(recentlyPlayed(["gone", one.id], byId)).toEqual([one]);
  });
});

describe("queueFrom", () => {
  it("queues ready songs only, starting at the tapped one", () => {
    const a = track();
    const waiting = track({ status: "waiting" });
    const b = track();
    const queue = queueFrom([a, waiting, b], b);
    expect(queue?.tracks.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(queue?.index).toBe(1);
  });
  it("starts at the first song when none is tapped", () => {
    const a = track();
    expect(queueFrom([a], null)?.index).toBe(0);
  });
  it("returns null for a song that can not play or an empty list", () => {
    const waiting = track({ status: "failed" });
    expect(queueFrom([track(), waiting], waiting)).toBeNull();
    expect(queueFrom([waiting], null)).toBeNull();
  });
});

describe("filterTracks", () => {
  const song = track({ title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories" });
  it("matches every word across title, artist and album, ignoring case", () => {
    expect(filterTracks([song], "lucky daft")).toEqual([song]);
    expect(filterTracks([song], "random")).toEqual([song]);
    expect(filterTracks([song], "lucky weeknd")).toEqual([]);
  });
  it("an empty query matches nothing", () => {
    expect(filterTracks([song], "   ")).toEqual([]);
  });
});

describe("formatting", () => {
  it("listSummary counts songs and minutes", () => {
    expect(listSummary([track({ durationSec: 90 })])).toBe("1 song, 2 min");
    expect(listSummary([track({ durationSec: 3000 }), track({ durationSec: 1200 })])).toBe("2 songs, 1 h 10 min");
    expect(listSummary([track({ durationSec: null })])).toBe("1 song");
  });
  it("hours keep one decimal under 10", () => {
    expect(formatHours(0)).toBe("0.0");
    expect(formatHours(5400)).toBe("1.5");
    expect(formatHours(36_000 * 12)).toBe("120");
  });
  it("storage reads like 3.2 of 10 GB", () => {
    expect(formatStorage(0, 10 * 1024 ** 3)).toBe("0 of 10 GB");
    expect(formatStorage(3.2 * 1024 ** 3, 10 * 1024 ** 3)).toBe("3.2 of 10 GB");
  });
  it("greeting uses the name", () => {
    expect(greeting("Denis")).toBe("Hey Denis");
    expect(greeting(" ")).toBe("Hey");
  });
  it("album and artist links round trip special characters", () => {
    const url = new URL(albumHref("AC/DC & Friends?", "Mötley #1"), "https://x");
    expect(url.pathname).toBe("/album");
    expect(url.searchParams.get("name")).toBe("AC/DC & Friends?");
    expect(url.searchParams.get("artist")).toBe("Mötley #1");
    expect(new URL(artistHref("A+B"), "https://x").searchParams.get("name")).toBe("A+B");
  });
  it("albumKey separates album from artist", () => {
    expect(albumKey("a", "bc")).not.toBe(albumKey("ab", "c"));
  });
  it("normalizeLibrary fills missing snapshot fields", () => {
    const full = normalizeLibrary({ tracks: [], downloader: { lastSeenAt: null, waitingCount: 0 } });
    expect(full.playlists).toEqual([]);
    expect(full.favoriteAlbums).toEqual([]);
    expect(full.recentlyPlayed).toEqual([]);
    expect(full.displayName).toBe("");
  });
});
