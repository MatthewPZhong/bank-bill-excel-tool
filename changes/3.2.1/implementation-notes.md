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

### Remaining Unknowns

- `PROBE / merge validation`：冲突组合后的 recovery/topology/metadata 定向回归、完整 unit/integration/smoke、lint 与 diff review已通过；merge commit 后仍须以干净 HEAD 重跑 packaged inputs，旧版本绿灯不代偿。
- `PROBE / exact CI`：推送后必须由新 exact head 的 `smoke-test` 与 `build` 全部完成且成功，并闭合 review threads。
- `PROBE / tag 后`：最终 Windows Release 四项资产、公开下载、摘要与更新元数据只能在 immutable annotated tag workflow 产生后回读。
- `BLOCK / production`：本版不启用 application production；后续若需启用，必须另行提交、验证和授权。
