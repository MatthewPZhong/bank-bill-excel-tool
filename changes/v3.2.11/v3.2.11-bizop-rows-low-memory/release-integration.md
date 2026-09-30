# release/v3.2.11 集成记录

## 集成身份

- 来源：`v3.2.11-bizop-rows-low-memory`，冻结提交 `641c574db460c4b8afe0b6d7e2188aae2414f87e`。
- 合并前 release：`407579955842a031f1002f36934b28bb64029417`，已含删除确认文案、公共反馈弹窗滚动、设置默认值和 VCC 按主体结果工作簿。
- 来源设计与边界见 [TechDoc](techdoc.md)。生产低内存资格仍为 `pending`，本次集成不构成 Windows 真机或正式发行验收。

## 架构变更记录的父链绑定

第一次组合 `release-check` 的源码扫描成功解析 786/786 文件，但历史检查报告 32 条 `ARCH-POLICY-HISTORY`。原因是来源分支的四条 `policyChanges` 绑定到上一正式版本 `18b82b4`，不能覆盖此后 release 的八个提交；四个字段在这些提交中仍保持原值。

已核对 `18b82b4` 与合并前 release 的 `architecture/boundaries.json` 均为 Git blob `61c9a9d5bcb87927b847e01c5da3555e8b7c1719`。保留来源的全部变更记录，再为同一四组准确 `from` / `to` 增加绑定 `40757995` 的记录：

| 字段 | 已核对的变化 |
|---|---|
| `platform-core.allowedLocal` | 仅新增 `execution-memory-config.js` 与 `memory-admission.js` 两个中性模块；原受限能力与纯模块约束保留。 |
| `renderer-dialog-toolbox.allowedApiFields` | `api` 仅新增单字段读取 `splitReadValues` 和取消 `splitCancelRead`，其他能力集合保持原值。 |
| `$policy.dynamicLoads` | 两处 Worker 构造携带执行内存配置后的准确 AST 指纹迁移；登记数量和全部目标集合保持原值。 |
| `publication-recovery-entry.allowedSites` | 两处私有传输/恢复调用因增加 `memoryConfig` 实参迁移准确指纹；仍保留队列、lease、owner 授权、seal、journal 和真实退出责任。 |

此次补记只增加四条历史迁移证据；机器规则、现行允许集合、激活状态、固定事实基线和历史例外均未额外放宽。正式门禁继续执行同一个检查器。

## 跨分支衔接

- 合并共享 Publisher 时同时保留来源的 `memoryConfig` 传输和已有 VCC `publicationNotStarted` / `publicationOutcomeUncertain` 发布状态处理。
- VCC 新结果工作簿 Worker 接入 `memoryCarrierAdmission(null).observe(...)`；活动清单从来源 28 个构造点补为组合版本的 29 个。回归测试确认低内存互斥期间在创建真实 Worker 前拒绝，并释放已申请的 phase lease。
- 保留 VCC `writeResultWorkbookFn`、`acquireResultExportLeaseFn` 与 Main 装配；背景生成测试从 legacy owner 数量中单独核对 VCC phase lease，再核对新增低内存 owner。
- 组合源码的最终测试日志、输入 hash、初次失败和修复记录随本地合并报告留存；来源分支内的历史门禁数字仍表示来源当时的验证范围。

## 到期删除集成夹具

组合完整门禁发现旧 `archive-permanent-delete-owner-recovery` 夹具把未指定期限解释为会到期，与设置分支的新默认永久保留冲突。该夹具专门验证跨进程恢复后的到期删除，现显式向 ArchiveService 注入 `defaultRetentionDays: 30`。产品默认值及永久保留行为保持；独立 `archive-center-default-retention` 集成仍覆盖默认永久及明确期限。来源冻结提交不变。
