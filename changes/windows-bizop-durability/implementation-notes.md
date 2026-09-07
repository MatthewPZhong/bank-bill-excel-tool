# Implementation Notes

## Baseline

- 需求、约束与未知见 spec.md。基线 v3.2.7 / efd4c302。
- 用户要求 Windows 新版完整可用；不采用仅恢复启动并回退旧模块的方案。

## Decisions

- 先在独立 Windows runner 探明 Node 与原生 Win32 目录句柄能力；此阶段不修改生产持久化代码。
- 既有稳定版本与原工作目录保持原状，开发在独立 worktree / 分支进行。
- 文件原件、用户数据库和日志仅只读；复现使用临时 SQLite 与合成旧业务数据。

## Evidence

- Electron 36.9.5 / Node 22.19.0：隔离故障复现 3 PASS / 0 FAIL / 0 SKIP。两类预检失败的外层 ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED 和内层错误均与日志一致；未创建激活记录或升级 Task，旧行、设置、旧月文件和外部原件摘要一致。
- 微软 FlushFileBuffers 文档要求 GENERIC_WRITE；卷级 flush 需要管理员权限，不能作为普通用户产品的默认路径：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers 。
- Electron 实际 libuv 1.51.0 对应源码：https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c 。

## Remaining Unknowns

- Windows 目录读写句柄与原生 API 的实际结果：等待独立探针。
- 生产修复方案与全面验证尚未完成；当前不宣称已修复或 Windows 可用。
