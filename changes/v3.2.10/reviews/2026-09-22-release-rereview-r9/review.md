# release/v3.2.10 第九轮增量审查

**结论：第八轮两项 P2 的原始反例已关闭；本轮确认 2 项 P2 既有剩余漏报，未确认由 R8 修复新引入的回归。** 一项是逻辑 AND 丢失短路结果，另一项是数组 mutator 的静态 spread 实参丢失插入对象来源。432 项架构测试和正式 CLI 通过，不能覆盖这两条独立反例。

同时更正第八轮共享探针的一项安全判定：旧同步 IPC stub 不符合 invoke 返回 Promise 的实际合同；改用异步 stub 后会执行被禁止的默认频道，当前拒绝正确。旧历史文件保持，本报告记录纠正依据。

依据：[第八轮审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/review.md)、[第八轮修复](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r8-repair/repair.md)、[G8 Spec](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md)、[TechDoc](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)及[架构能力说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md)。沿用 blindspot-pass 的只读证据审查方式；本轮仅新增审查材料。

## 1. 固定对象与范围

| 项目 | 当前事实 |
| --- | --- |
| worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 候选 | HEAD 加全部已有未提交修复，包含 R8 修复 |
| 正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结 | 2026-09-22 19:00:55，Asia/Shanghai；4,555 个已有文件 SHA-256 |
| 相对 R8 审查 | 7 个既有文件变化：1 个 Renderer 检查器、6 个文档；新增 release-rereview-r8.test.js |
| 未变范围 | 792 个 src 文件；G1/G5 contracts、rules、scan、schema、policy-history、boundaries、legacy-allowlist 均与 R8 修复起点一致 |
| 最新完整门禁 | HEAD 与 1,705 个输入逐一匹配当前冻结内容 |

[输入清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/input-manifest.json)、[tracked 差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/input-diff.patch)、[增量比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/prior-review-comparison.json)、[生产及机器合同](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/policy-production-comparison.json)、[完整门禁输入核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/gate-evidence-comparison.json)。

本轮集中于 R8 的 Renderer 默认来源及数组身份修复、有限静态组合和共享解析影响。没有重新审查全部未变化业务模块，也不证明任意动态循环、反射、变长展开、跨文件共享状态或真实运行时授权。

## 2. 第八轮问题的关闭范围

| 原问题 | 本轮独立复核 |
| --- | --- |
| RR8-01 IPC 缺字段触发默认对象 | 原实际 20 Renderer 边界、真实 AST 脚本复跑：缺字段越权例产生 1 条 ARCH-RENDERER-SCOPE；VM 仍确认实际使用 shared，故原漏报已关闭。 |
| RR8-02 固定数组槽位替换 | 原实际 20 边界的 5 例复跑：参数解构、直接索引及两个违规控制均拒绝；替换前捕获旧别名的安全例零诊断。固定槽位原始观察已关闭。 |

[原 IPC 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-original-realconfig.json)、[原数组五例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-real-original.json)。每组保持 20 个 active Renderer 边界，具体追加 BankStatement 装配，不表示逐个测试全部 20 个工厂。

原 backgroundConfig stub 安全例当前也被拒绝。该变化符合已明确记录的保守选择：IPC 来源标签不证明字段存在或非 undefined，不能把本次 stub 恰好提供对象当成静态合同。显式构造的对象及纯数据默认候选仍有安全对照。本轮不将该已声明限制另记为误报。

RR8-01 定向测试 **13/13 PASS**；新增 R8 的全部 46 个正式回归包含在本轮 **432/432** 架构测试中，不相加。原问题关闭不等于默认值或数组语义全部关闭，以下组合仍开放。

## 3. RR9-01 [P2] AND 表达式抹掉短路产生的 undefined，默认对象越权写入漏检

**位置：** [renderer-contracts.js:387](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:387)。该分支无条件只解析 AND 的右项，关联第 208 行把右侧对象当作已提供实参。

```js
const shared = { run() {} };
const provided = { run() {} };
function select(api = shared) { return api; }
async function run() {
  const info = await window.desktopApi.app.getInfo();
  const alias = select(info.api && provided);
  alias.outsideScope = window.desktopApi.outsideScope;
  window.BankStatementController.createBankStatementController({ api: shared });
}
run();
```

**事实：** info.api 缺失时，AND 的运行结果是左值 undefined，select 应使用 shared 默认值；alias 与 shared 是同一对象。当前代码却直接把右项 provided 作为表达式来源，进一步认定默认值不会触发，因此别名写入没有归到真正注入的 shared。

