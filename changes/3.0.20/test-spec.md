# Test Spec — v3.0.20 主页面同类要素垂直对齐

> status: merged-pass（Release workflow 待执行）
> created: 2026-07-20
> updated: 2026-07-20
> source: `changes/3.0.20/spec.md` AC-01～AC-09

## 1. 测试目标

- 锁定 10 个目标状态框的统一内容层及「新开账户余额账单生成」排除项。
- 证明单行、多行状态的图标与文字盒垂直中心差不超过 1 CSS px。
- 证明 5 组标签/下拉框共享同一垂直轨道，且原横向几何不变。
- 回归资金对账状态框滚动、状态更新后代选择器和两套主题样式兼容性。

## 2. P0 必测

| ID | 场景 | 预期 |
|---|---|---|
| P0-01 | 扫描 10 个目标状态框 DOM | 每框只有一个 `.status-box-content`，内部依次包含图标和文字 |
| P0-02 | 扫描新开账户状态框 DOM | 保持原直接子元素结构，不引入统一内容层 |
| P0-03 | 单行状态文案 | 图标中心与文字中心垂直差 `<= 1px` |
| P0-04 | 含换行的多行状态文案 | 图标中心与整段文字中心垂直差 `<= 1px` |
| P0-05 | 资金对账长状态文案 | 框内滚动保留，顶部和底部内容均可达 |
| P0-06 | 模式、BU、对账场景、账单类别、场景 | 标签与控件顶部、高度、中心一致 |
| P0-07 | 前置资金对账主面板 | 横向槽位和 `-14px / +14px` 按钮位移保持 |
| P0-08 | `1240×860` 与 `1080×760` 的 10 个模块 | 无重叠、截断或水平位移 |
| P0-09 | renderer 更新状态 | `.status-box-text` 后代选择器仍命中并正确更新 |
| P0-10 | Clear 与 General 源码契约 | 两套样式均包含固定图标盒、内容层和统一控件轨道 |

## 3. P1 边界

- 状态为空、超长单词、中文多行和含数字/符号时不改变状态框尺寸。
- Windows 字体覆盖下 SVG 不参与文本基线计算。
- 对账单修复禁用下拉框的文本仍垂直居中。
- 模块镜像布局 `direction: rtl/ltr` 不改变状态内容的阅读方向。
- General 主题继续停用，兼容 CSS 不影响当前 Clear 页面。

## 4. 执行顺序

1. 先增加 DOM/样式契约测试并确认旧结构不满足新契约。
2. 修改 HTML 与 CSS 后执行定向 unit。
3. 运行 `npm run verify:main-panel-alignment` 的双尺寸、三档设备缩放 DOM 几何测量和全部主模块 preview。
4. 执行 `npm run release-check`、`npm run scan:vars`、`npm run check:vars -- --include-minor`。
5. PR 与 Release 的 Windows workflow 运行同一几何脚本；安装版三档缩放字形观感作为发布后 canary 人工复核。

## 5. 不测项与原因

- 不测试业务对账、数据库和 Excel：本迭代不修改相关代码路径。
- 自动几何脚本同时接入 Windows PR/Release workflow；真实 Windows 安装版字形观感保留为发布后人工 canary。

## 6. 执行结果

- DOM/样式定向测试：`15/15 PASS`。
- 可复跑 Electron 几何门禁：本机双尺寸 × 三档设备缩放 `6/6 PASS`，实际 `devicePixelRatio=1/1.25/1.5`。
- 双尺寸几何测量：10 个状态框单行/三行中心差最大约 `0.004 CSS px`；5 组标签/控件顶部、高度和中心差均为 `0`。
- 资金对账 24 行状态文案：状态框可视高度 `174px`、内容高度 `531px`、底部可滚至 `scrollTop=357`，跨行单元格保持 `176px`。
- 全量门禁：unit `3702/3702 PASS`，integration `1955/1955 PASS`，lint、smoke 均通过。
- 变量门禁：`scan:vars` 与 `check:vars -- --include-minor` 均通过，无重要变量命中。
- Windows PR workflow run `29733232198`：PASS；Release workflow 待 tag 触发。
- 最终 PM/Development self-review：P0-P4 Finding 均为 0；review threads 为 0。
