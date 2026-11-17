# TechDoc — v3.2.18 设置「数据管理」：保留期限迁入与链接表保留期限

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.18（暂定） |
| 功能分支 | `feat/data-management-retention`，基于正式标签 `v3.2.17`（`a7f268f2`） |
| 日期 | 2026-11-13 |
| 状态 | 已实现，待审查、资金人工复核与 Windows 打包版回归 |
| 依据 | [spec.md](spec.md) |

## 一、模块与改动

| 文件 | 职责 |
| --- | --- |
| `src/main-process/linked-table-delete.js`（新） | 从 `linked-table:delete-by-date-range` handler 原样抽出三表白名单、统计与“删除 + 派生重建 + 清缓存”；手工删除与过期清理共用，handler 返回结构不变 |
| `src/main-process/linked-table-retention/policy.js`（新） | 三表清单与默认（网关 15 天、外汇交割永久、银行对账单 60 天）、设置键 `linked_table_retention_days_by_table`（缺键=默认，`null`=永久）、保存校验、过期截止日（本地今天 − N − 1）；保存后清空 `linked_table_retention_last_success_at` |
| `src/main-process/linked-table-retention/idle-retention.js`（新） | 空闲控制器，结构对齐 `database-compaction/idle-compaction.js`：`maybeRun/abort/stop/close/isRunning` |
| `src/main.js` | 创建控制器；空闲定时器中先清理链接表、再判断整理主库；`app:user-activity` 中止；关窗与退出等待两者收尾；新增 `linked-table:get-retention-settings` / `linked-table:set-retention-days`；删除 handler 改调共享实现 |
| `src/backend/database/migrations.js`、`database.js` | `ensureArchiveVccDefaultRetention`：模块设置无 VCC 项时写 15 天与标记 `archive_center_vcc_default_retention_seeded`，每次启动幂等 |
| `src/main-process/archive-center/retention-policy.js`、`controller.js` | 存档期限可选值加入 15 |
| `src/renderer/dialogs/app-settings.js` | 导航新增「数据管理」；输入/输出文件保留期限的 markup 原样迁入数据页，保存队列、关闭保护、删除批次前置保护不变；存档设置只剩存档位置；`loadArchiveSettings` 支持只读保留设置与独立反馈 |
| `src/renderer/dialogs/linked-table-retention.js`（新） | 链接表保留期限区块：读取代次、最新意图串行保存、失败回滚、保存中禁止切表与关闭 |
| `src/preload.js`、`src/renderer.js`、`index.html`、`src/styles-gemini-extra.css` | 窄 API、装配、脚本顺序、数据页滚动容器样式；`npm run preview:data-management` 预览入口 |
| 任务策略 | 两个新通道登记为 exclude：读取 `read-only-query`，保存 `ui-navigation`（同 `settings:set-dark-mode-schedule`） |
| `architecture/boundaries.json` | 新增稳定子边界 `renderer-dialog-linked-table-retention`（工厂 `createLinkedTableRetentionDialogs`，api 仅 `linkedTable.getRetentionSettings/setRetentionDays`）；`renderer-dialog-app-settings` 的 ui 增加 `mountLinkedTableRetention`，以 `policyChanges` 绑定 `v3.2.17`（`a7f268f2`）登记。设置弹窗不接触链接表 API，预览模式经 `options.linkedTablePreviewApi` 传入内存 API |

## 二、清理流程

每 2 分钟的空闲检查（收单清理之后、主库整理之前）：

1. 跳过条件：未空闲 30 分钟；距上次成功 < 24 小时；距上次失败 < 1 小时；三表均永久；`idleCompactionBusyReason()` 非空（收单锁、收单后台清理、银行对账锁、收单 worker）。
2. 取银行对账锁（`linked-retention`），再取过渡租约 `linked-table-retention`（`requireIdle`，期间新业务提示“正在清理过期链接表数据，请稍后再试。”）；任一失败即释放已取得的并跳过。
3. 按网关 → 外汇交割 → 银行对账单逐表：先让出事件循环并检查中止 / 仍空闲；统计 `[0000-01-01, 截止日]`，为 0 不删除（不清对账缓存）；否则调共享删除。
4. 全部表无失败才写成功时间；任一表抛错或派生 `created:false` 记错误日志并退避 1 小时（表间被用户操作中止时，已发生的失败同样退避并记错误，不降级为 info）；finally 释放租约与锁。
5. 活动日志 domain `linked-table-retention`，每次执行一条，含每张表的期限、截止日、删除行数、剩余行数与派生失败原因。

