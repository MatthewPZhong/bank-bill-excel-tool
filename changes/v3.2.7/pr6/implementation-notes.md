# PR6 实施记录

## Unknowns Register

| 未知 | 分类 | 已取得证据 / 处置 |
| --- | --- | --- |
| 旧侧库初始化会写库 | PROBE 已确认 | run-data-store.openSideDb 先建目录/DDL，不能用它作无副作用升级枚举；native 预检使用只读 SQLite |
| 旧恢复会产生新月末副本 | PROBE 已确认 | recoverMonthEndCopyIntents 可能写下月侧库，须先按原 provider 收口，再冻结最终清理清单 |
| 旧 orphan 会把打开失败当坏库删除 | PROBE 已确认 | reconcileOrphans 捕获异常后直接删旧文件；mode 必须先于该入口，MIGRATING/ACTIVE 禁止调用 |
| 旧 DDL 运行时机 | PROBE 已确认 | AppDatabase.init 早于 Background Recovery，须在旧 ensureBizOpReconTablesSupport 前读取已有 control.mode |
| 旧二进制不认识新模式 | PROBE | 使用持久、仅匹配旧 BizOP taskKey 的 SQLite 防写约束，配合旧六表保护；不得只隐藏页面或假设版本字符串阻止写入 |
| 无文件 Task 的迁移不确定状态 | PROBE | 当前 no-file TaskLifecycle 没有 FileTask 的 beforeTerminalSettlement 挂钩，需要同一可选挂钩覆盖该分类，保留未决 Task 给原恢复器；不改后台平台核心 |
| 未确认旧任务和文件 | PROBE | 旧 provider、真实关闭、完整清单/身份、未知表/文件/引用均需阻断；不得借通用 interrupted sweep 清空未知事实 |
| 发布门禁 | OPEN / 保持关闭 | Windows 目录耐久、2200 万目标规模、人工资金与 Excel/WPS 未通过，不运行真实用户数据激活 |

## Decisions / Assumptions / Deviations / Evidence

实施中继续维护。切换必须使用 Main 内部装配，renderer 不接收启用布尔值、路径或可修改的发布证明。生命周期挂钩范围只补齐现有 FileTask 与 no-file 之间的等价能力，不另建任务平台。

## Decisions

1. 不调用新的平台恢复框架。首个 Archive owner 只在本模块内部建立迁移所有权/盘点并运行原旧 provider；post-outbox hook 与明确重试接相同 activation driver，再进入 E5 调度。
2. 先检查路径/schema，再运行可能创建下月副本的原月末 provider；确认所有原 Task/Batch/flow 已收口后才记 LEGACY_QUIESCED。新产生的月文件进入最终固定清单，按页计入完整上限。
3. 阶段收据独立于普通 UPGRADE 收据，防止 LEGACY_DB_CLEARED 被平台误当作整个升级已完成。Main 是 SQL/阶段的唯一提交者；native I/O 只消费 Main 已持久授权的旧文件清单。
4. Main 六表删除、存清单、持久防写与阶段 receipt 同事务；最终清空复查、ACTIVE 标记与普通 receipt 同事务。保留所有 Archive 历史、锁、holds、blob 和其他模块配置。
5. 旧连接关闭观察只覆盖授权原恢复作用域。close 实际成功才释放 Main 所有权；关闭异常即使被旧调用方吞掉也阻断后续，连接对象仍被持有，晚到 close 可继续推进。
6. 无文件 Task 的 terminal hook 为现有 FileTask 能力的等价补齐。E5 原 Coordinator 负责最终 task/hold 状态，Main 不写自造 recoveryAttemptId 或通过旧 Archive API 更改平台 overlay。

## 实施中发现并修正

- macOS 的系统临时路径 `/var` 会规范化为 `/private/var`：使用可信 userData 目录的 realpath 作锚点，仍拒绝 userData 自身及本模块后代目录的符号链接。
- 原 no-file 分类器不接受 pending 业务结果：阶段待收口通过 terminal hook 保留原 running Task，并向内部 driver 返回待后处理状态。
- 原 Archive.beginTaskRunRecovery 会单独改变 Task status，造成平台 overlay 的 CAS 不匹配。恢复维护保持原 interrupted 状态，只在普通 UPGRADE receipt 就绪后交由现有平台收敛。真实进程退出用例已覆盖。
- UPGRADE 的非主操作 CARRIER 来源原来恒为 unknown；只将主 OPERATION 的未提交升级维持 unknown，独立 carrier 仍按新关闭事实和原终止收据合同收口。新增 WORKER_STARTED 真实退出验证。
- ACTIVE 后反馈错误也必须由 hook 暂缓自动终态，不能把已提交升级写成 failed。
- 初次全量回归指出 Main 最前面的 action-task binding startup require 必须保持首个语句；已调整新 import 位置，保留原启动合同而非放宽断言。旧 seam 的函数签名/带权限 finalizer 静态定位同步到实际调用路径。

## Assumptions / Remaining unknowns

- 磁盘预留主库大小 + 128 MiB 是保守工程初值，非目标升级规模证据；schema/文件完整预算超过上限就阻断，不丢项。
- 发布证据中 Windows 目录耐久、2200 万输入/最大并集、真实资金与 Excel/WPS 仍未完成。当前配置不激活用户数据，所有改写测试在 temp 根。既定人工验收仅阻止生产启用，不阻止已授权的实现/草稿 PR。
- 原遗留月末复制继续使用原 provider 的数据模型，本 PR 不另建旧引擎，不重写历史恢复语义。
- 本地提交和远端草稿 PR 已获用户授权；不合并、打标签、发布或执行真实清旧。

首次完整回归实际 5 项失败：Main 首 require 位置 4 项、额外 activation runtime.get 的旧计数 1 项。恢复 Main 首语句后相关静态/真实 loader 专项通过；旧 14 处 runtime 装配断言保留，新 activation 装配单列 1 处验证。完整回归正在重跑。

最终完整 release-check 已完成，退出码 0：7109 PASS / 3 既有 SKIP / 0 FAIL；53 个集成脚本 2488/2488。Electron 升级专项 30 PASS。5 项早期失败及实际修复保留在验证记录，不以最后通过覆盖历史失败。
