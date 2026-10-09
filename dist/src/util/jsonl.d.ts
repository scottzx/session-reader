export interface JsonlOptions {
    /** Stop after this many parsed objects. */
    maxLines?: number;
}
/** Streams a `.jsonl` file, silently skipping blank or malformed lines. */
export declare function readJsonl(file: string, options?: JsonlOptions): AsyncGenerator<Record<string, unknown>>;
