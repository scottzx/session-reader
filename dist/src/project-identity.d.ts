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
/** One resolver per query: Git is read at most once for each repository. */
export declare function projectIdentityResolver(mapping?: ProjectMapping[]): (workspace: string) => ProjectIdentity;
