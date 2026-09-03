# v3.2.1 Release Metadata Closeout — Implementation Notes

## Decisions

- 通过 merge commit 纳入最终 v3.2.0 metadata/docs closeout，保持版本链可审计；随后只在最终 v3.2.1 收口节点更新为 `3.2.1`。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不使用主工作区中与冻结来源不一致的旧 proposal。
- E04-C 第二 Writer gate 保持 rejected；Toolbox 只使用受管生成 Worker、单一 Writer/FIFO Publisher，不以“未实现”名义扩大写入拓扑。
- 文档区分 capability 与 effective production strategy；PreFund parser pool 的资源/性能 gate 未通过时生产保持 legacy/false。

## Assumptions

- #176～#183 的精确合并状态和 R3/R4 evidence 是功能完成的远端来源；本节点不替代对应 CI 或人工门禁。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。

## Evidence

- v3.2.0 closeout head `a7d9bf47` 已通过双父 merge commit `0a8ae056` 成为本分支真实祖先。
- package 三处版本一致性、v3.2.0/v3.2.1 顶层 Spec/TechDoc 冻结字节一致性、三份发布文档交叉校验与 `git diff --check`：PASS。
- v3.2.0/v3.2.1 metadata closeout 与既有 v3.1.14 发布文档定向组合：`16/16 PASS`。
- 干净 `npm ci` 后完整 unit：`6178/6181 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260831-135655.log`。
- 修改测试 ESLint、`node --check`、`git diff --check` 与本地 diff review：PASS；未发现 `src/`、production、资金/恢复合同或打包输入范围漂移。
- 提交后 `npm run check:packaged-inputs`：PASS，`build.files` 9 条覆盖范围与 HEAD 一致。
- 本地 commit review：最终 v3.2.0 收口通过双父 merge commit 成为真实祖先；v3.2.1 收口只含版本元数据、权威/发布文档与合同测试，无 `src/`、production、资金或恢复行为改动。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged/退出、PreFund 真实资金样本、金额/币种/文件顺序和恢复处置仍由 release owner/资金负责人确认。
- `BLOCK / production gate`：本节点不得启用 production，E04-C/E05-C 拒绝结论不被文档收口覆盖。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。

## 2026-09-03 正式发布准备

### Decisions

- 严格按 Issue #220 的 v3.2.0 → v3.2.5 顺序发布；v3.2.0 的 PR、annotated tag、Release workflow 与四项资产终审全部闭合后，才从冻结 v3.2.1 候选继续。
- 在新 isolated worktree 从 `ea60a5c7bdaaeeb5117d1c20be1f3df2ed4b0e38` 发起 natural merge，把正式发布的 `main@92380fd84471b061b7a84842be7da001aa82db87` 纳入真实祖先链；不 rebase、cherry-pick 或改写既有提交。
- 合并冲突按语义组合：三份发布文档保留 v3.2.1 capability，并同步 v3.2.0 已发布事实与 v3.2.1 发布授权；coordinator 完整保留 #221 已验证的确定性终态同事务关闭 Intent/解除同源 Hold 修复；topology 测试继续固定 8GB `os.freemem()`，不改生产内存算法。
- `docs/WINDOWS_RELEASE_RUNBOOK.md` 将 environment 条件纠正为唯一 custom tag policy `v*.*.*`，并记录 v3.2.0 首次 environment 拒绝、一次授权 rerun、最终成功与四资产摘要；该文档修正不改变 workflow 或服务端保护。
- application production 继续 disabled/legacy；E04-C 第二 Writer rejected 与 E05-C 未满足 gate 不因人工发布授权而解除。

### Assumptions

- `92380fd8` 与冻结候选的 Git 对象和远端 refs 在本轮预检后保持不变；推送、PR ready、合并和 tag 前均重新读取，不以本地状态代替远端事实。

### Deviations

