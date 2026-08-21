# v3.1.14 Unknowns Preflight

## Task Brief

- Goal：修复 VCC 财务 OP 明细导入在读取 38,197 行后因 staging 自引用外键清理退化而长时间无响应的问题，并展示真实数据库收尾阶段。
- Context：充值清退与 Pending 合计 67,356 行；现有 `comparison_import_row_id` 自关联列缺少子列索引，renderer 只展示最后一条读取进度。
- Constraints：不改变金额、币种、方向、业务键、幂等、异常、revision、取消和 worker 终止合同；不升级 storage contract v2；不修改下载底稿；禁止为正式路径不可达状态增加防御。
- Done when：新库/旧 v2 库幂等具备 partial index；清理计划不再二次扫描 staging；每个完成读取的明细 sourceType 上报一次 `committing`；取消提示不被晚到 progress 覆盖；真实样本首轮与重导守恒。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| staging 存在 `comparison_import_row_id → staging.id ON DELETE SET NULL` | `src/backend/vcc-financial-op-db/storage-contract.js` | 必须保留外键并索引子列，不能关闭外键规避 |
| 清理按 `import_record_id` 整批 DELETE | `repository.clearImportStagingRows()` | 只改变访问路径，不重写清理算法 |
| 读取每 50,000 行 checkpoint，最终读取提交后才分类 | `STAGING_COMMIT_INTERVAL`、`commitStagingProgress()`、`importDetailGroup()` | progress 时点必须落在最终 COMMIT 与分类调用之间 |
| 每个文件解析后执行 SHA 二次核对 | `assertSourceFileMatchesSync(file)` | SHA 失败、空表、取消不得发送 `committing` |
| progress 已由 worker/service/preload 透明转发 | 现有 import progress 调用链与单测 | 不新增 IPC 或中间层字段复制 |
| renderer 取消中先写固定提示，但现有 listener 可覆盖 | `handleCancelImport()`、`handleImport()` | formatter 必须以 `cancelRequested` 为最高优先级 |
| `batchId` 由 `batchContext.taskRunId` 归一化得到 | `vcc-financial-op-service.js` | 发布证据使用同一任务身份，不制造第二个 ID |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 打包 SQLite 是否使用 partial index 执行自引用外键子行查询 | 已知未知 | 高 | 容易 | 缺索引计划存在第二次 staging 扫描 | PROBE | `EXPLAIN QUERY PLAN DELETE ...` | 以执行计划单测为发布门禁 |
| 多明细组 progress 的数量与顺序 | 契约盲区 | 中 | 容易 | import service 按 sourceType 逐组调用 | PROBE | 同批两种明细捕获事件并分组 | 每个完成读取组恰好一次 |
| 分类事务失败前是否已经上报 `committing` | 失败边界 | 中 | 容易 | 事件位于最终读取 COMMIT 后 | PROBE | 归档数据集拒绝新增用例 | 允许已有 `committing` |
| 绝对耗时是否可作为 CI 门槛 | 环境差异 | 低 | 容易 | 磁盘、机器和 SQLite 版本影响明显 | ASSUME | 真实样本记录事件时间点与总耗时 | CI 不设置固定秒数 |

无 BLOCK 项。所有会改变方案的未知均可从仓库或最小本地实验确认。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 增加并验证 partial index | 外键完整性、旧库幂等升级、线性访问路径 | schema SQL、重复 ensure、执行计划、真实自引用清理 | 推翻 P0 方案 | 撤回索引并重新评估，不改 DELETE |
| 2 | 在最终读取 COMMIT 后发送 progress | SHA、取消、空表与事务时点 | 多组/失败/取消/空表测试 | 调整事件落点，不改数据事务 |
| 3 | renderer 纯函数与最小接线 | 取消文案优先、旧事件兼容 | 纯函数执行测试和 listener 接线断言 | 收缩为 formatter 局部改动 |
| 4 | 真实样本首轮和重导 | 行数、幂等、revision、主体×币种金额守恒 | 本地 DB 回读和人工核对 | 阻止发布，不引入补偿逻辑 |

## 增补：tag 前正式发布准备

### Task Brief

