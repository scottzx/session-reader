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
| `1session overview <session-id> [--json]` | **第 1 层**：统计卡片（轮次/文件/命令/提交/产物/上传/后台任务/token）+ 目标、口径修正、状态锚点、全量落盘 |
| `1session turns <session-id> [--json]` | **第 2 层**：逐轮概要——时间、耗时、事件区间、文件/命令/失败数、用户说了什么、agent 回了什么 |
| `1session turn <session-id> <n> [--event k] [--json]` | **第 3 层**：展开某一轮的全部事件；`--event` 定位单次工具调用，输出完整参数与**未截断**结果 |
| `1session digest <session-id> [--focus marketing\|review\|full] [--json]` | 单会话蒸馏：目标、改动文件、命令、关键节点 |
| `1session workspace [path] [--since 24h] [--limit n] [--digest] [--focus f] [--json]` | **按 pwd 跨智能体聚合**（默认 `.`）；带 `--digest` 输出统一故事线 |
| `1session search <query> [--workspace p] [--since 24h] [--kind k1,k2] [--regex] [--case] [--context n] [--max-hits n] [--json]` | 跨会话全文检索：命中轮次 + 上下文片段 |

`<session-id>` 支持完整 id、id 前缀（≥6 位）或原始文件路径。

```bash
1session workspace . --since 24h --digest --focus marketing
```

**三层下钻**——先看全局，再定位到轮次，最后钻进单次工具调用：

```bash
1session overview 01a0907c        # 第 1 层：这个会话到底干了什么
```

```text
## 统计
| 轮次 | 事件 | 文件改动 | 命令 | 失败 | 提交 | 产物 | 上传 | 后台任务 |
| 15 | 923 | 15（31 次） | 336 | 27 | 0 | 0 | 0 | 0/0 完成 |
事件构成：user 15 · assistant 89 · thinking 143 · tool_call 338 · tool_result 338　｜　token：入 51105.9k / 出 185.4k
```

```bash
1session turns 01a0907c           # 第 2 层：15 轮，每轮干了什么、花了多久
```

```text
T 3 2026-09-11T13:03:29 (283s)  事件 29–45  文件 1 · 命令 7 · 失败 0
    ▸ ### 🎉 阶段性重大进展：MiniMax-H3 首次文生视频测试成功落地！…
    ◂ 已经查到一个明确的配置问题：这版 H3 的 `num_inference_steps=4` 实际只执行 3 次去噪…
```

```bash
1session turn 5575981e 1 --event 11   # 第 3 层：单次工具调用的完整输出
```

第三层会自动补全被截断的内容：antigravity 的 `transcript.jsonl` 会把长输出截短（事件 #11 只存了 4092 字符），命令会回读 `.system_generated/steps/8/output.txt` 拿到完整的 6937 字节并标注 `[已从 steps/ 补全]`；补不回来时如实提示 `⚠️ steps/N/output.txt 不存在`。

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
  buildOverview,
  summarizeTurns,
  turnDetail,
  eventDetail,
} from '@1agents/session-reader';

const sessions = await findSessionsByWorkspace(process.cwd(), { since: '7d' });
const digest = distillSession(await parseSession(sessions[0].id), { focus: 'marketing' });
const story = await aggregateWorkspaceSessions(process.cwd(), { since: '24h' });
const hits = await searchSessions('小红书', { workspace: process.cwd(), since: '24h', kinds: ['user'] });
const session = await parseSession('01a0907c');
const overview = buildOverview(session);      // 第 1 层：overview.stats / overview.markdown
const turns = summarizeTurns(session);        // 第 2 层
const detail = turnDetail(session, 3);        // 第 3 层
const full = await eventDetail(session, 11);  // 第 3 层：未截断的单次工具输出
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
- **统计优先用各家自己记的结构化数据，而不是我们推断**。codex 的 `event_msg/item_completed` 里有 `FileChange`（带 diff）、`CommandExecution`（带 pid/cwd）、`task_started/task_complete`（轮次边界 + 耗时）与 `token_usage_record`；claude 每条都带 `gitBranch`/`model`/`usage`；antigravity 的产物、上传、后台任务分别在 brain 目录、`.user_uploaded/` 与 `.system_generated/{tasks,messages}/`。统计里 `fileChangeSource` 会标明这次是 `provider` 还是 `inferred`。
- **轮次边界按时间对齐，不按下标**。codex 原生边界（12 个）比用户消息（15 条）少，按下标取耗时会错位。
- **远程写会带 host**。命令形如 `ssh user@host '…'` 时，其中的写标记为 `host:/path`；但 `scp remote:src local_dst` 是往本地写，host 只认目标端自己写明的那个。

## 测试

```bash
npm test        # node --test，针对本机真实会话文件；无对应会话时自动 skip
npm run typecheck
```