- 原 metadata closeout 记录的“人工门禁未通过、不得合并 main/tag”已被发布负责人后续显式验收与 Issue #220 串行发布授权取代；自动测试仍不得代签人工结论，Windows 最终资产相关项目只转为发布后补测。
- natural merge 产生 5 个内容冲突：`CHANGELOG.md`、`docs/USER_GUIDE.md`、`docs/VERSION_FEATURE_HISTORY.md`、startup recovery coordinator 与 mature adapter topology 测试。冲突来自 v3.2.1 后续能力和 v3.2.0 发布准备在共同基线上同时演进，不通过选整侧丢弃任一版本语义。
- 首轮合并后定向回归发现 v3.2.1 已把无 settlement 的 committed Intent close 前移到 inspection 原子 transition，而 #221 补丁仍在第一次事务之后回读 `committed` 再 close/resolve；组合后 Intent 已是 `closed`，导致同源 active Hold 未解除。将默认 Hold resolution 与 v3.2.1 的即时 Intent close 放入同一 `writeAtomic` transition 列表，并移除已被前移语义覆盖的第二次 committed close。Provider settlement 与自定义 planner 路径不变。

### Evidence

- v3.2.0 PR #221 exact head `1f9168a083a85e1eeab07225eb453af5a9810587` 以双父 merge commit `92380fd84471b061b7a84842be7da001aa82db87` 合入；annotated tag object `8d7c85fdb73542c9c0564c2783e319fb7b8718db` peeled 后精确指向该 commit。
- Release run `33731833335` attempt 2 的全部步骤成功；最终远端审计 `/private/tmp/bbet-v320-release-final-remote-audit-20260903-193406.json` 为 `50655` bytes / SHA-256 `b27f2a732b6fad72d878e58775b7a463d2e7718c46aae7b4b43d1ccea8deeeb0`。
- 四项资产独立下载、大小/SHA-256、`latest.yml` version/path/size 与 Setup SHA-512 全部一致；本地资产审计 `/private/tmp/bbet-v320-release-asset-final-audit-20260903-194246.json` 为 `4551` bytes / SHA-256 `ce7062934b823d9af35a8320cd4c76ddfaaa17970f441f330aade27b26e8bb00`。
- v3.2.1 远端预检确认 `main=92380fd8`、候选远端 ref 精确、版本 `3.2.1`、无 `v3.2.1` tag/Release、无以 `main` 为 base 的开放 PR；审计 `/private/tmp/bbet-v321-release-preflight-audit-20260903-194442.json` 为 `777` bytes / SHA-256 `d83b9622423981299ff1d77c39ccf401675c02e2558a1cafa8c6ebcc3e4aa1c3`。
- 首轮五文件定向组合回归为 `66 pass / 3 fail`（Node 汇总把失败子测与父测同时计数）：真实缺陷仅 `critical intent committed` 留存 active Hold，另有 v3.2.0 USER_GUIDE 历史段缺“人工验收”合同词；该轮只作定位证据，不记 PASS。
- 修正后 recovery、mature adapter topology、v3.2.0/v3.2.1 metadata 与既有发布文档五文件组合回归为 `69/69 PASS`；其中 active same-source Hold 的 committed/not-committed/compensated、Provider completed/incomplete 分支全部通过。
- official Node.js `22.18.0` exact-lock 完整 unit 为 `6185/6188 PASS`、`0 FAIL`、`3 Windows-only SKIP`；日志 `/private/tmp/bbet-v321-release-prep.lLgHBo/worktree/logs/unit-tests/unit-20260903-195605.log`。
- official Node.js `22.18.0` exact-lock 完整 integration 为 `51 scripts / 2455/2455 PASS`；其中大文件真实链 `toolbox-large-file-stream=50/50`、`toolbox-large-split-multi-sheet=31/31`。runner 的耗时表机械改写已用 `apply_patch` 恢复，`rules/integration-test-policy.md` 回到原 SHA-256 `65716ba574d1139d72a1ca96f45ebaa4f85efa1f8ebf3f3bc81e8f0ce1edb74e`。
- `npm run smoke`、`npm run lint`、相对冻结候选的 `5` 个 changed JavaScript 文件 `node --check` 与定向 ESLint、版本三处 `3.2.1` 一致性、JSON/diff/conflict-marker 检查均通过；相对候选没有 changed JSON。
- production 冻结回读覆盖 `4` 个 mature action gates、`5` 个 v3.2.1 runtime policies 与 `2` 个 canary policies：`11/11 enabled=false`、`11/11 effectiveMode=legacy`，runtime/canary effective worker 均为 `0`；未修改 feature flag 或生产选择器。
- 资金/恢复盲区复核：本次组合不触及金额、币种、业务主键、Workbook 或正式文件发布；同源 Hold 只在确定性 committed/not-committed/compensated 或 Provider completed 终态解除，unknown/partial/Provider incomplete/失败继续 fail-closed；Intent 终态、inspection observation 与 Hold resolution 共用一次 `writeAtomic`，定向测试同时核对持久状态和唯一 `hold-resolved` 事件。
- 提交前 `npm run check:packaged-inputs` 按合同拒绝尚未成为 HEAD 的两个 tracked dirty 打包输入（`docs/USER_GUIDE.md`、startup recovery coordinator）；该结果不记 PASS，必须在 merge commit 后以干净 HEAD 重跑并通过。
- natural merge commit `6930f1791c94b7baa1bf07db698af2fa48955649` 的双亲精确为 `[ea60a5c7bdaaeeb5117d1c20be1f3df2ed4b0e38, 92380fd84471b061b7a84842be7da001aa82db87]`；提交后干净 HEAD 的 `npm run check:packaged-inputs` 已通过，`build.files` `9` 条覆盖范围与 HEAD 一致。