中止粒度：单表的删除事务与派生重建在主线程同步执行，不能中途打断；用户操作后当前表完成即停，其余表下次空闲继续。数据日期为空的行不在 `BETWEEN` 范围内，不会被删除。

## 三、对账盲区扫描（reconciliation-blindspot-pass，2026-11-13）

### [Critical] 外汇交割表按交易日期过期，可能早于 BOC 到期日删掉仍待匹配的 BOC 链接行
- 场景：远期交割交易日期在 60 天前、到期日在未来；过期清理按交易日期删除外汇交割行，并按 `transaction_no` 联动删除 BOC链接表行（仓储有意不按到期日删）。
- 事实与证据：`boc-fx-link-builder.js` 以“到期日 + 货币2金额 = 收款金额”与中台调拨订单匹配回填调拨单号；`deleteFxByDateRange` 只按 `transaction_date` 选行。
- 推断/未知：实际业务中交易日期到到期日的跨度是否会超过所设期限，仓库内无样本。
- 资损或审计影响：到期日前 BOC 行被删，BOC调拨订单修复无法匹配，调拨单号与对账 ID 回填缺失。
- 处置：用户 2026-11-13 决定外汇交割表默认永久（spec D7），口径不变；用户自行设置期限时风险仍在，用户手册 §1.11.12 已提示。⚠️ 资金红线，请人工复核。

### [Critical] 网关对账单默认 15 天，跨期核对可能出现“缺网关”误报
- 场景：资金对账运行（C3 网关核销 / R5）与前置资金对账以链接表网关对账单为对方；核对超过 15 天前的银行数据时，网关行可能已被清理。
- 事实与证据：前置资金“缺网关账单”以银行对账单为本方、网关联合池为对方（用户手册 §1.12.1）；默认 15 天为用户决定 D6。
- 处置：⚠️ 资金红线，请人工复核；属有意设计，已在用户手册 §1.11.12 提示升级后先调整期限。

### [Important] 空闲清理会使未导出的资金对账运行结果失效
- 场景：运行后未导出即离开 30 分钟，网关或银行对账单表有过期行被删，`processingResult` 被清空，回来需重跑，且重跑使用删除后的数据。
- 事实与证据：共享删除与手工删除同口径清缓存；无过期行时不删除也不清缓存（集成 C3）。
- 处置：ASSUME（与手工删除一致）；用户手册已说明。

### [Important] 银行对账单表旧行删除后，跨期重复命中提醒的历史标记随之消失
- 场景：重复命中标记 `last_hit_run/last_hit_at` 存在入金行上；行被删后再导入同一旧文件，不再提示跨期重复命中。
- 处置：PROBE（人工确认是否会重新导入超过保留期的旧对账单）；与手工删除行为一致。

### [Important] 自动删除只写活动日志，无界面提示
- 事实：spec D2“结果写活动日志”；日志含每表行数与截止日，不含逐行主键（手工删除同样只有计数）。
- 处置：ASSUME（按用户决定）。

### [Minor] 本机时间向前跳变会按错误“今天”提前删除
- 处置：ASSUME；与存档到期清理同样依赖本机日期。

### 已覆盖
- 并发：持银行对账锁 + `requireIdle` 过渡租约，覆盖资金对账导入/运行/导出、链接表导入/删除、账户映射、前置资金、重复入金、平盘；ADM 写入经 JPM Recovery Hold gate，gate 拒绝时该表不删并记错误。
- 边界：today−N 保留、today−N−1 删除、空日期保留、跨月 / 闰年（单测 + 集成）。
- 守恒：派生表按删后全库候选重建，与手工删除同一函数；meta 行数重算。

## 四、兼容与回滚

- 新增设置键均为可选：链接表设置缺失即按默认（网关 15 天、外汇交割永久、银行对账单 60 天）；回滚代码后不再清理，已删除的数据不可恢复。
- VCC 存档默认只在首次启动迁移时写一次；回滚后该模块保留 15 天的显式设置（旧版本可读）。
- 手工删除 IPC 的入参、校验文案与返回字段不变。

## 五、验证

见交付报告；`npm run verify:app-settings-layout` 为 backlog B28 既有失效（v3.2.17 同样报 `createAppUpdateSettingsDialog is not defined`），布局改由 renderer-lifecycle 生产样式用例核对（1080×760 100%、1080×760 150% 深色、1240×860 125%）。
