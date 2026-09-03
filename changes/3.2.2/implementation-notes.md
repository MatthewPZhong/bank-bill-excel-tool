# v3.2.2 Release Metadata Closeout — Implementation Notes

## Decisions

- 版本元数据只在最终 v3.2.2 分支收口为 `3.2.2`，不提前把后续分支统一改成同一版本。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不在收口提交中改写业务合同。
- v3.2.0、v3.2.1、v3.2.2 收口按版本顺序形成真实 Git 祖先；后续 v3.2.3 不能用未包含最终 v3.2.2 收口的旧绿色 CI 代偿。
- 文档区分“能力已实现并有证据”与“production 已启用”；后者保持 false。
- #210 Windows 真实进程探针的 CIM 冷启动抖动只在测试夹具中用有界预热吸收；`DEFAULT_EXTERNAL_TIMEOUT_MS=15000`、生产 snapshot/close/cleanup fail-closed 合同和工作流中“完整 release checks 后独立串行”顺序均保持不变。

## Assumptions

- #184～#191 的精确合并状态和 R3.2.2 evidence 是功能完成的权威远端证据；本节点不替代对应 CI 或人工门禁。
- v3.2.0/v3.2.1 收口只修改版本元数据、权威文档、发布说明和验证，不改变业务代码；其精确收口提交分别为 `a7d9bf472e4b4e0d7510b962a65fcd4690eff813` 与 `ea60a5c7bdaaeeb5117d1c20be1f3df2ed4b0e38`。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。
- 审计进一步发现 v3.2.0/v3.2.1 同样保留 `3.1.14`；原独立 v3.2.2 收口提交 `399c92aaac05bc8f105b9458ae5e3c4f7251d8af` 因缺少前两版最终收口祖先而不能直接作为最终节点。本分支先合入 v3.2.1 最终收口，再合入该 v3.2.2 收口内容并重新验证。
- #210 原计划仅做 metadata/docs 收口；精确 Windows CI 暴露专用真实进程探针在约一小时 release checks 后有一次 CIM snapshot 达到 15 秒硬上限。旧日志没有标注具体 snapshot 阶段，因此不把“首次调用”当作已证实事实。为避免重跑代偿或放宽生产安全上限，本节点追加测试夹具级有界预热、阶段证据和合同断言，不修改产品 adapter、业务代码或资金/恢复合同。

## Evidence

