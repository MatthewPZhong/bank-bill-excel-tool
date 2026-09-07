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
| 首次升级内存申请能否按实际阶段缩小而不低报 worker 预算 | PROBE | 检查 worker inspect/reclaim 批量与真实内存证据；公共预算不反向扩大 |
| 其他落盘入口能否同样完成 | PROBE | 升级旧文件回收、候选分片封存、Publisher 与删除回收均纳入验证 |
| 修复交付是否允许仅恢复启动 | 已消除 | 用户明确拒绝此范围，要求新版完整可用 |

## 风险优先计划

1. Windows 实际 API 能力探针；失败时选择有证据的替代持久化实现，不降级合同。
2. 完成跨平台落盘最小闭环，验证普通权限、中文目录、不可写/只读、失败与句柄释放。
3. 跑真实首次升级至 ACTIVE，核对旧对象范围、各阶段崩溃恢复和重启幂等。
4. 覆盖新版完整导入、计算、导出、删除链；核对输出与封存数据一致。
5. 将 Windows 实际业务链纳入发布门禁，完成相关完整 CI，再准备更高补丁版本交付。
