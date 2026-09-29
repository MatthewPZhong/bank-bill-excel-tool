# 第六轮证据与复现

全部工具命令显式在 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` 运行。固定候选为 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加 R5 未提交修复。脚本中的绝对 worktree 路径、node_modules 与相邻历史修复目录是复现依赖，移动位置或修改源码后不能继续引用本轮结果。

## 架构门禁与原反例

```sh
r6_evidence=changes/v3.2.10/reviews/2026-09-22-release-rereview-r6/evidence
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r6-architecture-recheck.json
node --test --test-name-pattern='RR5-01' tests/unit/architecture/release-rereview-r5.test.js
node --test --test-name-pattern='RR5-02' tests/unit/architecture/release-rereview-r5.test.js
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r5/evidence/r5-renderer-replacement-realconfig.cjs
node "$r6_evidence/r6-g1-native-data-real-source-probe.cjs"
node "$r6_evidence/r6-g1-preparing-real-source-probe.cjs"
```

本轮正式测试 316/316，CLI 31 active/零诊断/零 stale；26 项 Renderer 和 20 项 G1 定向回归包含在 316 内，不额外累加。原 Renderer 替换反例拒绝、安全旧别名通过；原 G1 includes 通过、reduce 执行入口拒绝。

Renderer 原样结果为 `r6-renderer-original-realconfig.json`；G1 输出为对应同名 JSON。真实源码 G1 探针只扫描副本、只对实际 active G1 求值，不把该结果当成全部 31 边界的突变验证，也没有执行真实恢复 IO。

## Renderer 参数解构回归

```sh
node "$r6_evidence/r6-renderer-neighbors.cjs"
r6_before_root="$(node "$r6_evidence/r6-renderer-before-bootstrap.cjs")"
RENDERER_SCANNER_ROOT="$r6_before_root" node "$r6_evidence/r6-renderer-neighbors.cjs"
node "$r6_evidence/r6-renderer-parameter-realconfig.cjs"
```

八个小夹具在 before/current 分别求值，使用实际 BankStatement 规则及许可集合，fixture 状态为 pending。before 从 R5 before/ 恢复三个改动工具，未改的 rules/schema 另核对起点 hash；五项全部匹配。bootstrap 输出新建临时工具目录并写 `/tmp/r6-renderer-before-inputs.json`，不覆盖本目录中的历史结果。

新实际配置脚本保留全部 20 个 Renderer boundary，只在内存替换真实 renderer AST，追加解构参数反例及旧别名安全对照。反例前后分别为 coverage 拒绝／零诊断，而 VM 证明确有可调用 outsideScope；替换前读取的安全对照只有 run。VM 仅运行最小装配 stub。

`neighbors-current.jsonl` 中不是八例全部合格：解构参数 after 是新增漏报；闭包 helper 写入有保守 coverage，包括一个运行时安全例，报告单独保留该限制。

## G1 改写数组方法回归

```sh
node "$r6_evidence/r6-g1-neighbor-probe.cjs"
node "$r6_evidence/r6-g1-compare.cjs"
node "$r6_evidence/r6-g1-projection-real-source-probe.cjs"
```

八例对照涵盖合法原生比较、直接改写、对象/解构/prototype 参数改写及投影后纯比较。compare 脚本从 R5 起点自举工具，核对五个工具与两个机器 JSON 的七项 hash，再运行同一 probe 的 before/current，完成后清理临时工具目录。结果还保存当前工具 hash 和 probe hash，不依赖某个已存在的临时工具目录。

三个 helper 参数改写反例都从修复前一条诊断变为当前零诊断，VM 恢复 stub 各执行一次；直接改写仍拒绝。实际源码副本的对象参数代表例 765/765 解析，G1 active，callbackTargets 为空且零诊断。副本只扫描，未执行真实恢复。

## 共享解析与私有旁表

```sh
node "$r6_evidence/r6-data-shared-probes.cjs" > /tmp/r6-data-shared-probes.json
node "$r6_evidence/r6-data-destructure-probes.cjs" > /tmp/r6-data-destructure-probes.json
node "$r6_evidence/r6-data-descriptor-isolation.cjs" > /tmp/r6-data-descriptor-isolation.json
python3 "$r6_evidence/r6-data-verify.py"
```

断言脚本读取上述 `/tmp` 输出并写 `/tmp/r6-data-verification.json`；本目录保存的是本轮运行后的副本。28 例 × 两版本，共 56 次主要规则求值，全部符合预期。每例另检查重复 scan、evaluateRules 前后 scan JSON、before/current JSON 及 site.evidenceId 一致性；四个共享值读取的 descriptor 不串用、不跨 analysis，描述顺序不影响结果。

SQL 运行证据使用内存 SQLite；7 个实际查询例被拒绝，5 个未执行 SQL 的对照通过。fixture 保留实际规则与许可集合，状态为 pending，不充当全仓配置验收。

## 主审断言与冻结保护

```sh
python3 "$r6_evidence/verify-probes.py"
```

该脚本只读取本目录的归档 JSON/JSONL，核对旧反例关闭、两项新增回归、安全对照及版本 hash，输出 `probe-verification.json`。PASS 表示证据核对一致，不表示违规反例已经被正确拒绝。

`input-manifest.json` 完整冻结 4,306 个已有文件（Git NUL 分隔枚举，包含中文路径）。`prior-review-comparison.json` 记录九个既有变化文件及新增回归；`policy-production-comparison.json` 证明 792 个 src 和四个机器合同/历史工具文件保持。`gate-evidence-comparison.json` 核对最近完整门禁 1,702 个输入及 HEAD，无漂移。

本轮没有重跑完整 release-check；9090 单测 PASS、4 Windows 条件 skip、68/68 集成脚本及 233/233 Renderer lifecycle 来自输入匹配的 R5 修复门禁。`../preservation-final.json` 核对最终保留，`../artifact-sha256.json` 校验所有本轮产物（不包含自身）。

各 probe 的 exit 0 只表示取证完成，不能将非法例的零诊断记为通过。生产业务、平台人工验收、Git 集成与发布不由本轮静态/VM 证据代替。