- 最终 v3.2.1 收口通过 merge commit `f6166c660e6b782e08caff8b859b2cbf83fff707` 进入当前分支；其两个父分别为最终功能分支 `a8033c14caf2fa3e1e4015be7e4174b7da258e7e` 与 v3.2.1 收口 `ea60a5c7bdaaeeb5117d1c20be1f3df2ed4b0e38`。
- 原独立 v3.2.2 收口 `399c92aaac05bc8f105b9458ae5e3c4f7251d8af` 的定向、完整 unit 与 packaged-inputs 结果只作为合并前基线；当前最终合并头必须重新运行对应验证后才能记录为最终证据。
- 合并冲突的首轮机械重建错误地把命令输出截断提示写入三份长文档，并把文件缩短为 `779 / 1469 / 1377` 行；盲区复核通过父提交行数与异常 marker 发现问题。该状态未提交，随后直接从完整 Git 对象重建，最终 `CHANGELOG.md / VERSION_FEATURE_HISTORY.md / USER_GUIDE.md` 分别恢复为 `3122 / 2614 / 4069` 行，且无截断提示、冲突 marker 或历史版本丢失。
- v3.2.0～v3.2.2 metadata、R3.2.2 release evidence 与 v3.1.14 历史发布文档定向组合：`45/45 PASS`。
- 干净 `npm ci` 后完整 unit：`6337/6340 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260831-141208.log`。
- v3.2.0～v3.2.2 Spec/TechDoc 冻结字节、package JSON、ESLint、Node 语法、`git diff --check` 与最终 v3.2.0/v3.2.1 功能祖先检查：PASS。
- 合并提交 `d449b2230645b679de54e06db2e7b0101b80c65d` 的两个父精确为 `f6166c660e6b782e08caff8b859b2cbf83fff707` 与 `399c92aaac05bc8f105b9458ae5e3c4f7251d8af`；最终 v3.2.0/v3.2.1 收口、v3.2.2 功能基线和原 v3.2.2 收口均通过 `git merge-base --is-ancestor`。
- 干净合并提交上的 `npm run check:packaged-inputs`：PASS；`build.files` 9 条覆盖范围与 HEAD 一致。后续只追加本证据说明，不改 package、业务代码或打包输入。
- #210 run `33368091206` / job `99412884782`：完整 `release-check` SUCCESS；专用 `WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST=1` 步骤中前 14 个 adapter 用例 PASS，唯一真实 PowerShell 用例在 `15008ms` 以 `PROCESS_SNAPSHOT_TIMEOUT` 失败，build 按门禁 SKIPPED。既有 v3.1.12/v3.1.13 证据证明该 hosted-runner CIM 冷启动抖动曾发生，且继续放宽生产 15 秒上限不是允许的修复。
- 测试夹具修复后，本地 `node --test tests/unit/scripts/startup-process-adapter.test.js tests/unit/windows-build-contract.test.js` 为 `19 PASS / 0 FAIL / 3 Windows-only SKIP`；`node --check tests/unit/scripts/startup-process-adapter.test.js` 与 `git diff --check` 均通过。真实 PowerShell 分支仍必须由 #210 精确新 head 的 Windows CI 闭合，不能用本机 skip 或旧 run 代偿。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged 行为及资金/恢复样本仍由 release owner 人工确认。
- `BLOCK / production gate`：本节点不得启用 production。
- `PROBE / 最终发布审计`：`npm ci` 报告现有依赖树有 `2 moderate / 9 high` advisory；本节点未改变依赖图且不自动执行破坏性 `npm audit fix`，需在 v3.2.5 最终发布审计中独立评估。

按用户明确要求，不运行本地 `release-check`、`npm run check:vars` 或 `npm run scan:vars`；提 PR 前仅按 `check-vars` skill 对真实 diff 做只读扫描，不把该扫描记作 npm 脚本 PASS。

## 2026-09-04 正式发布准备

### Decisions

- 严格按 v3.2.0 → v3.2.5 顺序发布；v3.2.1 的最终 main、annotated tag、Release workflow、四项资产与 production disabled/legacy 终审全部闭合后，才从冻结 v3.2.2 候选继续。
- 在新 isolated worktree 从 `a5af61ea186e3a13a34bf6d70491de673dfc6915` 发起 natural merge，把正式发布的 `main@c547097c8829c1c39437fe9047b5accbf5f1e388` 作为第二父纳入真实祖先链；不 rebase、cherry-pick 或改写既有提交。
- 三份长发布文档同时保留 v3.2.2 capability、v3.2.1 已正式发布事实和 Issue #220 的发布后补测边界；不把 capability 或人工签字写成 production enabled。
- Windows 专用真实探针保留候选的 30 秒有界 CIM 预热，同时采用 v3.2.1 已验证的外层 `adapter` 作用域，确保 launch 失败后的 `finally` cleanup 不引用块内变量；产品 adapter 的默认 15 秒 fail-closed 上限不变。

### Assumptions

- 冻结 R3.2.2 snapshot 与 #184～#191 仍是候选功能基线的权威证据；本次传播不改 snapshot authority，但其旧 CI 不代偿新 exact head 的验证。
- `c547097c` 与 `a5af61ea` 的远端 refs 在推送、建 PR、合并和 tag 前保持不变；每个有副作用节点前重新读取远端事实。

### Deviations

