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