| 对照 | R8 修复前最小诊断 | 当前最小 / 实际配置诊断 | 异步 VM |
| --- | --- | --- | --- |
| select(info.api && provided)，缺 api 字段 | **0** | **0 / 0，漏报** | shared===alias，API 含 run/outsideScope，额外方法可调用 |
| select(true && provided) | 0 | 0 / 0 | shared!==alias，注入 shared 只有 run |

实际配置保留当前全部 20 个 active Renderer 边界与真实 Renderer/Preload AST，两个原始基线均 0；VM 每例真实等待一次异步 getInfo stub。没有调用真实产品 Main 或 IPC。[实际脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-logical-realconfig.cjs)、[实际结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-logical-realconfig.json)、[最小 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-probes-before.jsonl)、[最小 current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-probes-current.jsonl)。

**性质与影响：** 这是本轮新确认的既有相邻漏报，修复前同一 AND 分支已存在；未证实生产源码已采用该装配。它使越权 scoped API 能通过架构门禁。本例只包含静态逻辑表达式、默认参数和固定成员写入，不需要动态循环或反射。

**合同与建议：** [G8-AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)要求拒绝越权注入；[TechDoc:110](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:110)保留条件来源，[默认来源约定](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:116)要求不确定值保留默认来源。应按短路语义保留左值可能结果；只有能证明左项真值时才能只取右项。无法解释时保留候选或明确 coverage 拒绝。补齐缺字段 AND 反例和 true AND 安全对照，保留本轮 OR/nullish 反例及显式对象安全控制。

6 个有限邻近例中，OR undefined、nullish undefined 均拒绝；IPC helper 转发由 before 0 变为当前拒绝；显式对象安全例通过。AND 剩余问题没有被这些修复反证。

## 4. RR9-02 [P2] 数组 mutator 的静态 spread 实参丢失可见插入对象来源

**位置：** [renderer-contracts.js:153](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:153)，153–154 行将 CallExpression 的每个 argument 直接 describe，没有解释 SpreadElement 的展开值。

```js
function provide() { return { api: { run() {} } }; }
const current = provide();
const list = [];
list.push(...[current]);
const alias = list[0].api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: current.api });
```

**事实与根因：** push/splice 被识别为未精确解释的数组变更，代码试图保留可能插入的对象。但直接 describe SpreadElement 只得到 unknown，静态展开中的 current 身份丢失；所选槽位候选因此不能关联 alias 与 current.api。unknown 没有转成此次装配的 coverage 诊断，别名写入被忽略，实际已扩展的 current.api 仍零诊断放行。

| 对照 | R8 起点最小 / 实际配置 | 当前最小 / 实际配置 | VM |
| --- | --- | --- | --- |
| push(...[current]) | **0 / 0** | **0 / 0，漏报** | 注入对象带可调用 outsideScope |
| splice(...[0, 1, current]) | **0 / 0** | **0 / 0，漏报** | 注入对象带可调用 outsideScope |
| push(current) | 0 / 0 | 1 / 1 | 直接实参的同义越权已拒绝 |
| 源数组替换前完成 spread 复制、随后修改旧别名 | 0 / 0 | 0 / 0 | 注入新对象保持安全 |

**实际证据：** before/current 各保留实际 20 个 active Renderer 边界、真实 Renderer AST，基线均 0，765/765 parsed、0 parseErrors。4 个代表场景均有 VM 同引用/额外方法证据，具体追加 BankStatement 装配。[四场景真实配置前后对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-selected-real-before-current.json)、[八个最小邻近例前后对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-neighbor-before-current.json)、[场景定义](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-neighbor-cases.cjs)、[自举比较脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-compare.cjs)。

**性质与建议：** 该路径在 R8 起点已经漏报，是数组 mutator 保守来源处理的既有剩余缺口，不计为本次新引入回归。[TechDoc:118](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:118)与[README:117](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:117)要求未精确解释的变更保留不确定性和可见来源，不以初始元素冒充实际结果。对可确定长度的静态 spread 展开并保留对象身份；无法解析时把不确定性落实为 coverage 拒绝，不能只生成随后被身份比较忽略的 unknown。保留直接 push、helper push 和安全复制对照。

8 个邻近例中，直接 push、helper push、槽位替换后默认值、delete 后默认值、length 清零后默认值均由 before 漏报变为当前拒绝；安全复制保持通过。两种静态 spread 调用是同一根因，合并为一项 P2。

## 5. 纠正旧共享探针的同步 IPC 假设

第八轮将 single-mount-category-explicit-ipc 判为安全的依据不成立。其源码直接读取 `ipcRenderer.invoke('app:get-info').reconIdFixBillCategory`，没有 await；旧 stub 却同步返回普通对象。

