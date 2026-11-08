import { describe, expect, it } from "vitest";
import {
  dropItems,
  filesFromDrop,
  MAX_FOLDER_SONGS,
  pickSongs,
  type DropDirectoryEntry,
  type DropEntry,
  type DropFileEntry,
  type DropItem,
} from "./drop-files";

// Pretend folders shaped like the browser's file system entries.
function fileEntry(fullPath: string): DropFileEntry {
  const name = fullPath.split("/").pop()!;
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (ok) => ok(new File([new Uint8Array([1, 2, 3])], name)),
  };
}

/** A folder whose reader hands out entries `batch` at a time, like Chrome's 100. */
function folderEntry(fullPath: string, children: DropEntry[], batch = 100): DropDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.split("/").pop()!,
    fullPath,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok) => {
          const next = children.slice(at, at + batch);
          at += next.length;
          queueMicrotask(() => ok(next));
        },
      };
    },
  };
}

describe("pickSongs", () => {
  it("keeps only songs, in track order, and leaves hidden files out", () => {
    const paths = [
      "/Album/10 Ten.mp3",
      "/Album/2 Two.FLAC",
      "/Album/cover.jpg",
      "/Album/notes.txt",
      "/Album/.DS_Store",
      "/Album/._2 Two.flac",
      "/__MACOSX/Album/1 One.mp3",
      "/Album/1 One.m4a",
      "/Album/Disc 2/1 Other.wav",
    ];
    expect(pickSongs(paths, (path) => path)).toEqual({
      songs: ["/Album/1 One.m4a", "/Album/2 Two.FLAC", "/Album/10 Ten.mp3", "/Album/Disc 2/1 Other.wav"],
      more: false,
    });
  });

  it("stops at the limit and says some were left out", () => {
    const paths = ["/a/3.mp3", "/a/1.mp3", "/a/2.mp3"];
    expect(pickSongs(paths, (path) => path, 2)).toEqual({ songs: ["/a/1.mp3", "/a/2.mp3"], more: true });
  });

  it("has a limit of 500 songs", () => {
    expect(MAX_FOLDER_SONGS).toBe(500);
  });
});

describe("filesFromDrop", () => {
  it("passes loose files through untouched, even ones that are not songs", async () => {
    const photo = new File(["x"], "photo.png");
    const song = new File(["y"], "song.mp3");
    const result = await filesFromDrop([
      { kind: "file", file: photo },
      { kind: "file", file: song },
    ]);
    expect(result).toEqual({ files: [photo, song], folders: 0, more: false });
  });

  it("walks a dropped album folder and its disc folders for songs", async () => {
    const album = folderEntry("/Album", [
      fileEntry("/Album/cover.jpg"),
      folderEntry("/Album/Disc 2", [fileEntry("/Album/Disc 2/01 B.mp3"), fileEntry("/Album/Disc 2/02 C.mp3")]),
      fileEntry("/Album/01 A.wav"),
      folderEntry("/Album/.hidden", [fileEntry("/Album/.hidden/x.mp3")]),
    ]);
    const loose = new File(["z"], "loose.flac");
    const result = await filesFromDrop([
      { kind: "folder", entry: album },
      { kind: "file", file: loose },
    ]);
    expect(result.folders).toBe(1);
    expect(result.more).toBe(false);
    expect(result.files.map((file) => file.name)).toEqual(["loose.flac", "01 A.wav", "01 B.mp3", "02 C.mp3"]);
  });

  it("reads big folders in batches until the reader is empty", async () => {
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`/Big/${i + 1}.mp3`));
    const result = await filesFromDrop([{ kind: "folder", entry: folderEntry("/Big", children, 100) }]);
    expect(result.files).toHaveLength(250);
    expect(result.files[0]!.name).toBe("1.mp3");
    expect(result.files[249]!.name).toBe("250.mp3");
  });

  it("caps a folder at the limit", async () => {
    const children = Array.from({ length: 5 }, (_, i) => fileEntry(`/F/${i + 1}.mp3`));
    const result = await filesFromDrop([{ kind: "folder", entry: folderEntry("/F", children) }], 3);
    expect(result.files.map((file) => file.name)).toEqual(["1.mp3", "2.mp3", "3.mp3"]);
    expect(result.more).toBe(true);
  });

  it("finds nothing in a folder without songs", async () => {
    const result = await filesFromDrop([{ kind: "folder", entry: folderEntry("/Pics", [fileEntry("/Pics/a.jpg")]) }]);
    expect(result).toEqual({ files: [], folders: 1, more: false });
  });
});

describe("dropItems", () => {
  function transfer(items: unknown[], files: File[] = []): DataTransfer {
    return { items, files } as unknown as DataTransfer;
  }

  it("tells folders from files", () => {
    const song = new File(["a"], "a.mp3");
    const folder = folderEntry("/Album", []);
    const items = [
      { kind: "file", webkitGetAsEntry: () => fileEntry("/a.mp3"), getAsFile: () => song },
      { kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => new File([], "Album") },
      { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
    ];
    expect(dropItems(transfer(items))).toEqual<DropItem[]>([
      { kind: "file", file: song },
      { kind: "folder", entry: folder },
    ]);
  });

  it("falls back to the file when the browser gives no entry", () => {
    const song = new File(["a"], "a.mp3");
    const items = [{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => song }];
    expect(dropItems(transfer(items))).toEqual([{ kind: "file", file: song }]);
  });

  it("uses the file list when there is no item list", () => {
    const song = new File(["a"], "a.mp3");
    expect(dropItems(transfer([], [song]))).toEqual([{ kind: "file", file: song }]);
  });
});
