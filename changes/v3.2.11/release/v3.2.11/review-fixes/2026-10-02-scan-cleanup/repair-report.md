# release/v3.2.11 扫描临时资源清理责任修复

- 日期：2026-10-02
- 基线：`8cc9b2ddbc056c8a78d4a8f061083853815db019`
- 工作分支：`release/v3.2.11`
- 问题：Worker 已真实退出后，临时目录删除失败使 owner 丢失补偿责任。
- 当前验证状态：修复完成，完整 `release-check` 通过（退出码 0）。

## 修复结果

`admission-only-owner` 独立保留载体记录与待清理记录。确认 Worker 真正退出即释放执行 lease；目录清理失败仍反馈原错误，保留输入、尝试次数和最后错误。`close()` 对本轮仍失败的记录重试一次，并发调用共享同一轮。

关闭结果为 `{ closed, unclosedCount, cleanupPendingCount }`。只有载体及清理责任都完成，`closed` 才为 true；持续删除失败不会占用已经释放的 Worker 或内存额度。

Toolbox 使用 Main 固定根 `{userData}/toolbox-scan-temp/`。启动前写 owner、根和目录身份；删除前保存关闭事实及文件身份清单。重试逐项复核设备号、inode、创建时间及文件大小/修改时间/状态变化时间；部分已删除对象允许缺失，替换对象、未知新增内容和符号链接保留。删除采用登记对象的 unlink/rmdir。

Main 启动读取同一固定根的责任记录；已保存 `cleanup-pending` 的记录可继续补偿。退出时，持久补偿待处理会留下诊断并继续关闭 runtime；仅有内存责任而未保存成功时明确拒绝退出，后续可重试。

## 故障回归

| 场景 | 结果 |
| --- | --- |
| 首次 EPERM，第二次允许删除 | run 报清理错误；close 第二次清理成功；目录及责任记录删除 |
| 持续 EACCES | `unclosedCount=0`、`cleanupPendingCount=1`、`closed=false`；执行配额为 0 |
| 清理仍在等待 | 下一项扫描可以取得前一项已退出 Worker 释放的额度 |
| 并发 close、关闭时清理失败 | 同轮单飞，仍失败的责任保留，迟到成功被取消抑制 |
| 新进程恢复 | 根据持久责任和原身份补偿成功 |
| 目录/文件替换、目录符号链接 | 保留替代对象和记录，返回身份错误 |
| 部分删除后重试 | 已删除对象不阻断，剩余对象仍按原身份处理 |
| 清理失败后新增文件 | 保留未知内容及责任记录 |
| 无记录的同名前缀目录、损坏记录 | 不删除，仅对记录异常给诊断 |
| 关闭事实尚未写盘、责任持久化失败 | 恢复保留；退出明确失败，可在写入恢复后重试 |
| 取消及窗口销毁后的清理失败 | 等待真实 Worker 退出，保留失败责任，close 可补偿 |
| 附加活动日志写入失败 | 已持久保存的补偿继续保留，不阻断 runtime 关闭 |

旧实现的四项新增故障回归为 **0/4 PASS**；原七项 owner 单测为 **7/7 PASS**，因此聚焦前测总计 **7/11 PASS**。这四项失败来自本轮新补的预期，未计为四个独立缺陷。

## 验证

| 层级 | 命令/范围 | 结果 |
| --- | --- | --- |
| 聚焦单测 | owner、实际扫描、Main 启动/退出合同 | 27/27 PASS |
| 新故障集成 | `node scripts/integration/toolbox-scan-cleanup.js` | 16/16 PASS |
| 低内存基础 | `node scripts/integration/toolbox-low-memory-foundation.js` | 4/4 PASS |
| pending 兼容扫描 | `node scripts/integration/toolbox-split-read-compatibility.js` | 12/12 PASS |
| lint | `npm run lint` | PASS |
| 架构 | `npm run check:architecture` | 787/787 文件；39 个历史提交；PASS |
| smoke | `npm run smoke` | PASS |
| 全量单测 | `npm run test:unit`，并发 2 | 9577 PASS／0 FAIL／4 Windows SKIP |
| 全量集成 | `npm run test:integration` | 79/79 脚本；3068 项计数检查；PASS |
| 最终完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check` | PASS，退出码 0 |

完整门禁于 2026-10-02 22:53:27—23:12:32（Asia/Shanghai）执行，耗时 1144.54 秒。开始前冻结 1778 个代码、测试和配置输入，结束后全部核对；只有 runner 自动生成的 `rules/integration-test-policy.md` §七变化，§一至§六保持原字节内容。

本轮门禁还包含 Renderer 303/303、大文件流式处理 50/50、多 Sheet 31/31、当前生产内存资格 9/9、builder/ASAR/Electron 身份 7/7，以及发布恢复兼容 18/18。完整机器可读结果和最终文件摘要见 [validation-result.json](validation-result.json)。

原始日志位于主检出目录 `outputs/release-v3.2.11/2026-10-02-scan-cleanup-repair/`，包括修复前故障、聚焦回归、完整门禁及输入摘要。

## 验证边界与保留策略

- 本机实际运行 Node Worker、新进程恢复和生产 Main 函数；EPERM/EACCES 等文件系统错误由隔离夹具注入。
- 未重新执行 Windows 原生文件锁/压力、安装包、Excel/WPS 或完整页面人工验收。本次修复不扩大此前用户确认的低内存人工验收范围。
- `running`、损坏或缺乏身份依据的历史记录/目录继续保留并诊断；不会根据目录前缀补造所有权，也不将所属进程消失等同于持久关闭事实。
- 记录写入使用文件 fsync 与同目录原子重命名；本轮证明进程退出/重启补偿，不声明断电耐久性。
- 本报告记录提交前完成的验证，候选内容基于 `8cc9b2dd`；生产 `qualified` 配置保持原值。
