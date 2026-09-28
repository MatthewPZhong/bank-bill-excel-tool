# 第五轮审查复现与证据范围

所有执行工具均显式使用工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。候选为 HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加冻结的已有未提交修复。以下命令使用变量简化路径，不覆盖已归档结果：

```sh
r5_evidence=changes/v3.2.10/reviews/2026-09-22-release-rereview-r5/evidence
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /tmp/r5-architecture-recheck.json
```

本轮两项均 exit 0：270/270 测试通过，31 active、0 诊断、0 stale。首次 CLI 误用了相对 JSON 路径，工具按合同报输入错误 2；随后改用绝对路径运行通过，详情 `command-input-error.json`。该输入错误不作为产品失败。

## 原反例复验与专项

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r4/evidence/r4-renderer-realconfig.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r4/evidence/r4-renderer-separate-instances.cjs
node --test --test-name-pattern='RR4-01/02|RR4-02' tests/unit/architecture/release-rereview-r4.test.js
node "$r5_evidence/r5-g1-preparing-neighbor-probe.cjs"
node "$r5_evidence/r5-g1-preparing-real-source-probe.cjs"
node "$r5_evidence/r5-g1-actual-config-baseline.cjs"
node --test --test-name-pattern=RR4-03 tests/unit/architecture/release-rereview-r4.test.js
```

结果为 `r5-renderer-original-realconfig.json`、`r5-renderer-original-separate-instances.jsonl` 和 G1 同名 JSON。23 项 Renderer、10 项 G1 正式测试包含在全部 270 项内，不相加。G1 脚本沿用上一轮逻辑，仅改 tempfile 前缀；实际源码副本只作扫描，VM 只运行内存恢复 stub。

原 Renderer 脚本在内存替换被扫描的 renderer analysis，使用完整实际 20 个 Renderer boundary，不改生产文件。G1 实际源码脚本扫描完整生产文件，但规则求值只选 active G1，不能写成全部 31 边界 mutant 验证。

## Renderer 静态成员替换与身份对照

```sh
node "$r5_evidence/r5-renderer-neighbors.cjs"
node "$r5_evidence/r5-renderer-replacement-realconfig.cjs"
r5_before_root="$(node "$r5_evidence/r5-renderer-before-bootstrap.cjs" /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10)"
RENDERER_SCANNER_ROOT="$r5_before_root" node "$r5_evidence/r5-renderer-neighbors.cjs"
```

八个有界邻近例在 before/current 各求值一次，包含 VM 实际对象键、同一引用比较与方法调用证据。前后工具来自 R4 before/ 四个文件及未变化的 schema，五项 hash 均与 R4 输入清单匹配，见 `r5-renderer-before-inputs.json`。

`nested-member-replacement` 在静态成员赋值后再经别名添加 outsideScope，是本轮确认的存活缺口；`nested-member-detached` 在替换前捕获旧别名，用于证明不能混淆被分离的对象。实际配置脚本仅追加这两个案例，保留当前全部 Renderer 配置，并记录基线及注入诊断。

八例不是全部 PASS：shallow spread 后选择嵌套成员的合法例在 before/current 均被 coverage 拒绝，是已记录保守解析限制；闭包共享成员的危险例在当前已正确拒绝。JSONL 为原始观察，不应把 exit 0 或行数写成合格总数。

bootstrap 本轮已运行，其后续重跑会在 `/tmp` 创建新的工具目录并写 `/tmp/r5-renderer-before-inputs.json`；审查目录中的已归档证明不受影响。脚本依赖本地 node_modules 和历史修复副本，不使用浮动旧分支。

## G1 原生函数值比较的新误报

```sh
node "$r5_evidence/r5-g1-native-data-probe.cjs"
node "$r5_evidence/r5-g1-native-data-real-source-probe.cjs"
node "$r5_evidence/compare-native-function-values.cjs"
```

`native-function-values-comparison.json` 是主审实际执行自举比较脚本的结果：四个历史检查器、未变化 schema、两个机器 JSON 共七项 hash 匹配；同一探针在前后分别运行。includes/indexOf 在 VM 中不调用恢复函数，before 0/current 1；源码 helper 比较前后 0；reduce 实际调用恢复 stub，before 0/current 1，后者是原问题的正确修复。

完整生产源码副本只向真实 prepare 添加固定数组及 includes，无真实恢复执行。765/765 可解析，active G1 报一个误报；calledTargets 为空，callbackTargets 错误包含 recoverPreparingIntent。两个 unresolved 是基线已有 generated module，没有新增未解析结构。

Agent 原始 before 取证结果另存 `r5-g1-native-data-before.json` 及 `r5-g1-before-inputs.json`；自举比较入口消除了复现对原 `/tmp` 工具目录的依赖，运行后清理其临时目录。

## 共享数据／查询解析

```sh
node "$r5_evidence/r5-data-shared-probes.cjs"
```

12 个 Renderer 与 8 个 BizOP Q3 小夹具，前后共 40 次规则评估。脚本自举历史工具且逐文件核对 hash；查询 VM 只使用 `DatabaseSync(':memory:')`。复制实际规则及许可集合，但 fixture 状态设为 pending；不将它们当成全仓正式配置扫描。`r5-data-verification.json` 记录本轮逐例断言符合预期、前后结果一致及配置保持。

## 冻结、完整门禁与交付核对

- `input-manifest.json` 冻结 4,229 个已有文件及 HEAD/status；文件枚举使用 Git NUL 分隔，完整保留中文路径。
- `prior-review-comparison.json` 记录对第四轮审查的增量；`policy-production-comparison.json` 确认生产源码及机器合同未放宽。
- `gate-evidence-comparison.json` 核对 R4 修复完整门禁的 1,701 个输入及 HEAD，无漂移。本轮不重跑 release-check；9044 单测通过、4 Windows 条件跳过、68 个集成脚本通过及 233/233 lifecycle 均为那次匹配证据。
- `../preservation-final.json` 记录交付前冻结文件、HEAD、tracked diff 与审查目录外新增项检查；`../artifact-sha256.json` 校验本轮产物，不包含自身。

所有探针 exit 0 只表示取证完成；预期违规的零诊断是漏报，安全输入的违规诊断是误报。完整候选门禁、静态反例与真实产品／平台验收分别记录，不互相代替。
