# 第四轮复现与证据说明

本目录记录固定 dirty 候选的只读审查。执行命令的工作目录均为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；不得在其他 checkout 中套用计数或哈希。以下使用变量 `r4_evidence` 便于重跑，正式结果以已归档文件为准。

```sh
r4_evidence=changes/v3.2.10/reviews/2026-09-22-release-rereview-r4/evidence
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r4-architecture-recheck.json
node --no-warnings changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-query-realconfig.cjs
```

237 项架构测试全部通过，正式 CLI 31 active、零诊断。定向子集为 RR3-02 的 7 项、RR3-03/04 的 13 项及 RR3-05 的 7 项，数量与 237 重叠，不相加。

```sh
node --test --test-name-pattern=RR3-02 tests/unit/architecture/release-rereview-r3.test.js
node --test --test-name-pattern='RR3-03|RR3-04' tests/unit/architecture/release-rereview-r3.test.js
node --test --test-name-pattern=RR3-05 tests/unit/architecture/release-rereview-r3.test.js
```

## Renderer 对象身份

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-renderer-realconfig.cjs
node "$r4_evidence/r4-renderer-independent.cjs"
node "$r4_evidence/r4-renderer-realconfig.cjs"
node "$r4_evidence/r4-renderer-separate-instances.cjs"
node "$r4_evidence/compare-distinct-instances.cjs"
```

原样真实配置结果为 `r4-renderer-original-realconfig.json`；三个新增 bound/member 组合的真实配置及 VM 结果为 `r4-renderer-realconfig.json`。它们保留当前 20 个 Renderer boundary，在内存替换/追加被扫描源码，无生产文件写入。

`compare-distinct-instances.cjs` 已执行，直接从上一修复的 before/ 恢复四个 checker 文件，补入未变化的 schema，逐一核对修复输入 SHA-256，再运行同一实例区分探针。输出 `distinct-instances-comparison.json` 证明 before 0 / current 1，而实际注入对象不含 outsideScope。临时工具目录在 finally 中删除。

`r4-renderer-independent-before.jsonl` 和 `r4-renderer-separate-instances-before.jsonl` 是本轮使用 `/tmp/r4-renderer-before-tools` 所生成的 before 对照。以下 bootstrap 仅为交付后的可复现入口，本轮创建归档但没有额外运行；主要新增误报结论由上面的已执行且有哈希检查的 compare 脚本独立复验：

```sh
r4_before_root="$(node "$r4_evidence/r4-renderer-before-bootstrap.cjs" /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10)"
RENDERER_SCANNER_ROOT="$r4_before_root" node "$r4_evidence/r4-renderer-independent.cjs"
RENDERER_SCANNER_ROOT="$r4_before_root" node "$r4_evidence/r4-renderer-separate-instances.cjs"
```

## 数据合同及反证候选

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-data-probes.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r3/evidence/r3-data-realconfig.cjs
node "$r4_evidence/r4-data-adjacent.cjs"
node "$r4_evidence/r4-data-array.cjs"
node "$r4_evidence/r4-data-array-realconfig.cjs"
```

原样输出为 `r4-data-original-probes.jsonl` 和 `r4-data-original-realconfig.json`，汇总为 `r4-data-summary.json`。相邻纯数据、特殊自有属性、正确/错误 IPC、未知数组 spread 探针的结果分别归档为同名 JSONL/JSON。opaque 数组候选经独立 VM 及实际配置验证已被拒绝，不是本轮发现。JSONL 包含有意构造的失败与安全对照，不能简单把行数当成测试总数。

## G1 受限恢复入口

```sh
node "$r4_evidence/r4-g1-actual-config-baseline.cjs"
node "$r4_evidence/r4-g1-callback-probe.cjs"
node "$r4_evidence/r4-g1-neighbor-probe.cjs"
node "$r4_evidence/r4-g1-real-source-probe.cjs"
node "$r4_evidence/r4-g1-preparing-neighbor-probe.cjs"
node "$r4_evidence/r4-g1-preparing-real-source-probe.cjs"
```

原 12 类静态入口都被拒绝；基线中 12 个 allowedSites 各匹配一个精确位置。neighbor probe 提供三个原生回调漏报、一个正确拒绝的源码 helper、三个不执行受限入口的安全对照；VM 只使用内存 remove stub。

真实源探针复制 src、index.html、package.json、生成器及 activationEvidence 到临时目录，向 prepare 增加一行 reduce，然后只做静态扫描。完整源码 765/765 可解析，规则求值只选实际 active G1 boundary。`recoveryScopeReached` 已到达受限函数而 callback 的 targets 仍为空；不能将这一结果写成“全部 31 个边界 mutant 通过”。正式 31 边界 CLI 另有独立原候选结果。

Preparing 变体采用 `reduce(recoverPreparingIntent, runtime)`，前两个参数与真实函数签名对齐。OneJournal 变体也显示身份漏记，但 reduce 第三个 index 与真实 options 参数不同，不用它宣称真实恢复 IO 可完成。两者都不执行真实恢复代码。

最初真实源探针的临时 fixture 未复制 package/generator，出现 4 条配置覆盖诊断；补齐 fixture 后才得到已归档结果。该搭建中间失败不作为产品问题，也不计入验证通过总数。

## 快照、历史门禁与保留检查

- `input-manifest.json` 通过 NUL 分隔 Git 文件清单完整冻结 4,142 个既有文件（含中文路径），`input-diff.patch` 保存 tracked 二进制差异。
- `prior-review-comparison.json` 记录对上轮审查的十个变化文件及新增回归文件。
- `gate-evidence-comparison.json` 核对最新修复完整门禁的 1,700 个输入及 HEAD，没有漂移。完整门禁本轮未重跑；9011 pass、4 Windows 条件 skip、68/68 集成脚本及 233/233 lifecycle 均来自那次匹配记录。
- `../preservation-final.json` 记录交付前既有文件、HEAD、tracked 差异和目录外新增项检查；`../artifact-sha256.json` 为本轮交付文件校验值，不包含自身。

探针 exit 0 表示取证完成。违规示例的零诊断是漏报证据，不是合格结果。复现脚本可能依赖当前指定 worktree 路径及相邻历史审查目录，迁移位置后须调整绝对路径并重新核对输入，不能继续引用原计数。
