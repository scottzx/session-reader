# @1agents/session-reader

**Read Plane（读平面）** —— 跨智能体会话的发现、逐轮解析、按 `pwd` 聚合与蒸馏。

读平面与执行平面解耦：不依赖任何常驻守护进程、不写库、不改会话，**以本地原始会话文件为唯一准绳**，纯 Node.js 标准库（`fs/promises`、`path`、`os`、`readline`）实现。

## 覆盖的智能体

| Provider | 落盘位置 | 工作区来源 |
| --- | --- | --- |
| `antigravity` | `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl`（+ 同级 `implementation_plan.md` / `walkthrough.md` 等产出物） | `run_command` 的 `Cwd`；缺失时由所操作文件向上找 `.git` |
| `claude` | `~/.claude/projects/<slug>/<session-id>.jsonl` | 条目自带的 `cwd` 字段（目录 slug 只用作快速预筛） |
| `codex` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | `session_meta` / `turn_context` 的 `cwd` |

所有会话被归一为同一组 `TurnEvent`：`user` / `assistant` / `thinking` / `tool_call` / `tool_result`。

## CLI

```bash
# 开发态（无需构建）
npx tsx bin/1session.ts <command>

# 构建后
npm run build && node dist/bin/1session.js <command>
```

| 命令 | 说明 |
| --- | --- |
| `1session list [--limit n] [--workspace path] [--provider name] [--since 24h] [--json]` | 按最近更新列出各智能体的会话 |
| `1session inspect <session-id> [--json]` | 会话概览：标题、工作区、时间跨度、各类轮次计数、产出物 |
| `1session digest <session-id> [--focus marketing\|review\|full] [--json]` | 单会话蒸馏：目标、改动文件、命令、关键节点 |
| `1session workspace [path] [--since 24h] [--limit n] [--digest] [--focus f] [--json]` | **按 pwd 跨智能体聚合**（默认 `.`）；带 `--digest` 输出统一故事线 |
| `1session turns <session-id> [-n index] [--json]` | 逐轮轨迹；`-n` 查看单轮全文 / 完整工具参数 |

`<session-id>` 支持完整 id、id 前缀（≥6 位）或原始文件路径。

```bash
1session workspace . --since 24h --digest --focus marketing
```

输出示例（上午 Antigravity 定方案 → 下午 Claude Code 落地实现，自动交织成一条时间线）：

```markdown
# 1agents_app · 跨智能体协作纪实
- 参与智能体：antigravity / claude
- 会话：2 个，统一时间线 12 个节点，涉及 1 个文件

## 统一时间线
- `2026-09-13T03:21:37Z` **antigravity** 提出：在 ./modules/ 创建一个 session-reader 的子模块…
- `2026-09-13T03:27:50Z` **antigravity** write_to_file → implementation_plan.md
- `2026-09-13T03:33:34Z` **claude** 提出：参考 implementation_plan.md，立即开始编码实现！
- `2026-09-13T03:36:52Z` **claude** 失败：src/resolver.ts(38,79): error TS1127: Invalid character.
```

## 编程接口

```ts
import {
  listRecentSessions,
  findSessionsByWorkspace,
  parseSession,
  distillSession,
  aggregateWorkspaceSessions,
} from '@1agents/session-reader';

const sessions = await findSessionsByWorkspace(process.cwd(), { since: '7d' });
const digest = distillSession(await parseSession(sessions[0].id), { focus: 'marketing' });
const story = await aggregateWorkspaceSessions(process.cwd(), { since: '24h' });
```

`aggregateWorkspaceSessions` 返回 `WorkspaceDigest`：`sessions` / `collaboratingAgents` /
`unifiedTimeline`（按时间排序的跨智能体节点）/ `fileAttribution`（文件 → 谁在什么时候改的）/ `markdown`。
适合直接喂给下游做小红书笔记、PRD、周报与 changelog，也可零成本包成 DeepSeek Harness（Cordis）插件或 MCP server。

## 设计取舍

- **发现是分层的**：先按文件 mtime 排序候选（只 `stat`），再按需读文件头填充元数据，最后才整篇解析。`list` 与 `workspace` 通常在 0.5 秒内返回。
- **`--since` 的精度**：预筛用文件 mtime（可能因同步/复制而失真），`--digest` 会在整篇解析后用真实轮次时间戳再过滤一次。
- **Claude 标题**：`list` 只读文件头，标题取首个用户请求；`inspect`/`digest`/`workspace --digest` 会整篇解析，此时优先使用会话自身的 `custom-title` / `ai-title`。
- **文件归属只统计"写"工具**（`Write`/`Edit`/`write_to_file`/`replace_file_content`/`apply_patch` 等）。通过 shell 写文件（heredoc、`sed -i`）不计入，命令本身仍会出现在 `commands` 里。

## 测试

```bash
npm test        # node --test，针对本机真实会话文件；无对应会话时自动 skip
npm run typecheck
```
