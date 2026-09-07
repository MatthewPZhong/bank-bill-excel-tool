# 业务 OP 显式启用记录

## Baseline

- 用户目标及范围见 [spec.md](spec.md)，基础提交 `5850fef1`。
- PR6 原文保留为历史实施记录，本次启用决定单独记录，不生成 E6。

## Decisions

- 接受用户“全部开启”的明确授权，按逐项 `USER_AUTHORIZED` 配置开启当前十二项动作。
- 未完成验收保留 NOT_RUN；平台沿用合法 baseline/probe 元数据，不修改平台 schema 或恢复接口。
- 清理范围、实际关闭、目录耐久、内存与磁盘前置保护保持原实现。

## Deviations

- 原交付默认 disabled，现依用户新指令启用。对应 spec 已先同步。
- 旧测试对 disabled 的场景改为显式构造 disabled 配置，避免依赖生产默认值；真实默认启用单独验证。
- 全量并发时故障子进程两次在 30 秒内尚未建库，隔离复跑约 1 秒通过。测试 runner 增加可选 UNIT_TEST_CONCURRENCY，默认行为不变；本次取 2，所有测试仍执行，生产超时与资源预算均不改变。

## Evidence

- 源码核对：ACTIONS 共 12 项；真实 Main 已传 productionRequests=true。
- 只读盘点及备份结果见 spec；源与备份均核验 SHA-256。
- 启用及升级专项 60 PASS；四个回归失败项定向复验 4 PASS。两条全局 false 断言及一个 disabled fixture 已同步，故障子进程的 30 秒超时保持原值。
- 真实生产 Runtime 取得并释放 1 GiB 租约；未提供 freeMemory 或 Governor override。只读旧 schema / quiescent 验证通过，六表完整，旧侧库文件为零。
- 首次 release-check：7198 PASS / 3 SKIP / 4 FAIL，日志保留；第二次发生同一子进程启动超时后中止，仅终止本次测试进程树。尝试通过 NODE_OPTIONS 设置并发被 Node 拒绝，未启动测试，单独保留记录。随后通过 runner 可选参数继续完整复验。
- 最终 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 退出码 0：lint / smoke 通过；单元 7202 PASS / 3 SKIP / 0 FAIL，459 个文件；53 个集成脚本、2488 项检查全部通过。完整日志及前三次尝试分别保留。
- `check-vars` 检查两个生产文件，未命中已登记重要变量；后台平台核心、内存/磁盘预算、恢复接口和限定清理实现没有修改。
- 第一次 npm 启动在尚未创建迁移 Task、模式仍为 DISABLED 时结束。随后用户关闭部分闲置应用，真实空闲内存满足预算，直接运行已安装 Electron，使用真实 userData、Main 和 production request。
- 2026-09-06 23:48 本机升级 Task succeeded；MIGRATING、LEGACY_QUIESCED、LEGACY_DB_CLEARED、LEGACY_FILES_RECLAIMED、ACTIVE 五阶段完整，六张旧表均为零。CUA 看到新版按钮可用及已就绪提示；随后用户发起的新版导入 Task 已为 running。未把该导入的完成结果或资金正确性计为本轮验收。

## Remaining Unknowns

- 已完成：当前机器真实平台内存准入与真实启动；本机已退出 legacy。其他机器仍需要通过相同实际资源、目录耐久和升级保护。
- NOT_RUN：Windows 目标耐久成功链、目标规模、资金与 Excel/WPS 人工验收仍未完成；本次用户授权不替代其结果。
