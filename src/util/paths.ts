import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Normalizes anything a session file may contain into one comparable absolute
 * path: `~`, relative paths, `file://` URIs, percent-encoding and symlinks.
 */
export function canonicalizePath(input: string): string {
  let p = (input ?? '').trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.slice('file://'.length));
    }
  } else if (/%[0-9A-Fa-f]{2}/.test(p)) {
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep as-is */
    }
  }
  p = path.resolve(expandHome(p));
  try {
    p = fs.realpathSync.native(p);
  } catch {
    /* path may not exist any more; the lexical form is still comparable */
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** True when `child` is `parent` itself or lives under it. */
export function isInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  if (parent === child) return true;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * Claude Code names its project directories by replacing every non-alphanumeric
 * character of the cwd with `-` (lossy, so we only ever slugify forwards).
 */
export function slugifyWorkspace(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Walks up from a file to the closest directory holding `.git`. */
export function findRepoRoot(from: string): string | undefined {
  let dir = path.dirname(canonicalizePath(from));
  for (let i = 0; i < 40 && dir && dir !== '/'; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}
