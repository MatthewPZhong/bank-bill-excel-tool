# v2.1.13 任务拆分与进度

> 配套：`PRD.md` / `TECH_DESIGN.md`
> 角色约定：主线程 = team-lead（拆分/委托/验收）；实现委托 dev agent。
> ⚠️ 前端任务多改 `renderer-dialogs.js`（单文件 5000 行）→ 串行或 worktree 隔离，避免冲突。

## 任务清单

| ID | 任务 | 层 | 依赖 | 状态 |
|---|---|---|---|---|
| **T1** | migrations：①category 加 `builtin-fixed`（重建表）②新建 `scenario_applicable_channels` 表 ③seed 迁移（提取场景→builtin-fixed/priority 0）④改 BUILTIN_SCENARIOS[0] | DB | — | ✅ 完成（13 测试）|
| **T2** | repository + facade + IPC + preload：VALID_CATEGORIES、get/setApplicableChannelIds、is_builtin 删除保护 | DB/IPC | T1 | ✅ 完成 |
| **T3** | 执行引擎：runScenario 加 builtin-fixed 路由；dispatcher 适用渠道选场景（跨渠道生效） | 引擎 | T1,T2 | ✅ 完成（5 测试）|
| **T4** | 文本：B1 月度Pending 去空格 / B2 / B3 / getCategoryLabel(builtin-fixed) | 前端 | — | ✅ 完成 |
| **T5** | A1 镜像对调（bankStatementModulePanel 加 layout-mirrored + 验证 rtl 交互） | 前端 | — | ✅ 完成 |
| **T6** | A2 ReconID 去渠道下拉 + D-2/D-4 builtin-fixed 列表渲染（置顶/优先级0/仅管理/启用/通用渠道可见） | 前端 | T2 | ✅ 完成 |
| **T7** | D-3 写死场景「管理」弹窗（抽公共多选下拉 + 多选适用渠道 + 保存） | 前端 | T2 | ✅ 完成 |
| **T8** | C 复制场景（C1-C4 header 按钮 + 复制弹窗 + 灌 config） | 前端 | T2 | ✅ 完成 |
| **T9** | D-1 移除 extract-recon-id 新建选项 | 前端 | — | ✅ 完成 |
| **T10** | 收尾：preview 回归 + 新弹窗 preview 入口 + 文档三件套 + 版本 bump + scan:vars/check-vars + release-check | 收尾 | T1-T9 | ✅ 完成 |

## 建议委托批次

- **批次 1（串行）**：T1 → T2 → T3（数据/引擎主链，后续依赖）。
- **批次 2（前端，串行同一文件）**：T4 → T9 → T5 → T6 → T7 → T8（都改 renderer-dialogs.js/renderer.js，建议串行；T5 改 index.html 可并）。
- **批次 3**：T10 收尾。

## 已确认（定稿）

1. **PRD §三**：适用渠道**跨渠道生效**——运行渠道 X 时，适用列表含 X（或为空=全部）且 enabled 的 builtin-fixed 场景纳入执行；默认全选=全部生效。
2. **PRD C5**：复制场景**覆盖 config、不覆盖名称**。
3. **复制可用模式**：**新建 + 修改都可用**。

## 进度日志

- 2026-06-05：建分支 v2.1.13；完成技术调查；落 PRD / TECH_DESIGN / TASKS（待 review）。
- 2026-06-06：T1-T3 后端核心完成（1491 unit 全过 + 18 针对性测试，含 dispatcher 资金红线契约回归）；T4 文本 / T5 镜像 / T6 列表改造+去渠道 / T7 适用渠道管理弹窗 / T9 移除新建选项 代码完成（语法 OK，待手动测）。剩 T8 复制场景 + T10 收尾（CSS 微调 / preview / 文档三件套 / 版本 bump / check-vars）。
- 2026-06-06（T4-T10 全部完成）：T8 复制场景 + 多批 UI 微调（按钮位置/宽度/居中）+ 字体策略（Win 端 Courier New 英文数字 + Noto Sans SC 中文，打包字体、仅 win32+Clear、大标题保留）；T10 收尾 = 文档三件套 + bump 2.1.13-beta.1 + preview 回归 10/10 + scan:vars + check-vars + release-check 全绿（unit / integration 952 / smoke）→ 提 PR #58（v2.1.13 → main）。
- 2026-06-06（PR #58 review 修复）：处理 Codex + owner review 4 类问题——**P2-A** builtin-fixed 归入 `BANK_STATEMENT_CATEGORIES`（启停写死场景不再误清 ReconID 修复结果）/ **P2-B** 迁移改 `is_builtin + config.extractByFeature` 定位（不依赖 name，解决改名漏迁 + 同名 UNIQUE 冲突）/ **P2-C** 适用渠道弹窗阻止 0 选项保存（避免空选反向变全渠道）/ **P3-D** 本表回写完成状态。
