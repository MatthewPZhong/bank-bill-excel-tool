# R3.2.3 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：v3.2.3 Spec、TechDoc 与 implementation sequence 的 `R3.2.3 | Windows、RSS、人工复核 | action 独立 enable`。
- Exact base：`9758ce887591ce41cac7c11d85cb690a5dadbccf`（已传播 E09-C review remediation 与 E09-P0 Windows path portability 修复的 E10-B head）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：7-action snapshot 与 current runtime/module ownership、冻结 Spec、Git-backed E09/E10 evidence 一致；production 保持 false/legacy/0，Windows/资金/恢复人工 gate 不被本地自动化升级。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 只新增 tracked JSON、readonly validator、mutation tests 与本目录文档。 | R3 scope 是 evidence；任务禁止生产修改。 | 修改 selector/runtime/IPC/version。 | live 与业务输出零变化。 |
| Statement 记录 `DORMANT_MODULE_ENTRY_ONLY / COMMON_RUNTIME_ABSENT`。 | 5个 entry key 在 module seam，公共 runtime action map exact absent。 | 把 fixture/entry seam伪报为 common runtime REGISTERED。 | capability 与 production wiring 分开审计；common runtime absent 是 fail-closed 门禁。 |
| NewAccount 两项同时校验 direct policy 与 common runtime object identity，并按冻结 action inventory 锁定 liveDisposition。 | 两项已公共注册但 production=false；仅 save-as currentDisposition=`inline-excluded`，其余六项=`legacy-preserved`。 | 只信 snapshot/fixture，或把所有 disabled action 泛化成 legacy-preserved。 | registration、current disposition 与 production enablement 分开审计。 |
| E09/E10 evidence 绑定 reviewed commit、path、blob OID 与 canonical SHA-256。 | 防止文件名/文本自声明替代真实 Git authority。 | 只记测试计数或当前 worktree hash。 | head/source/blob/hash 任一漂移拒绝。 |
| 自动 coverage 明列 E09-P0/A/B/C/D、E10-A/B、RSS/CANCEL/RECOVERY。 | 最终门禁需要把专项证据与行动项可审计关联。 | 只写一段“相关测试通过”。 | coverage 缺项或代换 fail closed。 |
| 复用 R3.2.4 已证实的 exact Git/raw JSON/audit-root guard，audit root 覆盖整个 `src`，删除 E12 topology 专属逻辑。 | checkout/duplicate/number/ignored shim 是已有真实反例；本版真实 require graph 会进入 `src/backend`；E12 topology 不属于本版。 | 只审计 `src/main-process`、照搬全部 R3.2.4 版本逻辑或重新发明防御。 | ignored backend extensionless shim 不能执行非 HEAD 字节；保持本版必要最小范围。 |
| 本地 merge-ready 与 production-ready 分离。 | Windows/真实资金/恢复人工门禁仍未完成。 | 自动测试升级人工 gate。 | global decision 固定 `localMergeReady=true / productionReady=false`。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| evidence-only PR 不更新 package/version 三件套。 | 无 version bump/live change；冻结 sequence 只要求 final evidence。 | release owner决定正式发版时仍需另行更新。 | 当前 5 文件可整提交回滚；正式发布另立 PR。 |

## Deviations

无行为或验收偏差。Statement common runtime absent 是 first-pass 取证后对原“7 action registered”泛称的精确澄清，已同步 preflight/schema/tests；没有改变冻结 Spec 或生产代码。

Reviewer blocking P2 证明原 `src/main-process` audit root 不包含真实依赖的 `src/backend`；ignored extensionless 同名文件可优先于 tracked `.js`。修复仅把同一 guard 的审计闭包扩大到整个 `src`，tracked count 锁定为 472，并把真实 Git 反例移动到 `src/backend/big-table-import/zip-reader`。未改变 snapshot action、生产状态、人工 gate 或公共合同。

第二个 blocking P2 证明原 runtime ownership 把 7 项统一写成 `legacy-preserved`，与冻结 Spec 的 action inventory 不一致。修复仅把 `new-account:save-as` 的 `liveDisposition` 改为 `inline-excluded`，其余六项保持 `legacy-preserved`，并增加 exact 正向映射与改回旧值的 fail-closed mutation；false/legacy/0、REGISTERED、wiring 与 gate 均未改变。

2026-08-30 复审发现 E09-C 重复 `prepare-generation` 入口仍走 release-first，已在 reviewed head `9be06726c3ae83b2c442615874751b1da5456164` 改为复用 E09-B candidate-first replacement，并通过显式 merge commit 传播至 E09-D、E10-A、E10-B。最终证据因此重建在新父 `9758ce887591ce41cac7c11d85cb690a5dadbccf`，不接受旧 E09-C head 或旧下游 head 代偿。

