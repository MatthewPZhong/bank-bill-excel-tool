# v3.2.1 R4 Review Hardening — Implementation Notes

## Baseline

- Goal/spec：修复 v3.2.1 Spec §5.1/§8 mixed-result 合同与 R3.2.1 release gate 的非授权绿色 invocation。
- Exact base：`7e739036609d16f7fce78eaba0f92029d67d0311`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：PreFund missing-middle per-file fail-closed且无 Critical/receipt；非授权 final CI 在 checkout 前失败；不改变 production enablement、资金/恢复合同或 #182 远端状态。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| source snapshot 获取保留 per-file filesystem failure，并在 Parser调度处形成固定脱敏 `PREFUND_SPOOL_SOURCE_CHANGED`。 | legacy逐file继续；直接把所有异常转null会吞掉参数/程序错误；既有 parser-error sidecar已提供有序Writer收口。 | 整批 reject；捕获所有throw；新增公开协议字段。 | missing/EACCES类文件不启动Parser、不进入Critical/receipt，后续文件继续；symlink/null snapshot既有行为不变。 |
| final gate 非精确 invocation 在 smoke job checkout 前显式 `exit 1`，尚未获授权的本地 R4 分支也纳入拒绝集合。 | 仅skip release-check仍可能让同名workflow/job变绿；修复分支自身也不能在未授权时形成绿色替代证据。 | 只依赖人工纪律或branch protection context；让后续build继续；把未授权 R4 当普通中间分支。 | wrong base、synchronize、reopened、rerun、fork final、final workflow_dispatch及未授权 R4稳定失败；普通branch/event保持原行为。 |
| 修复放在新的本地 R4 branch，不修改或push #182。 | #182 exact HEAD与唯一automatic CI授权已经冻结。 | 直接push R3 branch触发未授权synchronize。 | 本地可完整验证；新的最后PR/CI tuple仍需release owner授权。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `code + syscall` 足以区分 `lstatSync` 的真实文件系统错误与参数/程序错误。 | Node文件系统错误shape；现有路径均为picker提供的字符串。 | 极少数平台错误可能仍整批显式失败，但不会被静默吞掉。 | missing真实文件测试；未来平台样本若无`syscall`，扩展白名单而不捕获全部异常。 |
| 远端required check具体context不影响本地修复策略。 | guard直接使整个smoke job红，强于依赖context替代规则。 | 只影响远端展示，不改变FAIL结论。 | release owner只读核对远端保护规则；无需修改产品代码。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| R3 notes曾把 missing source 在runtime前整批失败作为测试预期，并声称所有非授权动作false即可保护gate。 | missing source改为当前file error；非授权final动作除不跑release-check外还必须显式FAIL。 | 外部review证明两处均与冻结mixed-result/hard-gate意图不一致。 | 恢复既有Spec语义；收紧CI，不扩大授权。 | 无需，修复回到现有Spec/门禁意图。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/main-process/pre-fund-reconciliation/mpt-import-e05-a.test.js` | PASS，41/41 | source snapshot、symlink、tamper、cleanup、Parser/Core/Coordinator旧合同。 |
| `node --test tests/unit/main-process/pre-fund-reconciliation/mpt-import-e05-b.test.js` | PASS，38/38 | Single Writer、receipt、repair、transport crash、Hold 与 managed import 全路径。 |
| `node --test tests/unit/main-process/pre-fund-reconciliation/mpt-import-e05-c.test.js tests/unit/main-process/pre-fund-reconciliation/mpt-mixed-lifecycle-e05-p0.test.js` | PASS，22/22 | missing-middle `ok/failed/ok`、repair缺源、无 Critical/receipt/Parser、repair token保留、无残留。 |
| `node --test tests/unit/windows-build-contract.test.js` | PASS，5；SKIP 2 个仅 Windows packaged 专用用例 | exact authorized tuple、wrong base/synchronize/reopened/rerun/fork/dispatch 与未授权 R4 真值表。 |
| `node --test tests/unit/scripts/v3-2-1-release-evidence.test.js` | PASS，11/11 | release snapshot、production disabled、人工门禁和单次 automatic CI 合同未被改写。 |
| `node scripts/validate-v3-2-1-release-evidence.js` | PASS；`releaseCheckStatus=PENDING_REMOTE_REQUIRED_CI`、`releaseCheckHardGateClosed=false` | validator authority 接受新 guard，同时不伪造远端 release-check PASS。 |
| affected ESLint、5 个 JS `node --check`、Ruby YAML parse、`git diff --check` | PASS | 语法、格式和 workflow 可解析性。 |
| 新 worktree 首次跑 mixed lifecycle | 环境 FAIL：缺少 ignored `node_modules/xlsx`；复用 exact R3 dependency tree 后同命令 5/5 PASS | 记录环境失败，不把它误记为产品回归。 |
| `release-check` / `check-vars` / `scan:vars` | 按用户约束未运行 | 不消耗唯一 final CI 语义，也不违反显式禁令。 |

## Blindspot Review

| 维度 | 结论 | 证据/剩余门禁 |
| --- | --- | --- |
| 入口与旁路 | ordinary import 与 repair 都经过同一 per-file snapshot 失败边界；参数/程序错误仍整批显式抛出，未被降级。 | missing、repair missing、`ERR_INVALID_ARG_TYPE` 回归。 |
| 状态与失败生命周期 | 缺失文件保留原 `fileIndex`，通过 sealed parser-error + Ordered Coordinator + Single Writer 收口；后续文件继续；repair token 对暂时性 source failure 保留。 | E05-C 与 mixed lifecycle unit。 |
| 资金/恢复 | 未改金额、币种、方向、候选、source identity、sequence、SQL、receipt schema 或 Recovery Hold；缺失文件不产生 Critical/receipt/business mutation。 | E05-A/B/C；⚠️ 资金与恢复人工复核仍是 production hard gate。 |
| CI 失败模式 | 非授权 R3 final invocation 与未授权 R4 都在 checkout 前失败，`build` 因 `needs: smoke-test` 不会继续形成绿色替代证据。 | workflow依赖图、Windows contract truth table、validator。 |
| 兼容与生产 | 普通非 final branch/event保持原行为；5 个 native action仍 disabled，现有 inherited action状态不变。 | release-evidence tests/validator。 |
| 重要变量人工对照 | `rules/important-variables.md` 未列出本次修改函数名；命中 PreFund risk-sensitive 关联域，但未改变其金额/币种/身份/修复边界合同。 | 未运行被禁止的自动扫描；人工保留资金 review 提醒。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| R4 新head/base与唯一automatic CI是否获授权。 | BLOCK remote push/CI | Release owner 在本地review通过后明确授权。 | 未授权前不得push、开/改PR、rerun或把旧#182 PASS代替R4验证。 |
| Windows packaged、真实业务文件、资金与恢复人工复核。 | BLOCK production enable | Windows/业务/资金/恢复owner。 | ⚠️ 资金红线，请人工复核；native actions继续disabled。 |
