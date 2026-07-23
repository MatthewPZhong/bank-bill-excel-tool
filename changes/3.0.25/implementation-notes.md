# Implementation Notes — v3.0.25

## Baseline

- Goal/spec：[`spec.md`](./spec.md)
- Initial plan：用户批准“设置弹窗保存修复 + 模板排除退役 + 文案/布局 + 平盘显示改名”计划。
- Done when：[`test-spec.md`](./test-spec.md) 自动验证完成，设置预览和六组合几何检查通过。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
|---|---|---|---|
| 全局【确认】承担存档设置保存 | 独立按钮位于事件委托容器外，是现有保存失效的直接原因；用户明确选择“确认即保存” | 修复独立保存按钮监听 | 设置页只保留一个明确提交入口 |
| 历史模板排除全部归零 | 用户明确选择“全部恢复存档” | 保留旧值但隐藏 UI | 旧模板排除不再隐式影响后续批次 |
| 保留通用 `skipArchive` | operation tracker 是跨模块基础能力，不等同于已退役模板策略 | 删除全部跳过能力 | 只移除模板级跳过，不扩大改动面 |
| 平盘只改显示文本 | 用户明确要求枚举文案变更，内部 value 是已存在契约 | 同时改 value | 无持久化或下游兼容风险 |
| CSS 共享尺寸变量派生右边界 | 右边界必须随窗口/缩放稳定对齐 | 固定某个视口的像素宽度 | 可用几何测试验证，避免响应式漂移 |
| 存档设置读取使用请求代次和加载闸门 | 独立审查发现返回后旧草稿与在途响应存在竞态 | 仅在返回时改下拉值 | 返回/切页使旧请求失效，重新加载完成前不可确认 |
| 保留期限默认值统一为 60 天 | 用户明确要求新增 60 天并作为默认值 | 仅修改前端 selected | Controller 与 ArchiveService 同步回退为 60；既有合法设置不迁移 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
|---|---|---|---|
| 旧排除 setting key 可保留但固定写 `[]` | 无需 schema migration，且便于升级用户立即失效旧策略 | 未来若复用同 key 需新版本重新定义 | 控制器启动测试锁定 |
| X 和返回箭头应放弃草稿 | 用户批准计划明确说明 | 用户可能误以为自动保存 | 行为测试及用户指南说明 |
| portable 提示是唯一保留的更新说明 | 用户只要求删除 NSIS 启动检查说明 | portable 用户仍需要下载路径提示 | UI contract 与 preview 验证 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
|---|---|---|---|---|
| 无 | 无 | 暂无行为契约偏差 | 无 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
|---|---|---|
| 后端模板排除定向测试 | `34/34 PASS` | 控制器归一化、IPC 退役、网银/月度存档恢复、通用 skip 保留 |
| 后端子任务 smoke | PASS | 存档基础链路回归 |
| 设置/存档/平盘定向单测 | `63/63 PASS` | 全局确认保存、永久值、失败保留、API 退役、说明删除、14px、平盘 value 兼容 |
| 60 天保留期定向测试 | `36/36 PASS` | Controller 缺失/非法值默认 60、60/90/永久持久化、ArchiveService 建批到期日、UI 枚举与文案 |
| `verify:app-settings-layout` | `6/6 PASS` | 双窗口 × 100%/125%/150%；右边界误差均 `0px`、开关文字 `14px`；成功/失败/无修改/重复点击/放弃与重载闸门 |
| 设置页 preview | PASS | 存档设置只剩统计、保留期限与确认；保留期限默认显示 60 天，无说明或字段标签空位 |
| `scan:vars` | PASS | v3.0.25：202 JS / 2320 顶层声明，报告已刷新 |
| `release-check` | PASS | lint、smoke、unit `3818/3818`、42 个 integration 脚本 `1963/1963` |
| `check:vars -- --include-minor` | REVIEWED | `ipcRenderer` 的删除通道与 Main 对称；`listTemplates` 仅删除模板策略依赖；`app/dialog/elements` 未改变生命周期或缓存；`getSetting/setSetting` 只将退役 key 归一化为 `[]` |
| `startup:measure` | PASS | 5 次建窗到可见平均 `98.202ms`，ready-to-show 平均 `167.323ms` |
| 独立代码审查 | 初审发现 P1 1 条、P2 1 条；修复后复审无 P0-P4 | 修复永久值被 90 覆盖，以及返回草稿/异步加载竞态 |
| team-lead 三层门禁 | PASS | UI、Controller、ArchiveService 均使用 60 天默认值；旧 30/90/180/365/永久配置兼容，存档其它契约不变 |
| GitHub PR #100 workflow | PASS | Windows smoke-test 与主页面对齐检查通过；run `29991926713` |
| 最终 self-review | P0-P4 Finding 0 | PR 实际 patch 无存活 P0-P4 Finding |
| PR #100 合并 | `047275f` | 2026-07-23 merge commit 合入 `main` |
| 发布前 `npm ci` + `release-check` | PASS | unit `3818/3818`、42 个 integration 脚本 `1963/1963`，lint 与 smoke 全绿 |
| 发布前设置布局 | `6/6 PASS` | 两种窗口尺寸 × Windows 100%/125%/150%，右边界误差 `0px`，开关文字 `14px` |
| 发布前主页面布局 | `6/6 PASS` | 两种窗口尺寸 × Windows 100%/125%/150% |
| 发布前启动性能 | PASS | 5 次建窗到可见平均 `100.985ms`，ready-to-show 平均 `170.123ms` |
| 发布前变量硬节点 | PASS | `scan:vars` 为 202/2320；`check:vars -- --include-minor` 因 `src` 无新改动安全跳过 |
| 生产依赖审计 | 7 条既有告警 | 2 moderate、5 high、0 critical；v3.0.25 未新增生产依赖，保留为依赖治理 follow-up |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 交付影响 |
|---|---|---|---|
| Windows 实机字体渲染与 macOS Electron 强制缩放是否完全一致 | PROBE | 自动六组合几何已通过；发布前可在 Windows 安装版复核 | 不阻断本地实施，不得表述为 Windows 实机已验收 |
