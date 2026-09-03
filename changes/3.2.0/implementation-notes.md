# v3.2.0 Release Metadata Closeout — Implementation Notes

## Decisions

- 版本元数据只在最终 v3.2.0 分支收口为 `3.2.0`，后续版本分别在各自最终收口节点更新。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不使用主工作区中与冻结来源不一致的旧 proposal。
- 文档区分“能力已实现并有证据”与“production 已启用”；后者保持 false。
- v3.1.14 历史发布测试继续锁定其 section、tag 和资产证据，但当前 package/USER_GUIDE header 允许推进到一致的稳定版本。

## Assumptions

- #168～#175 的精确合并状态和 R3/R4 evidence 是功能完成的远端来源；本节点不替代对应 CI 或人工门禁。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。

## Evidence

- package 三处版本一致性、顶层 Spec/TechDoc 冻结字节一致性、三份发布文档交叉校验与 `git diff --check`：PASS。
- `tests/unit/scripts/v3-2-0-release-metadata-closeout.test.js` 与既有 `tests/unit/vcc-financial-op-release-docs.test.js`：`15/15 PASS`。
- 首轮定向测试发现 USER_GUIDE 的 v3.2.0 历史摘要未显式承诺 Excel/Workbook 输出合同不变；补齐该兼容性文案后复跑通过。首轮 `14/15` 只作为修复证据，不记 PASS。
- 干净 `npm ci` 后完整 unit：`6019/6022 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260831-135019.log`。
- 修改测试文件 ESLint、`node --check`、`git diff --check` 与本地 diff review：PASS；未发现 `src/`、production、资金/恢复合同或打包输入范围漂移。
- 提交后 `npm run check:packaged-inputs`：PASS，`build.files` 9 条覆盖范围与 HEAD 一致。
- 本地 commit review：提交唯一父为最终 v3.2.0 `9b9887c1`，只含版本元数据、权威/发布文档与合同测试；无 `src/`、production、资金或恢复行为改动。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged 行为、VCC OP 真实样本及资金/恢复边界仍由 release owner/业务负责人确认。
- `BLOCK / production gate`：本节点不得启用 production。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。

## 2026-09-03 正式发布准备

### Decisions

- 采用 Issue #220 的稳定授权，严格按 v3.2.0 → v3.2.5 串行发布；每版只有在受保护 PR checks、annotated tag workflow 和四项资产回读全部完成后才进入下一版。
- 本提交只同步发布文档、实施记录和文档合同测试，不修改 `src/`、版本号、Release workflow、冻结 R3 evidence 或 production strategy。
- 发布负责人明确确认资金、恢复、真实业务样本及稳定窗口人工验收通过；最终发布资产产生后才能完成的 Windows 10/11、SmartScreen、离线覆盖与在线 canary 仍按 Issue #220 的发布前豁免补做。

### Evidence

- GitHub `main` 已要求 PR、严格 `smoke-test`/`build`、禁止 force/delete 且管理员受约束；`v*` tag 创建与不可变 ruleset、`production-release` required reviewer 已启用并回读。
- Issue #220 已记录批准人、exact 候选、生产禁用边界、串行冻结、失败规则和发布后计划。
- 按 `check-vars` skill 对 `main@b7abc2fa` 到候选 `a7d9bf47` 的 `src/` diff 做只读条目扫描；命中 `freezeWorkerBatchContext`、`TaskLifecycle`、`TaskPolicyRegistry`、Electron `app` 与 `VALID_DIRECTION_IN`。`state` 仅命中新后台模块的局部字段/函数，`src/renderer.js` 零 diff，判定为同名误报。未运行本地 `npm run check:vars` 或 `npm run scan:vars`，也不将其记为 PASS。
- 关联功能复核：exact-seven batch context 仍由原 authority 严格校验；VCC save 的 Task owner 来自 Main lifecycle 且 `recovery-required` 只转入既有失败终态；action/task inventory 不允许 caller replacement；方向常量仍为既有“入/出”，行级校验被提取为 legacy/worker 共用实现；packaged canary 在普通窗口、用户数据库和业务 IPC 前隔离退出，普通启动/退出 hooks 保留。上述路径由冻结候选既有的 lifecycle/protocol/VCC/parser/startup/packaged 测试覆盖，并要求本次 exact PR 的 `smoke-test` 与 `build` 重新全绿。
- `blindspot-pass` 合并前复核覆盖入口旁路、tag/main 冻结、失败停止、状态生命周期、兼容性、可观测性与测试缺口：发布只能经受保护 PR、唯一 annotated tag 与 required-reviewer environment；任一漂移或失败停止且不替换不可变资产；production 继续 legacy/disabled；最终 Windows 资产相关缺口仅按 Issue #220 的显式发布前豁免转为发布后补测，未被自动证据代偿。

### Remaining Unknowns

- `PROBE / tag 后`：最终 Windows Release 四项资产、公开下载、摘要及更新元数据只能在 tag workflow 产生资产后回读。
- `BLOCK / production`：本发布不启用 application production；若后续需要启用，必须另行提交、验证和授权。
