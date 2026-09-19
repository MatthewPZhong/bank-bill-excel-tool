# Spec — v3.0.20 主页面同类要素垂直对齐

> status: released（PR #95 已合入 `main`；GitHub Release `v3.0.20` 已发布）
> owner: PM / Dev
> created: 2026-07-20
> updated: 2026-07-20
> implementation branch: `codex/v3.0.20-main-panel-alignment`

## 0. 任务摘要

- Goal：修复主页面同一行状态图标与文字、标签与下拉框选中内容的垂直视觉偏移。
- Context：现有状态框直接混排行内 SVG 与文字；部分绝对定位标签使用整行 `top: 50% + translateY(-50%)`，在不同字体、面板高度和 Windows 显示缩放下会产生可见偏移。
- Constraints：保持现有水平位置、尺寸、整体居中方式、按钮状态和业务流程不变；不改「新开账户余额账单生成」。
- Done when：AC-01～AC-09 通过，版本与三份版本文档更新为 3.0.20，完整质量门通过。

## 1. 代码事实

| 事实 | 出处 | 约束 |
|---|---|---|
| 10 个目标主模块的状态框都直接包含 `.status-spark` 和 `.status-box-text` | `index.html` | 统一增加内容层；排除 `newAccountStatusBox` |
| 状态更新通过后代选择器查找 `.status-box-text` | `src/renderer.js`、`src/renderer-pending.js` | 增加包装层不得改变更新接口 |
| Clear 状态框使用 flex，但 SVG 仍按行内内容参与布局 | `src/styles-gemini.css` | 固定图标盒并把 SVG 改为块级显示 |
| 资金对账状态框通过直接子项自动外边距兼顾居中与滚动 | `src/styles-gemini-extra.css` | 自动外边距迁移到统一内容层，保留滚动能力 |
| BU 与前置资金对账标签使用 `top: 50% + translateY(-50%)` | `src/styles-gemini-extra.css`、`src/styles.css` | 改为相对 48px 控件轨道的 `top: 0` 定位 |
| General 主题已停用但保留兼容样式 | `index.html`、`src/styles.css` | 同步兼容规则，不恢复主题入口 |

## 2. 功能契约

### 2.1 状态框

- 覆盖以下 10 个主模块：网银账单生成、月度Pending数据核对、业务OP数据核对、月度银行对账单BU回填校验、重复入金匹配、VCC业务OP计算、资金对账数据处理、前置资金对账、对账单修复、收单单据币种校验。
- 每个目标状态框增加 `.status-box-content`，包装原 `.status-spark` 与 `.status-box-text`；原 ID、文案、SVG 和状态更新逻辑保持不变。
- 内容层使用横向 flex，水平和垂直居中；图标盒固定为 `14×14px`、禁止收缩，内部 SVG 使用块级显示。
- 单行文案时图标中心对齐文字中心；多行文案时图标中心对齐整段文字盒中心。
- 「资金对账数据处理」继续支持长文案框内滚动；短文案仍垂直居中，长文案可从顶部完整滚动查看。
- 「资金对账数据处理」跨行 Grid 固定为 `48px + 18px + 110px`，状态框限制在原 `176px` 高度内，长文案不得撑高主面板。
- 「新开账户余额账单生成」的状态框 DOM 结构保持原样。

### 2.2 标签与下拉框

- 为以下 5 组组合建立统一控件类与 48px 垂直轨道：
  - 网银账单生成：模式。
  - 业务OP数据核对：BU。
  - 前置资金对账：对账场景。
  - 对账单修复：账单类别。
  - 对账单修复：场景。
- 标签使用固定高度 flex 垂直居中；下拉框选中内容使用明确行高。
- BU 与前置资金对账的绝对定位标签按控件顶部和高度定位，不再依赖整行百分比位移。
- 对账单修复标签保持右对齐；前置资金对账保持现有横向槽位、按钮间距和 `-14px / +14px` 位移。

## 3. 非目标

