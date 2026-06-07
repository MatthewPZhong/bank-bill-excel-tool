# v2.1.14 任务拆分（TASKS）

> 配套 `PRD.md` / `TECH_DESIGN.md`。性质：纯前端。边界：骨架 + 复用现有对账单导入。
> 状态图例：⬜ 待办 / 🔄 进行中 / ✅ 完成 / ⏸️ 暂缓 / 🚧 阻塞（待用户答复）

## 任务清单

| ID | 任务 | 落点 | 边界 | 状态 |
|---|---|---|---|---|
| **T0.1** | 建分支 `v2.1.14` | git | — | ✅ |
| **T0.2** | bump version `2.1.14-beta.1` | `package.json:3` | — | ✅ |
| **T1.1** | 主标题「网银账单小助手」→「清结算小助手」| `index.html:10,30` + `startup-failure.js:34`（第三处）+ smoke 断言同步 `scenarios.js:650` | [真实] | ✅ |
| **T1.2** | 模块名「银行对账单处理」→「资金对账数据处理」(仅 name，id 不变) | `renderer.js:57` | [真实] | ✅ |
| **T1.3** | ~~按钮「开始运行」→「开始对账」~~（七-1 已撤回为「开始运行」，净效果文案不变）| `index.html` | [真实] | ✅ |
| **T2.1** | 面板 DOM 重构（3 行布局，移除 layout-mirrored，加 `fund-recon-board`，保留 `bank-statement-board`）| `index.html:272-303` | [真实] | ✅ |
| **T2.2** | 新布局 CSS（双主题：`styles-gemini-extra.css` + `styles.css`，`fund-recon-board` 作用域）| `styles*.css` | [真实] | ✅ |
| **T2.3** | 新增 3 按钮 elements 缓存 + 事件绑定 + `showComingSoon` helper | `renderer.js:293-296 / 3430 / 5160` | 混合 | ✅ |
| **T2.4** | `refreshBankStatementStatus` 兼容回归（原 3 按钮逻辑未动）| `renderer.js:3346-3390` | [真实] | ✅ |
| **T3.1** | `createLinkedTableManagerDialog` 弹窗骨架（4 表 + 状态列 + 导入/退出）| `renderer-dialogs.js:6077+` | [骨架] | ✅ |
| **T3.2** | 「链接表管理」按钮接入弹窗 | `renderer.js`（T2.3 内）| [真实] | ✅ |
| **T4.1** | 已有 assets 模板纳入 git 跟踪 | `assets/` | — | ⏸️ 待 §D 扩展名口径定稿后一并 add |
| **T4.2** | 缺失/待定模板（外汇期权订单.xlsx / 扩展名口径 / 网关对账单）| `assets/` | 用户答复 | 🚧 |
| **T5.1** | 新增 `linked-table-manager` preview（工厂 mock + package.json 脚本）| `renderer-previews.js:813` / `renderer.js` / `package.json` | [真实] | ✅ |
| **T5.2** | preview 回归（bank-statement-panel + linked-table-manager 出图）| — | — | ✅ |
| **T6.1** | `npm run release-check` 全绿 | — | — | ✅ smoke+unit 1511+integration 952，EXIT=0 |
| **T6.2** | `/check-vars`（版本 bump 节点）| — | — | ✅ 命中 MODULES/elements，见报告 |
| **T6.3** | self-review（分级 Critical/Important/Minor）| — | — | ✅ 无 Critical/Important；2 Minor（双导出按钮视觉态、General 主题未 preview）|

## 进度日志

- 2026-06-06：建 `v2.1.14` 分支（T0.1）；落 spec 三件套（PRD / TECH_DESIGN / TASKS）。
- 2026-06-06：**批次 1 完成**（委托 dev agent 实现）。
  - A 文案：主标题（含 startup-failure 第三处 + smoke 断言同步）/ 模块名 / 开始运行 按钮（七-1 撤回「开始对账」改名）。
  - B 面板：`#bankStatementModulePanel` 重构为 3 行布局（移除 layout-mirrored → fund-recon-board，保留 bank-statement-board 复用配色），双主题 CSS。5 原 id + status-spark svg 全保留。
  - C 弹窗：`createLinkedTableManagerDialog`（4 静态表 + 三列 + 导入[占位]/退出）。
  - 占位：`showComingSoon` helper（不平校验导出 / 链接表导入）—— 不伪装成功、不写数据。
  - 复用真实：导入对账单 / 导出文件(预加工) / 导入不平表(`importGatewayRecon`) / 开始运行 / 场景管理。
- 2026-06-06：**收口**。bump 2.1.14-beta.1；release-check 全绿（EXIT=0）；重跑 2 张 preview 同步版本号；revert 测试 runner 自动改写的 `rules/integration-test-policy.md` 噪声。
- 2026-06-06：team-lead 审查发现并修复：① smoke 断言依赖旧标题（同步）② 测试 noise 文件（revert）③ check-vars skill 的 `src/**/*.js` glob 坑（漏 src/ 顶层文件，已用正确 pathspec 重扫；建议单独修 SKILL.md）。
- 2026-06-07：**第二批用户答复处理**：assets 7 模板 git add（外汇期权订单.xlsx 缺失待补）/ 品牌改名 description+productName→清结算小助手（appId 不动）/ check-vars `SKILL.md` glob 坑修复（pathspec→`-- src/`）/ 布局还原 control-row 三行（移除 fund-recon grid）。
- 2026-06-07：**追加 6 条实现（PRD §七）**：dev agent 两次崩溃（tool call 输出成字面文本）后主线程自实现——七-1 撤回开始运行 / 七-2 左侧按钮组左右张开（导入←/导出→，终态各 14px）/ 七-3 C2 FundType「自己输入」/ 七-4 C2/C3 标题后缀不加粗 / 七-5 赋值下拉 160px / 七-6 去 #序号。c2/c3/panel 三张 preview 确认 + release-check EXIT=0。

## 未决项（待用户答复，不阻塞已交付主体）

1. **assets 模板**：✅ 网关对账单.xlsx 已放、口径按实际扩展名、7 模板已 git add；🚧 仅 `外汇期权订单.xlsx` 缺失待用户补。
2. ~~A3 功能说明文案~~ ✅ 定：不上 UI，仅 PRD 记录。
3. ~~C3 链接表导入占位深度~~ ✅ 定：纯 Toast 占位。
4. ~~品牌延伸~~ ✅ 已改（description + productName→清结算小助手，appId 不动）。
5. ~~check-vars skill 修复~~ ✅ 已修（SKILL.md pathspec→`-- src/`）。
