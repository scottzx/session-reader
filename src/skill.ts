import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bundled skill's directory name, used as the entry name in every agent. */
export const SKILL_NAME = '1session';

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
export function agentTargets(home: string = os.homedir()): AgentTarget[] {
  return [
    {
      agent: 'claude',
      homeDir: path.join(home, '.claude'),
      skillsDir: path.join(home, '.claude', 'skills'),
    },
    {
      agent: 'codex',
      homeDir: path.join(home, '.codex'),
      skillsDir: path.join(home, '.codex', 'skills'),
    },
    {
      agent: 'antigravity',
      // Not ~/.gemini/skills — that belongs to gemini-cli, not Antigravity.
      homeDir: path.join(home, '.gemini', 'antigravity'),
      skillsDir: path.join(home, '.gemini', 'antigravity', 'skills'),
    },
    {
      agent: 'grok',
      homeDir: path.join(home, '.grok'),
      skillsDir: path.join(home, '.grok', 'skills'),
    },
    {
      agent: 'dsh',
      homeDir: path.join(home, '.dsh'),
      skillsDir: path.join(home, '.dsh', 'skills'),
    },
  ];
}

/**
 * Walks up from this module to the package root holding the bundled skill, so
 * the same lookup works from `src/` under tsx and from `dist/src/` once built.
 */
export function bundledSkillDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'skills', SKILL_NAME);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('bundled skill not found — is the package installed completely?');
}

export type InstallMode = 'link' | 'copy';

/** What an entry at the install path currently is, before we touch anything. */
export type EntryState =
  | { kind: 'absent' }
  | { kind: 'linked'; target: string; current: boolean }
  | { kind: 'copied'; current: boolean }
  | { kind: 'foreign' };

export interface AgentStatus extends AgentTarget {
  installed: boolean;
  entryPath: string;
  state: EntryState;
}

function sameVersion(entryPath: string, source: string): boolean {
  try {
    const a = fs.readFileSync(path.join(entryPath, 'SKILL.md'), 'utf8');
    const b = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
    return a === b;
  } catch {
    return false;
  }
}

function inspect(entryPath: string, source: string): EntryState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryPath);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(entryPath);
    const resolved = path.resolve(path.dirname(entryPath), target);
    return { kind: 'linked', target: resolved, current: resolved === source };
  }
  if (stat.isDirectory() && fs.existsSync(path.join(entryPath, 'SKILL.md'))) {
    return { kind: 'copied', current: sameVersion(entryPath, source) };
  }
  return { kind: 'foreign' };
}

export function skillStatus(home?: string): AgentStatus[] {
  const source = bundledSkillDir();
  return agentTargets(home).map((target) => {
    const entryPath = path.join(target.skillsDir, SKILL_NAME);
    return {
      ...target,
      installed: fs.existsSync(target.homeDir),
      entryPath,
      state: inspect(entryPath, source),
    };
  });
}

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
export async function installSkill(options: InstallOptions = {}): Promise<InstallResult[]> {
  const { mode = 'link', force = false, dryRun = false } = options;
  const source = bundledSkillDir();
  const wanted = options.agents?.length ? new Set(options.agents) : undefined;
  const results: InstallResult[] = [];

  for (const status of skillStatus(options.home)) {
    if (wanted && !wanted.has(status.agent)) continue;
    const { agent, entryPath, skillsDir, state } = status;

    // An explicitly named agent is installed into even if we cannot see it, so
    // a fresh install of that agent picks the skill up later.
    if (!status.installed && !wanted) {
      results.push({ agent, entryPath, action: 'skipped', note: `未安装（${status.homeDir} 不存在）` });
      continue;
    }
    if (state.kind === 'linked' && state.current && mode === 'link') {
      results.push({ agent, entryPath, action: 'unchanged', note: '已链接到当前包' });
      continue;
    }
    if (state.kind === 'copied' && state.current && mode === 'copy') {
      results.push({ agent, entryPath, action: 'unchanged', note: '已是当前版本' });
      continue;
    }
    if (state.kind === 'foreign' && !force) {
      results.push({ agent, entryPath, action: 'blocked', note: '同名条目不是 skill 目录，--force 覆盖' });
      continue;
    }
    if (state.kind === 'copied' && !state.current && mode === 'link' && !force) {
      results.push({ agent, entryPath, action: 'blocked', note: '已有一份拷贝，--force 换成链接' });
      continue;
    }
    if (dryRun) {
      results.push({
        agent,
        entryPath,
        action: mode === 'link' ? 'linked' : 'copied',
        note: `将${mode === 'link' ? '链接' : '复制'}（--dry-run 未执行）`,
      });
      continue;
    }

    await fsp.mkdir(skillsDir, { recursive: true });
    if (state.kind !== 'absent') await fsp.rm(entryPath, { recursive: true, force: true });
    if (mode === 'link') {
      await fsp.symlink(source, entryPath, 'dir');
      results.push({ agent, entryPath, action: 'linked', note: `→ ${source}` });
    } else {
      await fsp.cp(source, entryPath, { recursive: true });
      results.push({ agent, entryPath, action: 'copied', note: `← ${source}` });
    }
  }
  return results;
}

export type UninstallAction = 'removed' | 'absent' | 'blocked';

export interface UninstallResult {
  agent: SkillAgent;
  entryPath: string;
  action: UninstallAction;
  note: string;
}

/** Removes only entries this installer could have created, unless forced. */
export async function uninstallSkill(options: InstallOptions = {}): Promise<UninstallResult[]> {
  const { force = false, dryRun = false } = options;
  const wanted = options.agents?.length ? new Set(options.agents) : undefined;
  const results: UninstallResult[] = [];

  for (const status of skillStatus(options.home)) {
    if (wanted && !wanted.has(status.agent)) continue;
    const { agent, entryPath, state } = status;
    if (state.kind === 'absent') {
      results.push({ agent, entryPath, action: 'absent', note: '未安装' });
      continue;
    }
    if (state.kind === 'foreign' && !force) {
      results.push({ agent, entryPath, action: 'blocked', note: '不像本 skill，--force 才删' });
      continue;
    }
    if (!dryRun) await fsp.rm(entryPath, { recursive: true, force: true });
    results.push({
      agent,
      entryPath,
      action: 'removed',
      note: dryRun ? '将删除（--dry-run 未执行）' : state.kind === 'linked' ? '已移除链接' : '已移除目录',
    });
  }
  return results;
}

export function describeState(state: EntryState): string {
  switch (state.kind) {
    case 'absent':
      return '未安装';
    case 'linked':
      return state.current ? `链接 → 当前包` : `链接 → ${state.target}（指向别处）`;
    case 'copied':
      return state.current ? '拷贝（与当前包一致）' : '拷贝（与当前包不一致，重装以更新）';
    case 'foreign':
      return '同名条目存在，但不是 skill 目录';
  }
}
