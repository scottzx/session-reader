import fs from 'node:fs/promises';
import zlib from 'node:zlib';

/**
 * Reading zstd-framed JSONL.
 *
 * Agents that compress their transcripts append one frame per flush, so a
 * session file is a *concatenation* of complete frames. Node's zstd APIs —
 * both the sync call and the stream — stop after the first one, which silently
 * yields a session with a single line. The walker below therefore finds every
 * frame boundary from the frame headers alone (no decompression), so the whole
 * file is read and a truncated tail frame is dropped instead of poisoning it.
 */

/** zstd reached `node:zlib` in Node 22.15 / 23.8; `engines` asks for at least that. */
const SUPPORTED = typeof zlib.zstdDecompressSync === 'function';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_LOW = 0x184d2a50;
const SKIPPABLE_HIGH = 0x184d2a5f;

const DICTIONARY_ID_BYTES = [0, 1, 2, 4];
const CONTENT_SIZE_BYTES = [0, 2, 4, 8];

/**
 * Offset just past the frame starting at `at`, or nothing when the bytes run
 * out or the header is not one we understand. RFC 8878 §3.1: a frame is a
 * header followed by blocks, each block announcing its own size, so the end
 * can be found without inflating anything.
 */
function frameEnd(buf: Buffer, at: number): number | undefined {
  let i = at + 4;
  if (i >= buf.length) return undefined;
  const descriptor = buf[i++]!;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  i += singleSegment ? 0 : 1; // Window_Descriptor
  i += DICTIONARY_ID_BYTES[descriptor & 3]!;
  // The one asymmetric case: flag 0 means "1 byte" for a single-segment frame
  // and "absent" otherwise.
  i += contentSizeFlag === 0 ? singleSegment : CONTENT_SIZE_BYTES[contentSizeFlag]!;

  for (;;) {
    if (i + 3 > buf.length) return undefined;
    const header = buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16);
    i += 3;
    const blockType = (header >> 1) & 3;
    if (blockType === 3) return undefined; // reserved — we are off the rails
    i += blockType === 1 ? 1 : header >>> 3; // RLE stores a single byte
    if (i > buf.length) return undefined;
    if (header & 1) break; // Last_Block
  }
  return i + (hasChecksum ? 4 : 0) <= buf.length ? i + (hasChecksum ? 4 : 0) : undefined;
}

/** Every complete frame in the buffer, in order. */
export function frameRanges(buf: Buffer): [number, number][] {
  const ranges: [number, number][] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const magic = buf.readUInt32LE(at);
    if (magic >= SKIPPABLE_LOW && magic <= SKIPPABLE_HIGH) {
      if (at + 8 > buf.length) break;
      at += 8 + buf.readUInt32LE(at + 4);
      continue;
    }
    const end = magic === FRAME_MAGIC ? frameEnd(buf, at) : undefined;
    if (end === undefined) {
      // Either not a frame start or a truncated one; resynchronize on the next
      // magic rather than giving up on the rest of the file.
      const next = buf.indexOf(MAGIC, at + 1);
      if (next < 0) break;
      at = next;
      continue;
    }
    ranges.push([at, end]);
    at = end;
  }
  return ranges;
}

/** Concatenated payload of every frame that decompresses. */
export function decodeZstd(buf: Buffer): string {
  // Saying so is the point: a silent empty session would read as "that agent
  // has no history", which is exactly the wrong thing to believe.
  if (!SUPPORTED) {
    throw new Error(
      `reading zstd-compressed sessions needs node:zlib zstd support (Node >= 22.15); this is ${process.version}`,
    );
  }
  const parts: Buffer[] = [];
  for (const [start, end] of frameRanges(buf)) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* a frame written mid-flush is not worth failing the whole session for */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

export interface ZstdJsonlOptions {
  /**
   * Read only this many bytes from the head of the file. Frames are
   * self-delimiting, so a prefix decodes to a prefix of the session — which is
   * all `scanRef` ever needs.
   */
  headBytes?: number;
}

/** Streams a zstd-framed `.jsonl`, silently skipping malformed lines. */
export async function* readZstdJsonl(
  file: string,
  options: ZstdJsonlOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const handle = await fs.open(file, 'r');
  let buf: Buffer;
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(options.headBytes ?? size, size);
    buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  for (const line of decodeZstd(buf).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>;
  }
}