### Remaining Unknowns

- `CLOSED / merge validation`：冲突组合后的 recovery/topology/metadata 定向回归、完整 unit/integration/smoke、lint、diff review 与 merge commit 后干净 HEAD packaged inputs 均已通过；旧版本绿灯未用于代偿。
- `PROBE / exact CI`：推送后必须由新 exact head 的 `smoke-test` 与 `build` 全部完成且成功，并闭合 review threads。
- `PROBE / tag 后`：最终 Windows Release 四项资产、公开下载、摘要与更新元数据只能在 immutable annotated tag workflow 产生后回读。
- `BLOCK / production`：本版不启用 application production；后续若需启用，必须另行提交、验证和授权。

## 2026-09-03 exact CI 与 review 收口

### Decisions

- 保留 `scripts/startup-process-adapter.js` 的生产默认 `15000ms` fail-closed 上限；只在 Windows 专用真实语义测试中先用 `30000ms` 完成一次有界 CIM 预热，随后仍由默认生产 adapter 验证 launch、token、graceful 与 force-cleanup 全链路。
- Hold 入口预检只为成功读取且 header identity 有效的 MPT 文件推导 exact batch scope；无法识别的文件继续进入既有逐文件 import/repair 路径形成失败，不再提前中断同批有效文件。
- 可识别 identity 的 Hold 仍在 prepare/beforeStart 检查；legacy 写入前 `identityGate` 与 managed Writer 持久 ACK 前 scope gate 均保持不变，未知 identity 不获得写入旁路。

### Deviations

- 首次 exact Windows CI 暴露 hosted runner 的 CIM 首次唤醒可恰好超过生产 15 秒边界；该失败只修复专用测试夹具，不放宽生产超时或 cleanup 证明。
- PR review 发现 Hold scope 预计算会把单文件 filename/header/read 失败升级为整批 prepare 失败，偏离 Spec 已冻结的 mixed-result/per-file failure 语义；因此在原计划的测试夹具修复外增加最小 Hold 预检修复与回归测试。
- 首轮新增回归确认 `readMptHeader()` 虽可被调用方捕获，`stream.pipe()` 不会自动传播 raw source 的 `ENOENT`，仍产生额外 `uncaughtException`；增加只把 source error 沿 hashing/gunzip 链转交最终 async iterator 的归一化，不改变 parser 成功路径、hash、行解析或业务校验。

### Evidence

