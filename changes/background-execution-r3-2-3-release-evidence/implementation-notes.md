# R3.2.3 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：v3.2.3 Spec、TechDoc 与 implementation sequence 的 `R3.2.3 | Windows、RSS、人工复核 | action 独立 enable`。
- Exact base：`d54f97cecddef992069d867eedc227681ed562d4`（第一父 `60cf39e7...` 在 `771e55f7...` 之上继续修复 v3.2.2 历史 base-anchor 的跨版本 authority；第二父 `4e778f10...` 仅保留已缓存远端 #207 ancestry，tree 由第一父完整决定）。
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
| 历史 exact suite的外层wrapper规范化clone cwd与三类temp环境变量。 | exact Windows job `99731507623` 中nested suite因`C:\Users\RUNNER~1\...`与Git/realpath长路径身份不一致，先报`GIT_REPOSITORY_IDENTITY_INVALID`，后续authority/tamper门禁未到目标断言。 | 修改`57fab04a`历史提交或历史/current validator；放宽Git identity；重签snapshot。 | 仅当前测试harness消除短路径别名；historical bytes、22-test期望、Git/tamper/privacy/action-scope/current-file strict合同不变。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| evidence-only PR 不更新 package/version 三件套。 | 无 version bump/live change；冻结 sequence 只要求 final evidence。 | release owner决定正式发版时仍需另行更新。 | 当前 5 文件可整提交回滚；正式发布另立 PR。 |

## Deviations

无行为或验收偏差。Statement common runtime absent 是 first-pass 取证后对原“7 action registered”泛称的精确澄清，已同步 preflight/schema/tests；没有改变冻结 Spec 或生产代码。

Reviewer blocking P2 证明原 `src/main-process` audit root 不包含真实依赖的 `src/backend`；ignored extensionless 同名文件可优先于 tracked `.js`。修复仅把同一 guard 的审计闭包扩大到整个 `src`；最终 v3.2.2 重新叠栈后 tracked count 锁定为 525，并把真实 Git 反例移动到 `src/backend/big-table-import/zip-reader`。未改变 snapshot action、生产状态、人工 gate 或公共合同。

第二个 blocking P2 证明原 runtime ownership 把 7 项统一写成 `legacy-preserved`，与冻结 Spec 的 action inventory 不一致。修复仅把 `new-account:save-as` 的 `liveDisposition` 改为 `inline-excluded`，其余六项保持 `legacy-preserved`，并增加 exact 正向映射与改回旧值的 fail-closed mutation；false/legacy/0、REGISTERED、wiring 与 gate 均未改变。

2026-08-30 复审发现 E09-C 重复 `prepare-generation` 入口仍走 release-first，已改为复用 E09-B candidate-first replacement，并通过显式 merge commit 传播至 E09-D、E10-A、E10-B。最终证据在最终 v3.2.2 基础上再次重建到单父 `259b3cf6bf5a4414dc81bbc40f859b8b30b3e430`，不接受旧 E09-C head、旧下游 head 或双父 merge 结果代偿。

同日远端 Windows CI 证明 E09-P0 manual-seed golden 直接比较 `path.relative()` 与 `/` frozen path，属于平台分隔符测试旁路。修复只在断言前规范化分隔符，并已按 `#192 → #193 → #197 → #199 → #202 → #205 → #206` 在最终 v3.2.2 上显式传播。当前 reviewed heads 依次为 `03d1cfcb`、`d386fba1`、`2b2b616d`、`733aa0aa`、`ff48ae4a`、`1f568bd8`、`259b3cf6`；旧失败快照与旧下游 head 不得代偿。

