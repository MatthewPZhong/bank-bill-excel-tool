# bank-bill-excel-tool 3.1.5 PRD

> 目标版本：`3.1.5`
> 状态：review-ready
> 源规格：`changes/3.1.5/spec.md`
> 更新时间：2026-08-01

## 1. 版本目标

v3.1.5 是 v3.1.4 的安全恢复发布。v3.1.4 的 Windows Release 在构建前因测试 SQLite 临时文件锁失败，没有 GitHub Release 或公开资产；本版保留原 tag 审计历史，以新版本交付已完成人工资金复核的平盘异常行过滤功能。

## 2. 用户功能

用户功能、数据契约与资金边界完整沿用 `docs/iterations/v3.1.4/PRD-v3.1.4.md`：调拨/测试付款白名单异常行自动过滤，正常行继续落库；异常报告可立即导出并从存档中心下载；结果确认页提供运行过滤数据导出。

## 3. 恢复改动

- 两处单元测试先关闭 `PositionReconciliationStore`，再删除临时目录。
- Windows PR workflow 增加受影响测试文件的定向执行。
- 应用版本升为 3.1.5，公开文档将实际交付版本同步为 v3.1.5。
- 不修改 `src/`、数据库、安装器/updater 或资金逻辑。

## 4. 发布标准

完整门禁、Windows PR 定向测试和 Codex Review 无 P3 Finding 后合并；annotated tag `v3.1.5` 必须指向最新 `main`。Release 成功后核对 Setup、blockmap、portable、`latest.yml` 四项资产，再回写正式发布日期和摘要。

Windows 10/11 启动/SmartScreen、`v3.1.3 → v3.1.5` 离线覆盖、真实用户数据保留和 production/latest 在线升级 canary 仍是发布后人工 follow-up，不记为已通过。
