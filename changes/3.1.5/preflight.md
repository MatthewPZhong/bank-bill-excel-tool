# v3.1.5 Preflight — v3.1.4 Windows Release 恢复

## Goal / Context / Constraints / Done when

- Goal：在不改写 v3.1.4 tag、不改变产品和资金逻辑的前提下，修复 Windows 发布门禁并产出可公开升级的 v3.1.5。
- Context：v3.1.4 annotated tag 已推送；Release run `30703982194` 在构建前因两处测试 cleanup hook 的 SQLite 文件锁失败，无 GitHub Release、无公开资产。
- Constraints：v3.1.4 tag 保留作审计；只修改测试资源回收、Windows PR 门禁、版本号和发布文档；原资金人工确认继续有效，但 Windows 实机 follow-up 不得冒充已通过。
- Done when：v3.1.5 PR 的 Windows 定向回归与完整门禁通过，Codex Review 无 P3 或更高 Finding，合并后 annotated tag 触发 Release 成功，四项资产与 `latest.yml` 核对完成，并回写发布证据。

## Unknowns Register

| ID | Class | Unknown | Resolution | Evidence / Gate |
|---|---|---|---|---|
| U1 | BLOCK → resolved | 是否移动/删除 v3.1.4 tag，还是使用新版本恢复 | 用户在推荐方案说明后要求继续；采用 v3.1.5，保留失败 tag | 当前任务决定；tag object/Release 查询 |
| U2 | PROBE → resolved | Windows 失败是否来自产品断言或测试资源回收 | 两项均为 `hookFailed` / `EBUSY`，断言未失败 | run `30703982194` 日志与测试源码 |
| U3 | PROBE → resolved | 如何在新 tag 前获得 Windows 证据 | 将受影响测试文件加入 `build-windows.yml` 的 PR job | PR Windows check 必须通过 |
| U4 | ASSUME | 原资金人工复核是否需要重做 | 本恢复不改 `src`、数据契约或候选结果，沿用已确认资金结论 | git diff 不得含业务实现；reconciliation blindspot pass |
| U5 | PROBE | 公开版本记录如何避免宣称 v3.1.4 已发布 | v3.1.4 记录为 Not released，全部功能归入 v3.1.5 | 三份版本文档同步检查 |

## Risk-ordered execution

1. 先修复 teardown 并在 Windows PR job 复现验证。
2. 再执行本地定向、完整 `release-check`、变量和发布契约门禁。
3. PR 复核与合并完成后才创建 annotated tag。
4. Release 成功后核对公开资产，最后回写正式日期和证据。
