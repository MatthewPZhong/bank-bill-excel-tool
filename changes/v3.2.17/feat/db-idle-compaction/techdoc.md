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

退出屏障与终止：
- 结果只在子进程真实退出（utilityProcess 的 `exit`、Node 子进程的 `close`）后给出，之后才恢复存档维护、释放业务租约。`error` 事件不代表已退出：进程从未启动（无 pid）时直接结束，否则补发终止并继续等待退出。
- 终止请求会被记住：`kill()` 返回 false 或进程尚未启动（utilityProcess 在 `spawn` 前无 pid）时，在 `spawn` 后及每 500 ms 重试，直到退出；重复的用户操作也会再次尝试终止。
- 用户活动由渲染层在 window 捕获阶段监听（`src/renderer.js` `setupUserActivityReporter`）：弹窗在 document 捕获阶段拦截 Tab/Escape 时仍能上报并中止整理；收单空闲清理同样受益。
- 存档维护准备（等待存档操作、暂停后台物化与归属扫描）期间也响应取消：用户操作或退出时立即放弃本次整理、释放业务租约；准备完成后再自行释放存档维护，在此之前新存档仍会收到“正在整理存储空间，请稍后重试”。

## 三、与其他写入者的关系

- 业务任务：过渡租约 `requireIdle` 保证开始时无登记任务；整理期间 `begin()` 一律拒绝。
- 未登记到业务操作登记表的写入方：`main.js` `idleCompactionBusyReason()` 在整理开始前检查收单操作锁、收单后台清理标记、银行对账单操作锁与收单校验 worker，任一在忙则本次跳过（与升级重启前的忙检查同口径）；整理开始后这些入口因过渡租约拿不到锁。
- 存档中心：`beginDatabaseMaintenance` 等待存档操作结束并暂停后台物化与归属扫描，结束后 `endDatabaseMaintenance`。
- 主连接：整理开始前在主连接做一次 `wal_checkpoint(TRUNCATE)`；主连接没有 `busy_timeout`，整理期间若有未登记的主线程写入（例如定时深色模式的设置写入）会得到“数据库忙”，按各自的失败路径处理，下次再写。
- 子进程：创建前经 `memoryCarrierAdmission` 准入（与其他原生载体一致，已登记 `changes/v3.2.11/v3.2.11-bizop-rows-low-memory/carrier-inventory.json`）；低内存任务占用资源时本次跳过，下次空闲再试。

## 四、兼容与回滚

不改数据结构；只新增 `app_settings` 键 `db_idle_compaction_last_success_at`。回滚代码即不再整理。整理需要临时空间：SQLite 先在临时目录重建再经 WAL 写回，因此主库所在卷与 SQLite 临时目录所在卷都要求剩余 ≥ 库大小 × 2（比 v3.0.5 一次性整理的 1.2 倍更保守，两卷相同时即同一判断）。临时目录由主进程确定为系统临时目录（`os.tmpdir()`），经环境变量 `SQLITE_TMPDIR`（Unix）与 `TMP`/`TEMP`（Windows）传给整理进程，保证重建临时库落在已检查的卷上，也不写入可能被 OneDrive 同步的数据目录。

## 五、验证

- `tests/unit/main-process/database-idle-compaction.test.js`：评估、跳过条件、磁盘告警限频、成功、中止、退出等待、低内存任务占用时跳过、登记表提示，以及下述生命周期用例。
- `tests/unit/main-idle-compaction-wiring.test.js`：6 项，执行 `main.js` 生产函数（收单阈值 60 分钟时仍检查整理、收单清理与整理的先后、整理中关窗先中止再关闭、升级准备期间仍阻止关窗）。
- 相关既有单测 156 项通过；lint 与架构检查通过。
- 2026-11-11 Codex 审查指出关窗入口与收单阈值两处接入缺陷，已修复并补上述回归测试。
- 2026-11-11 Codex 第二轮审查指出存档维护准备不可取消、终止失败未重试、`error` 事件提前放行三处生命周期缺口，已修复；`database-idle-compaction.test.js` 增至 13 项（新增维护准备取消、重复终止、error 后等真实退出、未启动即失败、启动前终止重试）。
- 2026-11-11 Codex 第三轮审查指出 SQLite 临时目录所在卷未纳入余量检查、弹窗拦截键盘活动导致无法中止两处，已修复；新增临时卷余量与临时目录传递用例、`tests/unit/renderer-user-activity-reporter.test.js`。
- 2026-11-11 Codex 第四轮审查：VCC 分支无发现；本分支指出整理准入漏掉只持收单操作锁的后台清理，已修复，`main-idle-compaction-wiring.test.js` 增至 8 项。
- 未完成：Electron 打包环境下 `utilityProcess` 路径的实际整理与中止（本机 Electron 无法开窗口），随 VCC B86 在 Windows 回归。
