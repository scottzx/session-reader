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

## 安装

```bash
npm install @1agents/session-reader   # 作为库
npm install -g @1agents/session-reader  # 作为 1session 命令
npx @1agents/session-reader list      # 不安装直接用
```

要求 Node.js >= 22.5（依赖内置的 `node:sqlite`），零运行时依赖。

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
| `1session jobs <id> [--json]` | 异步作业账本：状态 + **证据** + pid / host / log |
| `1session commands <id> [--failed] [--host h] [--turn n] [--json]` | 命令账本：exit_code / 耗时 / cwd |
| `1session files <id> [--group project\|runtime\|log\|all] [--json]` | 文件账本，按项目 / 运行态 / 日志分组 |
| `1session errors <id> [--json]` | 失败命令，带 stderr 与"同前缀命令后续是否成功" |
| `1session search <query> [--workspace p] [--since 24h] [--limit n] [--kind k1,k2] [--regex] [--case] [--context n] [--max-hits n] [--json]` | 跨会话全文检索：命中轮次 + 上下文片段 |
| `1session index [<id>] [--all] [--force] [--since 30d]` | 建立 / 刷新索引；`--all` 全库回填 |
| `1session graph <id> [--json]`（别名 `related`） | 会话之间的引用关系 + 每条边的证据 |

全局开关 `--no-index` 绕过索引直读源文件。

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
  loadSession,
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
const session = await loadSession('01a0907c'); // 走索引；parseSession 直读源文件
const overview = buildOverview(session);      // 第 1 层：overview.stats / overview.markdown
const turns = summarizeTurns(session);        // 第 2 层
const detail = turnDetail(session, 3);        // 第 3 层
const full = await eventDetail(session, 11);  // 第 3 层：未截断的单次工具输出
```

`aggregateWorkspaceSessions` 返回 `WorkspaceDigest`：`sessions` / `collaboratingAgents` /
`unifiedTimeline`（按时间排序的跨智能体节点）/ `fileAttribution`（文件 → 谁在什么时候改的）/ `markdown`。
适合直接喂给下游做小红书笔记、PRD、周报与 changelog，也可零成本包成 DeepSeek Harness（Cordis）插件或 MCP server。

## 事实的边界：到哪一步为止

（注意与下文「索引」的 L0–L3 不是一回事：那是**数据存在哪**，这里是**事实可信到什么程度**。）

| 档 | 内容 | 例子 |
| --- | --- | --- |
| **源文件显式字段** | 各家自己记好的结构化数据，零猜测 | codex `CommandExecution` 的 336 条命令（带 `exit_code`/`stderr`/`pid`/`duration`）、`FileChange`、token 记账；claude 的 `gitBranch`/`model`/`usage`；antigravity 的产物 metadata、上传、任务回执 |
| **确定性规则派生** | 纯规则，可重复、可验证 | antigravity 打印的 `The command exited with code N` → 211 条 exit_code；`ssh user@host` → 主机；`git commit -m` + `[branch sha]` 回显 → 提交；路径按项目/运行态/日志分组；每个资源的首见/末见轮次 |
| **语义解释** | **本模块不做** | 当前主线、目标漂移、已完成/阻塞/下一步、决策归纳、坑的因果链、资源的 primary/legacy 角色 |

所以 overview 回答的是"**最后一条成功命令是什么**"，而不是"当前阻塞是什么"；给出"末态事实"而不是"进度判断"。语义层留白处会显式写明 `属语义层，本阶段不生成`，不假装。

### 三级溯源（provenance）

每条事实都带 `provenance` 与 `extractor`，回答"你为什么认为这是事实、来自哪个事件、用什么规则提取"：

| 级别 | 含义 | extractor 例子 |
| --- | --- | --- |
| `observed` | provider 自己记的结构化字段 | `tool:Write`、`item:FileChange`、`item:CommandExecution`、`receipt:messages` |
| `derived` | 对**确实执行过的动作**施加确定性规则 | `shell:redirect`、`shell:scp`、`pair:tool_call+tool_result` |
| `candidate` | 仅在文本里被提到，没有任何人动过它 | `text:path-mention`（只出现在「资源」一段） |

```bash
1session files 3ab9fe0e --group all
```

```text
[project] derived   T1 src/types.ts　`shell:redirect E42`
[runtime] observed  T5 ~/.claude/plans/codex-01a0907c-….md　`tool:Write E206`
[project] derived   T7 src/ledger.ts　`shell:redirect E415`
```

**文件账本永远不含 `candidate`**——路径只有在证明发生过写操作后才会进来。「资源」一段是唯一收纳 candidate 的地方，标题里写明了。

**先证明发生了文件操作，再抽路径**——而不是看到像路径的字符串就当成文件。具体地：here-doc 的正文（正在被写入的数据）在分析前会被剥离，否则里面的源码会伪装成命令——`(a, b) => b[1].length` 里的 `>` 会被当成重定向，payload 里的 `ssh admin@1.2.3.4` 会被当成真连过的主机。裸 token 还必须带真实扩展名，否则 `r.source`、`a.name` 都会被当成文件。

每条事实后面带 **Evidence Handle**（`E<事件号> · T<轮次>`），可以直接下钻验证：

```bash
1session turn 3ab9fe0e 9 --event 491
```

同样的原则贯穿每一处：**没有证据就不断言**。异步作业只在有完成回执时标 `completed`，否则一律 `unknown` 并写明依据；没有打印 exit code 的命令结果，`exitCode` 就是空，绝不补成 0。

## 轮次完成状态

第二层每一轮带一个**有证据的状态**——只说这一轮有没有收尾，不说做成了什么：

| 标记 | 状态 | 判据 |
| --- | --- | --- |
| `✓` | completed | 有原生 `task_complete`，或以 assistant 收尾且下一轮不是催促 |
| `⚠` | unfinished | 有 `task_started` 但没有配对的 `task_complete` |
| `↻` | nudged | 下一轮是纯推进指令（`继续`/`continue`），记连续次数 |
| `✂` | interrupted | 轮内有 `tool_call` 却没有对应结果 |
| `⊘` | no_response | 除用户消息外没有任何助理事件 |
| `✗` | failed_tail | 以 `exit ≠ 0` 收尾且其后无 assistant |

多条证据可以同时命中，此时置信度更高。实例：

```text
⚠ T 9 ... [unfinished ×2]
    ! provider 记录了 task_started 但没有配对的 task_complete（turn 01a095f4-5b27）；下一轮是纯推进指令，连续 2 次（"contin"）