同日远端 Windows CI 证明 E09-P0 manual-seed golden 直接比较 `path.relative()` 与 `/` frozen path，属于平台分隔符测试旁路。修复提交 `65378a96b4a1f829fdcb6978aff770f8dd2faff6` 只在断言前规范化分隔符，并已按 `#192 → #193 → #197 → #199 → #202 → #205 → #206` 显式传播。当前 reviewed heads 依次为 `65378a96`、`ff0db0cb`、`3e292ea1`、`a913ae51`、`b54943c4`、`8258def9`、`9758ce88`；旧失败快照与旧下游 head 不得代偿。

## Reproducible Focused Validation

```bash
node --test --test-concurrency=1 tests/unit/main-process/statement-state-footprint-probe-e09-p0.test.js tests/unit/main-process/statement-legacy-golden-e09-p0.test.js tests/unit/main-process/statement-worker-contract-e09-p0.test.js tests/unit/main-process/statement-service-e09-a.test.js tests/unit/main-process/statement-interactions-e09-b.test.js tests/unit/main-process/statement-generation-e09-c.test.js tests/unit/main-process/manual-balance-seed-settlement-e09-d.test.js tests/unit/main-process/new-account-generation-e10-a.test.js tests/unit/main-process/new-account-save-as-e10-b.test.js tests/unit/main-process/background-execution/resource-governor.test.js tests/unit/main-process/background-execution/service-host.test.js tests/unit/main-process/background-execution/supervisor.test.js tests/unit/main-process/background-execution/recovery-control-repository.test.js tests/unit/main-process/background-execution/policy-registry.test.js tests/unit/main-process/toolbox-background-generation.test.js
```

2026-08-30 重建后实际结果：`418/418 PASS`，`0 FAIL / 0 SKIP`。旧 `469/469` 是早期未附 exact 命令的历史记录，不再作为本次重建证据。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact parent/worktree preflight | parent/merge-base `9758ce887591ce41cac7c11d85cb690a5dadbccf`；branch `codex/v3.2.3-r3-release-evidence-restacked`；5 path pure-add `100644` | 防错 base/worktree、额外生产提交与 mode/type 漂移。 |
| `node scripts/validate-v3-2-3-release-evidence.js` | PASS；7 action、production enabled=0、Statement dormant/common runtime absent、NewAccount registered、productionReady=false | 只读 machine evidence 与 NOT READY 人工门禁。 |
| `node --test --test-concurrency=1 tests/unit/scripts/v3-2-3-release-evidence.test.js` | `22/22 PASS` | exact Git parent/tree/index/blob/type/mode、整个 `src` audit-root backend ignored shim、duplicate/NFKC key、number token、7-action scope、production/live/gate/rollback/privacy mutations。 |
| 上述 E09-P0/A/B/C/D + E10-A/B + platform/Publisher focused unit（15 files，串行） | `418/418 PASS` | Statement state/Service/token/current-all/manual seed、NewAccount generation/save-as、RSS/cancel/recovery、Governor/ServiceHost/Supervisor/RecoveryControl/single Publisher。 |
| `npm run test:integration` | `51/51 scripts, 2455/2455 assertions PASS`；runner 生成的 `rules/integration-test-policy.md` 时间戳/耗时噪声已还原 | Statement/NewAccount、recovery、Publisher 与全仓跨模块回归。 |
| `npm run smoke` | PASS | Excel/账单/对账/报告与主业务 smoke。 |
| changed JS ESLint + `node --check` + `git diff --check` | PASS | validator/test 静态质量、语法与 patch 卫生。 |
| isolated dependency environment | worktree 增加 ignored `node_modules` symlink 指向主仓已安装依赖；未安装、未修改、未提交依赖 | 使 validator 的真实 NewAccount runtime authority 可加载；链接不属于证据 commit。 |

## Reconciliation Blindspot

- 本 PR 不读取或写入业务行、金额、币种、账号、seed 或 workbook；snapshot metadata privacy scan 拒绝这些值。
- 没有新执行、重试、Publisher、receipt、Inspector 或恢复状态 mutation；既有 owner 不变。
- 7 action 独立 gate、防跨 action 借证、legacy/receipt/hold rollback 保留由 mutation tests 锁定。
- ⚠️ 资金红线，请人工复核：Statement 金额方向/币种/seed/current-all 与 NewAccount 日期/账号/币种/输出记录；自动证据不能解除 production gate。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged、RSS、dev/ino、directory fsync、app quit | BLOCK production | release owner / Windows 实机 | 不阻止 evidence-only merge；阻止 production enable。 |
| 真实资金样本、Excel/WPS 与 durable recovery | BLOCK production | 资金/恢复人工复核 | 不阻止 evidence-only merge；阻止 production enable。 |

未运行 `release-check`、`check-vars`、`scan:vars`，符合本任务明确禁令。