本地 [Electron 类型定义:8847](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/node_modules/electron/electron.d.ts:8847)明确 invoke 返回 Promise，[Preload:84](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/preload.js:84)原样返回，[Renderer 初始化:1642](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/renderer.js:1642)实际使用 await。保持探针源码不变、只在新副本中用 async stub 后，VM 的调用顺序为 **app:get-info → other**：从 Promise 读取不存在成员得到 undefined，触发 other 默认表达式；工厂收到 Promise，等待结果的 channel 为 other。因此当前 1 条拒绝正确，before 的 0 诊断是漏报。

[异步反证完整结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-default-combinations.json)明确保留 historicalExpectedClean=true、expectedClean=false，旧历史材料没有改写。本轮不能继续沿用之前的“该例安全通过”结论。

共享检查合计 **50 个小夹具 × before/current**：44 个复用例中 43 项通过/拒绝预期保持，1 项按上述反证更正；新增 4 个数组纯数据组合及 2 个正确 await 对照。32 个 Renderer、18 个查询场景，10 个查询反例执行内存 SQLite 并被拒绝，8 个安全查询场景未执行 SQL。scanner JSON、重复扫描、规则评估前后及 evidenceId 全部保持。[共享汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-verification.json)、[主审归档核验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/shared-archive-verification.json)。

正确 await 后使用 other 默认值的运行样本也可能被保守拒绝，这是已有字段存在性合同不足的明确限制；改用纯数据默认值的对照通过。本轮不将这种已声明的保守拒绝记为新增缺陷。

## 6. 验证、版本与剩余边界

| 验证 | 本轮事实 |
| --- | --- |
| 全架构测试 | 实际执行，432/432 PASS，0 fail/skip，exit 0 |
| IPC 定向测试 | 实际执行 RR8-01 13/13 PASS，已包含于 432 项 |
| 正式 CLI | 实际执行，exit 0；31 active、0 pending/partial、0 violations/stale；765/765 parsed、0 parseErrors、2 个既有 generated unresolved、33 dynamicSites |
| 独立探针 | 原始实际配置、6 个逻辑/IPC 邻近例、8 个数组邻近例、50 个共享例及所列真实 AST 对照均执行；两项漏报被复现 |
| 证据断言 | verify-shared-archive.py 与 verify-probes.py 通过，PASS 仅表示归档支持记录的结果 |
| 完整门禁 | 本轮未重跑；核验最新 R8 修复门禁的 HEAD 与 1,705 个输入完全匹配后复用 |

[架构日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/architecture-tests.log)、[CLI JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/architecture-check.json)、[CLI 日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/architecture-check.log)、[证据断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/probe-verification.json)。

全部本轮 before 指 **R8 修复起点**，使用 R8 repair/before 的 renderer-contracts.js 加 4 个未变化工具，5 个 hash 与 R8 manifest 匹配。数组比较额外校验两份机器 JSON 和当前 R9 manifest，7 项双侧核对通过。[before hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-before-inputs.json)、[current hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-current-inputs.json)。

复用的完整门禁为 **2026-09-22 18:06:12–18:27:32，Asia/Shanghai**，沙箱外隔离测试环境运行 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0。单测 **9,210 total / 9,206 PASS / 0 fail / 4 Windows 条件 skip**；集成 **68/68 脚本通过**，有计数项 **2,901/2,901**，另一个 v2.1.12-beta-multiworker-nested 无单项计数；Renderer lifecycle 233/233。来源：[R8 修复 verification](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r8-repair/verification.json)、[完整门禁结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r8-repair/release-check-result.json)。不冒充本轮重新执行，不与本轮架构和定向数相加。

未重新审查未变化业务模块，没有真实产品 Main、业务 IPC、恢复 IO、Windows/安装包、GUI、Excel/WPS 或发布验收。自动门禁通过不消除上述漏报，也不等于 release 可发布结论。

## 7. 保全与交付

结束时逐字节核验 4,555 个冻结文件全部未变，HEAD、Git status 和 tracked 差异保持；本轮目录外没有新增 Git 可见文件。[最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/preservation-final.json)。仅新增审查文档与证据，未改源码、检查器、测试、配置或旧材料，未提交、推送、合并、PR、升版或发布。

当前仍影响验收的是 RR9-01 与 RR9-02。原始 IPC 缺字段、固定数组槽位和列明邻域的改善有独立证据；剩余静态组合需要对应反例及安全控制，不能用原始反例关闭代替完整合同关闭。

[机器摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/verification.json)、[复现说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/README.md)、[归档 SHA-256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/artifact-sha256.json)。
