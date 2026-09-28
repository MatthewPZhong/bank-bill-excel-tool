# R13 共享与闭包绑定重放

结论：62 个既有夹具全部 fresh 执行，断言 PASS；本范围无新增 finding。

执行目录固定为：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。七个 Node 命令均实际退出 0，Python 断言实际 PASS。/tmp 原始执行文件与本目录归档脚本、JSON 字节相同。归档断言从自身目录读取证据，不依赖 /tmp。

## 可重放命令

在上述 release worktree 中执行：

```sh
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-shared-probes.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-shared-probes.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-destructure-probes.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-destructure-probes.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-localenv-probes.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-localenv-probes.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-default-combinations.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-default-combinations.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-async-array-combinations.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-async-array-combinations.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-logical-combinations.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-logical-combinations.json
node /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-bindings-probes.cjs > /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-bindings-probes.json
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/r13-shared-verify.py
```

## 输入与结果

- before 精确使用 `2026-09-23-release-r12-repair/before/scripts/architecture/renderer-contracts.js`，SHA-256 `6b57b228b5fb576bbd3ea40d42ff010c5414c1a6a96fb7efdc6aba92fd2c2bec`。四个共享工具使用当前文件，均与 R12 repair/input-manifest.json 哈希一致。
- current 五工具逐一核对 R13 evidence/input-manifest.json；renderer-contracts.js SHA-256 `f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082`。
- 56 共享夹具源代码和 expectedClean 与 R12 归档一致，before/current 诊断数组完全相同；38 Renderer、18 query，10 个实际执行内存 SQLite 查询，SQL 和返回值与原归档相同。
- 6 个闭包绑定原样夹具中，三个安全例 before/current 均 0，三个越权例均 1 条 scope。VM 身份和额外方法实际执行结果与静态判定一致。
- 62 个夹具全部满足重复扫描、规则前后扫描序列化、before/current scanner digest 与 siteEvidenceIds 保持。
- boundaries、legacy-allowlist、schema、policy-history 四份政策文件与 R12 起点及 R13 冻结字节一致。
- `single-mount-category-explicit-ipc` 保留真实 async invoke：先 app:get-info，再 other，分类为 Promise；当前 expectedClean=false，历史同步 stub 的错误期望只作记录。
- `conditional-distinct-pure-values` 两端为纯字符串，前后均拒绝一次；单列为既有保守拒绝，不算合法通过或新增 finding。

机器汇总见 `r13-shared-verification.json`，源代码和完整诊断见七组 JSON。未增加相邻探针、未运行全仓扫描或全套架构测试；未修改源码、测试、配置和历史记录。