- PR #222 首次 exact CI run `33753987239`：`smoke-test` job `100643862345` 为 FAILURE，`build` job `100644374079` 按门禁 SKIPPED；完整日志 `/private/tmp/bbet-v321-pr222-exact-smoke-failure-33753987239-100643862345-20260903-2018.log` 为 `66950` bytes / SHA-256 `38a254101a0d036def576bc5a770b0ef9c74cbf0fe299729b783b1621437d0d4`。唯一失败为 Windows 真实 snapshot 在约 `15009ms` 触发 `PROCESS_SNAPSHOT_TIMEOUT`，不得由本地绿灯代偿。
- 修复前远端复核确认 `main=92380fd84471b061b7a84842be7da001aa82db87`、PR head `b250ad2544bef0f8cf66a814911d1fa2ffd22a37`、OPEN/non-draft/MERGEABLE；review thread `PRRT_kwDORiHOzM6e6Quj` 未解。审计 `/private/tmp/bbet-v321-pr-remediation-preflight-audit-20260903-203302.json` 为 `2198` bytes / SHA-256 `f308c967041a11083aa2b06fdb0d15502d53925d3c35ccc6bc94a1797d40d8ac`。
- 首轮定向回归为 `58 pass / 2 fail / 3 skip`；两项失败均是新增 missing-source 用例捕获到同一个底层 raw stream `ENOENT` 仍以 `uncaughtException` 外溢。该轮只作定位证据，不记 PASS。
- 修正 raw source error 传递后，Windows adapter/contract 与 MPT mixed import/repair 定向组合为 `60 pass / 0 fail / 3 Windows-only skip`；完整 MPT parser/import/receipt/mixed-file 组合为 `134/134 PASS`。
- official Node.js `22.18.0` exact-lock 完整 unit 为 `6187/6190 PASS`、`0 FAIL`、`3 Windows-only SKIP`；日志 `/private/tmp/bbet-v321-release-prep.lLgHBo/worktree/logs/unit-tests/unit-20260903-204509.log`。
- official Node.js `22.18.0` exact-lock 完整 integration 为 `51 scripts / 2455/2455 PASS`；其中 `toolbox-large-file-stream=50/50`、`toolbox-large-split-multi-sheet=31/31`。runner 机械改写已用 `apply_patch` 恢复，`rules/integration-test-policy.md` 精确回到 SHA-256 `65716ba574d1139d72a1ca96f45ebaa4f85efa1f8ebf3f3bc81e8f0ce1edb74e`。
- `npm run smoke`、`npm run lint`、本轮 `4` 个 changed JavaScript 文件的 `node --check` 与定向 ESLint、`git diff --check`、版本三处 `3.2.1`、冲突标记扫描和 `package.json` / `package-lock.json` / workflow / 生产 adapter 冻结检查均通过。
- 修复提交 `c44bc81c6e084379f63e0b3da4e7390c3f64ec7a` 创建后，干净 HEAD 的 `npm run check:packaged-inputs` 通过，`build.files` `9` 条覆盖范围与 HEAD 一致。
- 资金/恢复盲区复核：本轮不改变业务主键、金额、币种、行序、Workbook 或正式文件发布；不可识别文件只跳过只读 scope 预计算，仍形成逐文件失败且不获得 mutation 权限；可识别文件写入前继续经过 actual-header identity gate。repair 缺失源 token 保留，可读成功 token 仅在成功终态删除；回归同时证明同批有效文件继续、identity mismatch 仍拒绝、无跨 scope 写入。

### Remaining Unknowns

- `CLOSED / local`：新增 mixed import/repair token 生命周期、Windows adapter/contract、完整 unit/integration/smoke/lint、语法/ESLint、版本/冻结/diff 与提交后干净 HEAD packaged-inputs 均已通过。
- `PROBE / exact CI`：普通非 force push 后必须由新 exact head 的 `smoke-test` 与 `build` 全部成功，首次失败永不视为被重复或本地成功代偿。
- `BLOCK / review`：review thread 在代码、回归证据和新 exact head 建立前不得回复或 resolve。
- `BLOCK / production`：application production 继续 disabled/legacy；本轮不改变资金主键、金额、币种、Workbook 输出或恢复终态红线。
