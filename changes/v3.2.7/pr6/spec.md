# PR6 一次性升级、旧入口退役与启用门禁

Goal：接通 E5 的一次性清旧协议和实际启动/恢复重试装配，在全部发布门禁完成后启用新区间模块；未完成时保留 DISABLED，不能通过版本号或 renderer 参数越过门禁。

Context：基于 PR5 781d0b8d，原 E5 包只读，用户已确认本期旧业务数据清理的限定范围并要求分 PR 本地提交后直接提远端 PR。本次实现只使用隔离临时库/合成文件测试，不执行用户数据激活。

Constraints：只清六张旧 biz_op_recon_* 表和旧专属根中严格 month-YYYY-MM.sqlite 及已核实伴随文件；不清 Archive/Task/receipt、用户锁、共享 blob、其他模块或外部文件。新目录与旧目录隔离。迁移 intent 已持久化后不退回旧可写模式。StartupRecoveryCoordinator 保持原接口/恢复语义。

Done when：版本模式先于旧恢复、孤儿、retention 与旧 DDL 决定路由；真实 Task/worker 关闭和原恢复 driver 接通；同一激活 intent 经故障重启到准确阶段，主库清理和阶段收据同事务，清文件逐项身份复核，完成后重复启动不再清旧或新数据；旧客户端至少不能创建旧 BizOP Task 和写旧业务；门禁缺失保持禁用；相关自动测试/源码复核及文档同步后提草稿 PR。

工程细化：发布门禁由受版本控制的 Main 配置明确记录，未知/未执行/缺证据不算通过。只有新 action 的各自生产证据完整才准备启用，不改变其他后台 action。由于 Windows 目录耐久、目标规模和人工资金/Excel 仍未执行，本 PR 的交付配置继续关闭；实现验证和实际激活分开记录。

## 落地合同（工程细化，不生成 E6）

- 启动装配分两段共用一个 Main driver：Archive 首个 BizOP owner 在 MIGRATING 下盘点并调用原旧 provider；post-outbox hook 验证原 Task/Batch、flow intent 及关闭事实后再记 LEGACY_QUIESCED，并清主库/文件。恢复重试调用同一 driver 后接 E5 recovery.run。旧 owner/orphan/handler/DDL 均先读模式。
- ACTIVATION_PRECHECK 先核实 Main 单实例锁、尚无业务窗口/活动业务、六表/引用、可获得既有 1 GiB Governor 容量、真实目录屏障和磁盘。磁盘初值为“主数据库文件大小 + 128 MiB”可用空间，为 SQLite 日志及元数据留量；不足或查询失败拒绝，目标升级规模验收前仍需校准。
- 迁移的持久 intent、prepared operation、阶段行、mode 和旧 Task 插入防写 trigger 同事务。六表清空和 LEGACY_DB_CLEARED 阶段收据同事务；ACTIVE 才写普通 UPGRADE 业务收据。所有表名来自固定白名单；外部 FK、未知 trigger、未知文件、symlink/hardlink、未决旧 Task/Batch/flow/source 或旧连接未关均阻断。
- `upgrade-preflight` 的 native 载体处理盘点、hash 与 Main 已授权的旧文件 I/O。清理 step 仅在 LEGACY_DB_CLEARED 后下发精确持久清单，仍绑定同一 UPGRADE Task/intent 和实际 carrier；worker 无主库提交权。`none` 依照原平台合同 §2.3 不代表纯函数。每页最多 32 个侧库/96 个含伴随文件的文件项，完整上限 4096，不截断；报告/plan 仍受既有 64 KiB 文件合同限制。新数据的独立 RECLAIM 路线不变。
- 原 provider 可能创建下月副本，所以清理清单在 provider 和 outbox 收口后重新完整取得。每个 readonly SQLite 连接实际 close 后才记录完整文件 SHA-256 与 dev/ino/size/mtimeNs/ctimeNs。重放清理时仍核对身份和 hash；真实 unlink 后目录 fsync 成功才记完成，缺失的已授权项允许幂等收口。
- 共享改动仅补齐 no-file TaskLifecycle 的可选 beforeTerminalSettlement，与 PR4 FileTask 语义相同。迁移未完成/提交后反馈丢失时拒绝自动终态，保留原 Task。任务已由平台标记 interrupted 时，Main 恢复维护保持该状态及 overlay；最终 receipt 由现有 Coordinator 合法 begin/complete recovery。原关闭观察、容量所有权、Coordinator 接口与扫描预算不变。
- 主库保留空旧表并设置三类防写约束，同时阻止旧 `bizOpRecon:*` Task 创建；当前客户端还拦截旧所有 IPC、旧 orphan/删除和侧库初始化。每次新业务准入核对 ACTIVE 收据、发布证明与 guard 本体。激活后旧客户端不具备恢复旧数据的能力，受控旧库恢复必须另走明确备份与人工流程。
- 生产路径以 `production:true` 派发，并受编译进 Main 的版本化发布门禁和现有 policy 双重检查；隔离测试可注入合成发布证明，不能据此声称生产开关或真实数据激活通过。发布配置仍 disabled，版本号不 bump。
