/*
 * Made-up song files for the upload tests (T15), built in memory: the repo
 * never stores audio (scripts/check-repo.sh), and these stay tiny.
 *
 *   wavTone      a real tone as 16-bit mono PCM WAV, optionally carrying ID3
 *                tags in an "id3 " chunk (how WAV files hold tags)
 *   mp3Silence   MPEG-1 Layer III frames of silence, optionally after an ID3
 *                tag; browsers decode these
 *   id3v23       an ID3v2.3 tag: title, artist, album, album artist, cover
 *   pngSolid     a small one-colour PNG for the cover art
 *
 * Shared by the Vitest suites (tag reading) and the Playwright specs. Runs
 * in Node only (node:zlib for the PNG).
 */
import { deflateSync } from 'node:zlib';

export interface TagInput {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  cover?: Uint8Array;
  coverMime?: string;
  /** Extra bytes in a PRIV frame, so otherwise equal files differ. */
  salt?: string;
}

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function u32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function u16le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

/** ID3v2 tag sizes are "syncsafe": 7 bits per byte. */
function syncsafe(n: number): Uint8Array {
  return Uint8Array.of((n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([latin1(type), data]);
  return concat([u32be(data.byteLength), typed, u32be(crc32(typed))]);
}

/** A `size` x `size` PNG in one colour (RGB, 0 to 255 each). */
export function pngSolid(size: number, rgb: [number, number, number]): Uint8Array {
  const row = concat([Uint8Array.of(0), ...Array.from({ length: size }, () => Uint8Array.of(...rgb))]);
  const raw = concat(Array.from({ length: size }, () => row));
  const header = concat([u32be(size), u32be(size), Uint8Array.of(8, 2, 0, 0, 0)]); // 8-bit RGB
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([latin1(id), u32be(body.byteLength), Uint8Array.of(0, 0), body]);
}

/** Text frames in ISO-8859-1 (encoding byte 0). */
function textFrame(id: string, value: string): Uint8Array {
  return frame(id, concat([Uint8Array.of(0), latin1(value)]));
}

export function id3v23(tags: TagInput): Uint8Array {
  const NUL = Uint8Array.of(0);
  const frames: Uint8Array[] = [];
  if (tags.title) frames.push(textFrame('TIT2', tags.title));
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist));
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  if (tags.albumArtist) frames.push(textFrame('TPE2', tags.albumArtist));
  if (tags.cover) {
    // APIC: encoding, MIME type + NUL, picture type 3 (front cover), empty description + NUL, picture.
    const mime = latin1(tags.coverMime ?? 'image/png');
    frames.push(frame('APIC', concat([NUL, mime, NUL, Uint8Array.of(3), NUL, tags.cover])));
  }
  if (tags.salt) frames.push(frame('PRIV', concat([latin1('tapedeck-test'), NUL, latin1(tags.salt)])));
  const body = concat(frames);
  return concat([latin1('ID3'), Uint8Array.of(3, 0, 0), syncsafe(body.byteLength), body]);
}

/**
 * `seconds` of a sine tone at `frequency` Hz, 8 kHz mono 16-bit PCM. Pass
 * `tags` to add an "id3 " chunk. Different frequencies give different bytes,
 * so the same test can run on several browsers without "already uploaded".
 */
export function wavTone(options: { seconds: number; frequency?: number; tags?: TagInput }): Uint8Array {
  const rate = 8000;
  const frequency = options.frequency ?? 440;
  const samples = Math.round(options.seconds * rate);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000), true);
  }
  const fmt = concat([
    latin1('fmt '),
    u32le(16),
    u16le(1), // PCM
    u16le(1), // mono
    u32le(rate),
    u32le(rate * 2), // byte rate
    u16le(2), // block align
    u16le(16), // bits per sample
  ]);
  const data = concat([latin1('data'), u32le(pcm.byteLength), pcm]);
  const chunks = [fmt, data];
  if (options.tags) {
    let tag = id3v23(options.tags);
    if (tag.byteLength % 2 === 1) tag = concat([tag, Uint8Array.of(0)]); // RIFF chunks are word aligned
    chunks.push(concat([latin1('id3 '), u32le(tag.byteLength), tag]));
  }
  const body = concat(chunks);
  return concat([latin1('RIFF'), u32le(4 + body.byteLength), latin1('WAVE'), body]);
}

/**
 * `frames` MPEG-1 Layer III frames of silence (128 kbps, 44.1 kHz, mono;
 * 26 ms each), after an ID3 tag when `tags` is given.
 */
export function mp3Silence(options: { frames?: number; tags?: TagInput }): Uint8Array {
  const count = options.frames ?? 200;
  const frameLength = Math.floor((144 * 128000) / 44100); // 417 bytes, no padding
  const one = new Uint8Array(frameLength);
  one.set([0xff, 0xfb, 0x90, 0xc0]);
  const frames = concat(Array.from({ length: count }, () => one));
  return options.tags ? concat([id3v23(options.tags), frames]) : frames;
}
