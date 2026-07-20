# Implementation Notes — v3.0.20 主页面同类要素垂直对齐

> status: merged（Release workflow 待执行）
> owner: Dev
> updated: 2026-07-20

## Task Brief

- Goal：统一主页面状态图标/文字和标签/下拉框的垂直视觉中心。
- Constraints：仅改 DOM 包装和 CSS；水平几何、尺寸、业务行为不变；排除新开账户模块。
- Done when：spec AC-01～AC-09 通过。

## Decisions

| ID | 决定 | 原因 |
|---|---|---|
| D01 | 状态框增加统一内容层，不修改状态更新函数 | 现有函数使用后代选择器，兼容且改动面最小 |
| D02 | 图标盒固定 14×14px，SVG 块级显示 | 消除行内 SVG 基线和收缩造成的偏移 |
| D03 | 标签与下拉框共享 48px 轨道类 | 让不同模块按同一几何契约对齐 |
| D04 | 绝对定位标签使用 `top: 0`，不再按整行 50% 定位 | 控件轨道是稳定参照，不受父行额外高度影响 |
| D05 | General 仅同步兼容 CSS | 主题已停用，本迭代不改变产品入口 |
| D06 | 资金对账跨行 Grid 第一行固定为 48px，状态单元格和滚动框允许 `min-height: 0` | 防止超长文案参与 Grid 最小尺寸计算并撑高主面板，同时保留原 176px 跨行高度 |
| D07 | 将一次性几何检查固化为 Electron 脚本，并接入 Windows PR/Release workflow | 让 AC-03～AC-08 可重复执行，避免只依赖源码正则或本机截图 |
| D08 | Windows 自动几何验证作为 merge/release 硬门禁，安装版三档缩放字形观感作为发布后 canary | 用户要求本轮自动完成 merge 与发布；真实设备观感仍如实保留，不伪造人工证据 |

## Assumptions

- 视觉对齐以 CSS 盒中心为验收口径，不要求字体字形基线完全一致。
- Windows 三档缩放由真实安装版人工复核。

## Edge Cases Discovered

- 统一内容层初版在 24 行资金对账状态文案下会把 `auto` Grid 行撑高到 533px，导致滚动失效；改为固定 `48px 110px` 行轨道并约束滚动框后，可视高度恢复为 174px、内容高度 531px，顶部和底部均可达。

## Evidence

- 定向 unit：`15/15 PASS`。
- `npm run verify:main-panel-alignment`：双尺寸 × 三档设备缩放 `6/6 PASS`，实际 DPR 为 `1 / 1.25 / 1.5`。
- 双尺寸 DOM 几何：`1240×860`、`1080×760` 下 10 个状态框单行/三行中心差最大约 `0.004 CSS px`；5 组标签/下拉框顶部、高度、中心差均为 `0`。
- 长文案滚动：24 行内容下 `clientHeight=174`、`scrollHeight=531`、`bottomScrollTop=357`、父单元格高度 `176`。
- 10 个目标模块 preview 已生成并逐张检查；新开账户结构未改变。
- `npm run release-check`：unit `3702/3702 PASS`、integration `1955/1955 PASS`，lint、smoke 通过。
- `npm run scan:vars`、`npm run check:vars -- --include-minor`：通过，无重要变量命中。
- Windows PR workflow run `29733232198`：PASS；review threads 为 0。
- 最终 PM/Development self-review：P0-P4 Finding 均为 0。
- PR #95 以 merge commit `1142f7e` 合入 `main`；远程与本地开发分支已删除。

## Remaining Unknowns

- Windows Release workflow 尚待 tag 触发并执行同一几何脚本。
- Windows 安装版 100%、125%、150% 显示缩放下的最终字形观感需发布后实机 canary。
