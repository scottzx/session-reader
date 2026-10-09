# DSH Web 截图与验证范围

截图由 BrowserSkill 操作真实 DSH Web 拍摄，视口为 1440 × 900，没有重绘或后期合成。

- `session-reader-dsh.png`：跨 Agent 会话列表与 Claude 原文。
- `session-reader-search.png`：Codex 来源筛选、关键词搜索与原文高亮。
- 使用隔离 HOME、DSH profile、索引和工作区；数据为两个 Claude 和一个 Codex 合成会话，没有私人历史、账号或凭据。
- DSH 为本机开发快照，HEAD `21638c56315ae6a2b552d6091945d3144c9af32e`、CLI manifest `0.2.0-rc.1`，不是正式发行版兼容认证。
- 拍摄包为本次市场材料修订的未发布候选（manifest 基于 0.8.3）；DSH 实际提供的客户端与本仓构建相同，SHA256 `ec83e0ed393697b235546f713ee4af045a9218613df39cc7cad06775cc746722`。版本号将由现有 Release workflow 升级，不能据此称为已发布 npm 0.8.3 的旧产物。
- 已实际验证侧栏入口、会话列表/详情、来源筛选和搜索高亮；可选 ACP 原生续聊未测试。