```

这一轮切换到 Sol-H3-Spark 没跑完 → 用户打了 `contin` → 又打 `continue`。**两条独立证据指向同一结论，不需要模型参与。**

## 设计取舍

- **发现是分层的**：先按文件 mtime 排序候选（只 `stat`），再按需读文件头填充元数据，最后才整篇解析。`list` 与 `workspace` 通常在 0.5 秒内返回。
- **`--since` 的精度**：预筛用文件 mtime（可能因同步/复制而失真），`--digest` 会在整篇解析后用真实轮次时间戳再过滤一次。
- **Claude 标题**：`list` 只读文件头，标题取首个用户请求；`inspect`/`digest`/`workspace --digest` 会整篇解析，此时优先使用会话自身的 `custom-title` / `ai-title`。
- **`search` 没有扫描上限**。早先它受发现层的扫描预算限制，一次查询其实只看最近 ~60 个会话／每个智能体，却把结果报告得像查全了——"静默不全"比慢危险。现在 `--limit` 只管返回几个会话，不再兼任"最多检查几个会话"；满足 `--workspace` / `--since` / `--provider` 的会话一个不漏。默认每个会话最多列 5 处命中，`totalMatches` 给的是真实总数。
- **文件归属分三级溯源**（见上文 provenance）。`observed` 来自显式写工具（`Write`/`Edit`/`write_to_file`/`replace_file_content`/`apply_patch`）与 provider 自己记的 `FileChange`；`derived` 是从 shell 命令里解析出来的（`>`/`>>`、`tee`、`cp`/`mv`、`scp`、`sed -i`、python 的 `write_text`/`open(w)`）。没有后者，纯靠 shell 干活的智能体（如 codex 全程走 `exec` 沙箱）会显示成"一个文件都没改过"。这是启发式，可能漏也可能多报，所以每行都写明是哪条规则提取的。
- **轮次边界按"其后最近开始的那一轮"归属**。`task_started` 总比该轮第一个事件早几秒（12:41:06 vs 12:41:13），按"落在窗口内"匹配会全部落空。
- **统计优先用各家自己记的结构化数据，而不是我们推断**。codex 的 `event_msg/item_completed` 里有 `FileChange`（带 diff）、`CommandExecution`（带 pid/cwd）、`task_started/task_complete`（轮次边界 + 耗时）与 `token_usage_record`；claude 每条都带 `gitBranch`/`model`/`usage`；antigravity 的产物、上传、后台任务分别在 brain 目录、`.user_uploaded/` 与 `.system_generated/{tasks,messages}/`。统计里 `filesByProvenance` 给出这次的 `observed / derived` 分项计数。
- **轮次边界按时间对齐，不按下标**。codex 原生边界（12 个）比用户消息（15 条）少，按下标取耗时会错位。
- **token 把缓存复用单列**。claude 每次请求的真实 `input_tokens` 平均只有 2，而 `cache_read_input_tokens` 平均 30 万（重读整个缓存前缀）；把后者计入输入会让一个 20 万上下文的会话显示成 1.16 亿 token。现在 `input` 只含真正写入模型的部分，缓存复用记在 `cacheRead`。
- **失败只有一个定义**：exit code 明确非 0，或 exit code 未知但 provider 标了错。`stats.errors` 与 `1session errors` 永远是同一个数。
- **文件也只有一个账本**。`overview` 的统计、`overview --json` 的 `writes`、`1session files --group all` 三者行数恒等，且 `project + runtime + log` 必须刚好铺满（有测试钉住）。`filesChanged` 是去重后的文件数，`fileChangeEvents` 是写动作次数（同一文件写三次算三次），两者定义不同所以可以不等。混合账本不给单一来源标签，而是给 `observed / derived` 的分项计数。
- **远程写会带 host**。命令形如 `ssh user@host '…'` 时，其中的写标记为 `host:/path`；但 `scp remote:src local_dst` 是往本地写，host 只认目标端自己写明的那个。

## 索引：把事实存下来，而不是每次重推

`~/.1agents/session-reader/index.db`（SQLite，`SESSION_READER_DB` 可改）。任何命令碰到一个会话都会顺手索引它；`1session index --all` 做全库回填。

```
L0  各家原始 JSONL                        ← 永远是唯一真相
L1  归一事件  sessions / events
L2  确定性事实  file_ops / commands / jobs
L3  会话关系  session_edges / edge_evidence
```

**四个版本号各管一层**（`src/store/schema.ts`），这是分层的实际收益：

| 变了什么 | 代价 |
| --- | --- |
| 源文件指纹 或 `PARSER_VERSION` | 重读文件，L1/L2/L3 全部重建 |
| `EXTRACTOR_VERSION` | **一个字节的 JSONL 都不读**，从 `events` 行重新推导 L2 |
| `EDGE_VERSION` | 同上，只重推 L3 |
| `SCHEMA_VERSION` | 删库重建（L0 能重建全部，不写迁移代码） |

指纹 = 大小 + mtime + 文件头 64KB 的 sha256。没有"会话是否结束"这个概念——指纹没变就是没变。

**事件文本整条存，不截断**。曾经按 128KB 封顶，实测代价是全库 622 个会话里只有 7 个事件超限、省下 0.08% 的体积，却让 `search` 漏掉长构建日志里的命中（`--deployment-target` 正好落在切口之后）——用 0.08% 换一个"看起来查全了其实没有"的答案，方向反了。本机实测：622 个会话首次回填 7.5s，索引 297MB。

**索引只许加速事实，不许改动事实**。测试里钉着一条往返等价：三个 provider 各取一个真实会话，`parse()` 的结果与索引读回的结果必须 `deepStrictEqual`，`buildOverview` 的 markdown 也必须逐字相同。命令行上随时可复核：

```bash
diff <(1session overview <id>) <(1session overview <id> --no-index)
```

### 检索：SQL 出候选，正则下判决

`search` 不再把 622 个会话还原成对象——那一步比其余所有环节加起来还贵（实测 1.33s）。现在是 **SQL 预筛 + 原有正则裁决**：

```
Query
  ↓  planQuery：能不能证明出一个"必然出现"的子串？
