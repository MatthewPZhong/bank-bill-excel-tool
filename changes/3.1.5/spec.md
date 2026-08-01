# v3.1.5 Spec — v3.1.4 Windows Release 恢复

> status: `released`
> baseline: `main@14a9ce9de1d5607fe3c4dc58ae3adf81defef611`
> target-version: `3.1.5`
> branch: `codex/v3.1.5-release-recovery`
> updated: `2026-08-02`

## 1. 目标

v3.1.4 的产品实现和发布准备已经合并，但 tag 触发的 Windows Release 在产物构建前因测试临时 SQLite 文件锁失败。v3.1.5 用新版本恢复同一正式发布，不移动或删除 v3.1.4 tag。

## 2. 行为契约

- v3.1.5 完整承接 `changes/3.1.4/spec.md` 的用户功能和资金契约。
- 产品代码、数据库 schema、导入过滤、匹配、金额、币种、方向、FundType、严格 1:1 消费及确认流程均不修改。
- 两处受影响测试必须先关闭 `PositionReconciliationStore`，再删除临时目录。
- Windows PR workflow 必须定向执行 `position-reconciliation-filtered-source-report.test.js`，在 tag 前暴露同类文件锁回归。
- v3.1.4 记为未发布：有 annotated tag，无 GitHub Release，无公开资产；不得移动 tag 或补发同版本资产。
- 三份对外版本文档将功能实际交付版本记为 v3.1.5；Release 成功前保持 Unreleased/未发布。

## 3. 非目标

- 不修复或调整任何平盘业务逻辑。
- 不升级依赖，不改变 updater、安装器或数据库迁移。
- 不把 Windows 10/11 Setup/portable/SmartScreen、离线覆盖或 production/latest canary 记为已实测。
- 不删除 v3.1.4 tag 或伪造 v3.1.4 Release。

## 4. 验收

- 本地定向测试和完整 `npm run release-check` 通过。
- `npm run scan:vars`、`npm run check:vars` 和发布契约测试完成。
- PR Windows job 中新增的 SQLite teardown 定向测试通过。
- Codex Review 对最新提交无 P3 或更高 Finding，全部线程关闭后合并。
- annotated tag `v3.1.5` 指向合并后的最新 `main`。
- Release workflow 成功；Release 为 stable/latest、non-draft、non-prerelease，并包含 Setup、Setup blockmap、portable、`latest.yml`。
- 资产文件名、版本、大小、SHA-256 与 `latest.yml` 引用核对后，发布证据回写三份版本文档及本迭代记录。

## 5. 人工门禁与 follow-up

2026-08-01 已完成的资金业务确认继续适用于本版，因为恢复 diff 不触及产品或资金代码。此前明确豁免的 Windows 实机项仍保持“未执行”：正式资产公开后补做 `v3.1.3 → v3.1.5` 离线覆盖、Windows 10/11 启动/SmartScreen、大报告恢复、进程硬退出与 production/latest 在线升级 canary。

## 6. 发布结果

- PR #116 已以 merge commit `58bea9bb633930b73db13aee8174f5d989e0267e` 合入 `main`；Codex Review 覆盖最终提交 `c665fb090d35e75f18ba37cea07ebe1be1cd0bcd`，无 review thread 或 P3 及更高 Finding。
- annotated tag `v3.1.5` 的 tag object 为 `6b6d7591423563c8f24cf35b81b6d33587ac3195`，peeled commit 为 `58bea9bb633930b73db13aee8174f5d989e0267e`。
- Windows Release [run 30706152991](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30706152991) 全部成功；2026-08-02 00:01:11 +08:00 发布 stable/latest、non-draft、non-prerelease [v3.1.5](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.5)。
- Setup、Setup blockmap、portable 和 `latest.yml` 四项资产均已独立下载并核对大小、SHA-256；`latest.yml` 对 Setup 的 version/path/size/SHA-512 与实际字节一致。
