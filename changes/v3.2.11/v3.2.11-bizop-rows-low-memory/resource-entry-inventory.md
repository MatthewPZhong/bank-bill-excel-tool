# 低内存资源入口清点

基线 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`；本轮实现在功能 worktree 未提交。此表描述源码装配与本地回归，Windows 平台分支的实机覆盖单列待验收。完整构造点位置见 [carrier-inventory.json](carrier-inventory.json)。

## 统一观察规则

- Main 的 `memory-activity.js` 维护唯一活动表。构造前的 `memoryCarrierAdmission(config)` 同步检查低档排他，再创建载体并注册真实 `exit` 监听；业务 done、error 或 terminate 请求均不注销。
- 同时登记 runtime Governor；关闭失败的旧代 lease 继续参与新代判断。未知增长保持等待，未报告的增长不按零处理。
- worker_threads 内的嵌套 Worker 属于根载体完整阶段，观察器在子 isolate 不另起全局账本。根 owner 必须按原退出屏障等待子资源；原管理器和相关回归保留。
- 未迁移任务的兼容额度不因 H 扩大而放宽。低档运行时，新的 legacy carrier 构造先被拒绝；Main legacy 工作在进入重型执行前有界等待。
- Main 注册 IPC 默认观察；BizOP v327 和 rows/v2 prepare 由真实 phase 自管。取消／控制入口继续可用。新增普通 IPC 默认不能绕过低档屏障。

## 源码入口与所有权

以下路径省略 `src/main-process/`；`src/backend/` 明示完整根。

| 入口 | 覆盖方式与释放边界 |
| --- | --- |
| Supervisor、worker-thread/utility-process adapter | 同一 Governor；Base＋Phase 稳定预检；carrier 在真实 exit 后释放。 |
| service-host 与直接 phase | 既有活动 lease 进入同一账本；未申报的增长是 unknown，不能与低档并行。空闲但未退出的重型服务也保守阻断。 |
| toolbox-split-read-owner / large-split-dispatch | metadata、单字段和旧分支均观察；v2 cancel/window destroy 等待 closed 后清理自有临时目录。 |
| toolbox-background/route-scanner-core | 输出 writer Worker 构造前检查，实际 exit 注销。 |
| toolbox-row-split/service/executor/cache | generation config → 真实 Worker → rows-io 验证 → publication-io；阶段交接不长持上一低档锁。 |
| toolbox-output-publication-dispatch / publication-recovery/coordinator | 获批的 Publisher、目标校验、恢复 Worker 携带自有或借用配置；有领域租约时不重复申请。无领域观察的 pending 兼容路径保留基线零内存记账及 CPU／Worker／IO 约束，载体增长仍按未知观察。 |
| biz-op-v327/phase-admission / publication-owner / export-publication | import/compute/export、自动报告最终验证、raw-source、删除前保留、升级和恢复由静态 phase 映射；legacy IPC 内恢复沿用已有 1 GiB 兼容观察，通过 Main 活动身份证明解除受阻队首的依赖，内部观察先执行；父活动未知增长与完整资源检查保持。 |
| big-table-import-dispatch、src/backend/big-table-import/pipeline | 根和嵌套 parser Worker；子载体归根 owner。 |
| acquiring-bill-currency-session、run-check-worker-pool、run-check-multiworker | legacy Worker 生命周期纳入观察；保留既有池退出屏障。 |
| pending-session、biz-op-recon-session、position-reconciliation/import-dispatch | utilityProcess、spawn 与 Node 的 `forkChild` 别名分支均显式包裹；Windows 真实载体行为仍需平台验收。 |
| vcc-financial-op-service / output/writer-coordinator / storage-migration | read/write/compute/export、分片 writer 和存储迁移载体均观察。 |
| vcc-op-calc/parser-pipeline、bank-bu-worker/dual-parser-dispatch、duplicate-inbound-match/paired-parser-dispatch、pre-fund-reconciliation/mpt-import/managed-import | 领域解析载体均登记；不放宽原 action 生产开关。 |
| background-execution/canary/durable-recovery | 测试载体同样观察；其运行不算生产平台实测。 |
| Main 默认 IPC | 旧 Main 重型扫描、文件读写和持续 Promise 生命周期是增长未知工作；完成前不放行低档。 |
| Main 启动／异步维护 | acquiring 孤儿清理、side-DB reconcile、backup retention、pre-fund 持久镜像回收、idle cleanup 与独立清理入口均观察。资源等待超时保留原待办事实，不标记已清理。 |
| Main 更新检查／下载 | 完整异步工作进入未知增长观察；窗体控制和状态查询不被锁住。 |

## 负例和验证边界

`tests/unit/architecture/memory-carriers.test.js` 扫描全部 src，核对当前 28 个原生创建点与清单，并拒绝未经过同步 guard 的新 Worker；解构导入的 fork／spawn／Worker 别名也纳入解析，并有未包裹负例；既有 architecture gate 核对准确动态目标和模块边界。两个既存静态未解析点仍按架构报告保留，不能把静态 PASS 称为所有外部依赖运行行为的证明。

`memory-activity.test.js` 覆盖未知 Main 工作、未退出载体、反向 legacy 构造阻断、同配置已准入载体、旧 runtime 和默认新 IPC。原 Worker/utilityProcess/pool 的退出、故障及恢复测试参与完整单测。

生产 `memory-qualification.json` 仍为 pending。Windows 专有分支、完整安装包中的活动覆盖及压力峰值尚未验收；资格清单中的 inventoryComplete 不因本表生成就自动改为 true。
