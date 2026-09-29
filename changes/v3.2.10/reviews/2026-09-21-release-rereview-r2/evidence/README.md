# 第二轮审查证据与复现

所有命令的工作目录为：

```sh
cd /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10
```

证据对应 HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加 `input-manifest.json` 中的未提交快照。输入变化后，新的输出不能直接替换本轮证据。执行需要当前项目依赖与支持 `node:sqlite` 的 Node；审查时为 Node v25.8.0。

## 漏报复现

```sh
node --no-warnings changes/v3.2.10/reviews/2026-09-21-release-rereview-r2/evidence/query-execution-probe.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-21-release-rereview-r2/evidence/renderer-realconfig.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-21-release-rereview-r2/evidence/g1-internal-probe.cjs
```

三条命令的本轮重跑均 exit 0，结果见对应 `*-reproduced.json`，已与原始 JSON 完整比对相等。exit 0 表示探针完成；反例中当前扫描结果为空正是本次发现的缺陷。

- `query-execution-probe.cjs`：构造临时源码，以同一最小规则对比 HEAD 与当前 scanner；通过真实内存 SQLite 验证实际 SQL。固定数组和数组解构为报告依据，direct/default-callback 为拒绝对照，safe 为不误报对照。
- `renderer-realconfig.cjs`：保留实际 20 个 Renderer boundary，对现有 renderer 的内存 AST 追加反例，不改生产源码。VM 使用工厂替身捕获实际参数，不执行产品 Main。历史 scanner 在临时目录从 HEAD 提取并在结束时清理。`renderer-realconfig.original.cjs` 为原始探针，依赖先前临时 scanner；归档复现版只补充历史 scanner 创建和清理。
- `renderer-probes.cjs` / `renderer-probes.jsonl` / `renderer-head-probes.jsonl`：更宽的探索与历史对照，包括已排除的既有缺口；不能把每一行都算作新增 finding。真实配置复验为最终收敛证据。
- `g1-internal-probe.cjs`：完整原样 G1 boundary，保留 active / restrictedApis / protectedScopes / allowedSites；临时构造存在性 fixture。只验证静态守卫，不执行真实恢复或真实文件清理。

## 既有问题关闭与测试

- `g3-independent.cjs/json`：五条确认按钮路径分别验证关闭拒绝、非栈顶、只提交一次、重复旧回调、保护新弹窗、导航失效。
- 其他测试命令、结果、日志及是否重跑见上级 `verification.json`。
- `gate-evidence-comparison.json`：当前 1,698 个门禁输入与既有完整 release-check 输入的逐文件 SHA-256 比对。完整门禁日志未复制、未重新执行，仍保留于相邻 `2026-09-21-release-repair/`。
- `input-manifest.json` / `input-diff.patch`：开始时冻结的 3,958 个已有文件和 tracked 差异。初始 Git 带引号的路径枚举漏掉 67 个非 ASCII tracked 文件；最终用 NUL 分隔重新枚举，它们逐个与未变化的 HEAD blob 相同，初始／最终 status 和 tracked diff 也相同。详见上级 `preservation-final.json`。

真实产品 Main、Windows、安装包、Excel/WPS 和资金人工验收不在这些证据的证明范围内。

