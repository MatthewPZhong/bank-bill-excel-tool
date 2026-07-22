# Implementation Notes — v3.0.24

## Baseline

- Goal/spec：[`spec.md`](./spec.md)
- Initial plan：用户批准“平盘对账仅前端占位 + Payment 多账号同账号隔离”实施计划。
- Done when：[`test-spec.md`](./test-spec.md) 自动验证完成；人工双账号复核缺口明确记录。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
|---|---|---|---|
| 保留 `bigAccount` 字符串 schema | 旧 config、renderer、orchestrator 和引擎均消费该键；顿号字符串可向后兼容单账号 | 新增 `bigAccounts` 数组并迁移 | 无 DB 迁移，旧单账号直接兼容 |
| 三轮候选按账号隔离 | 单账号时代双方天然同账号；合池后若不补同账号条件会跨账号误回填 | 账号仅做两边 membership，不校验 pair 相等 | 扩大账号范围但不扩大单笔匹配边界 |
| 新模块默认闲置 | 现有前置资金对账、重复入金匹配新增模块均采用此模式 | 修改默认启用列表 | 不打乱既有用户模块顺序 |
| 五按钮统一走 `showComingSoon` | 仓库已有“纯前端占位、禁止真实 IPC”统一 helper | disabled 按钮；空 handler | 页面可验收且不会产生业务副作用 |
| 仅开始运行为蓝色，运行/导出宽度固定 140px | 用户视觉复核发现父级通用样式把左列按钮撑到 180px，并明确颜色层级 | 沿用首次实现的按钮 class 和继承宽度 | 恢复对账单修复原槽位尺寸，突出唯一主操作 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
|---|---|---|---|
| 多账号共用银行渠道和地区 | 用户批准计划明确限定 | 未来若需账号级渠道配置需新 schema | 本次引擎测试锁定；后续独立迭代 |
| 账号只需 trim 且区分大小写 | 现有 `normalizeCellValue` 精确比较口径 | 大小写脏数据不会自动命中 | 单测锁定；需要放宽时单独资金评审 |
| 平盘功能选择无需跨重启保存 | 本迭代明确只做前端 | 重启恢复第一项 | 无持久化数据，易回滚 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
|---|---|---|---|---|
| 无 | 无 | 实施未发生行为契约偏差 | 无 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
|---|---|---|
| Payment 定向单测 | `89/89 PASS` | 单/多账号、R1/R2/R3 三轮同账号隔离、非法配置、warning 到主错误报告透传、编排接线、UI 保存校验和中文原因 |
| 模块/设置定向单测 | `68/68 PASS` | 12 模块注册、默认闲置、页面结构、五按钮占位、存档中心仍为原 11 模块 |
| `preview:position-reconciliation-panel` | PASS | 页面文本、槽位、状态初始值和整体布局人工查看无异常 |
| `verify:main-panel-alignment` | `6/6 PASS` | 两种窗口尺寸 × Windows 100%/125%/150%，状态/下拉垂直对齐且控件无重叠 |
| `scan:vars` | PASS | v3.0.24：202 JS / 2324 顶层声明，重要变量报告已刷新 |
| `release-check` | PASS | smoke；`3813/3813` 单测；42 个集成脚本、`1963/1963` 断言 |
| `check:vars -- --include-minor` | PASS | 命中 Runtime-state `MODULES` / `elements`；已核模块 ID 两端同步、默认列表不扩写、占位按钮无业务入口 |
| `startup:measure` | PASS | 5 次建窗到可见平均 `100.039ms`，ready-to-show 平均 `173.88ms` |
| 资金盲区复核 | 自动部分 PASS | R1/R2 使用账号×周桶，R3 显式同账号，三轮共享全局消费；非法配置进入 error-report；真实双账号逐笔复核待完成 |
| GitHub PR #99 workflow | PASS | smoke-test 通过；Windows build job 按 PR 工作流约定跳过 |
| 最终 self-review | P0-P4 Finding 0 | 合并前无存活 P0-P4 Finding |
| PR #99 合并 | `a965c48` | 2026-07-22 merge commit 合入 `main`；远程开发分支已删除 |
| 发布前 `npm ci` + `release-check` | PASS | unit `3813/3813`、42 个 integration 脚本 `1963/1963`，lint 与 smoke 全绿 |
| 发布前主页面几何 | `6/6 PASS` | 两种窗口尺寸 × Windows 100%/125%/150% |
| 发布前启动性能 | PASS | 5 次建窗到可见平均 `99.058ms`，ready-to-show 平均 `170.467ms` |
| 发布前变量硬节点 | PASS | `scan:vars` 为 202/2324；`check:vars -- --include-minor` 因 `src` 无改动安全跳过 |
| 生产依赖审计 | 7 条既有告警 | 2 moderate、5 high；v3.0.24 未新增生产依赖，保留为依赖治理 follow-up |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
|---|---|---|---|
| 真实双账号是否存在完全相同金额币种日期碰撞 | PROBE | 资金负责人用真实或脱敏样本逐笔复核 | 不阻断编码；不得宣称人工资金验收完成 |
