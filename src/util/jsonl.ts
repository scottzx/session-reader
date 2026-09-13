import fs from 'node:fs';
import readline from 'node:readline';

export interface JsonlOptions {
  /** Stop after this many parsed objects. */
  maxLines?: number;
}

/** Streams a `.jsonl` file, silently skipping blank or malformed lines. */
export async function* readJsonl(
  file: string,
  options: JsonlOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let emitted = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      yield parsed as Record<string, unknown>;
      emitted++;
      if (options.maxLines && emitted >= options.maxLines) return;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
