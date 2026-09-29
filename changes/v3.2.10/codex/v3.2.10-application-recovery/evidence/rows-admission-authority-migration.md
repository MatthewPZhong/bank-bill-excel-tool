# rows admission 集成脚本授权装配补漏

范围：仅 `scripts/integration/toolbox-row-split-admission.js`，未修改生产、ROWS_POLICY、Governor 或预算。

工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-application-recovery`。

本轮 RED 与 GREEN 均执行：

```sh
node scripts/integration/toolbox-row-split-admission.js
```

- RED：exit 1；768 MiB 拒绝 1 GiB 场景 PASS，约 30.8 ms；2 GiB 正向场景先在 Main finally 清理计数断言失败，`cleanup.length` 实际 0，预期 1。完整原始输出见 [rows-admission-authority-red.log](rows-admission-authority-red.log)。源码核对显示该正向场景仍调用未绑定 authority 的默认 `publishToolboxPublicationAsync`；其失败携带 `preserveTemporaryFiles=true`，使原 Main cleanup 断言先于后续 success 断言暴露。原 RED 日志未直接打印 authority 错误，不把此根因分析写成日志中的直接观察。
- 迁移：每个隔离临时 userDataDir 显式 `createTestPublicationHarness`，用该 dispatcher 执行真实发布，保留 `requireArchiveHandoff:true`、`requireValidatedArtifacts:true`；Main 动态执行 scope 注入 `recoverArchivePublications: publication.recovery.recover`。批次和耐久回执原本为合成 fixture，因此采用测试专用 owner，不假装已有生产 Archive durable proof。
- GREEN：exit 0，2/2 PASS；768 MiB 拒绝 1 GiB 仍在约 28.5 ms 内完成，零 Worker/Publisher、源文件与旧目标保留；2 GiB 正向仍执行真实 rows Worker + Publisher，三份输出按 2/2/1 行独立回读，原 settlement/cleanup/预算归还断言全部通过。完整输出见 [rows-admission-authority-green.log](rows-admission-authority-green.log)。
- `git diff --check -- scripts/integration/toolbox-row-split-admission.js`：PASS。没有重复全套 release-check。

## 入口库存说明

早先 raw core 调用库存覆盖 `prepareToolboxPublication/recoverPendingToolboxPublications` 等底层符号，未将所有隔离脚本中默认 async publish wrapper 的装配列为 inventory 条目，故漏掉本脚本。此条补充记录将其明确列为“隔离脚本的测试 authority 装配”：`runCase()` 创建 harness；Main scope 的 `publishToolboxPublicationAsync` 委托 harness dispatcher；`recoverArchivePublications` 委托同一 root 的 owner facade。此脚本不是生产恢复旁路，也不使用未授权 default dispatcher。