- Goal：把已合入 `main` 的 v3.1.14 从迭代状态收口为可随安装包长期成立的 tag 前候选，随后按两阶段流程完成技术 Release 与独立证据回写。
- Context：功能 PR #162 已以 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` 合入 `main`；`package.json.version` 已为 `3.1.14`；本阶段尚未生成 v3.1.14 的 tag、workflow、Release 或资产事实。
- Constraints：不修改生产代码、业务合同、版本号或 Release workflow；不得预写 tag object、workflow ID、Release URL、资产大小、摘要或尚未创建的授权记录链接；真实金额不入仓；已推送 tag 和已发布资产视为不可变。Windows packaged VCC 交互、Windows 10/11、SmartScreen、离线覆盖安装与 `production/latest` canary 未执行时必须保留 `MANUAL / NOT RUN`。
- Done when：tag 前发布准备 PR 合入；从重新同步并复验的 `main` 创建唯一 annotated `v3.1.14`；受控 Windows workflow 创建公开 latest stable Release；发布后独立 PR 回写实际 tag、workflow、Release 与四项资产证据。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| v3.1.14 功能已完整进入 `main` | PR #162，merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` | 本阶段只收口发布文档与文档合同测试，不重开产品实现 |
| 自动门禁与真实样本已闭合 | `implementation-notes.md` 中的 `release-check`、`scan:vars` 和真实样本证据 | 可作为候选证据，不替代 Windows packaged、安装与升级人工验收 |
| 发布负责人已知晓未执行范围并明确授权正式技术发布 | 当前发布准备任务指令 | 授权允许生成技术资产，不把任何 `MANUAL / NOT RUN` 项写成 PASS |
| Release workflow 对 tag/main、版本和四项资产 fail closed | `.github/workflows/release-windows.yml` 与 `docs/WINDOWS_RELEASE_RUNBOOK.md` | 必须先合并发布准备 PR，再从当时最新 `main` 创建 annotated tag |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| 发布准备 PR 合并后 `main` 是否仍是唯一发布 HEAD | 发布身份 | 高 | tag 前重新 fetch，核对本地 `HEAD === origin/main`、版本、门禁和同名 tag/Release 不存在 | 未精确一致则不创建 tag |
| 人工边界授权是否有可长期回读的完整记录 | 审批审计 | 高 | 在稳定 GitHub PR body 或 Issue 评论中记录实际批准人、完整豁免范围、理由和发布后逐项补做计划；创建后才记录真实链接 | 缺记录或字段不全则不得创建/推送 tag |
| Windows packaged VCC 阶段切换与取消体验是否通过 | 人工验收 | 中 | Windows 10/11 候选包人工验证 | `MANUAL / NOT RUN`；授权不是 PASS |
| Windows 10/11 Setup/portable、SmartScreen 和 `v3.1.13 -> v3.1.14` 离线覆盖是否通过 | 安装验收 | 高 | 发布前或按 Runbook 授权范围补做 | `MANUAL / NOT RUN`；失败停止推广 |
| `production/latest` 在线升级是否通过 | 发布后 canary | 高 | Release 存在后用上一 stable NSIS 验证 | `MANUAL / NOT RUN`；不得公告在线升级已验证 |
| tag、workflow、Release 和资产身份是否一致 | 分发契约 | 高 | 发布后独立回读并以单独证据 PR 记录实际值 | 当前不预写任何实际 ID、大小或摘要 |

### 风险优先发布顺序

1. 发布准备 PR 仅收口文档与合同测试，经本地门禁和 Review 后合入 `main`。
2. tag 前先创建稳定的 GitHub PR body 或 Issue 评论，写明实际批准人、完整豁免范围、理由和发布后逐项补做计划；仅在记录真实存在后保存链接。缺少完整稳定记录不得创建或推送 tag。
3. 进入最小串行窗口：从 tag 前最终同步/复验并准备推送 tag 起冻结对 `main` 的 merge/push，重新 fetch 并确认 `HEAD === origin/main`、tracked worktree 干净、`package.json.version === 3.1.14`、同名 tag/Release 不存在，再创建唯一 annotated `v3.1.14`。tag 前发现漂移就重新同步并复验门禁、文档和 Review。
4. tag 触发受控 Windows Release workflow；冻结持续到 `Verify tag and main` 成功。tag 推送后、该校验成功前若 `main` 漂移，则停止 v3.1.14，保留且不改 tag，并改发更高补丁版本；窗口外不要求全程冻结 `main`。
5. 仅当 Release/资产均未创建且可证明是基础设施瞬时故障时，可在代码、tag、commit 和打包输入完全不变的前提下受控重跑同一 tag/commit。产品、元数据、打包输入问题或 Release 已创建后的失败均停止公告/推广并改发更高补丁；不得删除、替换或重传 tag/资产。
6. Release 成功后独立回读 tag、workflow、latest 状态、四项资产与更新元数据，再通过发布证据 PR 回写真实事实。
7. 任一后续 Windows 人工项或 canary 失败均停止推广，保留不可变证据并发布更高补丁版本修复。
