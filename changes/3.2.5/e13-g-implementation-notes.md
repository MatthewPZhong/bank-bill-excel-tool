# v3.2.5 E13-G Implementation Notes

## Baseline

- Authority：[spec.md](./spec.md) §7～§9、[techdoc.md](./techdoc.md) §6～§10、
  [implementation-sequence.md](./implementation-sequence.md) E13-G。
- Preflight：[e13-g-preflight.md](./e13-g-preflight.md)。
- Exact local parent：E13-F `0791560239398323760972fb9fe2b9cb1d409de0`。
- Initial current-tree evidence：`26/29 PASS`；3 个失败 gate 共 135 条错误，最初归因于旧 60-pair
  authority/provenance/report 对 E13-C 中间 59-pair binding 的漂移。随后按冻结 Spec 做入口盲区复核，
  发现 `pre-fund:bank-import` 与 `pre-fund:run` 两个延后入口未被独立枚举；最终 current authority
  为 54 actions / 61 pairs，而不是中间 52 / 59 snapshot；冻结 Runtime Policy Registry 仍为
  52 actions / 59 Spec rows，两个延后入口只进入独立 Manifest/Binding/Strategy 层。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 独立静态 action/pair inventory 与生产 binding 双向 exact 比较 | coverage 不能由 forward binding snapshot 自生 | 直接把 `bindingSnapshot()` 当 manifest authority | 缺失、额外、替换或重复 pair 均 fail closed。 |
| Capability 与 Handler route 分开 | Runtime policy 是 dormant 能力，不证明默认 IPC 已切路 | policy 存在即写 managed route | Position import-result 等入口继续如实显示 legacy Main route。 |
| Contract Authority v1 走 revision 1→2 受控变化 | current 变化由移除 1 条 stale Acquiring pair、补入 2 条遗漏 PreFund pair 构成，60→61；validator 明确要求 exact +1 revision | 保持 rev1 同步改派生证据；另造不受 previous 约束的新 authority | `genesis=false`、人工 redline PENDING、mergeReady/production enablement 仍 false。 |
| PreFund bank import/run 使用独立 legacy-only action，但不写入冻结 Runtime Policy Registry | current 顶层 E13-G authority 明确不能以已后台化的 MPT/export 宣称覆盖完整 PreFund；真实 Main 与 TaskPolicy 各有独立入口，而冻结 package Spec/Registry 只定义 Runtime capability | 继续沿用 52-action 中间清单；把两者并入 MPT/export；或伪造两条 Runtime policy | 两入口只进入 Manifest/Binding/Capability/Strategy：保持 legacy-main、runtimeRegistered=false、effective legacy、worker=0、feature flag=false；Registry 仍为 52。 |
| validator 只允许两个精确 legacy-only binding action | Manifest 必须覆盖真实入口，但不能把任意 binding-only action 泛化为合法例外 | 继续要求 Manifest=Registry；或允许任意 Registry 外 action | exact set 为 Registry ∪ `{pre-fund:bank-import, pre-fund:run}`，并锁定各自唯一 TaskPolicy；缺一、多一或塞回 Runtime Registry 的 mutant 均失败。 |
| checksum 最后生成 | checksum 只证明 bytes 完整，不证明语义正确 | 先重算 69/69 再处理 validator | 必须先通过 coverage、mutants 与 29/29。 |

## Evidence

