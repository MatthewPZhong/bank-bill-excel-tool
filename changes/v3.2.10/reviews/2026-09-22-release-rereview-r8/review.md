# release/v3.2.10 第八轮增量审查

**结论：确认 2 项当前仍开放的 P2，均在 R7 修复前已存在；本轮未确认由 R7 修复新增的回归。** RR7-01 的三个原始反例已关闭，但 IPC 返回数据的缺失字段仍会抹掉实际触发的默认对象来源。另将第七轮数组元素替换观察补齐实际配置证据，登记为既有未关闭问题。386 项架构测试与正式 CLI 通过，不能反证这两个独立反例。

依据：[第七轮审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/review.md)、[第七轮修复](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r7-repair/repair.md)、[G8 Spec](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md)、[TechDoc](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)及[架构能力说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md)。沿用 blindspot-pass 的只读证据审查。本轮仅新增审查文档与证据。

## 1. 固定对象

| 项目 | 事实 |
| --- | --- |
| worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 实际候选 | HEAD 加已有全部未提交修复，包含 R7 默认参数修复 |
| 正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结 | 2026-09-22 17:33:31，Asia/Shanghai；4,476 个已有文件 SHA-256 |
| 相对 R7 审查 | 7 个既有文件变化：1 个 Renderer 检查器、6 个文档；新增 release-rereview-r7.test.js |
| 未变范围 | 792 个生产 src 文件；G1/G5 contracts、rules、scan、schema、policy-history、boundaries、legacy-allowlist 均与 R7 修复起点相同 |
| 最近完整门禁 | HEAD 和 1,704 个门禁输入与本轮冻结内容完全一致 |

[输入清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/input-manifest.json)、[tracked 差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/input-diff.patch)、[上轮比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/prior-review-comparison.json)、[生产及机器合同核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/policy-production-comparison.json)、[门禁输入核对](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/gate-evidence-comparison.json)。

本轮复核 R7 修复、默认值及有限相邻调用环境，扩展上轮明确保留的数组槽位观察，并检查共享解析的 Renderer/G5 结果。没有重新审查全部未变化的业务模块；没有把任意动态循环、反射、多次动态调用或跨文件共享对象时序纳入证明范围。

## 2. RR7-01 关闭边界

三个原始反例——缺成员、显式 undefined、省略普通默认参数实参——均由修复前零诊断变为当前 1 条 ARCH-RENDERER-SCOPE；显式提供另一对象的安全例仍零诊断。原实际 Renderer 脚本保留全部 20 个 active 边界，真实 AST 的缺成员越权例产生 1 条 scope 诊断，安全例 0。正式 RR7 回归 **30/30 PASS**，包含于本轮 **386/386** 架构测试，不相加。

前序参数及默认容器读取时点的 4 个有限相邻例，分别按预期拒绝越权或接受安全路径。默认容器替换后的漏报也由修复前 0 变为当前拒绝。[10 个最小例 before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-probes-before.jsonl)、[10 个最小例 current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-probes-current.jsonl)、[原实际配置复验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-original-realconfig.json)、[30 项定向测试](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-targeted-tests.log)。

**上述关闭只针对原始反例；不能据此宣布默认参数来源合同全部关闭。** 以下 RR8-01 是同类语义的既有剩余路径。

## 3. RR8-01 [P2] IPC 数据字段被视为必然已提供，缺失字段触发默认值时仍漏报

**位置：** [renderer-contracts.js:168](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:168)，默认值 choose 分支把 ipc-data 与确定已提供的 object/literal 等一并直接返回；关联第 146 行字段投影。

```js
const shared = { run() {} };
function select(api = shared) { return api; }
async function run() {
  const info = await window.desktopApi.app.getInfo();
  const alias = select(info.api);
  alias.outsideScope = window.desktopApi.outsideScope;
  window.BankStatementController.createBankStatementController({ api: shared });
}
run();
```

**事实：** [Preload:84](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/preload.js:84)将 getInfo 映射到 app:get-info；[Main 返回结构:5108](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/main.js:5108)提供 backgroundConfig 等数据，api 并非该接口声明的返回字段。取缺失字段所得 undefined 会触发 select 的默认值，alias 实际与 shared 同一对象。静态 ipc-data 描述仅保存 channel/fields 路径，不证明字段存在或非 undefined；choose 却据此不再保留默认来源，导致对 alias 的越权写入未归到 shared。

