import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalizePath, findRepoRoot, isInside } from './util/paths.js';
/** Normalize transport and credentials without confusing forks or same-named repos. */
function remoteIdentity(remote, root) {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(remote);
    if (!remote.includes('://') && scp)
        remote = `ssh://${scp[1]}/${scp[2]}`;
    try {
        const url = new URL(remote);
        if (url.protocol === 'file:')
            return canonicalizePath(remote);
        const port = url.protocol === 'ssh:' && url.port === '22' ? '' : url.port;
        return `${url.hostname.toLowerCase()}${port ? `:${port}` : ''}${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`;
    }
    catch {
        return canonicalizePath(path.resolve(root, remote));
    }
}
function git(root, args) {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
}
/** One resolver per query: Git is read at most once for each repository. */
export function projectIdentityResolver(mapping = []) {
    if (!Array.isArray(mapping))
        throw new Error('project map must be an array');
    const ids = new Set();
    const mappedPaths = new Set();
    const aliases = mapping.flatMap((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.name !== 'string' || !entry.name.trim()
            || !Array.isArray(entry.workspaces) || !entry.workspaces.length || entry.workspaces.some(p => typeof p !== 'string' || !p.trim())) {
            throw new Error('each project map entry requires id, name and nonempty workspaces');
        }
        if (ids.has(entry.id))
            throw new Error(`duplicate project map id: ${entry.id}`);
        ids.add(entry.id);
        const workspaces = entry.workspaces.map(canonicalizePath);
        const identity = { id: `mapped:${entry.id}`, name: entry.name, workspace: workspaces[0], mergeSource: 'mapping' };
        return workspaces.map(prefix => {
            if (mappedPaths.has(prefix))
                throw new Error(`duplicate project map workspace: ${prefix}`);
            mappedPaths.add(prefix);
            return { prefix, identity };
        });
    }).sort((a, b) => b.prefix.length - a.prefix.length);
    const repos = new Map();
    const workspaces = new Map();
    return (input) => {
        const workspace = canonicalizePath(input);
        const cached = workspaces.get(workspace);
        if (cached)
            return cached;
        const mapped = aliases.find(alias => isInside(alias.prefix, workspace));
        let identity = mapped?.identity;
        if (!identity) {
            const root = findRepoRoot(path.join(workspace, '__session_workspace__'));
            identity = root ? repos.get(root) : undefined;
            if (root && !identity) {
                try {
                    const common = canonicalizePath(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
                    let remote;
                    try {
                        remote = git(root, ['config', '--file', path.join(common, 'config'), '--get', 'remote.origin.url']);
                    }
                    catch { /* no origin */ }
                    const main = path.basename(common) === '.git' && fs.existsSync(path.join(path.dirname(common), '.git')) ? path.dirname(common) : root;
                    const repository = remote ? remoteIdentity(remote, main) : common;
                    identity = { id: `git:${repository}`, name: remote ? path.basename(repository) : path.basename(main), workspace: main, mergeSource: 'git' };
                }
                catch { /* not a readable Git repository; retain the historical workspace */ }
                if (identity)
                    repos.set(root, identity);
            }
        }
        identity ??= { id: `path:${workspace}`, name: path.basename(workspace) || workspace, workspace, mergeSource: 'workspace' };
        workspaces.set(workspace, identity);
        return identity;
    };
}
