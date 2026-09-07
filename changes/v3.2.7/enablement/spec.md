# 业务 OP v3.2.7 显式启用

## Task Brief

- Goal：按用户 2026-09-06 在本任务中“全部开启”的明确要求，开启新版业务 OP 的全部 12 项后台动作，使用现有一次性升级与恢复流程退出 legacy。
- Context：本地 main 已同步 `5850fef15c6241da957a7af0848a1411eee9bde7`，PR230—236 已合并。用户随后明确要求打开原先关闭的生产启用开关。
- Constraints：仅改变本模块的启用决定及下述启动保护；E5 恢复、公共平台、资源预算、目录耐久、关闭事实、限定清旧、原件及历史存档保护不变。2026-09-07 用户追加要求合并并正式及开发发布，版本与发布条件见 release/implementation-notes.md。
- Done when：12 项生产策略全部启用；授权记录与测试证据可区分；缺失、不完整或非法授权仍拒绝；真实环境只有通过既有预检和升级收据后才进入 ACTIVE。

## 启用授权与验收记录

用户原话：引用“业务 OP 新版的生产启用开关仍保持关闭；同步到 main 不会自动将真实数据环境从 legacy 切换出去”后，要求“全部开启”。

本次将该指令记录为 `USER_AUTHORIZED`，不是测试 `PASS`。Windows 目录耐久、2200 万输入/最大结果并集、真实资金及 Excel/WPS 人工验收仍按未完成记录。原有全量自动化与 PR CI 是既有实现证据，不能代替这些项目。

Main 的版本化配置允许两种明确证据：原来的 `PASS + reference`，或本次新增的 `USER_AUTHORIZED + reference + approvedBy + approvedAt + reason + validationStatus=NOT_RUN`。授权逐项覆盖五项发布条件及当前十二项动作；不是缺项放行，也不允许未来新增动作自动继承授权。Renderer、环境变量和版本字符串不能提供这些字段。

使用授权启用时，现有平台策略保留 `evidenceStatus=baseline`、`recoveryStatus=probe`、`benchmarkEvidenceId=null`，不伪造 `release-pass` 或规模测试证明。所有条件确为 PASS 的既有分支继续使用原有证据元数据。

授权日期必须为规范 `YYYY-MM-DD` 的真实日历日期，解析后 UTC 日期必须与原文一致；不能把自动进位的非法日期作为有效授权。

范围：导入、计算、删除、升级、回收，以及 OP 原表、流水原表、OP 核对表、流水核对表、完整结果、差异结果、错误报告七种导出。全部使用现有 native `thread-single` 执行路径。

## 数据与启动保护

沿用 PR6 已实现的六张旧业务表清空、旧专属月文件回收和防旧写约束；不新增清理对象，不删除外部原件、Archive 历史、用户锁、共享 blob 或其他模块数据。升级开始后的回滚必须使用独立数据备份，不能仅换回旧代码。

启用前已只读盘点六张旧表、旧专属月文件、未完成旧 Task/Batch 和未 ACK 运行收据。现有磁盘预留规则为主库文件大小加 128 MiB，不按整个 userData 计算。

启动预检仍申请 1 GiB 租约，但资源不足时立即拒绝，已有排队请求时也不无限等待（`reject + timeoutMs: 0`）。首次升级失败发生在迁移 Task、intent 和模式变更之前；中断升级的非 ACTIVE 恢复同样预检，失败保留原任务、阶段和数据。启动主提示保留现有恢复失败语义，明细保留内层资源不足原因。不更改 worker 的资源预算或执行合同；其他 Main 阶段的有界等待、错误明细和退出修复见 `changes/biz-op-startup-resource-wait/spec.md`。

当前版本的所有发布条件和十二项动作必须仍有效。已完成激活及未完成升级按首次冻结的 `gates_digest` 重建固定升级 intent 并核验摘要；恢复另核验原 Task 和持久 intent，ACTIVE 继续核验原收据及防旧写约束。合法补充证据引用或 `USER_AUTHORIZED` 转为真实 `PASS` 不使原激活失效，也不改写历史授权、intent、收据或重复清旧。未完成升级沿原 Task 继续，最终 ACTIVE 阶段证据仍引用首次授权。当前门禁撤销、缺项、非法日期或冻结摘要/清理范围/收据不一致继续拒绝。

完整项目与 userData 已独立备份并逐文件核对 SHA-256；本机数据规模、文件清单与前后状态保留在该备份的核验记录中。实际切换前重新核对资源和数据状态。

## Unknowns Register

| 未知 | 分类 | 证据与处置 |
| --- | --- | --- |
| 十二项是否都有生产入口 | PROBE 已确认 | ACTIONS、policies、module.prepareDispatch、IPC 已完整接线 |
| 开启是否会清旧 | PROBE 已确认 | upgrade-main 的五阶段合同，清理范围保持 PR6 原白名单 |
| 是否可把授权记为测试通过 | 已决定 | 用户授权与测试分开，新增明确授权状态，不使用合成 PASS |
| 真实内存预算是否足够 | PROBE 已确认 | 关闭闲置应用后，真实空闲内存满足平台 freeMemory 减 2 GiB 的预算与本模块 1 GiB 租约；未改预算或注入测试 Governor |
| 真实激活是否完成 | PROBE 已确认 | 2026-09-06 本机原 Task succeeded、五阶段落盘、模式 ACTIVE；真实页面已就绪，新版导入 Task 已能创建 |

## 验证与回滚

先验证授权完整性反例、十二项策略、原严格 PASS 路径和升级保护，再运行 release-check。真实启动使用原 Main 和 production request，不注入测试 release gates 或隔离 Governor。预检不足时明确报告具体阻碍，不将配置启用等同于已经切换。

迁移 intent 尚未创建时可撤回本次配置改动；创建之后不能切回旧可写模式。保留既有 Main driver 的重试与恢复，必要时先停止应用再从完整备份恢复。