最终全量 unit 又暴露两个跨版本收尾问题：归档 source root 被 symlink 替换时，后台 ArchiveService 与 StorageRootManager 会竞态返回不同错误码；v3.2.2 evidence validator 把共享 implementation sequence 的合法 v3.2.3 只追加章节误判为冻结内容漂移。两项均在独立单父 `b180ca0e` 中以 fail-closed 方式修复并完成全量 unit/integration/smoke；R3.2.3 因而从该稳定化节点重新生成，仍保持 5 文件纯证据提交。E09/E10 reviewed heads 不变，稳定化节点不得伪装成 E10-B 的 reviewed head。

最终顺序链再次传播后，#192/#193/#197/#199/#202/#205/#206 reviewed heads 更新为 `03d1cfcb`、`8c69d8f7`、`290c3a9c`、`c014b9ee`、`81484cdc`、`3b9f71cf`、`5c557ae5`。R3.2.3 从最终 #206 上重放原 stabilization 得到 `771e55f72b5f91caecc013220fd8f50dd2b18e18`；完整 unit 随后证明 v3.2.2 历史 base anchor 仍会被 v3.2.3 合法 startup registry 改写反向失效，因此以 `60cf39e739147001cfbb34201edf5fa20c994bf6` 分层为“历史 anchor 读 reviewed blob、当前 policy/runtime 读 current source”。最后用 `ours` ancestry bridge `d54f97cecddef992069d867eedc227681ed562d4` 保留已缓存远端 #207 head `4e778f10...`，同时保持第一父 tree 不变。最终 evidence commit 仍是 exact-base 上的单父 5-path pure-add，authority source/blob/hash 与 evidence catalog 已按这些 exact heads 重建；旧 `b180ca0e/259b3cf6` 结果只保留为历史证据，不代偿本次 final-chain validator。

## Reproducible Focused Validation

```bash
node --test --test-concurrency=1 tests/unit/main-process/statement-state-footprint-probe-e09-p0.test.js tests/unit/main-process/statement-legacy-golden-e09-p0.test.js tests/unit/main-process/statement-worker-contract-e09-p0.test.js tests/unit/main-process/statement-service-e09-a.test.js tests/unit/main-process/statement-interactions-e09-b.test.js tests/unit/main-process/statement-generation-e09-c.test.js tests/unit/main-process/manual-balance-seed-settlement-e09-d.test.js tests/unit/main-process/new-account-generation-e10-a.test.js tests/unit/main-process/new-account-save-as-e10-b.test.js tests/unit/main-process/background-execution/resource-governor.test.js tests/unit/main-process/background-execution/service-host.test.js tests/unit/main-process/background-execution/supervisor.test.js tests/unit/main-process/background-execution/recovery-control-repository.test.js tests/unit/main-process/background-execution/policy-registry.test.js tests/unit/main-process/toolbox-background-generation.test.js
```

