# 完整门禁旧 fixture 授权装配迁移

工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-application-recovery`。

完整门禁给出的两个 ReconFix 用例都位于 `tests/unit/main-process/recon-id-fix-export-e11-c.test.js`，因此本轮实际修改三个测试文件；共享 crash worker fixture 已支持 discovery/execute 签名授权，无需再改。没有修改生产代码或放宽 owner/proof 检查。

## RED

命令（在上述工作目录执行）：

```sh
node --test --test-name-pattern='确认快照传至真实 Publisher|rows 父目录身份贯穿|真实 journal Publisher 一次提交 main\+unmatched|双artifact Publisher kill后沿用journal recovery' tests/unit/main-process/toolbox-row-split-overwrite.test.js tests/unit/main-process/toolbox-row-split-parent-identity.test.js tests/unit/main-process/recon-id-fix-export-e11-c.test.js
```

结果：8 tests / 0 pass / 8 fail，exit 1。完整输出：[fixture-authority-red.log](fixture-authority-red.log)。

共同原因：fixture 使用默认未绑定 dispatcher 或直接创建未绑定 dispatcher，真实 publication 前被 `PUBLICATION_RECOVERY_AUTHORITY_REQUIRED` 拒绝；这使原目标漂移、父目录漂移和 crash recovery 断言尚未走到原被测阶段。

## 最小迁移

- `toolbox-row-split-overwrite.test.js`：每个真实 Publisher case 用自身临时 userDataDir 创建 `createTestPublicationHarness`；保留 `requireArchiveHandoff:true`、`requireValidatedArtifacts:true` 与原覆盖确认快照，目标被创建/替换时继续断言原拒绝和文件保留。
- `toolbox-row-split-parent-identity.test.js`：临时 root 独立装配 harness，真实 Main wrapper 仍调用真实 Worker Publisher；保留父目录重命名、原目录与新目录文件保留、目标未生成、settleCalls 和成功 XLSX 内容断言。
- `recon-id-fix-export-e11-c.test.js`：成功与 crash 两条真实发布链注入 root 固定的测试 authority dispatcher，保留 main+unmatched 双 artifact、原 exact-7 receipt、未提交回滚/已提交恢复和只调用一次的业务断言；自动恢复诊断断言同步为当前“已执行授权恢复”文案。

此处测试合成 Archive identity 没有真实持久 Archive owner 数据，故明确使用 tests/helpers 专用 authority；不是生产 owner proof 的替代验收。

## GREEN

```sh
node --test tests/unit/main-process/toolbox-row-split-overwrite.test.js tests/unit/main-process/toolbox-row-split-parent-identity.test.js tests/unit/main-process/recon-id-fix-export-e11-c.test.js
```

结果：26 tests / 26 pass / 0 fail，exit 0，约 7.6 秒。完整输出：[fixture-authority-green.log](fixture-authority-green.log)。

```sh
git diff --check -- tests/unit/main-process/toolbox-row-split-overwrite.test.js tests/unit/main-process/toolbox-row-split-parent-identity.test.js tests/unit/main-process/recon-id-fix-export-e11-c.test.js
```

结果：PASS，exit 0。此轮没有重复全套 release-check；全套门禁由主 Agent 汇总。