**实际配置证据：** 使用真实 Renderer AST、当前全部 20 个 active Renderer 边界，基线 0；缺字段反例最终 **0 scope/coverage 诊断**。异步 VM 使用与此返回结构一致的内存 stub，实际 await 读取一次，捕获到 alias === shared、API 键为 run/outsideScope、额外方法返回 true。改传明确提供的 backgroundConfig 对象时，alias 与 shared 不同，注入 shared 只有 run，当前同样零诊断。[实际配置脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.cjs)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.json)。

| 同一最小夹具 | R7 修复前 | 当前 | VM |
| --- | --- | --- | --- |
| info.api 缺失，触发默认 shared 后写入越权方法 | **0，漏报** | **0，漏报** | shared 收到 outsideScope |
| info.backgroundConfig 为提供的另一对象 | 0 | 0 | shared 保持只有 run |

**性质：** 本轮新增确认的剩余路径，修复前也已漏报，不能写成 R7 新引入回归；没有证据证明当前生产代码已经采用该越权装配。真实配置探针是内存 AST 追加与 VM stub，不是真实 IPC 或产品业务执行。

**合同与建议：** [G8-AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:101)要求迁移域拒绝越权注入；[TechDoc 默认参数约定](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:116)要求不确定值保留可能默认来源。数据类别不能代替字段存在性证明。对不能证明非 undefined 的 IPC 投影保留默认候选，或明确 coverage 拒绝；如要精确接受确定存在的字段，应使用可验证的返回结构事实。补充异步缺字段反例，保留能证明明确提供对象的安全路径。

## 4. RR8-02 [P2，既有未关闭] 固定数组槽位替换后仍沿初始元素追踪身份

**位置：** [renderer-contracts.js:176](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:176)，176–178 行仅对 object/identity-candidates 使用调用时点快照；普通成员读取第 223 行存在相同限制。

```js
function provide() { return { api: { run() {} } }; }
const old = provide();
function select([{ api }]) { return api; }
const list = [old];
const current = provide();
list[0] = current;
const alias = select(list); // 改成 list[0].api 也复现
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: current.api });
```

**事实与根因：** 数组分支直接使用初始 elements，未应用已经完成的固定槽位赋值；数组求值没有对象路径使用的 identity/origin。因此 alias 被错误关联到 old.api，而 JavaScript 实际返回 current.api。检查器把越权写入归到旧对象，最终放行已扩展的 current.api。相关实现见第 147–150 行 select、第 223 行 memberRead 及第 241 行数组求值。

**本轮补齐实际证据：** 保留实际 20/20 active Renderer 边界、真实 Renderer AST，基线 0、765/765 文件解析、0 parseErrors；5 个逻辑场景在最小夹具和实际 AST 下结果一致。具体追加的是 BankStatement 装配，不表示逐个测试了全部 20 个工厂。

| 场景 | R7 修复前最小诊断 | 当前最小 / 实际 AST 诊断 | VM |
| --- | --- | --- | --- |
| 固定槽位替换后经参数解构取别名 | **0** | **0 / 0，漏报** | 新对象收到 outsideScope |
| 替换前捕获旧别名，随后修改旧对象 | 0 | 0 / 0 | 注入新对象只有 run |
| 固定槽位替换后直接 list[0].api | **0** | **0 / 0，漏报** | 新对象收到 outsideScope |
| 对象固定键 0 的替换对照 | 1 | 1 / 1 | 越权被拒绝 |
| 数组没有替换、直接解构当前对象 | 1 | 1 / 1 | 越权被拒绝 |

[五场景定义](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-cases.cjs)、[通用探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-probe.cjs)、[before/current 与双侧 hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-before-current.json)、[实际 AST 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-real-current.json)。两项违规控制均产生准确的 outsideScope 诊断，排除了工厂未匹配或整条规则未生效的解释。

**性质：** 第七轮已留下该最小例观察，R7 修复明确未处理；本轮补齐实际配置验证后登记为 P2，未计为本次默认参数修复新增回归。本例没有使用默认参数，与 RR8-01 的触发和根因独立。

