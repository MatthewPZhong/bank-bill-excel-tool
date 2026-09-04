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

## 2026-09-04 P2 Review Remediation

### Decisions

- 对 `PRRT_kwDORiHOzM6fHT10` 不新增 coordinator dispatcher：只读调用链确认 Duplicate Worker 从不发布 Platform `critical:ready`/`commit:receipt`，零 business-unit Service command 的持久事实由既有 E07-B side receipt、Main mirror与startup inspector闭环；真实 native runtime 回归改为显式断言四个 coordinator hook 调用数均为 0。
- 对 `PRRT_kwDORiHOzM6fHT15` 修复真实 FilePlan 缺口：managed export拒绝顶层正式 `savePath`，只接受 version 1 task-private `stagingPlan` 的单一 `{ artifactKey, stagingPath }` 输出，并把同一 `artifactKey` 原样写入 artifact manifest。
- 写入前同时验证绝对路径、lexical containment、由 Main 预先分配且已存在的普通非符号链接 staging root/父目录、physical parent realpath containment与target absence；Worker不递归创建目录，既有普通文件、符号链接和 dangling symlink 均不能被覆盖，拒绝中间符号链接时也不会在外部产生目录副作用。
- Writer 或 hash 失败只删除已验证的 staging leaf，不递归删除 Main-owned task root；cleanup失败以 `DUPLICATE_EXPORT_STAGING_CLEANUP_FAILED` 报告并保留原错误 cause。

### Deviations

- 评审最初建议按 action/module 增加公共 coordinator dispatch；真实事件流证明该失败前提不可达，且冻结 E07-B 使用模块内 receipt/recovery。为避免无证据扩成公共协议重构，本次只增加显式零调用回归与评审证据说明。
- 原 managed artifact 固定使用 `duplicate-result`；task-private FilePlan 接入后改为透传 plan 的唯一 `artifactKey`，从而允许 Main 按冻结 output identity 精确 join，输出内容与 Workbook 语义不变。

### Evidence

- 授权后远端防漂移审计 `/private/tmp/bbet-v322-pr225-authorized-preedit-audit-20260904-011455.json`：`3023` bytes / SHA-256 `4eb6634cb6e2e047ceeb763c7c38bc1f0952f00c6773e90271ea5aa69f4b05c7`；main/base/head、两条未解决 review、成功的两项 exact contexts 与缺失 tag/Release 均无漂移。
- 首轮 focused：`managed-service.test.js` + `runtime.test.js` 为 `12/12 PASS`；覆盖 task-private 成功输出、正式路径/lexical escape/既有target拒绝、physical symlink escape、失败清理与cleanup双重错误，以及真实 native Worker 的 coordinator hooks 零调用。
- 完整 Duplicate 邻接 unit（模块全部测试 + UI/preload/IPC wiring）为 `128/128 PASS`；覆盖真实 XLSX staging 输出、artifact hash失败清理、paired parser、side receipt/Main mirror/startup inspector、service generation/crash/close 与原金额/币种/匹配/行数守恒合同。

### Remaining Unknowns

- `PROBE / local`：仍需完成 Duplicate/Platform 邻接、完整 unit/integration/smoke/lint、changed JS、diff与clean-HEAD packaged-inputs。
- `PROBE / exact CI`：补丁 ordinary non-force push 后必须取得新 exact smoke/build与关键步骤成功；旧 `b05e4bce` 绿灯不代偿。
- `BLOCK / review`：两条 thread 在逐项证据回复并 resolved 前继续禁止 merge/tag/Release。
- `BLOCK / production`：application production 继续 disabled/legacy；本补丁不接 live managed export、Publisher 或用户正式目标。

## 2026-09-04 指定会话修复纳入 v3.2.2

### Decisions

- 会话 `01a06168-1d95-7cf3-9be1-63d1513956ff` 的修复当时存在于工作区但没有形成当前分支可传播的提交；本次依据原始操作记录逐项复核当前调用链后，在 PR #225 同一隔离分支重新实现并测试。
- 普通 no-file task 没有模块 `beforeStart` 时返回 `{}`，同时保留最终 `assertTaskPolicyNotHeld(policy, prepared)`；不放宽 TaskLifecycle 对非法 evidence 的拒绝。
- `file:save-balance-seed` 继续是 eager File Task。FilePlan 输入依次使用 freshness 路径、`importContext.inputFilePaths`、当前 statement session entry；全部缺失时在 execute/写盘前返回 `BALANCE_SEED_SOURCE_MISSING`。
- active 与 legacy 余额弹窗都在局部包装 IPC：异常或非法返回会显示错误、保留日期/余额草稿，提交期间禁用完成按钮；覆盖确认继续只提交 opaque `contextId + confirmOverwrite`。

### Evidence

- 原始会话 summary 与 JSONL 操作记录确认两项根因、实际修改文件和测试边界；当前 head 的源码核验确认修复尚未完整进入 ancestry，因而不是文档性声明。
- 纳入后首轮 official Node 22.18 聚焦组合（TaskLifecycle/policy、interactive preflight、Duplicate managed/runtime）为 `104/104 PASS`；包含 no-file evidence、内存 session source fallback、余额字符串 `0` 写盘、opaque confirmation 和两个 renderer 失败反馈合同。
- 纳入前的 official Node 22.18 完整 unit 基线为 `6352/6355 PASS`、`0 FAIL`、`3 Windows-only SKIP`，日志 `logs/unit-tests/unit-20260904-092611.log`；由于指定会话代码随后加入，该结果只作基线，不能代偿最终完整验证。

