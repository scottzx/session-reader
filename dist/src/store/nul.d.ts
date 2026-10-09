/**
 * 写进 SQLite 的 TEXT 列之前调用。
 *
 * 绝大多数内容两个字符都不含，直接原样返回——所以常态是零拷贝。
 */
export declare function encodeText(value: string): string;
export declare function encodeText(value: string | null | undefined): string | null;
/** 从 SQLite 的 TEXT 列读出来之后调用。 */
export declare function decodeText(value: string): string;
export declare function decodeText(value: string | null | undefined): string | null;
/** 测试与诊断用：这段文本经过 SQLite 的 TEXT 列会不会被截断。 */
export declare function wouldTruncate(value: string): boolean;
