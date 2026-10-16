import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalizePath, findRepoRoot, isInside } from './util/paths.js';

/** Explicit identities for renamed, moved or deleted historical workspaces. */
export interface ProjectMapping {
  id: string;
  name: string;
  workspaces: string[];
}

export interface ProjectIdentity {
  id: string;
  name: string;
  workspace: string;
  mergeSource: 'workspace' | 'git' | 'mapping';
}

/** Normalize transport and credentials without confusing forks or same-named repos. */
function remoteIdentity(remote: string, root: string): string {
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(remote);
  if (!remote.includes('://') && scp) remote = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(remote);
    if (url.protocol === 'file:') return canonicalizePath(remote);
    const port = url.protocol === 'ssh:' && url.port === '22' ? '' : url.port;
    return `${url.hostname.toLowerCase()}${port ? `:${port}` : ''}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`;
  } catch {
    return canonicalizePath(path.resolve(root, remote));
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
  }).trim();
}

/** One resolver per query: Git is read at most once for each repository. */
export function projectIdentityResolver(mapping: ProjectMapping[] = []): (workspace: string) => ProjectIdentity {
  if (!Array.isArray(mapping)) throw new Error('project map must be an array');
  const ids = new Set<string>();
  const mappedPaths = new Set<string>();
  const aliases = mapping.flatMap((entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.name !== 'string' || !entry.name.trim()
      || !Array.isArray(entry.workspaces) || !entry.workspaces.length || entry.workspaces.some(p => typeof p !== 'string' || !p.trim())) {
      throw new Error('each project map entry requires id, name and nonempty workspaces');
    }
    if (ids.has(entry.id)) throw new Error(`duplicate project map id: ${entry.id}`);
    ids.add(entry.id);
    const workspaces = entry.workspaces.map(canonicalizePath);
    const identity: ProjectIdentity = { id: `mapped:${entry.id}`, name: entry.name, workspace: workspaces[0]!, mergeSource: 'mapping' };
    return workspaces.map(prefix => {
      if (mappedPaths.has(prefix)) throw new Error(`duplicate project map workspace: ${prefix}`);
      mappedPaths.add(prefix);
      return { prefix, identity };
    });
  }).sort((a, b) => b.prefix.length - a.prefix.length);
  const repos = new Map<string, ProjectIdentity>();
  const workspaces = new Map<string, ProjectIdentity>();
  return (input) => {
    const workspace = canonicalizePath(input);
    const cached = workspaces.get(workspace);
    if (cached) return cached;
    const mapped = aliases.find(alias => isInside(alias.prefix, workspace));
    let identity = mapped?.identity;
    if (!identity) {
      const root = findRepoRoot(path.join(workspace, '__session_workspace__'));
      identity = root ? repos.get(root) : undefined;
      if (root && !identity) {
        try {
          const common = canonicalizePath(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
          let remote: string | undefined;
          try { remote = git(root, ['config', '--file', path.join(common, 'config'), '--get', 'remote.origin.url']); } catch { /* no origin */ }
          const main = path.basename(common) === '.git' && fs.existsSync(path.join(path.dirname(common), '.git')) ? path.dirname(common) : root;
          const repository = remote ? remoteIdentity(remote, main) : common;
          identity = { id: `git:${repository}`, name: remote ? path.basename(repository) : path.basename(main), workspace: main, mergeSource: 'git' };
        } catch { /* not a readable Git repository; retain the historical workspace */ }
        if (identity) repos.set(root, identity);
      }
    }
    identity ??= { id: `path:${workspace}`, name: path.basename(workspace) || workspace, workspace, mergeSource: 'workspace' };
    workspaces.set(workspace, identity);
    return identity;
  };
}