| 证据 | 当前结果 | 说明 |
| --- | --- | --- |
| 初始 current-tree validator | 26/29 PASS | `canonical-action-legacy-task-binding`、`contract-authority-anchor`、`validation-input-hash-coverage` 失败；不是绿灯。 |
| 当前生产 inventory | 54 actions、61 pairs、122 TaskPolicies | binding digest `5c9ee534…9ff2`；TaskPolicy digest保持 `95381024…b368`；Runtime Policy Registry 仍为 52 actions、package Spec table 仍为 59 rows。 |
| 当前 capability | 36 policies、16 legacy-only、2 platform canary | 全部 production disabled；Snapshot 必须保持 legacy/0。 |
| Contract Authority v1 revision 2 | `29/29 PASS`、0 error、73 inputs；52 Registry actions、59 Spec rows | 相对 merge-base revision 1 精确 +1；`genesis=false`、人工 redline 仍 PENDING；validator 对缺失/额外/错误入 Registry 的 legacy-only mutant 全部拒绝。 |
| E13-G 独立清单 gate | `324/324` surfaces、61 pairs、0 production enabled | 四份已发布 JSON 已由 `npm run check:background-execution-manifest` 对当前模块导出和 source hashes 复验；中间 312/312 结果不作最终绿灯。 |
| package checksum | `69/69 PASS` | 在 semantic validator 29/29 和最终 report 落盘后重算，随后逐文件 `shasum -a 256 -c` 复验；不以 checksum 代替语义 gate。 |
| 完整本地回归 | 最终 E13-G/binding/bootstrap 定向 `27/27 PASS`；unit `6857/6860 PASS`（0 FAIL、3 SKIP，日志 `logs/unit-tests/unit-20260831-032421.log`）；integration 53/53 scripts、`2488/2488 PASS`（349045 ms）；smoke PASS | lint、E13-G 脚本/测试 ESLint、语法与 `git diff --check` 均 PASS；未运行被禁止的聚合命令。 |
| 依赖环境复验 | `electron-builder/app-builder-lib 26.15.7` 与 lockfile 精确一致；Windows contract `5 PASS`、`2 SKIP` | 首次全量 unit 的唯一失败来自主工作区旧 `node_modules` 26.8.1；隔离安装 lockfile 精确依赖后精确用例与完整 unit 均 0 FAIL，未把旧依赖失败快照当绿灯。 |

## Remaining Unknowns

| 未知 | 处理 | 合并影响 |
| --- | --- | --- |
| 当前 Main/TaskPolicy 逐 pair AST 行号与 source hash | RESOLVED：61 条 provenance 已逐行/source hash 复验；普通 early-return mutant 继续 fail closed，只对 exact packaged canary exit guard 例外 | 不再阻塞 E13-G。 |
| package 文档中全部 revision/digest/count 投影 | RESOLVED：规范文档、runtime/package schema、KAT fixture、manifest 与 codex-ready projection 已同步 revision 2/61 pairs，且 Registry/Spec 52/59 边界由 29/29 锁定 | checksum 最终复验后不再阻塞 E13-G。 |
| Windows、真实业务样本、资金/恢复签字 | BLOCK（production） | 不阻止 dormant E13-G；阻止 production enablement。 |

## Blindspot / Reconciliation

- 自生 coverage 风险：Action Manifest 的 canonical action/pair inventory 与生产
  `bindingSnapshot()` 保持独立；缺失、额外、替换、重复、伪报 managed route 的 mutants 全部失败。
- surface 虚假覆盖风险：持久 Action Manifest、Capability Inventory、Effective Production Strategy 和
  coverage report 必须与当前模块导出逐值相等，并绑定 9 个关键 source hash；仅复制旧 JSON 不能通过 gate。
- capability/production 混淆风险：36 个 runtime capability 不等于生产路由；快照必须精确记录 54/54
  effective legacy、worker count=0、production enabled=0，外部 feature flag 不能覆盖 code-level disabled。
- 入口血缘风险：`acquiring:export-diff-workbook` 保持无 legacy binding；
  `position-reconciliation:run:import-result` 保持 `legacy-main`，不得用 E13-F capability 伪造当前 route。
- PreFund 入口旁路风险：`pre-fund-reconciliation:import-bank` 与 `pre-fund-reconciliation:run`
  分别绑定独立 action，保持 legacy-main；MPT import/repair 与 export 不得代偿其 coverage；两入口不得
  写入冻结 Runtime Policy Registry，避免把真实 legacy 入口伪装成 dormant Runtime capability。
- AST 放宽风险：只允许 exact `packagedRuntimeModeSelected` guard 内的 `app.exit(exitCode); return;`，
  其他 DB/IPC 前提前返回、嵌套/吞错/重复 initializer/run mutants 继续 fail closed。
- 资金/恢复红线：E13-G 未修改业务 SQL、金额币种、Workbook、事务、幂等、取消或恢复语义；
  `PENDING_HUMAN_REVIEW`、production disabled、legacy seam 保留。

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