SQL  instr() 预筛（外加 workspace / kind / since 下推）
  ↓
现有 regex matcher ← 唯一的语义权威
Hit
```

分三档：

| 查询 | 处理 |
| --- | --- |
| 字面量 `src/ledger.ts`、`会话` | 直接 `instr()` 预筛 |
| 正则且能安全抽出必然子串 `src/.*ledger\.ts` → `ledger` | `instr()` 预筛 + 正则裁决 |
| 抽不出来 `(foo\|bar)`、`\d+\.\d+` | 不预筛，流式扫行 + 正则裁决 |

**抽取器故意保守**：出现 `|` 或任何分组就直接放弃；`abc?def` 只敢claim `def`（`c` 可能不存在）。宁可全表扫，也不要一个"看起来搜过了其实漏了"的答案——这和截断上限是同一类错误。

两个必须对齐的细节，都有测试钉住：

- **大小写折叠**。`gi` 正则在非 `u` 模式下只折叠 ASCII，SQLite 的 `lower()` 恰好也只折叠 ASCII，所以纯 ASCII 字面量可以两边一起折。非 ASCII 则取最长的"无大小写"字符串（CJK 折叠是恒等），用大小写敏感的 `instr` 比。
- **预筛按列比，不按拼好的 haystack 比**。匹配串一旦跨列就会漏，所以含换行的字面量直接不预筛。

中文不需要分词：`instr` 是子串匹配，搜「会话」在「跨会话检索」里天然能中——这正是 FTS5 做不到的（`unicode61` 把整段当一个 token，`trigram` 要求 ≥3 字符，两者搜「会话」都是 0 命中）。Agent transcript 里大量内容是 session id / 路径 / CLI flag / 变量名 / commit hash，子串语义本来就比 token 语义更贴合。

本机实测（622 个会话）：

| 查询 | 改造前 | 现在 |
| --- | --- | --- |
| `deploy`（1631 命中 / 239 会话） | 1.62s※ | 0.47–0.60s |
| `会话`（2336 命中 / 263 会话） | 1.14s※ | 0.35–0.39s |
| `src/ledger.ts` | 1.1s※ | 0.43–0.46s |

※ 改造前那几个数字还只覆盖了 ≤180 个会话。以上都是热缓存；文件缓存冷时首跑约 1.8s，绝大部分花在 622 次 stat 与指纹头读上。现在是全库，而且 `search` 与 `search --no-index` 的**会话集合 / 命中数 / excerpt / 顺序逐项相同**（10 种查询形态验证过）。

### 会话关系图（L3）

边从真实工具调用里长出来，不猜。B 跑了 `1session overview A`，就记一条 `B --references--> A`：

结构化的问题不要走全文检索——L2/L3 有确定答案：

| 问题 | 该查 |
| --- | --- |
| 哪些会话文本里**提到过** `src/ledger.ts` | `search` |
| 哪些会话**确实动过**它 | `file_ops`（`1session files`） |
| 谁引用过 `01a0907c` | `session_edges`（`1session graph`） |

```
$ 1session graph ca8325e1
  → references    claude:3ab9fe0e…　证据 9 次（overview turns overview files files …）
  → references    codex:01a0907c…　证据 2 次（overview overview）
