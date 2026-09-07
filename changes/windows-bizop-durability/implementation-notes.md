# Implementation Notes

## Baseline

- 需求、约束与未知见 spec.md。基线 v3.2.7 / efd4c302。
- 用户要求 Windows 新版完整可用；不采用仅恢复启动并回退旧模块的方案。

## Decisions

- Windows 探针已证明目录可写句柄可真实落盘：共享目录屏障、Publisher 和旧文件回收改用 Windows 可写目录句柄，候选分片用 O_RDWR。POSIX 目录保持只读；不更换存储格式或迁移策略，不忽略新增错误。
- 既有稳定版本与原工作目录保持原状，开发在独立 worktree / 分支进行。
- 文件原件、用户数据库和日志仅只读；复现使用临时 SQLite 与合成旧业务数据。

## Evidence

- Windows 探针 run 34099429931 / ac6aa4dc 成功；Node 22.19.0、libuv 1.51.0、Windows 10.0.26100.0。文件和目录 r 均 fsync EPERM，r+ 与 O_RDWR|O_SYNC 成功；原生 Win32 GENERIC_WRITE/READ_WRITE + BACKUP_SEMANTICS + FlushFileBuffers 成功，GENERIC_READ 失败。不使用卷级 flush 或主动开启备份/恢复权限；runner 结果不代替目标用户权限验收。链接：https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/34099429931 。
- Electron 36.9.5 / Node 22.19.0：隔离故障复现 3 PASS / 0 FAIL / 0 SKIP。两类预检失败的外层 ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED 和内层错误均与日志一致；未创建激活记录或升级 Task，旧行、设置、旧月文件和外部原件摘要一致。
- 微软 FlushFileBuffers 文档要求 GENERIC_WRITE；卷级 flush 需要管理员权限，不能作为普通用户产品的默认路径：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers 。
- Electron 实际 libuv 1.51.0 对应源码：https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c 。

## Remaining Unknowns

- 完整 Windows 业务链、正常 Electron 单实例启动与普通权限验收尚待完成。
- 生产修复方案与全面验证尚未完成；当前不宣称已修复或 Windows 可用。

## Implementation Findings

- 完整本地回归发现最小候选验证入口用 copyFile 复制只读归档，会继承只读权限；封存改用可写句柄后暴露 EACCES。仅将新建的自有候选设为 0600，原件权限和字节不变；正常 XLSX 导入/计算生成的分片已有写权限。
- 资源预检保留现有 1 GiB 阶段预算和有界拒绝合同，错误文案增加实际可用预算与预算上限；不通过低报 worker 占用来绕过保护。本机正常 Electron 启动实际触发该预检，不能将本地启动记作通过。
- 复核输入归档至导出交付路径，存档中心的归档、物化、根目录迁移及 outbox 也存在同类只读目录调用；一并修正 Windows 打开方式，保持各自原有错误传播/兼容处理，纳入既有归档回归。
- 本地归档补充回归 126 PASS / 0 FAIL / 0 SKIP；落盘/Publisher 86 PASS；候选/升级资源补测 46 PASS。首轮完整 429 项中的 12 个只读副本失败已在对应候选套件补测覆盖；不把首轮整体结果改写为 PASS。
- Electron default_app ESM 初始断点不适合验收控制，改成正常启动后连接 loopback inspector。独立临时探针以测试 Host 预激活数据库，仅验证接入：真实主窗口、单实例锁、ACTIVE / recoveryReady IPC 和正常退出成功。此探针不证明正常首次激活或完整业务流程；Windows 正式验收不使用预激活捷径。
- 草稿 PR #238。Windows 完整合同与源码/打包正常应用验收仍等待实际 CI 结果，不交付半成品。

## Blindspot Review

- 已覆盖：不再把只读句柄 EPERM 解释为平台必然不支持；所有 BizOP 候选/旧文件回收和归档至 Publisher 路径均检查句柄方式。错误/unsupported 保护、句柄关闭和原件不变保持原合同。
- 已覆盖：副本继承只读权限的问题已定位到最小候选验证入口；只修改新建副本权限，没有改变归档原件或业务内容。
- 无新增金额、币种、账户识别、结果行处置或迁移清理范围变化；未发现由本次修改引入的资金红线。计算/输出和各提交边界恢复由现有完整业务合同与实际 IPC 验收覆盖。
- 存活验证项：Windows 普通目标设备人工验收、真实在线升级后启动，以及最终打包产物验证。不得用本地 fixture 激活、源码应用或原生 API 探针替代这些结论。
