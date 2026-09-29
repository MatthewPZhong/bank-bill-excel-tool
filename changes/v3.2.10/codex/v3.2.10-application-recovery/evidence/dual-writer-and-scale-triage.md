# 定向失败核查

工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-application-recovery`。

## VCC E12-C CompoundLease

初始定向执行：

```sh
node --test --test-name-pattern='E12-C runtime CompoundLease admits two' tests/unit/main-process/vcc-financial-op-dual-writer-e12-c.test.js
```

失败为 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED`：该 Writer 合成夹具注入了 publish stub，但遗漏 G1 新增的必需 `recoverPublications` 依赖。证据在 `vcc-dual-writer-targeted-initial.log`。

最小迁移：给本文件三处 `generateValidateAndPublishVccExport` 调用注入 `rejectUnexpectedPublicationRecovery`。该函数仅 `assert.fail`，明确该夹具没有 publication journal 或 owner proof，任何意外 recovery 都失败。未伪造 production proof，未改 Publisher exactly once、双 child 准入、金额/币种/行序或 crash/cancel 断言。

验证：

```sh
node --test tests/unit/main-process/vcc-financial-op-dual-writer-e12-c.test.js
```

**8/8 PASS，0 skipped**；证据 `vcc-dual-writer-targeted-final.log`。该文件 ESLint 和 `git diff --check` 通过。

## BizOP 1024 来源复杂度

初次完整门禁 `release-check-initial.log` 第 10261—10274 行记录：在 407 个来源完成后，`reason=ERR_SQLITE_ERROR`，`stopReason=null`、`elapsedMs=0`；不是准入期限或评估次数预算触发。原恢复 driver 只返回 error.code，未保留该次 SQLite 原始 message/extended code，因此现有历史证据不能确定具体 SQLite 失败原因。

保持测试及生产预算原样，独立执行：

```sh
node --test --test-name-pattern='1024 个真实 Task 来源使用两次全量扫描及 3N 次 Inspector' tests/unit/main-process/biz-op-v327.test.js
```

**1/1 PASS，0 skipped**，总耗时约 139.9 秒；恢复阶段 wallElapsedMs=95105。`fullScans=2`、`inspector=3072`、`observationAttempts=3072`、`main=1024`、`completedSources=1024`、`reason=null`，全部保留断言通过。证据 `bizop-scale-1024-targeted.log`。

未修改此规模用例、生产预算或阈值，也未重复全套。核查期间宿主与临时目录同分区，`df -h /private/tmp` 显示可用容量约 1.1 GiB；这只是环境上下文，不能据此断言初次 SQLite 错误一定由磁盘或并发负载导致。初次完整门禁失败继续保留为失败；定向 PASS 不替代完整门禁 PASS。