- 原 closeout 文档记录的“人工门禁未通过、不得合并 main/tag”已被发布负责人后续明确验收与串行发布授权取代；自动测试仍不得代签人工结论，Windows 10/11、SmartScreen、离线覆盖和 `production/latest` canary 继续作为发布后补测。
- v3.2.1 最终发布不再等同原候选 `ea60a5c7`：PR #223 后的 main exact CI 暴露 MPT 共享 spool 父目录 cleanup 竞态，safe forward-fix PR #224 将最终 main 收口为 `c547097c`。本版必须传播该最终节点，不能沿用旧 `f6166c66` ancestry 叙述作为当前事实。
- natural merge 产生 4 个内容冲突：`CHANGELOG.md`、`docs/USER_GUIDE.md`、`docs/VERSION_FEATURE_HISTORY.md` 与 Windows startup adapter 测试。冲突均逐项组合；没有用整文件 ours/theirs 覆盖，也没有产品代码内容冲突。

### Evidence

- 远端冻结审计 `/private/tmp/bbet-v322-preflight-audit-20260904-064828.json` 为 `5284` bytes / SHA-256 `e53881609ecebca6d2295ca0e322d831968cf640a1b0433781209244f16964fd`：`main=c547097c`、candidate ref 精确指向 `a5af61ea`、package version `3.2.2`、共同祖先 `ea60a5c7`，且无开放 PR、`v3.2.2` tag 或 Release。
- natural merge commit `33f27a0b23c55759a12a44a46a1150350c449aaa` 的双亲精确为 `[a5af61ea186e3a13a34bf6d70491de673dfc6915, c547097c8829c1c39437fe9047b5accbf5f1e388]`；合并后的 `CHANGELOG.md / VERSION_FEATURE_HISTORY.md / USER_GUIDE.md` 行数分别为 `3128 / 2615 / 4069`，无冲突 marker 或截断提示。
- v3.2.1 MPT/恢复/Toolbox 修复相关源文件与 Windows adapter 测试在 merge commit 中逐字节等于 `c547097c` 对应版本；候选的 FundRecon、Duplicate、BankBU 功能树未因冲突处理改写。
- 使用 `/usr/local/bin/node` 的 official Node `v22.18.0` 与 exact lock 完成干净 `npm ci`；安装 `492` 个 package，依赖审计维持既有 `2 moderate / 9 high`，未执行 `npm audit fix`。此前误取 Desktop bundled Node 24 的准备尝试已中止，不作为任何验证证据。
- 最终聚焦组合（v3.2.0～v3.2.2 metadata、R3.2.2 authority、Windows startup adapter、v3.2.1 MPT/恢复/Toolbox 交集）为 `205 PASS / 0 FAIL / 3 Windows-only SKIP`；日志 `/private/tmp/bbet-v322-focused-final-20260904-070105.log` 为 `51388` bytes / SHA-256 `7c37bd494354244e0e6e52f41810e71339c74332688b3385d6ff0643c7038aaa`。
- 完整 unit 为 `6349/6352 PASS`、`0 FAIL`、`3 Windows-only SKIP`；官方日志 `logs/unit-tests/unit-20260904-070210.log`，wrapper stdout `/private/tmp/bbet-v322-unit-stdout-20260904-070210.log` 为 `1648588` bytes / SHA-256 `ed1897ffac41fada0fe71cd0cc664e01b1fcd148f296dbe2e2ab2d6ebc434a08`。
- 完整 integration 为 `53 scripts / 2488/2488 PASS`；stdout `/private/tmp/bbet-v322-integration-stdout-20260904-070332.log` 为 `10342` bytes / SHA-256 `04d7e2cd5f2596b9e636e7c936ce641d053138951590401a1c866679915eb2c7`。runner 的机械策略文档改写已用 `apply_patch` 恢复，`rules/integration-test-policy.md` SHA-256 仍为 `65716ba574d1139d72a1ca96f45ebaa4f85efa1f8ebf3f3bc81e8f0ce1edb74e` 且相对 HEAD 无 diff。
- `npm run smoke`、`npm run lint`、19 个候选变更 JS 的 `node --check` 与显式 ESLint、`git diff --check`、package/release-evidence JSON、三版冻结 Spec/TechDoc 字节、冲突/截断 marker、版本与双亲祖先检查均 PASS。smoke 日志 `/private/tmp/bbet-v322-smoke-20260904-070946.log` 为 `10328` bytes / SHA-256 `98d8559eaa142dae4a47ae094230fbd1c8305ee03b94bbaa07c011f3e264ab38`。
- R3.2.2 只读 validator 输出 `10` actions、`productionEnabledCount=0`、`commonRuntimeActionCount=6`、BankBU common-runtime registration `ABSENT_FAIL_CLOSED`。当前 policy 模块直接回读进一步确认全部 10 项均为 `enabled=false / effectiveMode=legacy / effectiveWorkerCount=0`；审计 `/private/tmp/bbet-v322-production-policy-readback-20260904-071438.json` 为 `4511` bytes / SHA-256 `4fc33ab601d859f214595db7f657952e1dbc4172eb1e6807024d526684358870`。
- `blindspot-pass` 与 `reconciliation-blindspot-pass` 沿真实入口、状态、receipt/inspector、部分提交、并发 cleanup、守恒和产物发布链复核，未发现改变方案的存活盲区或新增资金红线；审计 `/private/tmp/bbet-v322-prepr-blindspot-reconciliation-20260904-071640.json` 为 `2405` bytes / SHA-256 `8fe9f1e1af70b32fb2564a569d8fc8cc97a85a095302bd02c06362a8c9a17eca`。冻结 R3 snapshot 的历史人工字段保持原事实，不回写；当前发布授权来自发布负责人后续明确验收，Issue #220 项目仍是发布后补测。
- `check-vars` skill 以 `main@c547097c` 为基准只读扫描真实 PR `src` diff（65 个 JS），未运行 `npm run check:vars` 或 `scan:vars`。定义文件宽口径命中 `Critical 15 / Important-skeleton 4 / Runtime-state 11 / Risk-sensitive 13 / Minor 0`；直接语义命中集中在 Duplicate/FundRecon/BankBU 的服务、侧库、守恒与状态接线，逐项由上述 focused/unit/integration/smoke、冻结 R3 authority 和人工资金验收覆盖。审计 `/private/tmp/bbet-v322-check-vars-readonly-v2-20260904-071556.json` 为 `45667` bytes / SHA-256 `217eb6465c54af89b4bf723ff846514f74d7edb9567a6139806936f9671259ec`。
- 证据收口提交 `a0969ce499d2ccc518f28ced5ebda2d4073ad412` 的 clean HEAD `npm run check:packaged-inputs` PASS；日志 `/private/tmp/bbet-v322-clean-head-packaged-inputs-20260904-071803.log` 为 `187` bytes / SHA-256 `3f05eba40765133e8640510e85a88cdc64f41b355dde76e3d86faeb86cf64a97`，`build.files` 9 条覆盖范围与 HEAD 一致。

### Remaining Unknowns

- `CLOSED / local`：本次双亲组合后的 metadata、R3 authority、资金/恢复、Windows 合同、完整 unit/integration/smoke/lint、静态检查与 clean-HEAD packaged-inputs 均已在 official Node 22.18 exact-lock 上通过。
- `PROBE / exact CI`：普通非 force push 后必须由新 exact head 的 `smoke-test`、`build` 和关键步骤全部实际成功，并闭合 review threads；旧 CI 不代偿。
- `PROBE / tag 后`：最终 Windows Release 四项资产、公开下载、摘要与更新元数据只能在 immutable annotated tag workflow 产生后回读。
- `BLOCK / production`：application production 继续 disabled/legacy；本版不改变金额、币种、主键、Workbook、正式文件发布或恢复终态红线。