- 不修改弹窗、模块切换按钮、工具箱、设置页或「新开账户余额账单生成」。
- 不修改状态文案、下拉枚举、按钮状态、业务流程、IPC、数据库或 Excel 输出。
- 不改主页面现有水平位置、宽高和整体居中方式。
- 不重新启用 General 主题。

## 4. 验收标准

- AC-01：10 个目标状态框均使用统一内容层，`newAccountStatusBox` 不使用该内容层。
- AC-02：现有状态更新函数仍能通过后代选择器更新 10 个状态文字。
- AC-03：单行状态的图标中心与文字中心垂直差不超过 1 CSS px。
- AC-04：多行状态的图标中心与整段文字中心垂直差不超过 1 CSS px。
- AC-05：5 组标签与对应下拉框的顶部、高度和垂直中心一致。
- AC-06：`1240×860` 与 `1080×760` 下 10 个目标模块无重叠、截断或水平位移。
- AC-07：资金对账状态长文案仍可滚动且顶部内容可达。
- AC-08：前置资金对账 `-14px / +14px` 水平位移与新开账户状态框结构保持不变。
- AC-09：Clear 生效样式与 General 兼容样式同步，版本号及三份版本文档为 3.0.20。

## 5. 验证与验收

- 自动化：DOM/样式契约测试、相关 UI 单测、全部主模块 preview、`npm run release-check`、`npm run scan:vars`、`npm run check:vars -- --include-minor`。
- 可复跑几何门禁：`npm run verify:main-panel-alignment` 在 `1240×860`、`1080×760` 与 100%、125%、150% 设备缩放组合下真实加载 Electron，检查 10 个状态框、5 组标签/下拉框、默认文案、内容边界和长文案滚动。
- Windows PR/发布门禁：Windows workflow 必须执行同一几何脚本并通过 6/6；PR CI 未通过不得合并，Release workflow 未通过不得发布。
- Windows 人工：安装版在 100%、125%、150% 显示缩放下复核字形观感；用户已要求本轮自动完成 merge 和发布，因此该项记录为发布后 canary，不替代上述合并与发布自动门禁。

## 6. 假设

- “平行显示”定义为元素视觉垂直中心一致，不要求不同字体的文字基线完全一致。
- 状态内容继续水平居中；多行状态图标对齐整段文字中心。
- Electron 设备缩放自动门禁验证几何不变量；真实 Windows 字形观感仍需安装版 canary，自动测量不能替代人工观感确认。

## 7. 合并与发布记录

- 2026-07-20：本地 `release-check` 全绿，unit 3702/3702、integration 1955/1955；Electron 双尺寸 x 三档缩放 6/6 PASS。
- 2026-07-20：Windows PR workflow run `29733232198` 通过；最终 PM/Development self-review 均为 P0-P4 Finding 0。
- 2026-07-20：PR #95 以 merge commit `1142f7e` 合入 `main`，远程与本地开发分支删除。
- 归档见 `docs/prs/PR95-v3.0.20.md` 与 `docs/iterations/v3.0.20/PRD-v3.0.20.md`。
- 2026-07-20：最终 `main` 重新执行 `npm ci`、release-check、六组合 Electron 几何门禁、scan-vars 与 check-vars，全部通过；可创建发布 tag。
- 2026-07-20：annotated tag `v3.0.20` 指向 `9b02fd1f8f9be9c615be8dce31b40292a0b993c3`；Windows Release workflow run [`29733820343`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/29733820343) 全部通过。
- 2026-07-20：GitHub Release [`v3.0.20`](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.20) 已发布为 latest、非 draft、非 prerelease，包含 Setup、Setup blockmap、portable 和 `latest.yml` 四个资产。
- 2026-07-20：匿名下载 `latest.yml` 显示 `version=3.0.20`、Setup 大小 `99,722,015` 字节；下载文件头为 `MZ`，SHA-512 与 feed 的 `ttrde0bfZnHmZT5prt/gQ+wUIiRbzyNkWlyKk5CY3yHrR7HeMw2qsqFao++VCIibDva2KEatXdEh1OwKmxb+Qw==` 完全一致；blockmap 与 portable 公开地址返回 HTTP 200。
