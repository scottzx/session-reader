# session-reader 0.8.6 市场入口验收

2026-10-12 验收两处公开市场；2026-10-15 增加 dsh.pub。三个渠道分别按各自真实命令，在独立 HOME、DSH_HOME 和全新 web profile 中验收公开根包 `@1agents/session-reader@0.8.6`。

| 渠道 | 实际广告命令 | 结果 |
| --- | --- | --- |
| [DSH Marketplace](https://dshmarketplace.dev/plugins?q=scottzx%2Fsession-reader) | `dsh plugin --profile web add @1agents/session-reader` | 解析并启用 0.8.6，通过 |
| [dsplugin](https://dsplugin.app/plugin-detail?plugin=scottzx%2Fsession-reader) | `dsh plugin --profile web add github:scottzx/session-reader` | 固定解析到源码提交 `576d68e60f3a4549576aa22c8dc89d5b17bdd86b`，启用 0.8.6，通过 |

| [dsh.pub](https://dsh.pub/en/plugins/session-reader/) | `npx dshpub add scottzx/session-reader --ref f006816b2b7819ee02f033fd0c941965f7eb0159` | 自动公开收录；实际解析固定 Git 提交、启用 0.8.6，通过 |

2026-10-12 的两套环境均确认 bundle 启用、真实 Cordis Loader 和 ClientModuleRegistry 注册、客户端 HTTP200 且字节匹配安装产物。API 和浏览器均完成 3 条合成会话浏览、Codex 筛选 1 条、搜索命中 2 处、读取原文及高亮。Marketplace 有一条被相同查询替换的客户端取消请求；替换请求 HTTP200，最终内容正常显示。

另用真实只读索引目录触发 EACCES / SQLite 打开错误 14，在未设置跳过索引开关的情况下，公共读取 API 与真实 DSH Web API 均回退到原始合成文件，浏览、筛选、搜索和原文读取通过，未创建数据库文件。所有自有服务、浏览器会话、临时环境和凭据已清理，合成原文保持不变。

DSH 验证范围为现有开发工作树 `0.2.0-rc.1`，以只读方式使用其 CLI 与依赖。该记录不扩展为其他官方 DSH Release 的兼容结论。没有读取个人历史、复制个人凭据或调用模型。

dsh.pub 的公开奖页和完整 npm 名搜索返回唯一正确条目。实际 npx 解析 dshpub0.1.1，默认 web profile，验证固定 Git bundle 后委托原生 DSH 安装；Git archive SHA512 匹配 pnpm lock。真实 Loader、ClientModuleRegistry、客户端字节匹配及五项 API 通过，浏览器浏览3/筛选1/搜索2/原文高亮通过，捕获的7项插件读取均HTTP200。该渠道使用新独立环境并已完成关闭清理；未另外重复只读索引回退用例，未输入模型密钥或调用模型。安装 telemetry 已关闭。原人工表单仍没有提交回执；本次通过的是独立的自动公开收录，不是绕过表单验证。

0.8.6 的 npm 产物与已有 [Release tarball](https://github.com/scottzx/session-reader/releases/download/v0.8.6/session-reader-0.8.6.tgz) 字节相同，共 593,980 字节，SHA256：

```text
93ca675b9c02c746b31c044444eb9d71965d1a8e12b253309f886636ac94ecb6
```

npm gitHead、annotated tag 和固定源码 manifest 对应 `576d68e60f3a4549576aa22c8dc89d5b17bdd86b`。本次 docs 提交只记录证据，不是 npm 构建源码提交。

[Canonical PR6956](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6956) 更新同一条目的固定 0.8.6 Release 兜底，仍待审核；canonical / dsh-market、DSH Plugin Store、DSH STORE 仍须各自正式收录与市场入口验收；dsh.pub 已在上述独立环境完成验收。dsplugin 的自动公开收录与待审 [PR337](https://github.com/vbarter/dsh-plugin-registry/pull/337) 分别记录。所有原始投稿回执和 0.8.4/0.8.5 历史验收保留；此次授权止于 0.8.6。

机器可读摘要：[market-acceptance.json](market-acceptance.json)。
