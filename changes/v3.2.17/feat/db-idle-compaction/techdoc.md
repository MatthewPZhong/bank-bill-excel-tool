# TechDoc — v3.2.17 空闲时自动整理主库

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.17（暂定） |
| 功能分支 | `feat/db-idle-compaction`，基于正式标签 `v3.2.16`（`8e027cb8`） |
| 日期 | 2026-11-11 |
| 状态 | 已实现，待 PR 审查与 Windows 打包版回归 |
| 依据 | [spec.md](spec.md) |

## 一、模块

| 文件 | 职责 |
| --- | --- |
| `src/main-process/database-compaction/idle-compaction.js` | `evaluateCompactionNeed`（只读评估）、`createIdleCompactionController`（条件判断、过渡租约、存档维护暂停/恢复、启动与中止子进程、日志、完成时间）、`launchCompactionProcess`（Electron 用 `utilityProcess.fork`，纯 Node 用 `spawn`） |
| `src/main-process/database-compaction/compaction-process.js` | 子进程入口：`VACUUM` → `wal_checkpoint(TRUNCATE)` → `quick_check`，结果一行 JSON 写 stdout |
| `src/main-process/business-operation-registry.js` | `acquireTransition(owner, { busyMessage })`：持有租约时拒绝新任务的提示可自定义，默认仍为升级提示 |
| `src/main.js` | 创建控制器；空闲清理定时器（每 2 分钟）在收单空闲清理结束后调用 `maybeRun()`，不受收单清理阈值设置（可大于 30 分钟）和其提前返回影响；`app:user-activity` 调用 `abort()`；`before-quit` 与主窗口 `close`（`handleMainWindowClose`，覆盖任务栏关闭、Alt+F4 等不经渲染层的入口）在整理进行中先 `stop()` 收尾，再继续退出或重新关闭窗口；升级准备期间仍阻止关窗 |

## 二、为什么用子进程

`VACUUM` 是一次长时间的同步原生调用，`worker_threads` 的 `terminate()` 要等调用返回才生效，做不到“一操作就中止”。子进程可随时结束；结束等同一次崩溃，SQLite 丢弃未提交内容（WAL 中未提交帧被忽略、临时文件清理），数据库保持整理前状态。实验：12 万行、235 MB 库在启动后 100 ms、250 ms（VACUUM 进行中）与 400 ms（已提交）强杀，`quick_check` 均为 ok，行数与内容合计一致。

## 三、与其他写入者的关系

- 业务任务：过渡租约 `requireIdle` 保证开始时无登记任务；整理期间 `begin()` 一律拒绝。
- 存档中心：`beginDatabaseMaintenance` 等待存档操作结束并暂停后台物化与归属扫描，结束后 `endDatabaseMaintenance`。
- 主连接：整理开始前在主连接做一次 `wal_checkpoint(TRUNCATE)`；主连接没有 `busy_timeout`，整理期间若有未登记的主线程写入（例如定时深色模式的设置写入）会得到“数据库忙”，按各自的失败路径处理，下次再写。
- 子进程：创建前经 `memoryCarrierAdmission` 准入（与其他原生载体一致，已登记 `changes/v3.2.11/v3.2.11-bizop-rows-low-memory/carrier-inventory.json`）；低内存任务占用资源时本次跳过，下次空闲再试。

## 四、兼容与回滚

不改数据结构；只新增 `app_settings` 键 `db_idle_compaction_last_success_at`。回滚代码即不再整理。整理需要临时空间：SQLite 先在临时目录重建再经 WAL 写回，因此要求剩余磁盘 ≥ 库大小 × 2（比 v3.0.5 一次性整理的 1.2 倍更保守）。

## 五、验证

- `tests/unit/main-process/database-idle-compaction.test.js`：8 项（评估、跳过条件、磁盘告警限频、成功、中止、退出等待、低内存任务占用时跳过、登记表提示）。
- `tests/unit/main-idle-compaction-wiring.test.js`：6 项，执行 `main.js` 生产函数（收单阈值 60 分钟时仍检查整理、收单清理与整理的先后、整理中关窗先中止再关闭、升级准备期间仍阻止关窗）。
- 相关既有单测 156 项通过；lint 与架构检查通过。
- 2026-11-11 Codex 审查指出关窗入口与收单阈值两处接入缺陷，已修复并补上述回归测试。
- 未完成：Electron 打包环境下 `utilityProcess` 路径的实际整理与中止（本机 Electron 无法开窗口），随 VCC B86 在 Windows 回归。
