import { createHash } from 'node:crypto';

/** Conservative UTF-8 byte budget, NOT a tokenizer or a claim that bytes equal tokens. */
export const CHUNKER = 'dialogue-utf8-v1:max320:overlap32';
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface TextChunk { start: number; end: number; text: string; textHash: string }

/** Offsets are UTF-16, like String.slice and existing reader text ranges. Never splits a surrogate. */
export function chunkText(text: string): TextChunk[] {
  const chars = Array.from(text);
  const offsets = [0];
  for (const char of chars) offsets.push(offsets[offsets.length - 1]! + char.length);
  const chunks: TextChunk[] = [];
  for (let start = 0; start < chars.length;) {
    let end = start, bytes = 0;
    while (end < chars.length && bytes + Buffer.byteLength(chars[end]!) <= 320) bytes += Buffer.byteLength(chars[end++]!);
    // Prefer a paragraph/line boundary in the latter half of the window.
    if (end < chars.length) {
      for (let at = end - 1; at > start + (end - start) / 2; at--) {
        if (chars[at] === '\n') { end = at + 1; break; }
      }
    }
    const body = chars.slice(start, end).join('');
    if (body.trim()) chunks.push({ start: offsets[start]!, end: offsets[end]!, text: body, textHash: hash([CHUNKER, body]) });
    if (end === chars.length) break;
    let next = end, overlap = 0;
    while (next > start + 1 && overlap + Buffer.byteLength(chars[next - 1]!) <= 32) overlap += Buffer.byteLength(chars[--next]!);
    start = next;
  }
  return chunks;
}
