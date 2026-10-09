/** The bundled skill's directory name, used as the entry name in every agent. */
export declare const SKILL_NAME = "1session";
export type SkillAgent = 'claude' | 'codex' | 'antigravity' | 'grok' | 'dsh';
export interface AgentTarget {
    agent: SkillAgent;
    /** Where this agent loads user skills from. */
    skillsDir: string;
    /** Existence of this directory is what tells us the agent is installed. */
    homeDir: string;
}
/**
 * Every one of them loads `<dir>/<name>/SKILL.md` with the same YAML
 * frontmatter, so one bundled skill can serve all of them unchanged.
 */
export declare function agentTargets(home?: string): AgentTarget[];
/**
 * Walks up from this module to the package root holding the bundled skill, so
 * the same lookup works from `src/` under tsx and from `dist/src/` once built.
 */
export declare function bundledSkillDir(): string;
export type InstallMode = 'link' | 'copy';
/** What an entry at the install path currently is, before we touch anything. */
export type EntryState = {
    kind: 'absent';
} | {
    kind: 'linked';
    target: string;
    current: boolean;
} | {
    kind: 'copied';
    current: boolean;
} | {
    kind: 'foreign';
};
export interface AgentStatus extends AgentTarget {
    installed: boolean;
    entryPath: string;
    state: EntryState;
}
export declare function skillStatus(home?: string): AgentStatus[];
export interface InstallOptions {
    agents?: SkillAgent[];
    mode?: InstallMode;
    force?: boolean;
    dryRun?: boolean;
    home?: string;
}
export type InstallAction = 'linked' | 'copied' | 'unchanged' | 'skipped' | 'blocked';
export interface InstallResult {
    agent: SkillAgent;
    entryPath: string;
    action: InstallAction;
    note: string;
}
/**
 * Symlinks (or copies) the bundled skill into each agent's skills directory.
 * A link keeps every agent current for free on the next `npm i -g`; a copy is
 * the escape hatch for a loader that does not follow symlinks.
 */
export declare function installSkill(options?: InstallOptions): Promise<InstallResult[]>;
export type UninstallAction = 'removed' | 'absent' | 'blocked';
export interface UninstallResult {
    agent: SkillAgent;
    entryPath: string;
    action: UninstallAction;
    note: string;
}
/** Removes only entries this installer could have created, unless forced. */
export declare function uninstallSkill(options?: InstallOptions): Promise<UninstallResult[]>;
export declare function describeState(state: EntryState): string;
