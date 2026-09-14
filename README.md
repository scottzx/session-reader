# @1agents/session-reader

**Read Plane（读平面）** —— 跨智能体会话的发现、逐轮解析、按 `pwd` 聚合与蒸馏。

读平面与执行平面解耦：不依赖任何常驻守护进程、不写库、不改会话，**以本地原始会话文件为唯一准绳**，纯 Node.js 标准库（`fs/promises`、`path`、`os`、`readline`、`zlib`）实现。

## 覆盖的智能体

| Provider | 落盘位置 | 工作区来源 |
| --- | --- | --- |
| `antigravity` | `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl`（+ 同级 `implementation_plan.md` / `walkthrough.md` 等产出物） | `run_command` 的 `Cwd`；缺失时由所操作文件向上找 `.git` |
| `claude` | `~/.claude/projects/<slug>/<session-id>.jsonl` | 条目自带的 `cwd` 字段（目录 slug 只用作快速预筛） |
| `codex` | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | `session_meta` / `turn_context` 的 `cwd` |
| `dsh`（DeepSeek Harness） | `~/.dsh/sessions/<slug>/session-<uuid>/session.v2.jsonl.zstd`（**zstd 分帧压缩**） | 开篇 `session` 记录的 `cwd` |
| `grok` | `~/.grok/sessions/<percent-encoded cwd>/<uuid>/chat_history.jsonl`（+ 同目录 `events.jsonl` / `rewind_points.jsonl` / `updates.jsonl` / `summary.json` / `goal/*.md`） | `summary.json` 的 `info.cwd`；目录名本身就是 cwd 的百分号编码，可反解 |

所有会话被归一为同一组 `TurnEvent`：`user` / `assistant` / `thinking` / `tool_call` / `tool_result`。

两家新来的各自带一个别人没有的麻烦，都在解析层吃掉了：

- **dsh 的 zstd 是「一次 flush 一帧」追加出来的**，整个文件是若干完整帧首尾相接。Node 的
  `zstdDecompressSync` 和 `createZstdDecompress` 都只解第一帧就停——不报错，只是安静地
  少给你 99% 的会话。`src/util/zstd.ts` 按 RFC 8878 的帧头逐帧走位（不解压就能算出每帧
  边界），整文件读全；正在写入的半截尾帧丢掉而不是毒化整个会话。
- **grok 的 `chat_history.jsonl` 里一个时间戳都没有**。时间、工具成败、后台回执分散在同目录
  的侧文件里：`events.jsonl` 的 `tool_started`/`tool_completed`（按 `tool_call_id` 对上，给
  出耗时与 `outcome`）、`rewind_points.jsonl` 的 `prompt_index → created_at`（用户消息的
  确切时刻）、`updates.jsonl` 的 ACP 流（助理消息与思考的时刻，**按文本本身对上**而不是按
  位置猜；对不上就宁可不给时间戳）。token 记账也只有 `updates.jsonl` 有，没有这个文件的
  会话就如实不报 token。

## 安装

```bash
npm install @1agents/session-reader   # 作为库
npm install -g @1agents/session-reader  # 作为 1session 命令
npx @1agents/session-reader list      # 不安装直接用
```