### Remaining Unknowns

- `PROBE / local`：指定会话修复加入后必须重新跑完整 unit/integration/smoke/lint 和发布文档/变量/资金盲区检查。
- `PROBE / live`：真实 Electron 窗口需在发布后重启，再由用户自行用账单文件验证模板重命名与余额补录；本次不代写真实余额。
- `BLOCK / production`：上述修复不改变 v3.2.2 application production disabled/legacy 边界。

## 2026-09-04 最终本地收口

### Decisions

- 盲区复核发现原 staging 实现会在 physical containment 校验前递归创建父目录；若中间路径是指向外部的符号链接，拒绝前可能产生越界目录。最终实现改为只接受 Main 已预先分配且存在的普通 staging root/父目录，Worker 不创建目录，只创建 FilePlan 叶子文件。
- `prepareDuplicateExportStaging` 在构造或采用业务 Service 前完成路径验证；非法 FilePlan 不触发 Service 初始化。新增“符号链接后接缺失目录”的回归，证明外部目录零创建。

### Deviations

- 首次完整 unit 因把 `docs/USER_GUIDE.md` 的冻结发布段落直接改写而触发 1 个 metadata closeout 失败（`6353/6357`，日志 `unit-20260904-093311.log`）。该偏差不是产品失败；发布段落已恢复逐字冻结，仅在其前新增修复说明，定向 metadata 测试随后通过。最终全量结果以下方新日志为准，失败轮次不作绿灯代偿。
- 一次 changed-JS shell 检查在 zsh 中把多行文件名拼成一个参数而失败；源码全量 lint 已在该命令前通过。随后改为逐行读取，9 个改动 JavaScript 的 `node --check` 全部通过，ESLint 为 0 error；`renderer.js` 与 `renderer-dialogs.js` 仅因仓库既有 ignore 规则各产生 1 个 warning。

### Evidence

- 最终 official Node `v22.18.0` unit：`6354/6357 PASS`、`0 FAIL`、`3 Windows-only SKIP`；日志 `logs/unit-tests/unit-20260904-095151.log` 为 `1649976` bytes / SHA-256 `343f0b811583e4efb457d6f264943621c213627038114f4df72d7928894784cf`。
- 最终 integration：`53/53` scripts、`2488/2488` assertions、`0 FAIL`；包含 `duplicate-inbound-match-end-to-end` `31/31`。runner 临时同步后已用 `apply_patch` 恢复冻结 `rules/integration-test-policy.md`，SHA-256 精确为 `65716ba574d1139d72a1ca96f45ebaa4f85efa1f8ebf3f3bc81e8f0ce1edb74e` 且相对 HEAD 无 diff。
- `npm run smoke`、`npm run lint`、9 个 changed JS `node --check`、逐文件 ESLint 和 `git diff --check` 均通过。
- 本地验证审计 `/private/tmp/bbet-v322-final-local-verification-20260904-100002.json`：`1837` bytes / SHA-256 `459079360702ae63605c8f5c9d111324a1debee5307aa875176926e13760b6a7`。
- check-vars 只读审计 `/private/tmp/bbet-v322-check-vars-readonly-final-20260904-100002.json`：`2270` bytes / SHA-256 `1d5bb9f190343cbe0d6897b4d6607f6b4095af1c1c413447db84674824f75781`；命中 Important-skeleton `TaskLifecycle`、Runtime-state `statementImportSessions/lastFileImportContext`、Risk-sensitive `normalizeInputFilePaths` 与 Duplicate Service 邻接、Minor `getStatementSessionEntries`，均已逐项复核。
- blindspot/reconciliation 审计 `/private/tmp/bbet-v322-blindspot-reconciliation-final-20260904-100002.json`：`2534` bytes / SHA-256 `ea1bde227a1499f4dc2cb79ca11c85bfea3dc0abfe661dc5db2a09f91d3768c8`；金额、币种、借贷方向、匹配键、行数/去向与正式发布门均未变化，`fundLossRedLine=false`。
- 本地严格未运行 `npm run release-check`、`npm run check:vars` 或 `npm run scan:vars`。
- 产品/测试/发布文档提交 `ee77d27a702c92dc4ec5a5e2114b2bfee9c652e5`，直接父为 PR #225 旧 exact head `b05e4bcea3ab7cf7ab0508a1666059ca861579d2`；commit message 不含 AI 标记。该提交的 clean HEAD `npm run check:packaged-inputs` 通过。

### Remaining Unknowns

- `CLOSED / local`：最终 unit/integration/smoke/lint、changed JS、diff、重要变量与资金盲区均已闭合。
- `CLOSED / clean HEAD`：产品/测试/文档提交后的 `npm run check:packaged-inputs` 已通过；本 evidence follow-up 提交后将再次运行，确保最终 exact HEAD 同样干净且被 build.files 覆盖。
- `PROBE / remote`：ordinary non-force push 后必须由新 exact head 的 PR smoke/build、四个关键步骤与 review threads 全部闭合；合并后 main exact 也必须重新成功。
- `PROBE / live`：真实 Electron 模板重命名与余额 `0` 补录由用户在安装 v3.2.2 并重启后验证；Windows 补测继续由 Issue #220 跟踪。
- `BLOCK / production`：application production 保持 disabled/legacy，不因本地或 CI 绿灯启用。
