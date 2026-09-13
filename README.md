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
| `1session handoff <session-id> [--anchors n] [--json]` | **交接简报**：把一个会话压成另一个智能体接手所需的状态 |
| `1session search <query> [--workspace p] [--since 24h] [--kind k1,k2] [--regex] [--case] [--context n] [--max-hits n] [--json]` | 跨会话全文检索：命中轮次 + 上下文片段 |

`<session-id>` 支持完整 id、id 前缀（≥6 位）或原始文件路径。

```bash
1session workspace . --since 24h --digest --focus marketing
```

**跨智能体接力**——上游会话收尾后，把状态交给下游，而不是粘 UI 滚屏：

```bash
1session handoff 01a0907c        # 上游会话 id
```

```text
# 交接简报 · codex 01a0907c
- 远程主机：100.115.178.96

## 用户的口径修正（务必遵守，按时间顺序）
- 这个描述不对哦，这不是英伟达的视频大模型，英伟达其实是基于 MiniMax H3 进行的优化。

## 状态锚点
- 📁 /home/admin/sol-spark-runtime（490 次）
- 📄 /home/admin/sol-spark-runtime/qwen-build.log（40 次）

## 未完成的后台任务（会话结束后仍在跑，去这里看结果）
- `cache-build.log` ← (r/'queue-cache.py').write_text(script)

## 上游最后的话
只剩两个大文件下载，我会把下载带宽重新分配给它们…
```

简报专治手工接力的三处丢失：**用户中途的口径修正**、**这盘棋的状态锚点**（远程主机 / 反复操作的目录与文件）、以及**会话结束后仍在跑的后台任务**——最后这一类在对话摘要里几乎必然丢失。

跨会话检索（`--kind` 可过滤轮次类型，只看用户说了什么 / 只看工具调用）：

```bash
1session search "xhs|小红书" --regex --workspace ~/proj --since 24h --kind user
```

```text
4 处命中，分布在 2 个会话

### antigravity 5575981e  2026-09-13T00:21:05Z → 2026-09-13T03:31:58Z  (2 命中)
  #318 user  /xhs-tech-card 结合 docs/xhs_sol_h3_spark_output/index.html，第一次实战经验贴。
  #441 user  /mobile-xhs-publisher
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
  searchSessions,
  buildHandoff,
} from '@1agents/session-reader';

const sessions = await findSessionsByWorkspace(process.cwd(), { since: '7d' });
const digest = distillSession(await parseSession(sessions[0].id), { focus: 'marketing' });
const story = await aggregateWorkspaceSessions(process.cwd(), { since: '24h' });
const hits = await searchSessions('小红书', { workspace: process.cwd(), since: '24h', kinds: ['user'] });
const brief = buildHandoff(await parseSession('01a0907c'));  // brief.markdown 可直接交给下游 agent
```

`aggregateWorkspaceSessions` 返回 `WorkspaceDigest`：`sessions` / `collaboratingAgents` /
`unifiedTimeline`（按时间排序的跨智能体节点）/ `fileAttribution`（文件 → 谁在什么时候改的）/ `markdown`。
适合直接喂给下游做小红书笔记、PRD、周报与 changelog，也可零成本包成 DeepSeek Harness（Cordis）插件或 MCP server。

## 设计取舍

- **发现是分层的**：先按文件 mtime 排序候选（只 `stat`），再按需读文件头填充元数据，最后才整篇解析。`list` 与 `workspace` 通常在 0.5 秒内返回。
- **`--since` 的精度**：预筛用文件 mtime（可能因同步/复制而失真），`--digest` 会在整篇解析后用真实轮次时间戳再过滤一次。
- **Claude 标题**：`list` 只读文件头，标题取首个用户请求；`inspect`/`digest`/`workspace --digest` 会整篇解析，此时优先使用会话自身的 `custom-title` / `ai-title`。
- **`search` 会整篇解析候选会话**（匹配的是 `text` + 工具结果 + 工具参数 JSON），所以先用 `--workspace` / `--since` / `--provider` 收窄，再放大 `--limit`（默认最多扫 30 个会话）。默认每个会话最多列 5 处命中，`totalMatches` 给的是真实总数。
- **文件归属分两级置信度**。`explicit` 来自显式写工具（`Write`/`Edit`/`write_to_file`/`replace_file_content`/`apply_patch`）；`inferred` 是从 shell 命令里解析出来的（`>`/`>>`、`tee`、`cp`/`mv`、`scp`、`sed -i`、python 的 `write_text`/`open(w)`），在展示时标 `~`。没有它，纯靠 shell 干活的智能体（如 codex 全程走 `exec` 沙箱）会显示成"一个文件都没改过"。这是启发式，可能漏也可能多报。
- **远程写会带 host**。命令形如 `ssh user@host '…'` 时，其中的写标记为 `host:/path`；但 `scp remote:src local_dst` 是往本地写，host 只认目标端自己写明的那个。

## 测试

```bash
npm test        # node --test，针对本机真实会话文件；无对应会话时自动 skip
npm run typecheck
```
