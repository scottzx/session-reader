# DSH 会话真归档（冷归档）

DSH 原生“归档”只是在 `~/.dsh/storages/workspace.json` 的
`global.archivedSessionIds` 中记录 `session-<uuid>`，前端隐藏并拦截继续运行；
`ApiSessionList.list()` 仍会扫描 `~/.dsh/sessions/` 的全部投影。冷归档把已归档
会话**物理迁出**热目录，从根本上缩小热列表规模。

## 目录与文件

```
~/.dsh/
  sessions/<workspace-slug>/<session-id>/        # 热目录（DSH 原生）
  sessions-archive/<workspace-slug>/<session-id>/  # 冷目录（同构，可原路返回）
  sessions-archive/index.json                   # 冷归档索引/元数据
  storages/workspace.json.cold-archive-backup-*  # 写入前原子备份
  storages/workspace.json.restore-backup-*       # 还原前原子备份
```

`workspace-slug` 与 `session-id` 目录名均原样保留（包括 DSH 的旧式无 `session-`
前缀目录），因此迁移和还原都是无损的。`index.json` 记录 nativeDir、workspaceDir、
原路径、冷路径、归档时间和体积；索引与 `workspace.json` 均用「临时文件 + rename」
原子写入。

## 使用

默认阈值 **7 天**，两条规则（候选条件是 **或** 的关系）：

1. **已标记归档的会话**：只要在 `global.archivedSessionIds` 里、且不在 `pinnedSessionIds`
   中，就立即冷迁出——**不看 mtime、不受 7 天阈值约束**。置顶会话永远跳过。
2. **超时的活跃会话**：未被手动标记归档、但静默超过阈值（默认 7 天）的会话也会被冷迁出——
   除非它所在的 pwd 靠它才凑得够活跃会话。

也就是说，候选条件 = **已标记归档 OR mtime 早于阈值**；7 天只约束规则二的活跃会话。

**每个 pwd 的保底**：一个 pwd 跑完一轮后至少保留 **3 条活跃会话**（`--keep-active <n>`
可改，`0` 表示不保底）。若正常归档会让某个 pwd 剩下不足 3 条，就把该 pwd 本轮待归档会话里
**最新的 x 条**留下不归档（x = 3 − 剩余条数）。

参与保底计算的口径：

- **按 pwd 分组**（DSH 的工作区目录）。
- **未分组会话不参与**：DSH 没挂到任何工作区的会话既不计入保底，也不会被规则二归档。
- **置顶会话不占名额**：置顶会话照旧跳过、不归档，也不计入「剩余活跃会话」。
- 保底只约束自动归档；`--session <id>` 显式指定时直接归档，不受保底与阈值约束。

`--days 0` 表示活跃会话也不看天数（此时分组内的活跃会话都算超时）。

```sh
# 1. 只读预览（不创建目录、不写任何文件）
1session dsh-archive --dry-run --days 7 --json

# 2. 执行冷归档：已标记归档的全部 + 闲置超 7 天的活跃会话（每个 pwd 保底 3 条）
1session dsh-archive --days 7 --json

# 3. 调整保底条数（0 = 不保底）
1session dsh-archive --days 7 --keep-active 5 --json

# 4. 立即归档全部会话（忽略天数）或指定会话
1session dsh-archive --days 0 --json
1session dsh-archive --session <session-id> --json

# 5. 浏览与一键还原
1session dsh-archive --list --json
1session dsh-archive --restore <session-id> --json

# 6. 阅读冷归档会话（与热会话完全一致的阅读链路）
1session list --archive cold --global --json
1session search '关键词' --archive cold --global --json
1session overview <session-id> --json
1session turns <session-id> --json
```

`--archive include|hot|cold` 同样适用于 HTTP `/api/session-reader/sessions` 与
`/api/session-reader/search`，以及 DSH 工具 `history_search` 的 `archive` 参数。
默认 `include` 同时读取热、冷目录；冷会话的 `SessionRef` 带 `coldArchived: true`，
CLI 显示「冷归档」标签，Web/DSH 历史面板显示「冷归档」徽标与还原按钮。

## 安全护栏

- 规则一只处理 `global.archivedSessionIds` 中的会话；规则二处理 DSH 已挂到工作区的活跃会话。
  置顶（`pinnedSessionIds`）一律跳过，也不占保底名额。
- 未分组会话（DSH 没挂到任何工作区）不参与规则二，也不计入保底。
- `session.lock`：**空且 mtime 超过 10 分钟**视为 DSH 遗留 tombstone；非空 PID
  且进程存活、或 mtime 在 10 分钟内视为活跃锁并跳过。`lockFreshMs` 可在 API 调整。
- 保留天数按会话 transcript 的最后写入时间计算（目录 mtime 会因锁文件重建而失真）；
  阈值只作用于活跃会话，已标记归档的会话不看天数；`--days 0` 表示活跃会话也不看天数；
  显式 `--session` 忽略保底与天数。
- 目标目录已存在时标记 `conflict` 并拒绝覆盖；执行前再次检查目标。
- 迁移成功后才更新索引与 DSH 状态；任一步失败会按逆序迁回并恢复 `workspace.json`
  与索引。备份文件刻意保留作为证据。
- 还原时若热目录已存在则拒绝覆盖；还原会从 `archivedSessionIds` 移除该 ID，使 DSH
  立即重新显示并可继续使用，同时留下 `.restore-backup-*`。

## DSH 插件集成（只读浏览 + 还原，不做自动/迁出）

**冷归档迁出只由 CLI 手动触发**：`1session dsh-archive`。插件不监听 DSH 归档事件，也不提供迁出工具/接口，避免 DSH 侧任何自动或误触的物理迁移。

插件工具：

| 工具 | 用途 |
| --- | --- |
| `cold_archive_list` | 列出冷归档条目与元数据 |
| `cold_archive_restore` | 一键还原指定会话 |

HTTP（`/api/session-reader` 前缀，写操作要求同源 POST）：

- `GET /cold-archive/list`
- `POST /cold-archive/restore` — `{ "sessionId": "…" }`

历史面板仍可按「仅冷归档」筛选、阅读冷会话并执行还原；搜索与列表默认包含冷归档。

## 路径覆盖（测试/多机）

`DSH_HOME`（默认 `~/.dsh`）、`DSH_SESSIONS_DIR`、`DSH_SESSIONS_ARCHIVE_DIR`、
`DSH_WORKSPACE_STORAGE` 可整体重定向；所有路径每次调用时解析，便于在临时目录中
做完整集成测试。跨文件系统的归档根目录使用「先完整复制、再删除源」的回退。
