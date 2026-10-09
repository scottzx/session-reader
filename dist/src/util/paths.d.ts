export declare function expandHome(p: string): string;
/**
 * Normalizes anything a session file may contain into one comparable absolute
 * path: `~`, relative paths, `file://` URIs, percent-encoding and symlinks.
 */
export declare function canonicalizePath(input: string): string;
/** True when `child` is `parent` itself or lives under it. */
export declare function isInside(parent: string, child: string): boolean;
/**
 * Claude Code names its project directories by replacing every non-alphanumeric
 * character of the cwd with `-` (lossy, so we only ever slugify forwards).
 */
export declare function slugifyWorkspace(p: string): string;
/** Walks up from a file to the closest directory holding `.git`. */
export declare function findRepoRoot(from: string): string | undefined;
