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

## 增补：正式发布证据收口

### Task Brief

- Goal：把已完成的 v3.1.14 技术 Release、tag、workflow、公开资产和人工边界以独立证据 PR 回写仓库。
- Context：功能 PR #162 已以 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` 合入产品代码；发布准备 PR #163 已以 merge commit `225d07d17a7c211348ba549734aaf84f602253cb` 合入 `main`，annotated tag 与 Release 已从该提交生成并完成远端回读。
- Constraints：不修改生产代码、业务合同、版本号或 Release workflow；只记录给定的实际 tag/workflow/Release/资产事实；真实金额不入仓；已推送 tag 和已发布资产视为不可变。Windows packaged VCC 交互、Windows 10/11、SmartScreen、离线覆盖安装与 `production/latest` canary 必须继续保持 `MANUAL / NOT RUN`。
- Done when：正式文档不再使用候选口径；tag、workflow、Release、四项资产与 latest 元数据跨文档一致；发布准备规则记录为已执行/继续保留；人工项不被冒充为 PASS。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 发布代码与准备提交均已进入 `main` | PR #162 / `1cc5999c62e4666d56b542e37e54529f6177e6bc`；PR #163 / `225d07d17a7c211348ba549734aaf84f602253cb` | 发布证据必须同时保留功能与发布准备两段血缘 |
| tag 身份与远端回读一致 | annotated tag object `fee1498311854a69fea666fe275511da89d99836` peeled 至 `225d07d17a7c211348ba549734aaf84f602253cb` | 不得删除、移动或重建 tag |
| Release workflow 与公开 Release 已闭合 | workflow [32508170702](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32508170702) 全部 15 步 success；[v3.1.14 Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.14) 公开且为默认 latest | 技术发布可写为完成；不能外推 Windows 人工项 PASS |
| 发布准备 Finding 已执行 | PR #163 body 稳定记录实际批准人、完整豁免范围、理由及发布后逐项补做；最小 `main` 冻结窗口在 `Verify tag and main` 成功后闭合 | 审批留痕与串行窗口仍是后续版本硬规则 |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| tag、workflow、Release 和资产身份是否一致 | 发布身份 | 高 | 远端 tag、workflow、Release API 与匿名下载逐项回读 | 已关闭；实际证据见 Runbook 与 implementation notes |
| 人工边界授权是否有可长期回读的完整记录 | 审批审计 | 高 | 回读 PR #163 body 的实际批准人、完整豁免范围、理由和发布后逐项补做计划 | 已关闭；记录稳定存在 |
| Windows packaged VCC 阶段切换与取消体验是否通过 | 人工验收 | 中 | Windows 10/11 候选包人工验证 | `MANUAL / NOT RUN`；授权不是 PASS |
| Windows 10/11 Setup/portable、SmartScreen 和 `v3.1.13 -> v3.1.14` 离线覆盖是否通过 | 安装验收 | 高 | 发布前或按 Runbook 授权范围补做 | `MANUAL / NOT RUN`；失败停止推广 |
| `production/latest` 在线升级是否通过 | 发布后 canary | 高 | Release 存在后用上一 stable NSIS 验证 | `MANUAL / NOT RUN`；不得公告在线升级已验证 |
| GitHub 是否提供平台级 immutable 强制 | 分发契约 | 中 | Release API 回读 | `isImmutable=false`；流程仍禁止删除、替换或重传 |

### 已执行顺序与保留规则

1. PR #163 body 完成稳定授权留痕，写明实际批准人、完整豁免范围、理由和发布后逐项补做计划。
2. 最小串行窗口从最终同步/tag 推送持续到 workflow 的 `Verify tag and main` 成功；tag object 与 peeled `main` 提交一致，没有漂移。
3. workflow [32508170702](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32508170702) 首轮全部 15 步 success，没有触发重跑；Release 于 `2026-08-21T17:58:54Z` 发布。
4. 四项资产、匿名下载、GitHub digest、`latest.yml`/Setup SHA-512、公开 latest 状态和 EXE 类型均完成独立回读；详细值写入 Runbook 与 implementation notes。
5. 瞬时失败边界继续保留：只有 Release/资产均未创建且可证明为基础设施瞬时故障，才可在代码、tag、commit、打包输入不变时受控重跑同一 tag/commit；产品、元数据、打包输入问题或 Release 已创建后的失败均改发更高补丁。
6. 任一后续 Windows 人工项或 canary 失败均停止推广；tag/资产不得删除、替换或重传，改由更高补丁版本修复。
