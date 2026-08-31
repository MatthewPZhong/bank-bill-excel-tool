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

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
