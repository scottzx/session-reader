/** Conservative UTF-8 byte budget, NOT a tokenizer or a claim that bytes equal tokens. */
export declare const CHUNKER = "dialogue-utf8-v1:max320:overlap32";
export declare const hash: (value: unknown) => string;
export interface TextChunk {
    start: number;
    end: number;
    text: string;
    textHash: string;
}
/** Offsets are UTF-16, like String.slice and existing reader text ranges. Never splits a surrogate. */
export declare function chunkText(text: string): TextChunk[];
