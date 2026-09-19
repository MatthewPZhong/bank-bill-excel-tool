# Windows 业务 OP 启动与完整可用性修复

## Task Brief

- Goal：修复 v3.2.7 Windows 真实升级后的启动失败，交付新版业务 OP 完整可用。
- Context：2026-09-07 用户提交 error/info/warning 三份日志，随后明确选择“新版业务 OP 在 Windows 完整可用后再交付”。日志显示 3.2.0 在线下载并安装 3.2.7 / efd4c302 后，资源预检与目录持久化预检先后阻断启动。
- Constraints：不回退 legacy，不关闭新版策略，不忽略或伪造持久化成功；保留旧数据、迁移阶段、Task/intent/收据和金额合同；不操作用户真实数据库；不覆盖已发布 v3.2.7 tag 或资产。
- Done when：Windows 真实宿主执行生产配置首次升级、ACTIVE 重启、输入导入、核对、全部导出、删除与中断恢复成功；资源错误可解释且不会无限等待；Windows 成功链不再因本缺陷跳过。人工目标设备验收与自动 Windows CI 分开记录。

## 已确认事实

| 事实 | 证据 | 约束 |
| --- | --- | --- |
| 用户已运行正式 efd4c302，非旧二进制 | info.log 87/88、102/103、117/118、132/133 行 | 原发布已包含 12 文件修复，不能靠重传同版本修复 |
| 最新两次错误是 DURABILITY_BARRIER_UNAVAILABLE | error.log 12、16 行 | 关闭其他程序不足以处理目录屏障问题 |
| 升级预检申请 1 GiB，再写 precheck 文档 | upgrade-main.js acquirePrecheckCapacity/runAttempt | 两类失败出现在启动迁移 Task 之前 |
| POSIX 式目录 fsync 在 Windows EPERM/EISDIR/EACCES 被标为 unsupported | background-execution/durable-file.js | 不能把 unsupported 改为 supported 或空操作 |
| Windows 成功路径被跳过，打包 canary 未覆盖实际业务 OP 首次激活 | tests/helpers/durable-directory-tests.js、packaged-runtime-runner.js | 增补真实 Windows 生产入口验证 |
| 两种失败在临时 SQLite + Archive/升级真实调用链复现，旧数据不变 | 原工作目录 outputs/investigations/bizop-win-startup-20260907/reproduction.json | 该结果不代替用户数据库逐项核对 |

## Unknowns Register

| 未知 | 分类 | 验证与决定 |
| --- | --- | --- |
| Windows 是否存在当前权限下可用的真实目录落盘句柄 | 已消除 | Windows 10.0.26100.0 / Node 22.19.0：目录 r 返回 EPERM，r+ 真实 fsync 成功；Win32 GENERIC_WRITE/READ_WRITE 同样成功 |
| 如何保留原持久化合同 | 已消除 | Windows 目录改用可写句柄；POSIX 保持只读。候选分片用 O_RDWR 真正落盘；不改数据格式、迁移策略或失败保护 |
| 首次升级内存申请是否缩小 | 已决定 | 保留现有 worker 的 1 GiB 预算，不低报占用或反向扩大公共预算；补充可用/上限信息，既有低预算及恢复阶段测试验证有界拒绝和数据保留 |
| 其他落盘入口能否同样完成 | PROBE | 升级旧文件回收、候选分片封存、Publisher 与删除回收均纳入验证 |
| 修复交付是否允许仅恢复启动 | 已消除 | 用户明确拒绝此范围，要求新版完整可用 |

## 风险优先计划

1. Windows 实际 API 能力探针；失败时选择有证据的替代持久化实现，不降级合同。
2. 完成跨平台落盘最小闭环，验证普通权限、中文目录、不可写/只读、失败与句柄释放。
3. 跑真实首次升级至 ACTIVE，核对旧对象范围、各阶段崩溃恢复和重启幂等。
4. 覆盖新版完整导入、计算、导出、删除链；核对输出与封存数据一致。
5. 将 Windows 实际业务链纳入发布门禁，完成相关完整 CI，再准备更高补丁版本交付。

## 验收入口

- `scripts/biz-op-v327/verify-windows-app.js` 启动正常应用入口，保留单实例锁和真实生产策略。只替代原生文件选择，所有导入、核对、七类导出、删除与恢复通过真实 renderer/preload/Main IPC 执行。
- 默认验证源码应用；`BIZOP_ACCEPTANCE_APP` 指定当前构建的 win-unpacked 可执行文件时验证真实 app.asar 入口并断言 isPackaged。开发构建与正式发布均在发布资产之前执行此门禁。
- 全部数据是脚本新建的临时合成数据。旧迁移范围、外部原件摘要、19 列结果中的入账 15 / 出账 5 / 合计 10 / 反推余额 110 / 差额 -10、重启幂等、导入中断后旧 heads 和原件不变均有明确断言。
- Windows 业务 OP 成功合同不允许因目录能力跳过；仅保留 Publisher 既有 macOS 专属 case-fold 测试的显式平台跳过。

## Windows 全量回归补充范围

- 首轮真实 Windows 全量执行暴露导出文件身份超出 Number 安全整数范围。导出候选的内部 `fileIdentity` 增加 `version: 2`，以 BigInt stat 取得精确 dev/ino/size/mtimeNs/ctimeNs，并以十进制字符串保存；Main 按相同精确字段验证。原有安全数值的 v1 暂存证据继续兼容，不接受已失去精度的旧身份。账单、结果列、公开版本和业务迁移格式保持不变。
- 首轮故障还包括测试仅匹配 POSIX 路径、只识别只读目录打开方式，以及在关闭 SQLite/spool 前删除临时目录。修正测试的故障注入和资源释放顺序，保留原有取消、EIO、原件和恢复结果断言；不以重试删除或跳过测试掩盖打开的句柄。
- 正常 Windows 应用验收独立于耗时合同测试并行执行，先暴露实际用户流程问题；打包应用仍是开发构建与正式发布的独立门禁。
- 合同测试按业务 OP、C2 恢复、归档/Publisher 三组分别执行，完整覆盖原文件集合并分别保存清单；各组保留有界超时和原 skip 拒绝规则。Windows 终态恢复子进程的测试宿主上限为 120 秒，并记录阶段与超时原因；生产任务的等待和恢复合同不变。