**合同与建议：** [TechDoc:102](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:102)要求未知 alias 来源不得静默放行，[架构说明:105](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:105)与[109 行](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:109)约定成员读取时点与数组参数解构来源。保留观察说明它仍开放，不能把零诊断视为合同成立。对固定数组槽位追踪分配身份、写入与读取时点；暂不支持的数组改写应明确 coverage 拒绝。回归须同时保留旧别名分离和对象固定键对照。

## 5. 共享解析、版本与验证

共享解析检查 **44 个小夹具 × before/current 两版本**：复用 38 个，加 6 个单调用装配 helper／不同调用上下文组合，共 26 个 Renderer 与 18 个查询。42 个通过/拒绝结果保持，2 个合法显式覆盖场景的旧误报消除；有 1 个违规例从 scope 变为 coverage，两端都拒绝。10 个查询反例实际运行内存 SELECT 并被拒绝，8 个安全查询场景未执行 SQL。scanner JSON、重复扫描、求值前后及 evidenceId 保持；未确认本范围新问题。[共享汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-verification.json)、[归档重核](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/shared-archive-verification.json)。

所有本轮 before 都指 **R7 修复起点**，使用归档 renderer-contracts.js 和 4 个未变化工具，并校验 R7 manifest；不使用 R6 作为本轮 before。数组比较额外对 2 份机器 JSON 和当前 R8 输入双侧验证，7 项全部匹配。[Renderer before hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-before-inputs.json)。当前工具与生产源码的保全由本轮结束核验覆盖。

| 验证 | 本轮执行与结果 |
| --- | --- |
| 全架构单测 | 实际执行：386/386 PASS，0 fail/skip |
| RR7 定向 | 实际执行：30/30 PASS；已包含于 386 项 |
| 正式架构 CLI | 实际执行并生成 JSON：31 active，0 pending/partial，0 violations/stale；765/765 parsed，0 parseErrors，2 个既有 generated unresolved，33 dynamicSites |
| 独立探针 | 实际执行：10 个默认参数最小例、5 个数组场景、44 个共享夹具及上述实际配置正反例；两个漏报被复现 |
| 归档证据断言 | 实际执行 verify-shared-archive.py 与 verify-probes.py，PASS 仅表示证据支持已记录观察 |
| 完整门禁 | 本轮未重跑；最新 R7 修复门禁的 HEAD 与 1,704 个输入逐一匹配后复用 |

[架构日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/architecture-tests.log)、[CLI JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/architecture-check.json)、[CLI 日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/architecture-check.log)、[独立证据断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/probe-verification.json)。

复用的完整门禁运行于 **2026-09-22 16:37:31–16:56:01，Asia/Shanghai**，命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，在沙箱外使用隔离测试环境，exit 0。单测 **9,164 total / 9,160 PASS / 0 fail / 4 Windows 条件 skip**；集成 **68/68 脚本通过**，有计数项 **2,901/2,901**，另一个 `v2.1.12-beta-multiworker-nested` 无单项计数；Renderer lifecycle 233/233。来源为[R7 修复验证汇总](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r7-repair/verification.json)及[完整命令结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r7-repair/release-check-result.json)，不冒充本轮重跑，不与本轮架构/定向数相加。

G1/G5 相关工具未改，本轮通过架构测试与共享小夹具核验，未重跑过去 G1 实际源码突变或真实恢复 IO。没有 Windows、安装包、GUI、Excel/WPS、真实业务数据或发布验收。扫描与自动门禁通过不能推导这两个缺陷已消除或 release 整体验收完成。

## 6. 保全与后续验收

结束时核验 4,476 个冻结文件全部未变，HEAD、Git status 和 tracked 差异保持；除本轮审查目录外没有新增 Git 可见文件。[最终保全](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/preservation-final.json)。没有修改源码、检查器、测试、配置、旧证据，也没有提交、推送、合并、PR、升版或发布。

仍会影响验收的事项为 RR8-01 与 RR8-02。原始默认值三例、明确提供对象、旧别名、前序参数和有限调用环境对照已反证相应修复回退候选；它们不能覆盖 IPC 字段存在性或数组槽位写入。后续修复应加入两项独立反例及安全控制，继续区分原始反例关闭、完整合同关闭和产品/平台验收。

[机器摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/verification.json)、[复现说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/README.md)、[证据 SHA-256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/artifact-sha256.json)。
