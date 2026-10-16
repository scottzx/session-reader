import { type ListOptions } from './resolver.js';
import type { AgentProvider } from './types.js';
import { type ProjectIdentity, type ProjectMapping } from './project-identity.js';
export type { ProjectMapping } from './project-identity.js';
export interface ProjectSummary extends ProjectIdentity {
    /** All observed historical directories, including worktrees and subdirectories. */
    workspaces: string[];
    /** Earliest known session creation time within the selected scope. */
    createdAt?: string;
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
    /** Optional explicit identities; longest matching workspace prefix wins. */
    projectMap?: ProjectMapping[];
}
export interface ProjectPage {
    projects: ProjectSummary[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    nextPage?: number;
}
/** Resolve identities across providers and repositories before sorting and paging. */
export declare function listProjects(options?: ProjectOptions): Promise<ProjectPage>;
export interface ProjectWeekActivity {
    id: string;
    name: string;
    workspace: string;
    sessionCount: number;
    providers: AgentProvider[];
    providerSessionCounts: Partial<Record<AgentProvider, number>>;
    /** First dated session in the selected scope, not a claimed launch date. */
    isNew: boolean;
}
export interface ProjectWeek {
    /** Local Monday and Sunday, formatted YYYY-MM-DD in the selected time zone. */
    week: string;
    endDate: string;
    projectCount: number;
    newProjectCount: number;
    cumulativeProjectCount: number;
    sessionCount: number;
    providerSessionCounts: Partial<Record<AgentProvider, number>>;
    projects: ProjectWeekActivity[];
}
export interface ProjectWeekOptions extends ProjectOptions {
    /** IANA time zone; defaults to the machine's local zone. */
    timeZone?: string;
}
export interface ProjectWeekPage extends Omit<ProjectPage, 'projects'> {
    weeks: ProjectWeek[];
    timeZone: string;
    /** Sessions with a workspace but no valid creation timestamp. */
    undatedSessionCount: number;
}
/** Complete Monday–Sunday series, including empty weeks, newest first. */
export declare function listProjectWeeks(options?: ProjectWeekOptions): Promise<ProjectWeekPage>;
