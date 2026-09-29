# 第三轮审查证据

本目录对应 release/v3.2.10 的 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加 `input-manifest.json` 中冻结的未提交修复。全部仓库命令工作目录：

```sh
cd /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10
```

执行需要当前项目依赖及支持 node:sqlite 的 Node。本轮脚本先在 /tmp 执行，再原样复制归档。除完整查询配置探针复制生产源码到临时目录外，Renderer 实际配置探针采用内存 AST overlay；均不改仓库源码。

## 重现五项发现

```sh
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-query-realconfig.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-renderer-realconfig.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-data-realconfig.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-data-probes.cjs
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-g1-callback-probe.cjs
```

- RR3-01：`r3-query-realconfig.json` 使用全部 31 个当前边界和真实 allowlist。baseline 0；opaque-parameter-spread 实际 SQL 1 次、0 诊断；known-static-spread 实际 SQL 1 次、1 条查询诊断；safe 无 SQL、无诊断。SQLite 为临时内存库，执行源码置于隔离 VM；未执行业务模块入口。`r3-query-probes.json` 的 10 个最小变体同时给出旧修复前与当前结果，旧扫描四文件通过保存的 input-diff.patch 恢复且 SHA-256 匹配。未把其中所有探索结果都列为 finding。
- RR3-02：`r3-renderer-realconfig.json` 使用实际 20 个 Renderer boundary。当前 nested_alias / nested_spread / nested_helper_escape 均漏报，VM 确认额外方法实际存在；safe_nested 是正向对照。HEAD 输出只作为历史对照，未将其原有基线诊断混入追加注入点。独立 AST 身份摘要见 `r3-renderer-object-identity.json`。
- RR3-03/04：`r3-data-realconfig.json` 使用实际 20 个 Renderer boundary 和真实 allowlist，baseline 0，旧普通 nested API 反例已拒绝；prototype_computed、category_callable、category_other_ipc 漏报。纯数据与正确 IPC 对照见 `r3-data-probes.jsonl`。computed 属性的 VM 身份摘要见 `r3-data-proto-vm.json`。
- RR3-05：`r3-g1-callback-probe.json` 原样使用当前 active G1 boundary，但用临时存在性 fixture 缩小扫描输入。12 个真实执行 stub 的变体中 8 个正确拒绝、4 个漏报。stub 只计数，不执行恢复 IO。实际生产 allowedSites 的精确匹配见 `r3-g1-actual-config-baseline.json`。

探针 exit 0 说明程序完成，不能写成“违规负例通过”。报告依据是特定反例的真实执行／实参与缺失诊断之间的不一致。

## 原问题、测试和历史门禁

原样复验日志与 JSON 以 `original` 或 `recheck` 命名；定向单测与架构 204 项套件重叠，不相加。结构化命令和结果见上级 [verification.json](../verification.json)。

完整 release-check 本轮没有重跑。最新修复候选的门禁执行于 2026-09-21 23:59:32—2026-09-22 00:19:13，当前 1,699 个输入及 HEAD 全部匹配，见 `gate-evidence-comparison.json`。旧轮 1,698 输入／8,944 单测数据不用于本轮门禁结论。

## 取证边界

首次完整查询配置探针的临时副本缺少 package.json，出现两条与反例无关的缺失依赖诊断；补齐副本并改用独立 VM 执行每个变体后重新运行，最终归档为基线零诊断且运行时正反对照有效的结果。该调整仅涉及 /tmp 的取证脚本，不是产品修复。

input-manifest 使用 NUL 分隔路径枚举，覆盖中文路径；旧轮 prior-review-comparison 中“未在旧 manifest”包含旧枚举遗漏的 67 个非 ASCII tracked 路径，不应算成新增源码。最终保护状态在上级 preservation-final.json。

本目录证明静态守卫、JS 传值或临时 SQLite 行为；不证明真实产品 Main、Windows、Excel/WPS、资金人工验收或正式发布已完成。

