# release/v3.2.10 第十一轮独立增量审查

确认 **2 项 P2**：RR11-01 是第十轮修复新增的成员来源漏报；RR11-02 是本轮新发现的既有数组重排漏报。第十轮 RR10-01/02 的原始反例已通过独立复核，但不能据此宣布全部邻近组合关闭。两项问题影响 G8 静态门禁；没有证据表明当前产品生产流程已经触发这些反例。

## 1. 候选与范围

| 项目 | 冻结事实 |
|---|---|
| 分支 / worktree | `release/v3.2.10` / `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| HEAD | `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`，加已有未提交修复 |
| 基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 时点 | 2026-09-23 10:14:31 Asia/Shanghai |
| 冻结输入 | 4,805 个 Git 可见文件、Git status、tracked binary diff |
| 当前检查器 SHA256 | `dd34f594f57d0d5d6f33944bed80802d50b4712077e9f4dba1f205d93b19dbb7` |
| 反例 before | R10 repair 准确起点的检查器 `a375dd2d18307907a158ae04f86197f0630657e64d81de2e60fd0f4e4ecfe3fb`，另 4 个工具逐文件核对起点 hash 后复用 |

相比第十轮审查快照，既有文件变化 7 个：`renderer-contracts.js` 及 6 个说明文件；审查目录外新增 `tests/unit/architecture/release-rereview-r10.test.js`（84 项回归）。792 个 `src/` 文件不变，机器边界、例外、schema、policy-history、共享 scan/contracts/rules 不变。

本轮聚焦新逻辑分支证明、数组 origin/不确定来源、候选合并和声明函数参数绑定，并复查受影响的共享解析合同。没有重新遍历 G1–G8 全部生产流程。使用 blindspot-pass 的证据纪律；所有 probe 和正式命令均使用该独立 worktree，新增内容仅为本报告目录及临时 fixture。

证据：[冻结清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/input-manifest.json)、[前轮差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/prior-review-comparison.json)、[检查器增量](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/renderer-incremental.diff)、[生产与共享工具比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/policy-production-comparison.json)。

## 2. 确认问题

### [P2] RR11-01：IPC 父对象的真值/非空证明被错误继承给子成员

**事实：** [IPC 成员投影](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:220) 使用 `{ ...value, fields: [...] }` 生成子成员值，保留了父对象私有的 `truthiness/nonNullish` 标记。第十轮新增 [默认参数快速排除](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:246) 根据这些标记跳过默认来源。父对象非空不证明其 `api` 字段存在。

```js
const shared = { run() {} };
const provided = { run() {} };
const fallback = { api: provided };
function select(api = shared) { return api; }
async function run() {
  const info = await window.desktopApi.app.getInfo();
  const alias = select((info || fallback).api);
  alias.outsideScope = window.desktopApi.outsideScope;
  window.BankStatementController.createBankStatementController({ api: shared });
}
run();
```

当异步 IPC 返回普通对象、但未提供 `api` 字段时，OR 返回 `info`，`.api` 为 undefined，运行时必须选择 `shared` 默认对象。VM 证明 `alias === shared`，注入 API 的键为 `run/outsideScope`，额外方法调用返回 `true`。将 `||` 换为 `??` 同样成立。

**静态结果与分类：** 两种形式在 R10 repair 起点各有 **1 条诊断**，当前均 **0 条**，是新增漏报。实际生产 Renderer AST 和全部 **20 个 active Renderer 边界**下，基线 0 诊断，追加 OR 反例后仍为 0。安全对照 `select(info.api || provided)` 当前 0 诊断且 VM 注入对象只有 `run`。同一 IPC 候选合并的 `info.api || info.api`、`??` 形式仍诊断，未另行认定候选交集问题。

**影响：** 缺失成员触发默认对象并改写该对象的代码能通过 G8 scoped API 检查，违背 [G8-AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101) 和 [分支证明合同](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:126)。实际产品是否存在同样装配路径未在本轮证明；此处结论限定为检查器漏报。

**处置建议：** IPC 成员投影应保留数据来源标签，但不能将父值的真值/非空证明提升为子成员存在性证明。应由子成员自身的逻辑表达式建立证明。补齐父对象回退后取成员与成员自身回退的正反例，并验证默认值来源。

**最便宜验证（已执行）：** [6 例最小脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes.cjs)、[before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes-before.jsonl)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-probes-current.jsonl)；实际配置代表为 [脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-member-realconfig.cjs)、[运行与静态结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-member-realconfig.json)。[before 工具 hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-before-inputs.json) 与 [current hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-current-inputs.json) 锁定版本。

### [P2] RR11-02：数组重排的保守来源集合遗漏其他固定槽位写入

**事实：** [snapshotMember mutator 分支](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:181) 只汇总当前选中值、初始 elements 和 mutator 实参。固定槽位读取在 155 行先排除其他数字槽位的写入；后续遇到 `reverse()` 时没有将那些已知来源补回来。

```js
function provide() { return { api: { run() {} } }; }
const old = provide();
const clean = provide();
function make(value) {
  const args = [];
  args.push(value);
  return args;
}
const list = [...make(old)];
list[1] = clean;
list.reverse();
const alias = list[0].api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: clean.api });
```

读取第 0 项时 `list[1] = clean` 已被排除；`reverse()` 无实参，来源集合不再包含 `clean`。VM 证明重排后的 `alias === clean.api`，注入 API 的额外方法可调用并返回 `true`，当前既未报告 scope，也未报告 coverage。

**静态结果与分类：** 准确 R10 repair 起点和当前都是 **0 条诊断**，属于新发现的既有残留，非第十轮新增回归。实际 20 个 Renderer 边界的 before/current 基线均 0，反例均 0。去掉 reverse、直接读取已写入的第 1 项，当前正确诊断；独立数组安全对照保持 0，VM 确认注入对象未改变。第二条件分支来源、未知前缀的可见对象、复制时点等其余有限组合符合预期。

**影响与边界：** 未授权 API 字段可经已知数组槽位写入及重排传播到注入对象，却不被 G8 识别。[TechDoc 来源保留](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:126) 与 [数组支持边界](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:139) 要求不确定数组仍保留可见对象并检查别名写入。这里不要求精确执行 `reverse()` 或推导结果索引；问题是已知来源被静默丢弃。

**处置建议：** mutator 的保守来源收集应纳入读取前可能参与重排的其他固定槽位写入，保持调用环境和先后时点；无法判定时保留 coverage 缺口。不要仅用初始 elements 或 mutator 实参代表完整可能来源。

**最便宜验证（已执行）：** [8 例 before/current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-neighbor-before-current.json)、[实际配置 3 代表 before/current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-neighbor-real-before-current.json)、[实际配置脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-neighbor-real-probe.cjs)、[受控版本比较脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-compare.cjs)。比较文件含 5 个工具、2 份配置、脚本和 793 个 `src/*` 加 `index.html` 输入的一致性证据。

## 3. 原问题关闭与被反证的候选

| 范围 | 本轮独立结果 | 有效结论 |
|---|---|---|
| RR10-01 原 8 逻辑例 | 全部符合修复后的预期；2 个原误报归零 | 原组合关闭；完整 API 和实际默认对象仍拒绝 |
| RR10-01 原实际配置 2 例 | 安全 0，违规 1 | 在全部 20 Renderer boundary 配置中的指定装配成立 |
| RR10-02 原 7 数组例 | 5 违规拒绝、2 安全通过 | 原工厂空数组扩容缺口关闭 |
| RR10-02 原实际配置 4 例 | 3 违规各 1、1 安全 0 | 原代表关闭 |
| 新逻辑邻近 6 例 | 2 个同根因漏报、2 安全对照、2 合并负例 | 父成员证明为 RR11-01；候选交集未见额外问题 |
| 新数组邻近 8 例 | 7 符合预期、1 漏报 | 重排来源为 RR11-02；第二分支和复制时点未见新问题 |
| 声明绑定/闭包捕获 6 例 | 3 安全仍 0；3 违规从 before 0 到 current 1 | 原样复跑 R10 adjacent 六例，未发现新增问题 |
| 共享解析 56 例 | 38 Renderer、18 query 前后诊断数组一致 | 修正后的期望保持；10 query 用例执行内存 SQLite 查询 |
| scanner 稳定性 62 例 | 重复、规则执行前后、before/current digest 及 evidenceId 一致 | 私有证明/身份数据未改变这些 fixture 的共享扫描结果 |

对应证据：[原逻辑例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-original-probes.jsonl)、[原逻辑实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-renderer-original-realconfig.json)、[原数组前后](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-original-before-current.json)、[原数组实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-array-original-real.json)、[参数绑定结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/r11-bindings-probes.json)、[共享与绑定归档断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/shared-archive-verification.json)。

保留两项既有解释边界：

- `single-mount-category-explicit-ipc` 使用真实异步形态 stub，直接取 Promise 的分类属性会得到 undefined，继而调用 `other` 默认来源；应拒绝。未恢复更早同步 stub 的错误安全期望。
- `flag ? "business" : "gateway"` 两端均纯字符串，但 before/current 都保守拒绝不确定值。单独记录，不称为合法通过，也不计入本轮新增问题。

实际配置 probe 在生产 AST 的内存副本中追加人工样例；VM 仅执行样例和 mock API/controller。使用 20 个边界配置不等同于逐个运行 20 个真实控制器，也未执行真实业务 IPC。

## 4. 正式验证与完整门禁复用

本轮重新执行：

| 项目 | 结果 |
|---|---|
| `node --test --test-concurrency=1 tests/unit/architecture/*.test.js` | **566/566 PASS，0 fail、0 skip，exit 0**；[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <本轮绝对输出路径>` | **exit 0，31 active、0 pending/partial、0 诊断、0 stale**；解析 765/765，未解析 2，动态位置 33，历史 21 个提交；[JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/architecture-check.json)、[日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/architecture-check.log) |
| 本轮证据断言 | [verify-probes.py](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/verify-probes.py) 与 [结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/probe-verification.json)；校验版本 hash、原例关闭和已确认缺陷，不把断言 PASS 解释为候选无缺陷 |
| 共享归档断言 | [verify-shared-archive.py](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/verify-shared-archive.py)，62 个样例、SQL/Promise 行为、输入及 scanner 稳定性校验通过 |

完整 `release-check` **本轮未重跑**。复用 R10 repair 的最终门禁：2026-09-23 **02:53:40–03:14:31 Asia/Shanghai**，`UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0；**9340 项单测通过、0 失败、4 项 Windows 条件跳过**，9344 total/828 suites；**68/68 集成脚本通过**，有数字摘要的 2901/2901，另 1 个脚本无数量摘要，Renderer lifecycle 233/233。

其 HEAD 与 **1707 个门禁输入文件**逐一匹配当前候选，且本轮复核了实际日志计数和进程结果。较早被主动 SIGTERM 的 preliminary 门禁 exit -15，明确排除，不作为通过依据。正式架构 566、新增 84 项回归及定向 probe 存在包含/重叠关系，不能与 9340 累加。

依据：[完整门禁摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r10-repair/verification.json)、[最终门禁进程结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r10-repair/release-check-result.json)、[门禁输入清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-r10-repair/gate-input-manifest.json)、[本轮复用核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/reused-gate-verification.json)。

## 5. 结项边界与保全

会改变本轮修复验收的存活项为 RR11-01/02。建议各补充前后版本、VM 身份和实际配置正反例后再做针对性复审。现有自动门禁通过与两个检查器反例同时成立，不能据此宣布 G8 全部合同完备。

没有修改生产源码、检查器、测试、机器配置或历史记录；没有提交、合并、推送、PR、升版、标签或发布。GUI、真实 Main 全流程、Windows/安装包、Excel/WPS 和真实资金人工验收未执行，本审查不宣称正式可发布。

最后对照 **4805 个冻结文件**及 HEAD、Git status、tracked binary diff，且检查本轮目录外无新增 Git 可见文件。见 [最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/preservation-final.json)。产物的文档链接、JSON/JSONL 完整性和归档哈希见 [产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/artifact-validation.json)、[SHA256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/artifact-sha256.json)。

[证据与复现入口](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-23-release-rereview-r11/evidence/README.md) 保留脚本依赖和执行说明。所有结论限定于本轮冻结候选与列出的有限组合。