```

关系表一条、证据表多条，所以能区分"瞥了一眼"和"全程在消费"。规范方向只存 `from=调用方`，反向由展示层翻成 `referenced_by`。

三条硬约束：

- **here-doc 正文先剥掉**（复用 `writes.ts` 的 `stripHeredocs`）。文档里写着 `1session overview xxx` 的代码块不是调用，把它算成边就会凭空造出关系——这和早先把 here-doc 里的 `r.source`、`1.2.3.4` 当成真实文件和主机是同一个坑。
- **目标必须能解析成已索引的会话**，否则不落边。悬空边比没有边更糟。
- **幂等**：重新索引不会让证据计数膨胀（计数是数出来的，不是累加的）。

本期只实装 `references` 与 `handoff_from`；`forked_from` / `resumed_from` / `sends_to` 在类型里预留但从不猜测。

运行时捕获：若环境注入了 `SESSION_READER_CALLER_SESSION`，调用当下就直接落边（`observed / runtime:caller-env`），无需事后从历史里恢复。

## 测试

```bash
npm test        # node --test，针对本机真实会话文件；无对应会话时自动 skip
npm run typecheck
```

## 发布

npm 包为 `@1agents/session-reader`，由 GitHub Actions 发布，本地不手工 `npm publish`：

- `.github/workflows/ci.yml` —— push 到 `main` 与 PR 上跑 `typecheck` / `test` / `build` / `npm pack --dry-run`。
- `.github/workflows/release.yml` —— 手动触发（Actions → Release → Run workflow），输入 `patch` / `minor` / `major` / `prerelease` 或具体版本号。流程：跑测试 → `npm version` 打版本提交与 tag → `npm publish`（带 provenance）→ 推送 commit 与 tag → 创建 GitHub Release。

发布顺序是先 publish 再 push：npm 发布失败时远端不会留下悬空的版本提交和 tag，直接重跑即可。

仓库需要配置 secret `NPM_TOKEN`（npm 上具备该包发布权限的 Automation token）。
