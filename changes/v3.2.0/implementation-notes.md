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

## 2026-09-03 PR #221 合并前审查收口

### Decisions

- 接受“确定性恢复完成后同源 active Hold 未解除”的审查意见。默认恢复链现在只在终态已同事务落库时解除同源 Hold：`not-committed` / `compensated` 与 Intent recovered→closed 同事务；无 settlement 的 `committed` 与 Intent close 同事务；有 settlement 的 source 只在 Provider 返回 `completed` 时与 Intent close 同事务。`incomplete`、瞬态失败、终止失败、未知或部分提交均继续保留 Hold。
- 自定义 `planTransitions` 仍拥有动作级 Hold 生命周期，通用 coordinator 不替动作 planner 自动解除，避免后续版本对资金/恢复动作的专用 transition 产生重复或提前解锁。
- “按 Action→legacy Task 保守阻断而非通用精确 scope 匹配”是 v3.2.0 的既定版本边界，不在本次审查中发明未来业务 scope 合同。v3.2.0 没有注册真实 production Inspector/Provider，所有相关 action 仍 `production.enabled=false`；本发布不宣称逐 scope production 闭环，该项继续作为未来 production enablement 的显式阻断条件。
- “首次 scan 早于建表”的审查意见不成立：对象参数按序构造 request-owner、observation-attempt 与 control 写仓库时会同步执行 schema ensure，之后才调用 `scanAndRecover()`。增加 fresh in-memory DB 回归测试固定这一真实构造顺序。

### Deviations

- 正式发布准备原计划仅改发布文档；PR 审查发现默认恢复链真实生命周期缺陷后，范围扩展为 coordinator 与同文件合同测试的最小修复。未修改业务 `src` 调用方、资金策略、production strategy、package/lock、冻结 schema/validator/snapshot 或 canonical R3 evidence。
- 首轮完整 unit 暴露既有 topology 测试直接依赖运行瞬间 `os.freemem()`：全套测试并发占用使可用内存短暂低于既有 2GB 闸值时，生产算法按合同从 2 降为 1，而测试仍硬编码期望 2。只在测试中固定 8GB 可用内存输入；生产内存闸、并行度算法及资金单写合同均未修改。

### Evidence

- `node --check` 覆盖 coordinator 与新增测试：PASS。
- `node --test tests/unit/main-process/background-execution/recovery-contract-c2.test.js`：`42/42 PASS`；新增 fresh DB 建表顺序以及 active same-source Hold 的五个确定性/非确定性分支。
- fresh DB 测试不调用产品 archive migration 或 canary schema helper，直接以空 `DatabaseSync(':memory:')` 构造 coordinator 并完成零 source scan，回读四张 recovery control 表。
- Hold 回归覆盖 critical Intent 的 `committed`、`not-committed`、`compensated`，以及 Provider 的 `completed` 与 `incomplete`；仅前三个 Intent 终态和 Provider `completed` 解除 Hold，`incomplete` 保持 active。
- 首轮完整 unit 为 `6025/6029`、`1 FAIL`、`3 SKIP`，失败仅为上述动态内存断言，不能记为 PASS；定向固定输入后该 topology 用例通过，仍须重跑完整 unit 才能形成有效全绿证据。
- 固定 topology 测试输入后，official Node `22.18.0` 与 exact lock 的完整 unit 为 `6026/6029 PASS`、`0 FAIL`、`3 Windows-only SKIP`；日志 `logs/unit-tests/unit-20260903-151055.log`。首轮失败日志 `logs/unit-tests/unit-20260903-150754.log` 仅保留为缺陷定位证据，不作通过证据。
- recovery contract 与 repository 组合回归 `81/81 PASS`；`background-execution-recovery-control` integration `27/27 PASS`，`background-execution-recovery-canary` integration `9/9 PASS`。
- 完整 integration 为 `51 scripts / 2455/2455 PASS`，完整 smoke 与 lint 通过；integration 对 `rules/integration-test-policy.md` 的机械更新已用 patch 恢复，最终 SHA-256 为 `b5238d88ed1c0b6e8bf4f6c98d9ff24daaa8e3cd573b2e951ea2486f5ac0b5d5`。
- 本次四文件修复 delta 对 `rules/important-variables.md` 做人工只读扫描，未直接命中 Critical/Important 命名变量；但 coordinator 属于恢复生命周期敏感路径，仍按资金/恢复高风险复核同源身份、expected state、同事务原子性、失败保留 Hold 与可观测事件。topology 变更仅固定测试输入，不改变生产内存闸。
- `git diff --check`、修改 JavaScript 的 `node --check` 与最终四文件 scope review 通过。依赖审计仍为已知 `2 moderate / 9 high`，未执行 `audit fix`。

### Remaining Unknowns

- `PROBE / exact CI`：本修复提交后必须由 PR #221 新 exact head 的 `smoke-test` 与 `build` 全部完成且成功；旧 exact CI 不代偿。
- `BLOCK / production`：通用精确 conflict-scope resolver 仍未建立；production 继续 disabled，不得把本次 Hold 生命周期修复解释为启用许可。
