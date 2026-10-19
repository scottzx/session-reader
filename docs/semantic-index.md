# 可选会话语义索引（自 0.11.0 起）

关键词检索仍是默认行为。`searchSessions()` 的旧返回类型不变；新增
`retrieveSessions(query, { mode: 'semantic', model: 'qwen3' })` 返回 `{ hits, retrieval }`。
CLI、DSH `session_search`、HTTP `/v1/search` 和 Web API `/api/session-reader/search`
复用这层编排。Web 面板尚未增加模式切换控件；通过 API 明确指定模式。

## 准备、构建和查询

```sh
# 先更新所需范围的结构化索引；不要一上来对全机做昂贵编码。
1session index --all --scope /absolute/project
1session index build --semantic --scope /absolute/project --model qwen3 --json
1session index status --semantic --scope /absolute/project --model qwen3 --json
1session search '以前为什么采用独立插件' --scope /absolute/project --mode semantic --json
# 命中后使用完整 provider:id 和原始事件 locator 回读，不能把相似度当事实。
1session turn 'provider:complete-id' --locator 'exact-locator' --json
```

`index build/status --semantic` 支持 `--scope`、`--global`、`--provider`、`--since`
和 `--session`。它不重新发现源文件：覆盖范围仅为当前结构化索引快照。
源文件发生变化后先刷新结构化索引，再显式重复语义 build；未变化文本不会重新编码。
当前没有自动 watcher。查询不会自动创建数据库或触发全文编码。

## 文件、模型与版本隔离

默认结构化索引改为 `~/.1agents/session-reader/index-v3.db`，旧 `index.db` 不自动修改或复制。
默认向量库为 `~/.1agents/session-reader/semantic-v1.db`，与结构化索引分开。
`SESSION_READER_DB`、`SESSION_READER_SEMANTIC_DB` 可分别指定隔离路径。
不要将两者设为同一路径，不要让旧 reader 打开新版本专用数据库。
有内容而 schema 不匹配的数据库会被拒绝写入，而不是删除。

复用 `@1agents/artifact-index/embeddings` 客户端，通过
`SESSION_READER_EMBEDDING_GATEWAY`（默认 `http://127.0.0.1:36908`）访问既有本地服务。
reader 不下载模型，不安装 Python，不启动第二套模型进程。默认使用 Qwen 的
`document_search`；Gemma 建库需要共享客户端的 `getTextProfile` / `embedDocuments`
扩展。旧发布客户端仍支持 Qwen，选择 Gemma 会明确提示需要升级，不能静默换模型。
跨模型、revision、维数、encoding/task 的向量不能混算。模型修订变更的构建仅在
全部选定来源完成并再次校验源指纹后激活；失败保留此前活动空间，并缓存已成功编码的批次。
每个模型有独立活动 profile。仅重建一个 scope 时，其他 scope 可能仍待索引，必须检查 partial。

## 第一版分块与覆盖限制

仅索引有稳定 locator 的非空 user/assistant 文字，不索引工具正文或隐藏推理。
第一版是保守的 UTF-8 字节分块：每块最多 320 字节、重叠不超过 32 字节，保留 UTF-16 原文偏移；
这不是 tokenizer 分块，也不同于早先 895 块 benchmark 的双 tokenizer 方案。
主查询同样最多 320 UTF-8 字节；长问题请缩短，不会静默截断。
真实 tokenizer/召回质量需要另测，不能把旧 benchmark 指标直接称为本实现质量。

`retrieval` 包含 profile、chunker、totalSessions、indexedSessions、totalEvents、
pendingEvents、skippedEvents、indexedChunks、partial、updatedAt 和 lastBuild。
`rawSourceDiscovery:false` 与 `coverageBasis:'structural-index-snapshot'` 明确说明不是全磁盘覆盖。
`since` 延续会话文件修改时间筛选，不代表只返回那个时间之后的消息。
范围筛选在向量排序前进行，不设置隐藏的候选会话上限。结果按会话聚合，每事件保留最相关块。
`totalMatches` 是截取前的候选事件数，`matches` 是实际返回子集；`hasMore` 指示仍有候选，
第一版不提供语义分页 cursor。余弦值是相似度，不是正确率；不自动拒答、不生成长期记忆。

`--regex`、`--case`、`--terms`、`--operator`、`--cursor`、时间排序、`--no-index`
及工具/产物检索不适用于语义模式，会报错。显式语义模式缺索引/模型离线不会静默退化成关键词。
HTTP/Web API 参数错误为 400，缺索引/模型等语义不可用为 503，并返回 code；CLI 非零退出、错误在 stderr。

## 并发、删除与恢复

单个语义数据库用 `<db>.build.lock` 串行化写入，普通查询只读；没有数据库事务跨越模型请求。
意外杀进程后可能留下锁目录，先检查 `owner.json` 的 PID/时间并确认该进程已经退出，再由操作者恢复。
第一版不自动抢占陈旧锁，不因目录临时失联推断历史被删除。

```sh
# 显式移除该完整会话的语义引用，跨所有模型，不修改源文件/结构化记录。
1session index forget --semantic --session 'provider:complete-id' --json
```

forget 保留其他会话共享的向量，但这不是持久排除规则：下次对同一来源 build 会重新索引它。
这是逻辑删除，不保证 SQLite/WAL/备份中的物理安全擦除。未加入自动垃圾回收或模型代次切换 UI。
