import { createHash } from 'node:crypto';
import type { EventSource, TurnEvent } from '../types.js';

/** Records are addressed before normalization, so filtering cannot shift references. */
export function sourceEvents(provider: string, sessionId: string) {
  let record = -1;
  const blocks = new Map<string, number>();
  let base: Omit<EventSource, 'block'>;
  return {
    record(raw: Record<string, unknown>, nativeId?: string, messageId?: string, parentId?: string, nativeTurnId?: string) {
      record++;
      blocks.clear();
      const checksum = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
      base = {
        record, checksum, key: nativeId ? `native:${nativeId}` : `record:${record}:${checksum}`,
        ...(nativeId ? { nativeId } : {}), ...(messageId ? { messageId } : {}),
        ...(parentId ? { parentId } : {}), ...(nativeTurnId ? { nativeTurnId } : {}),
      };
    },
    event(event: Omit<TurnEvent, 'id' | 'index'>): Omit<TurnEvent, 'id' | 'index'> {
      const block = blocks.get(event.kind) ?? 0;
      blocks.set(event.kind, block + 1);
      const source = { ...base, block };
      // The checksum is mandatory for positional references. Native references survive append/reindex.
      const locator = 'event:' + Buffer.from(JSON.stringify([provider, sessionId, source.key, event.kind, source.block])).toString('base64url');
      const present = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as Omit<TurnEvent, 'id' | 'index'>;
      return { ...present, source, locator };
    },
  };
}

export function existingTitles(...values: [string | undefined, string][]): { text: string; source: string }[] {
  return values.filter((value): value is [string, string] => !!value[0]).map(([text, source]) => ({ text, source }));
}
