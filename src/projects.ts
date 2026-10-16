import { listRecentSessions, type ListOptions } from './resolver.js';
import type { AgentProvider, SessionRef } from './types.js';
import { canonicalizePath } from './util/paths.js';
import { projectIdentityResolver, type ProjectIdentity, type ProjectMapping } from './project-identity.js';

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

function pagination(options: ProjectOptions) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  for (const [name, value] of [['page', page], ['limit', limit]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  return { page, limit };
}

async function collectProjects(options: ProjectOptions) {
  const identify = projectIdentityResolver(options.projectMap);
  const refs = await listRecentSessions({ ...options, limit: Number.MAX_SAFE_INTEGER, scan: Infinity });
  const grouped = new Map<string, { project: ProjectSummary; refs: SessionRef[] }>();
  for (const ref of refs) {
    if (!ref.workspace) continue;
    const workspace = canonicalizePath(ref.workspace);
    const identity = identify(workspace);
    let group = grouped.get(identity.id);
    if (!group) {
      group = { project: { ...identity, workspaces: [], sessionCount: 0, providers: [] }, refs: [] };
      grouped.set(identity.id, group);
    }
    const { project } = group;
    // Stable representative even when independent clones share an origin.
    if (identity.workspace.localeCompare(project.workspace) < 0) {
      project.workspace = identity.workspace;
      project.name = identity.name;
    }
    group.refs.push(ref);
    if (!project.workspaces.includes(workspace)) project.workspaces.push(workspace);
    project.sessionCount++;
    if (!project.providers.includes(ref.provider)) project.providers.push(ref.provider);
    const createdMs = Date.parse(ref.createdAt ?? '');
    if (Number.isFinite(createdMs)) {
      const createdAt = new Date(createdMs).toISOString();
      if (!project.createdAt || createdMs < Date.parse(project.createdAt)) project.createdAt = createdAt;
      if (!project.updatedAt || createdMs > Date.parse(project.updatedAt)) project.updatedAt = createdAt;
    }
  }
  for (const { project } of grouped.values()) {
    project.providers.sort();
    project.workspaces.sort();
  }
  return [...grouped.values()];
}

/** Resolve identities across providers and repositories before sorting and paging. */
export async function listProjects(options: ProjectOptions = {}): Promise<ProjectPage> {
  const { page, limit } = pagination(options);
  const projects = (await collectProjects(options)).map(group => group.project).sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
    return bTime - aTime || a.workspace.localeCompare(b.workspace);
  });
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

const DAY_MS = 86_400_000;
const dateString = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Complete Monday–Sunday series, including empty weeks, newest first. */
export async function listProjectWeeks(options: ProjectWeekOptions = {}): Promise<ProjectWeekPage> {
  const { page, limit } = pagination(options);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeZone = formatter.resolvedOptions().timeZone;
  const weekOf = (timestamp: string): string => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const day = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')));
    return dateString(day - (new Date(day).getUTCDay() + 6) % 7 * DAY_MS);
  };
  const buckets = new Map<string, ProjectWeekActivity[]>();
  const firstWeeks: string[] = [];
  let undatedSessionCount = 0;
  for (const { project, refs } of await collectProjects(options)) {
    const activity = new Map<string, ProjectWeekActivity>();
    for (const ref of refs) {
      if (!Number.isFinite(Date.parse(ref.createdAt ?? ''))) { undatedSessionCount++; continue; }
      const week = weekOf(ref.createdAt!);
      let entry = activity.get(week);
      if (!entry) {
        entry = { id: project.id, name: project.name, workspace: project.workspace, sessionCount: 0, providers: [], providerSessionCounts: {}, isNew: false };
        activity.set(week, entry);
      }
      entry.sessionCount++;
      entry.providerSessionCounts[ref.provider] = (entry.providerSessionCounts[ref.provider] ?? 0) + 1;
      if (!entry.providers.includes(ref.provider)) entry.providers.push(ref.provider);
    }
    const first = [...activity.keys()].sort()[0];
    if (first) { activity.get(first)!.isNew = true; firstWeeks.push(first); }
    for (const [week, entry] of activity) {
      entry.providers.sort();
      const bucket = buckets.get(week) ?? [];
      bucket.push(entry); buckets.set(week, bucket);
    }
  }
  const datedWeeks = [...buckets.keys()].sort();
  const total = datedWeeks.length ? (Date.parse(datedWeeks.at(-1)!) - Date.parse(datedWeeks[0]!)) / (7 * DAY_MS) + 1 : 0;
  // Page the calendar before materializing it, so a sparse long history stays bounded.
  const offset = (page - 1) * limit;
  const weeks: ProjectWeek[] = [];
  for (let index = offset; index < Math.min(offset + limit, total); index++) {
    const ms = Date.parse(datedWeeks.at(-1)!) - index * 7 * DAY_MS;
    const week = dateString(ms);
    const projects = (buckets.get(week) ?? []).sort((a, b) => b.sessionCount - a.sessionCount || a.id.localeCompare(b.id));
    const providerSessionCounts: Partial<Record<AgentProvider, number>> = {};
    for (const project of projects) for (const provider of project.providers) {
      providerSessionCounts[provider] = (providerSessionCounts[provider] ?? 0) + project.providerSessionCounts[provider]!;
    }
    weeks.push({ week, endDate: dateString(ms + 6 * DAY_MS), projectCount: projects.length,
      newProjectCount: projects.filter(p => p.isNew).length, cumulativeProjectCount: firstWeeks.filter(first => first <= week).length,
      sessionCount: projects.reduce((sum, p) => sum + p.sessionCount, 0), providerSessionCounts, projects });
  }
  const hasMore = offset + limit < total;
  return { weeks, total, page, limit, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}), timeZone, undatedSessionCount };
}