要求 Node.js >= 22.15（`node:sqlite` 建索引，`node:zlib` 的 zstd 读 dsh 的压缩会话；zstd 是 22.15 才进 `node:zlib` 的）。
唯一的运行时依赖是自家的 [`@1agents/dreammate-network`](https://github.com/scottzx/dreammate-network)
——L0 协议定义，12 kB，本身零依赖——`npm install` 会自动带上，不需要单独装。

## 内置 skill：一条命令装到五家智能体

`1session` 自带一个 skill（`skills/1session/`），装进各家智能体自己的 skills 目录后，
它们在用户问起"上次/之前/那个报错"时会自己想起来调这个 CLI，而不需要你每次手动贴命令。

```bash
1session skill install        # 链接到五家（未安装的智能体会跳过）
1session skill status         # 看五家各自是什么状态
1session skill uninstall      # 撤掉
```

| 智能体 | 落位 |
| --- | --- |
| claude | `~/.claude/skills/1session` |
| codex | `~/.codex/skills/1session` |
| antigravity | `~/.gemini/antigravity/skills/1session`（**不是** `~/.gemini/skills`，那是 gemini-cli 的位） |
| grok | `~/.grok/skills/1session` |
| dsh | `~/.dsh/skills/1session` |

五家的格式完全一致（`<dir>/<name>/SKILL.md` + YAML frontmatter），所以装的是同一份文件。

默认建**符号链接**而不是拷贝：下次 `npm i -g @1agents/session-reader@latest` 升级后，
各家看到的 skill 自动就是新的，不用记着重装。Claude Code 实测会跟随符号链接并热加载。
如果某家的加载器不认符号链接（表现是 `status` 显示已链接、但智能体里看不到这个 skill），
用 `1session skill install --copy` 换成拷贝——代价是升级后要重跑一次安装，`status`
会把"拷贝与当前包不一致"显式标出来。

其他开关：`--agent claude,codex`（只装指定的几家，即使该智能体尚未安装也会建目录，
方便先装 skill 后装智能体）、`--dry-run`（只说会做什么）、`--force`（覆盖同名条目）。

**别用 `npx` 跑 `skill install`。** 默认的链接模式会指回包所在目录，而 npx 装的那份在
`~/.npm/_npx/<hash>/` 的缓存里，npm 自己会清。清掉那天五家的 skill 一起静悄悄消失。
先 `npm i -g` 再 `skill install`；实在要从 npx 引导就加 `--copy`，把字节交给各家自己拿着。

传播给别人时，两行就够——第二行是大家会忘的那行：只装 CLI 的人得自己记着它存在，
两行都跑了的人是智能体替他记着。

```bash
npm i -g @1agents/session-reader
1session skill install
```

skill 自己也带着这套安装说明（`skills/1session/references/install.md`）：即便对方只拿到
一份 SKILL.md、机器上没有 CLI，它也会先用 `npx` 把问题回答掉，再回头提一次永久安装。

## CLI

```bash
# 开发态（无需构建）
npx tsx bin/1session.ts <command>

# 构建后
npm run build && node dist/bin/1session.js <command>
```

| 命令 | 说明 |
| --- | --- |
| `1session list [--limit n] [--scope <path>\|cwd\|global] [--provider name] [--since 24h] [--json]` | 按最近更新列出各智能体的会话（默认当前 pwd 子树，见 `--scope`） |
| `1session overview <session-id> [--json]` | **第 1 层**：统计卡片（轮次/文件/命令/提交/产物/上传/后台任务/token）+ 目标、口径修正、状态锚点、全量落盘 |
| `1session turns <session-id> [--json]` | **第 2 层**：逐轮概要——时间、耗时、事件区间、文件/命令/失败数、用户说了什么、agent 回了什么 |
| `1session turn <session-id> <n> [--event k\|a-b\|a,b,c] [--json]` | **第 3 层**：展开某一轮的全部事件；`--event` 定位工具调用，输出完整参数与**未截断**结果，支持 `491`、`491-493`、`491,495,502` |
| `1session digest <session-id> [--focus marketing\|review\|full] [--json]` | 单会话蒸馏：目标、改动文件、命令、关键节点 |
| `1session workspace [path] [--since 24h] [--limit n] [--digest] [--focus f] [--json]` | **按 pwd 跨智能体聚合**（默认 `.`）；带 `--digest` 输出统一故事线 |
| `1session jobs <id> [--json]` | 异步作业账本：状态 + **证据** + pid / host / log |
| `1session commands <id> [--failed] [--host h] [--turn n] [--json]` | 命令账本：exit_code / 耗时 / cwd |
| `1session files <id> [--group project\|runtime\|log\|all] [--json]` | 文件账本，按项目 / 运行态 / 日志分组 |
| `1session errors <id> [--json]` | 失败命令，带 stderr 与"同前缀命令后续是否成功" |
| `1session search <query> [--scope <path>\|cwd\|global] [--since 24h] [--limit n] [--kind k1,k2] [--regex] [--case] [--context n] [--max-hits n] [--include-self] [--json]` | 跨会话全文检索：命中带 `T<轮次> · E<事件号>` 句柄 + 上下文片段（默认当前 pwd 子树，见 `--scope`） |
| `1session index [<id>] [--all] [--scope <path>\|cwd\|global] [--force] [--since 30d]` | 建立 / 刷新索引；`--all` 全库回填 |
| `1session graph <id> [--json]`（别名 `related`） | 会话之间的引用关系 + 每条边的证据 |
| `1session skill install\|status\|uninstall [--agent a,b] [--copy] [--force] [--dry-run]` | 把内置 skill 装进五家智能体的 skills 目录（见上） |

全局开关 `--no-index` 绕过索引直读源文件。

### `--scope`：会话按路径子树取

`list` / `search` / `index --all` **默认只看当前 pwd 这棵子树下的会话**；跨项目要显式说出来。`--scope` 取三种值：

| 值 | 含义 |
| --- | --- |
| 省略 / `cwd` | 当前 pwd **及其所有子目录**下的会话 |
| 相对路径（`..`、`../web`、`~/proj`）或绝对路径（`/Users/me/proj`） | 该目录**及其所有子目录**下的会话 |
| `global`（或 `--global`，或 `--scope /`） | 全部会话 |

按子树取而不是按目录相等取：`--scope ~/Documents` 会列出 `~/Documents` 下每一个项目的会话，而不只是恰好在 `~/Documents` 里启动的那几个。目录写错会直接报错，不会静悄悄地返回"0 个会话"。

```bash
1session list                        # 当前项目（含子模块）
1session list --scope ..             # 连同同级的兄弟项目
1session list --scope ~/Documents    # 这棵树下的全部项目
1session list --global               # 全部
1session search "超时" --scope ../..  # 在祖父目录这棵树里检索
1session index --all --global        # 全库回填索引
```

（`--workspace <path>` 是路径形式的旧拼法，仍然可用，优先于 `--scope`。）

**路径从哪来**（各家各写各的，读之前先归一）：

| Provider | 项目路径 | 时间 |
| --- | --- | --- |
| claude | 目录名 = cwd 的 slug（`~/.claude/projects/-Users-me-proj/`），每行 JSONL 另带 `cwd` | `updatedAt` = 文件 mtime；`createdAt` = 首行 `timestamp` |
| codex | 目录只按日期分（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`），路径只在 `session_meta` / `turn_context` 的 `payload.cwd` 里 | `updatedAt` = mtime；`createdAt` = `session_meta.timestamp`，兜底解析文件名里的时间戳 |
| antigravity | transcript 里没有 cwd，但 IDE 自己维护着项目↔会话的关系：`~/.gemini/antigravity/conversations/<id>.db` 的 `trajectory_metadata_blob` 里存着打开的目录（protobuf 字段 1.1，`file://` URI；1.2 是外层 workspace 根，1.4 是 git 分支）。读它，读不到才退回从工具参数里猜 | `updatedAt` = mtime；`createdAt` = 首个 step 的 `created_at` |
| dsh | 目录名是 cwd 的有损编码（`-` 同时代表 `/` 和字面 `-`），只当参考；真 cwd 在开篇 `session` 记录的 `cwd` 里。`scanRef` 只解压文件头 64KB——zstd 帧自带边界，取前缀就等于取会话前缀 | `updatedAt` = mtime；`createdAt` = `session.createdAt`（epoch 毫秒） |
| grok | 目录名是 cwd 的**百分号编码**，`decodeURIComponent` 就能无损还原，所以带 `--scope` 时可以在开文件之前就筛掉不相干的会话；`summary.json` 的 `info.cwd` 是正式答案 | `updatedAt` / `createdAt` 直接取 `summary.json`；候选发现时的 mtime 取 `chat_history.jsonl` 与 `summary.json` 里较新的那个 |

排序和 `--since` 都只用 mtime，`listCandidates()` 一次 `stat` 就够，不必打开文件 —— 打开文件（拿标题、cwd、创建时间）才是贵的那一步，所以它走索引缓存。

Antigravity 的 626 个会话里，本机有 14 个至今没有路径 —— 不是没读到，是 IDE 自己把它们标成了 `outside-of-project`（开着聊天窗口、没开文件夹时起的会话）。这类会话只在 `--global` 下出现。

### 列表为什么是全的

`list` / `workspace` / `search` 都走索引：先对每个会话文件做一次指纹检查（size + mtime + 头部哈希），**只有字节动过的才重新解析**，然后用一条 SQL 出结果。所以：

- 没有扫描预算，`--scope` 再大也不会悄悄丢掉更早的会话；
- 第一次全量解析本机 625 个会话约 **10s**，之后每次 `list` 约 **0.5s**；
- `--no-index` 仍然可以绕开索引直读源文件，两条路的结果应当逐条一致（可以 `diff` 验证）。

升级到这一版后，索引会因为 `PARSER_VERSION` / `EXTRACTOR_VERSION` 提升而自动重建一次（新增 grok / dsh 两家，写文件工具表也跟着补了 `search_replace` 与 `run_terminal_command`），无需手动清库；想主动做可以跑 `1session index --all --global`。

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
1session turn 5575981e 1 --event 11      # 第 3 层：单次工具调用的完整输出
1session turn 5575981e 1 --event 11-13   # 连着看：调用 + 结果 + 助理的判断
```

`--event` 收 `11`、`11-13`、`11,15,22` 及其混合，一次最多 50 条；区间会按会话长度裁剪，
所以 `560-999` 就是「看到结尾」。读一次工具调用通常要连读它的结果和后面那条助理判断——
一个进程读完，而不是起三次。

第三层会自动补全被截断的内容：antigravity 的 `transcript.jsonl` 会把长输出截短（事件 #11 只存了 4092 字符），命令会回读 `.system_generated/steps/8/output.txt` 拿到完整的 6937 字节并标注 `[已从 steps/ 补全]`；补不回来时如实提示 `⚠️ steps/N/output.txt 不存在`。

跨会话检索（`--kind` 可过滤轮次类型，只看用户说了什么 / 只看工具调用）：

```bash
1session search "xhs|小红书" --regex --workspace ~/proj --since 24h --kind user
```

```text
4 处命中，分布在 2 个会话
（已折叠 1 处本次检索自身留下的回声；--include-self 展开）

### antigravity 5575981e  2026-09-13T00:21:05Z → 2026-09-13T03:31:58Z  (2 命中)
  T7 · E318 user  /xhs-tech-card 结合 docs/xhs_sol_h3_spark_output/index.html，第一次实战经验贴。
  T9 · E441 user  /mobile-xhs-publisher
    ↳ 1session turn 5575981e 7 --event 318
```

每条命中前缀就是**下钻句柄** `T<轮次> · E<事件号>`——顺序照着 `turn <id> <T> --event <E>` 排，
每个会话再附一条拼好的命令，从第 1 层到第 3 层不用再跑一趟 `turns` 人工比对事件区间。

**默认折叠本次检索自己留下的脚印**：调用方的会话是边跑边索引的，`1session search "X"` 这条
命令本身（以及它打印出来的东西）会立刻成为 `X` 的第一条命中。判据只有一条——五分钟内写下的
`1session` 调用及其结果；只有活着的那个 transcript 才可能有「此刻」的时间戳，所以历史会话一条
都不会被碰到。折叠了多少永远会打印出来，`--include-self` 可以全部展开。

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
  eventDetails,
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
const around = await eventDetails(session, '11-13'); // 相邻几条一起读
hits[0]?.matches[0]?.turn;                    // 命中所在轮次，与 match.index 凑成 T·E 句柄
```

`searchSessions` 另接 `selfSessionId` 显式指明调用方（默认取 `SESSION_READER_CALLER_SESSION`）；
被判定为「调用方自己」的命中不会被删掉，而是带上 `self` / `suppressed` 标记返回，展不展示由调用方定。

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

### 三级溯源回答不了的那一问：现在还成不成立

`observed / derived / candidate` 回答的是**这个事实怎么来的**，不是**它现在还对不对**。
overview 的「末态」恰恰是最易腐的一段：

> 凡是关于**当前状态**的问题（凭据、环境变量、装了哪个版本、文件还在不在），会话只能告诉你
> 它**最后一次为真是什么时候**——去核实。转录记下的是说过什么和退出码，不是效果。

三种真实撞上过的情况：一条命令退出码为 0、无报错，但它读到的是空输入，写进配置的是个空值；
某一轮的结论说「现在存了三份」，其中一份是只活在当时那个 shell 里的临时函数，从没落盘；
「某某已配好」在当时是对的，三周后需要另外验证。会话忠实记录了意图和退出码，记不下效果——
这是转录这种载体的边界，不是提取规则的疏漏，所以本模块不打算用更聪明的规则去补它，
只把话说清楚。

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
- **文件归属分三级溯源**（见上文 provenance）。`observed` 来自显式写工具（`Write`/`Edit`/`write_to_file`/`replace_file_content`/`apply_patch`/grok 的 `search_replace`）与 provider 自己记的 `FileChange`；`derived` 是从 shell 命令里解析出来的（`>`/`>>`、`tee`、`cp`/`mv`、`scp`、`sed -i`、python 的 `write_text`/`open(w)`）。没有后者，纯靠 shell 干活的智能体（如 codex 全程走 `exec` 沙箱）会显示成"一个文件都没改过"。这是启发式，可能漏也可能多报，所以每行都写明是哪条规则提取的。
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

## `1session serve`：接入 DreamMate Network

把本地 Read Plane 原样暴露成网络能力——`1session overview <id>` 成为 `sessions.read`。
**不重新实现索引与事实层**，只是换一个调用入口。不引第三方 HTTP 框架，只用 `node:http`。

```bash
1session serve                                  # 默认 127.0.0.1:7777
1session serve --host 100.x.x.x --token <t>     # 暴露到 tailnet
```

启动时默认向本机 [node agent](https://github.com/scottzx/dreammate-node)（36908）报备，
`--no-report` 可关。**agent 没起时是静默 no-op**，不影响本服务——只是外部得靠约定端口
碰运气找它，而不是探一个 36908 就看见。报备会如实声明可达性：`--host` 是回环就报
`localhost`（外部发现得了但连不上），否则报 `network`。

端口 7777 是 [L0 协议](https://github.com/scottzx/dreammate-network) 的**约定端口**
（`DEFAULT_PORTS['session-registry']`），不是随手挑的：发现是 pull 的——
Control Plane 从 tailnet 拿到节点后，照着这张表探测 `/manifest` 与 `/health`。
换成别的端口就探测不到了，得由服务自己 `POST /nodes/register` 告知。

```
GET /manifest              只报本服务自己（节点全貌在 agent 的 :36908/manifest）
GET /health
GET /v1/sessions           ?limit&scope&since&provider
GET /v1/sessions/:id       会话概要
GET /v1/sessions/:id/turns 逐轮概要
GET /v1/search             ?q=&scope=&since=&limit=&provider=&kind=&regex=&case=
GET /v1/graph/:id          会话之间的引用关系
```

声明的能力：`sessions.list` `sessions.read` `sessions.turns` `sessions.search` `sessions.graph`。

每个会话都带上网络内的地址：

```
session://<node>/<runtime>/<session_id>
session://Scott-Mac.local/claude/87f7a60a-a86e-49c5-b711-e463156a5420
```

**跨机实测**（Windows 节点读 Mac 的会话，全程没有 Control Plane 参与）：

```
scott-pc$ curl http://scott-mac.tailfb4720.ts.net:7777/v1/sessions?limit=3
{ "node": "scott-mac",
  "sessions": [ { "uri": "session://scott-mac/claude/87f7a60a-…", … } ] }
```

**读取即落边。** 请求带 `X-Caller-Session: <调用方会话>` 时，读取当下就写入
`调用方 --references--> 目标`，与 CLI 的 `SESSION_READER_CALLER_SESSION` 是同一条路径。
两端都必须是本地已索引的会话，否则静默跳过——悬空边比没有边更糟。

**节点身份由 [`@1agents/dreammate-node`](https://github.com/scottzx/dreammate-node) 统一提供**
（优先 `tailscale status --json` 的 `Self`，缓存 60s）：它是每台机器的公共事实，
本机所有服务读到同一份，不会各自生成 id 把一台机器裂成几个 Node。

```
node_id   nigVtDS1s521CNTRL                            ← tailscale ID，重启不变
name      scott-mac                                    ← DNSName 前缀
type      macos                                        ← 由 tailscale 的 OS 映射
base_url  http://scott-mac.tailfb4720.ts.net:7777/v1   ← MagicDNS，跨机可直接用
```

> ⚠️ 名字取 **DNSName** 而不是 HostName 是有原因的：iOS 设备的 HostName
> 全是 `localhost`（实测 11 个节点里只有 9 个唯一），几台手机接进来会产出
> 一模一样的 `session://localhost/yima/...`。DNSName 实测 11/11 唯一且可读。

没装 / 没登录 tailscale 时**静默回退**到本地身份（hostname + 首次生成的 uuid，
存在 `~/.1agents/node.json`）。回退身份的 name 不保证跨设备唯一，只适合单机自用。
`manifest.metadata.identity_source` 会如实报告身份来自 `tailscale` 还是 `local`。
`DREAMMATE_NODE_ID` / `DREAMMATE_NODE_NAME` 覆盖一切（容器或同机第二个实例用）。

**只读、且默认只监听 loopback。** 会话原文含源码、shell 历史和恰好滚过屏幕的密钥，
所以走出本机必须是一个刻意动作：显式 `--host`，并且最好配 `--token`（`Authorization: Bearer`）。
非 loopback 且无 token 时启动会告警。非 GET 一律 405。

> 协议定义来自 [`@1agents/dreammate-network`](https://github.com/scottzx/dreammate-network)（L0）。
> `src/serve/node.ts` 直接 import 它的类型，不再本地抄一份——单向依赖 L2 → L0 是允许的，
> 而共用同一份定义才谈得上「公共语言」。**schema 是唯一事实源，改类型先去改那个包。**
> `/manifest` 的 `metadata.protocol_version` 报告本服务遵循的协议版本。

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
