/** Resolve the selected DSH session, never an arbitrary workspace in the catalog. */
export function selectedWorkspace(sessionId, byId, items) {
    if (!sessionId)
        return {};
    const member = items.find(workspace => workspace.sessionIds.includes(sessionId));
    const cwd = byId[sessionId]?.cwd ?? member?.path;
    if (!cwd)
        return {};
    const workspace = items.find(item => item.path === cwd);
    return { cwd, title: workspace?.title || cwd.split('/').pop(), workspaceId: workspace?.workspaceId };
}
