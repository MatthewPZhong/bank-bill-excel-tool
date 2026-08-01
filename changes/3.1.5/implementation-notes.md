# v3.1.5 Implementation Notes

## Decisions

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | 保留 v3.1.4 tag，恢复版使用 v3.1.5 | 保持已推送 tag 的不可变审计历史；v3.1.4 无公开资产，不存在用户升级分叉 | active |
| D2 | 只修复测试 teardown，不改产品代码 | Windows 失败是 hook 顺序，不是产品断言；资金实现已完成复核 | active |
| D3 | 受影响测试加入 Windows PR job | 在新 tag 之前验证 Windows 文件锁语义 | active |
| D4 | Release 成功前版本文档保持 Unreleased | workflow 再次失败时不得提前宣称公开版本存在 | active |

## Assumptions

- A1：用户在“保留 v3.1.4、改走 v3.1.5”的推荐方案后要求继续，视为批准该恢复路径。
- A2：只要最终 diff 不含 `src/` 或业务配置，v3.1.4 的资金人工确认可沿用；任何后续业务 diff 都会使该假设失效并重新触发人工复核。
- A3：v3.1.3 仍是生产 latest，因此离线和在线升级 follow-up 的起点都是 v3.1.3。

## Evidence

- E1：v3.1.4 tag object 为 `fdab8bbbfe967ffed1fccbcde4614e53ee9f49f3`，peeled commit 为 `14a9ce9de1d5607fe3c4dc58ae3adf81defef611`。
- E2：Release run `30703982194` 在 `Run release checks` 失败；unit `4478/4481 PASS`、2 fail、1 skip。
- E3：失败用例在 `store.close()` 之前注册目录删除 hook；Windows 报 `EBUSY` 删除 `position-data.sqlite`。
- E4：v3.1.4 GitHub Release 不存在，workflow 未执行 build/publish，公开资产为 0。
- E5：修复后定向执行 `position-reconciliation-filtered-source-report.test.js` 为 `9/9 PASS`；更新/发布契约定向测试为 `42/42 PASS`。
- E6：`npm run release-check` 退出码 0：lint、smoke、unit `4481/4481`、44 个 integration 脚本 `2051/2051` 全部通过；integration 总耗时 297,087ms。
- E7：`npm run scan:vars` 为 263 个源文件、3,322 个顶层名称；版本 bump 已刷新统计报告。当前 diff 无 `src/`，`npm run check:vars -- --include-minor` 安全跳过。
- E8：`npm run verify:main-panel-alignment` 在受限桌面沙箱内返回 `electron exit null`；沙箱外按真实 Electron 路径重跑，两种窗口尺寸、三种缩放 `6/6 PASS`。
- E9：发布 workflow 继续强制 tag/version/main 三者一致、annotated tag、完整 release checks、更新资产 SHA-512 和不可替换 Release；v3.1.3 直接升级到稳定 SemVer v3.1.5 不需要中间 v3.1.4 资产。
- E10：通用与资金盲区扫描未发现入口旁路、状态生命周期、兼容性、行数守恒或资损新风险；最终实现 diff 不含 `src/`、schema、配置或资金测试期望。
- E11：PR #116 的 Windows Build run `30705791034` 成功，包含新增的 `Run Windows SQLite teardown regression`；Codex Review 对最终提交 `c665fb090d35e75f18ba37cea07ebe1be1cd0bcd` 未发现 major issue，GraphQL `review_threads=[]`。
- E12：PR #116 已以 merge commit `58bea9bb633930b73db13aee8174f5d989e0267e` 合入 `main`；main 候选 Windows run `30705981990` 成功完成 smoke、SQLite teardown、布局、Setup/portable 构建、包体、更新资产暂存和上传。
- E13：annotated tag `v3.1.5` 的 tag object 为 `6b6d7591423563c8f24cf35b81b6d33587ac3195`，peeled commit 与最新 main 均为 `58bea9bb633930b73db13aee8174f5d989e0267e`。
- E14：正式 Windows Release [run 30706152991](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30706152991) 全部成功；release checks 用时 26 分 25 秒，随后布局、构建、包体、更新资产、不可变发布和公开复核全部通过。
- E15：[v3.1.5 Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.5) 于 2026-08-02 00:01:11 +08:00 发布，stable/latest、non-draft、non-prerelease；四项资产均为 uploaded。
- E16：公开资产独立下载后 SHA-256/size 与 GitHub digest 完全一致：portable `afcc4917...9116f2` / 99,526,150；Setup `27a1be34...3b40ec` / 100,023,007；blockmap `75331686...8e7682` / 105,674；`latest.yml` `afad0c38...66ee31` / 369 bytes。
- E17：`latest.yml` 的 version `3.1.5`、path `bank-bill-excel-tool-setup-3.1.5.exe`、size `100023007` 和 SHA-512 `dFd2gBX3bL9fkWBvxvX1v0+/JKy3ny1tOVFOg5MHzgC3rPVGdrkpa/usovYskSpa8svGEtIp8NON7Y0WbCQTrQ==` 与实际 Setup 完全一致。

## Deviations

- 暂无。

## Remaining unknowns

- R1（resolved）：Windows PR 定向回归已在 run `30705791034` 通过。
- R2（resolved）：完整 Release workflow 已成功并产出、复核四项公开资产。
- R3（人工 follow-up）：Windows 10/11 安装、SmartScreen、离线/在线升级和用户数据保留仍未实测。

## Reconciliation blindspot pass

- 当前 diff 不含产品、数据库、金额、币种、方向、匹配、消费或输出实现；资金结果集合不变。
- v3.1.4 已确认的 409 条过滤审计、第三份调拨硬拒绝和真实候选结论继续作为发布门禁。
- 版本跳过 3.1.4 不改变 SQLite 迁移顺序：v3.1.5 资产包含 v3.1.3 之后的同一代码基线，updater 按稳定 SemVer 接受严格升版；v3.1.4 没有用户安装资产或独立数据状态需要兼容。
- 发布失败仍在构建/发布前关闭；文档在 Release 成功前保持 Unreleased，避免再次把 tag 误写成可下载版本。
- 如果 review 或 CI 修复需要改动 `src/`、数据库 schema、业务配置或测试期望，立即停止沿用该结论并重新执行完整资金盲区扫描与人工复核。
