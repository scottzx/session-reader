interface Workspace {
    path: string;
    title?: string;
    workspaceId: string;
    sessionIds: readonly string[];
}
/** Resolve the selected DSH session, never an arbitrary workspace in the catalog. */
export declare function selectedWorkspace(sessionId: string | undefined, byId: Record<string, {
    cwd?: string;
}>, items: readonly Workspace[]): {
    cwd?: string;
    title?: string;
    workspaceId?: string;
};
export {};
