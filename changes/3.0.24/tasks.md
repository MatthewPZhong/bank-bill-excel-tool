# Tasks — v3.0.24 平盘对账前端与 Payment 多大账号支持

## Task 1 — 规格与风险基线
- 目标：固化前端占位边界、配置兼容、严格分隔和同账号匹配不变量。
- 验证：四份迭代文档一致。
- 状态：completed

## Task 2 — Payment 多账号
- 目标：扩展 UI 校验和引擎账号分桶，保留原 schema 与三轮 1:1 行为。
- 验证：IN-01～IN-08、ENG-01～ENG-12。
- 状态：completed

## Task 3 — 平盘对账前端模块
- 目标：注册闲置模块、复用两行页面、接五个占位按钮和 preview。
- 验证：UI-01～UI-10。
- 状态：completed

## Task 4 — 版本与文档
- 目标：更新 3.0.24 版本号、三份版本文档和重要变量清单。
- 验证：版本搜索、`scan:vars`、`check:vars`。
- 状态：completed

## Task 5 — 自动门禁与人工资金复核
- 目标：定向测试、release-check、主页面几何、启动性能和资金盲区复核。
- 验证：test-spec §4 全部通过；真实/脱敏双账号人工结论单独记录。
- 状态：completed（自动门禁）；真实/脱敏双账号人工复核保留为资金负责人 follow-up

## Task 6 — 合并归档与在线发布
- 目标：归档 PR/PRD，在干净依赖上重跑发布门禁，创建 annotated tag，验证 Windows Release 与公开更新资产。
- 验证：PR、tag、workflow、Release、`latest.yml`、Setup/portable 文件头和最终 tracked worktree 状态。
- 状态：in_progress（PR #99 已合并；发布门禁、tag 与 Release 待完成）
