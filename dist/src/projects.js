import path from 'node:path';
import { listRecentSessions } from './resolver.js';
import { canonicalizePath } from './util/paths.js';
/** Group every discovered workspace before sorting and paging the projects. */
export async function listProjects(options = {}) {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    for (const [name, value] of [['page', page], ['limit', limit]]) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(`${name} must be a positive safe integer`);
        }
    }
    const refs = await listRecentSessions({ ...options, limit: Number.MAX_SAFE_INTEGER, scan: Infinity });
    const byWorkspace = new Map();
    for (const ref of refs) {
        if (!ref.workspace)
            continue;
        const workspace = canonicalizePath(ref.workspace);
        let project = byWorkspace.get(workspace);
        if (!project) {
            project = { name: path.basename(workspace) || workspace, workspace, sessionCount: 0, providers: [] };
            byWorkspace.set(workspace, project);
        }
        project.sessionCount++;
        if (!project.providers.includes(ref.provider))
            project.providers.push(ref.provider);
        const createdMs = Date.parse(ref.createdAt ?? '');
        if (Number.isFinite(createdMs) && (!project.updatedAt || createdMs > Date.parse(project.updatedAt))) {
            project.updatedAt = new Date(createdMs).toISOString();
        }
    }
    const projects = [...byWorkspace.values()].sort((a, b) => {
        const aTime = a.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
        const bTime = b.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
        return bTime - aTime || a.workspace.localeCompare(b.workspace);
    });
    for (const project of projects)
        project.providers.sort();
    const offset = (page - 1) * limit;
    const hasMore = offset + limit < projects.length;
    return {
        projects: projects.slice(offset, offset + limit),
        total: projects.length,
        page,
        limit,
        hasMore,
        ...(hasMore ? { nextPage: page + 1 } : {}),
    };
}
