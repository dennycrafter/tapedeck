/** Pure helpers of the catalog screens (V2-PLAN T11) and the catalog waiting label. */
import { describe, expect, it } from "vitest";
import type { CatalogAlbum } from "@/lib/catalog-types";
import { catalogSummary, groupReleases, parseSearchTab, searchPageUrl, songsToAdd } from "./catalog-view";
import { CATALOG_WAITING_LABEL, statusLabel } from "./ui";

function album(id: string, recordType: CatalogAlbum["recordType"]): CatalogAlbum {
  return {
    id,
    title: id,
    artist: "A",
    artistId: null,
    coverUrl: null,
    thumbUrl: null,
    year: null,
    trackCount: null,
    recordType,
    explicit: false,
  };
}

describe("catalogSummary", () => {
  it("counts songs and total length", () => {
    expect(catalogSummary([])).toBe("0 songs");
    expect(catalogSummary([{ durationSec: 200 }])).toBe("1 song, 3 min");
    expect(catalogSummary([{ durationSec: 3000 }, { durationSec: 1464 }])).toBe("2 songs, 1 h 14 min");
    expect(catalogSummary([{ durationSec: null }, { durationSec: null }])).toBe("2 songs");
  });
});

describe("groupReleases", () => {
  it("splits albums, singles and EPs, and compilations, leaving out empty groups", () => {
    const groups = groupReleases([album("a", "album"), album("s", "single"), album("e", "ep"), album("b", "album")]);
    expect(groups.map((g) => [g.title, g.albums.map((x) => x.id)])).toEqual([
      ["Albums", ["a", "b"]],
      ["Singles and EPs", ["s", "e"]],
    ]);
  });
});

describe("songsToAdd", () => {
  it("keeps only the songs not owned", () => {
    const tracks = [{ id: "1" }, { id: "2" }, { id: "3" }] as never[];
    expect(songsToAdd(tracks, (t: { id: string }) => t.id === "2")).toEqual([{ id: "1" }, { id: "3" }]);
  });
});

describe("search address", () => {
  it("keeps the query and a non-default tab in the address", () => {
    expect(searchPageUrl("", "top")).toBe("/search");
    expect(searchPageUrl("daft punk", "top")).toBe("/search?q=daft+punk");
    expect(searchPageUrl("daft punk", "albums")).toBe("/search?q=daft+punk&tab=albums");
    expect(parseSearchTab("youtube")).toBe("youtube");
    expect(parseSearchTab("nope")).toBe("top");
    expect(parseSearchTab(null)).toBe("top");
  });
});

describe("statusLabel (T11)", () => {
  it("gives waiting catalog songs their own label", () => {
    expect(statusLabel({ status: "waiting", source: "catalog" })).toBe(CATALOG_WAITING_LABEL);
    expect(CATALOG_WAITING_LABEL).toBe("Waiting for your PC to find it");
    expect(statusLabel({ status: "waiting", source: "youtube" })).toBe("Waiting for your PC");
    expect(statusLabel({ status: "downloading", source: "catalog" })).toBe("Downloading");
    expect(statusLabel({ status: "failed", source: "catalog" })).toBe("Failed");
  });
});