2026-08-30 重建后实际结果：`419/419 PASS`，`0 FAIL / 0 SKIP`。旧 `469/469` 是早期未附 exact 命令的历史记录，不再作为本次重建证据。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact parent/worktree preflight | parent/merge-base `d54f97cecddef992069d867eedc227681ed562d4`；branch `codex/v3.2.3-r3-final-evidence-chain-20260830`；5 path pure-add `100644` | 防错 base/worktree、额外生产提交与 mode/type 漂移；bridge 只保留旧远端 ancestry，不改变第一父 tree。 |
| `node scripts/validate-v3-2-3-release-evidence.js` | PASS；7 action、production enabled=0、Statement dormant/common runtime absent、NewAccount registered、productionReady=false | 只读 machine evidence 与 NOT READY 人工门禁。 |
| `node --test --test-concurrency=1 tests/unit/scripts/v3-2-3-release-evidence.test.js` | `22/22 PASS` | exact Git parent/tree/index/blob/type/mode、整个 `src` audit-root backend ignored shim、duplicate/NFKC key、number token、7-action scope、production/live/gate/rollback/privacy mutations。 |
| 上述 E09-P0/A/B/C/D + E10-A/B + platform/Publisher focused unit（15 files，串行） | `419/419 PASS` | Statement state/Service/token/current-all/manual seed、NewAccount generation/save-as、RSS/cancel/recovery、Governor/ServiceHost/Supervisor/RecoveryControl/single Publisher。 |
| `npm run test:unit`（本证据精确提交） | `6604` tests，`6601 PASS / 0 FAIL / 3 SKIP`；旧 `6602/6599` 与修复前 `6603/6597 + 3 FAIL` 均不代偿 | 全仓 unit 与新增 R3.2.2/R3.2.3 validator mutation test 同树验证；三条 `/baseAnchors/4/source` 失败已关闭。 |
| 历史稳定化基线 `npm run test:integration`（旧精确 parent `b180ca0e`） | `53/53 scripts, 2488/2488 assertions PASS`；runner 生成的 `rules/integration-test-policy.md` 时间戳/耗时噪声已还原 | 只作为旧稳定化基线，不代偿 final-chain exact head。 |
| final-chain NewAccount integration + smoke | `36/36 PASS`；smoke PASS | 最终 #205/#206 联合 runtime、NewAccount Workbook/账户/日期/币种/余额与应用级路径回归；本证据提交仍只改 5 个证据文件。 |
| changed JS ESLint + `node --check` + `git diff --check` | PASS | validator/test 静态质量、语法与 patch 卫生。 |
| isolated dependency environment | worktree 增加 ignored `node_modules` symlink 指向主仓已安装依赖；未安装、未修改、未提交依赖 | 使 validator 的真实 NewAccount runtime authority 可加载；链接不属于证据 commit。 |
| Windows historical exact失败 | job `99731507623` checkout `d0379600271e04156736468d2f67ddd7a6a0f055`；外层unit `6562/6594`、30 fail/2 skip；nested `57fab04a` suite为4 pass/18 fail，首错`GIT_REPOSITORY_IDENTITY_INVALID`，authority随后`AUTHORITY_MODULE_PATH_INVALID` | 失败由短路径lexical identity污染harness；不得把未到目标断言的18项归因于证据内容漂移。 |
| canonical historical wrapper回归 | 官方Node22.18；正常temp与精确mktemp内`RUNNER~1` symlink alias temp各运行一次当前外层wrapper，二者均成功复验nested historical `22/22`（外层`1/1`），临时alias资源按精确路径清理 | canonical clone cwd与TMP/TEMP/TMPDIR足以隔离alias；真实Windows仍是权威PROBE，未把macOS本地结果升级为Windows通过。 |
| Windows protocol/path修复联合验收 | 官方Node22.18；E10-B/R3.2.3/protocol/privacy/Supervisor/inline adapter及既有跨模块17文件矩阵`436/436`；完整unit `6592/6595`、0 fail/3 Windows-only skip/0 cancelled，日志`logs/unit-tests/unit-20260901-124639.log`；`check:packaged-inputs` PASS、lint exit0、changed JS node-check与diff-check通过 | 长inode精确allowlist、Publisher/cleanup、historical 22/22、R3 tamper/privacy/action-scope及前序业务合同同树验证；未运行被禁release-check/check-vars/scan:vars。 |

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
| 当前macOS alias probe能否等价模拟Windows `RUNNER~1` | PROBE；仅验证wrapper把nested repo/temp转换为真实路径，不作为Windows通过证据 | 临时symlink alias与正常环境各跑historical suite；最终仍由新exact Windows CI权威验证unit/integration | 本地probe失败若源于宿主差异不放宽Git identity；旧CI/本地绿不代偿。 |
| 新exact Windows unit与首次到达的integration | PROBE；旧job在unit阶段退出，不能由本地完整unit代偿 | 推送严格新head后等待全部exact smoke/build成功；失败仅按新日志隔离 | 阻止合并直至精确新CI全部成功。 |

未运行 `release-check`、`check-vars`、`scan:vars`，符合本任务明确禁令。
