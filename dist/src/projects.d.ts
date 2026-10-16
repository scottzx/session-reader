import { type ListOptions } from './resolver.js';
import type { AgentProvider } from './types.js';
export interface ProjectSummary {
    name: string;
    workspace: string;
    /** Latest session creation time, never a transcript's modification time. */
    updatedAt?: string;
    sessionCount: number;
    providers: AgentProvider[];
}
export interface ProjectOptions extends Pick<ListOptions, 'workspace' | 'provider' | 'useIndex' | 'refresh'> {
    /** One-based page number; defaults to 1. */
    page?: number;
    /** Projects per page; defaults to 20. */
    limit?: number;
}
export interface ProjectPage {
    projects: ProjectSummary[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    nextPage?: number;
}
/** Group every discovered workspace before sorting and paging the projects. */
export declare function listProjects(options?: ProjectOptions): Promise<ProjectPage>;
