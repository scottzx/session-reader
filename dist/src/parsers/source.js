import { createHash } from 'node:crypto';
/** Records are addressed before normalization, so filtering cannot shift references. */
export function sourceEvents(provider, sessionId) {
    let record = -1;
    const blocks = new Map();
    let base;
    return {
        record(raw, nativeId, messageId, parentId, nativeTurnId) {
            record++;
            blocks.clear();
            const checksum = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
            base = {
                record, checksum, key: nativeId ? `native:${nativeId}` : `record:${record}:${checksum}`,
                ...(nativeId ? { nativeId } : {}), ...(messageId ? { messageId } : {}),
                ...(parentId ? { parentId } : {}), ...(nativeTurnId ? { nativeTurnId } : {}),
            };
        },
        event(event) {
            const block = blocks.get(event.kind) ?? 0;
            blocks.set(event.kind, block + 1);
            const source = { ...base, block };
            // The checksum is mandatory for positional references. Native references survive append/reindex.
            const locator = 'event:' + Buffer.from(JSON.stringify([provider, sessionId, source.key, event.kind, source.block])).toString('base64url');
            const present = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
            return { ...present, source, locator };
        },
    };
}
export function existingTitles(...values) {
    return values.filter((value) => !!value[0]).map(([text, source]) => ({ text, source }));
}
