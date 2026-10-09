/** Every complete frame in the buffer, in order. */
export declare function frameRanges(buf: Buffer): [number, number][];
/** Concatenated payload of every frame that decompresses. */
export declare function decodeZstd(buf: Buffer): string;
export interface ZstdJsonlOptions {
    /**
     * Read only this many bytes from the head of the file. Frames are
     * self-delimiting, so a prefix decodes to a prefix of the session — which is
     * all `scanRef` ever needs.
     */
    headBytes?: number;
}
/** Streams a zstd-framed `.jsonl`, silently skipping malformed lines. */
export declare function readZstdJsonl(file: string, options?: ZstdJsonlOptions): AsyncGenerator<Record<string, unknown>>;
