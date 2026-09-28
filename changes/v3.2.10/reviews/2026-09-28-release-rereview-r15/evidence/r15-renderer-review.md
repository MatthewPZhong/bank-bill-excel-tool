# R15 Renderer 增量复核

RR14-01 原问题在本轮固定候选上关闭。本责任范围没有新增高置信必改 finding。6 个相邻静态跳转探针中，2 个合法路径通过、2 个违规路径被拒绝，另有 2 个空 for-of 合法路径受到保守拒绝；不能把它们写成“6/6 正确通过”。

工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`。本轮源码、测试、规则和历史资料未修改。当前 renderer checker SHA-256 `eb2aae187b91f9e204eeacf97234ae6a4ebb277a9a0e9ce642cef556153c0e4d`；before 为 R14 repair 起点保存的 `adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072`。before 的 5 工具逐一对 R14 repair/input-manifest 核验；current 的 5 工具逐一对 R15 freeze 核验。795 个生产扫描输入、HTML 及配置文件仍与本轮冻结一致。

## 原反例关闭

未改动 R14 原探针源，原 6 个最小例诊断数为 before `[0,0,0,0,0,1]` → current `[1,0,1,1,0,1]`：do/break、do/continue、break 跳过 test 的三个旧漏报都已拒绝；写入位于跳转前和 for-init 的安全对照保持通过；while 零次 body 的违规对照仍拒绝。

R14 原实际配置脚本复跑：全部 20 个 Renderer boundary；baseline 0；`do-break-before-write` 为 1 个 scope 诊断，`do-write-before-break-safe` 为 0。两例 VM 分别拿到带有 outsideScope / 仅有 run 的原对象。所有 scanError 均为 null。

## 有限精度观察：空 for-of 中的标签跳转

最小结构如下；完整可执行 source 位于 probes-current.jsonl 和实际配置 JSON。

```js
const old = { run() {} };
const clean = { run() {} };
const box = { api: old };
// async helper 中，info 来自登记的 app.getInfo IPC。
outer: do {
  for (const item of []) {
    if (info.hasEnum) break outer;
  }
  box.api = clean;
} while (false);
const alias = box.api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: old });
```

空字面量 iterable 不执行循环体，后续替换执行，别名写入只影响 clean；VM 在 hasEnum=false/true 下都确认传入 old 仅含 run。将 `[]` 换为 `[0]`，hasEnum=true 时 break 跳过替换，传入 old 才确实获得 outsideScope。

| 探针 | before | current | VM 语义 |
|---|---:|---:|---|
| 空 for-of + break 外层 label | 0 | 1 | 两种输入均安全，保守拒绝 |
| 非空 `[0]` + break 外层 label | 0 | 1 | true 越权，正确拒绝 |
| 空 for-of + continue 外层 label | 0 | 1 | 两种输入均安全，保守拒绝 |
| break 内层 label | 0 | 0 | 两种输入均安全 |
| label 跳转同时跳过读写 | 0 | 0 | 两种输入均安全 |
| 双 label + continue | 0 | 1 | true 越权，正确拒绝 |

真实全部 20 Renderer 配置的空 `[]` / 非空 `[0]` 代表同样分别为 before `0/0`、current `1/1`，每次 baseline 0，scanError null。所有 before/current 成对 source 完全一致。12 次异步 VM false/true 运行已断言对象身份及额外能力。

来源位于 `scripts/architecture/renderer-contracts.js:157-166`：可达性裁剪目前识别 IfStatement 和 While/For 的 literal test，ForOf 的 iterable 未参与，因而空循环中的 label jump 仍加入 bypassJumps。`182-190` 再把后续替换视为可能跳过并保留 old 来源。

分类理由：TechDoc:134 / architecture/README.md:147 说“可证明不可达的字面量分支不引入跳过来源”，也明确不推断任意循环次数或全部 JS 控制流。空 iterable 能有限证明，但文档没有明确承诺 ForOf 迭代次数的精确解析；不能仅凭 VM 安全把所有保守拒绝升级为合同违反。本轮将其作为新增精度观察保留。实际影响限于这一合法结构若进入受保护装配路径，会因旧来源保守合并而被架构门禁拒绝；未证明当前生产 Renderer 已触发。

## 复跑命令

以下命令在固定 workdir 执行；`evidence` 指向本轮目录。before bootstrap 可重建独立工具树，不依赖已存在的随机临时目录。

```sh
repo=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10
cd "$repo"
evidence="$repo/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence"
old_evidence="$repo/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence"
node "$old_evidence/r14-renderer-probes.cjs" > /tmp/r15-renderer-original-probes.jsonl
node "$old_evidence/r14-renderer-do-realconfig.cjs" > /tmp/r15-renderer-original-realconfig.json 2> /tmp/r15-renderer-original-realconfig-progress.log
renderer_before_root="$(node "$evidence/r15-renderer-before-bootstrap.cjs")"
RENDERER_SCANNER_ROOT="$renderer_before_root" node "$old_evidence/r14-renderer-probes.cjs" > /tmp/r15-renderer-original-probes-before.jsonl
node "$evidence/r15-renderer-probes.cjs" > /tmp/r15-renderer-probes-current.jsonl
RENDERER_SCANNER_ROOT="$renderer_before_root" node "$evidence/r15-renderer-probes.cjs" > /tmp/r15-renderer-probes-before.jsonl
node "$evidence/r15-renderer-branch-vm.cjs" /tmp/r15-renderer-probes-current.jsonl > /tmp/r15-renderer-branch-vm.json
node "$evidence/r15-renderer-forof-realconfig.cjs" > /tmp/r15-renderer-forof-realconfig-current.json 2> /tmp/r15-renderer-forof-realconfig-current-progress.log
RENDERER_SCANNER_ROOT="$renderer_before_root" node "$evidence/r15-renderer-forof-realconfig.cjs" > /tmp/r15-renderer-forof-realconfig-before.json 2> /tmp/r15-renderer-forof-realconfig-before-progress.log
```

`r15-renderer-verification.json` 是机器核验结论与输入 hashes；`r15-renderer-archive-manifest.json` 索引归档文件。初次实际代表生成曾误把合法 run 字段随 helper 名重命名，出现额外诊断；该中间结果以 preliminary-renamed-method 文件名保存，不参与上述最终统计。修正生成脚本后，两版真实配置均重新运行并完成。

本子任务没有重复全架构测试或 CLI，没有运行产品 Main、GUI 或平台验收。finally、跨 helper 调用帧和其他组的结论由主审另行汇总。
