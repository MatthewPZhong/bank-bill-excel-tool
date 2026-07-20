# bank-bill-excel-tool 3.0.20 PRD

> 目标版本：`3.0.20`
> 状态：released（PR #95 已合入 `main`；GitHub Release `v3.0.20` 已发布）
> 归档：PR #95 merge commit `1142f7e`；源规格 `changes/3.0.20/spec.md`
> 更新时间：2026-07-20
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

统一修复主页面同类要素的垂直视觉偏移：状态框星形图标与单行或多行状态文字按内容中心对齐，五组标签与下拉框按同一 48px 控件轨道对齐。

本迭代不修改业务流程、状态文案、枚举、按钮状态、IPC、数据库或 Excel 输出，也不改变「新开账户余额账单生成」的横向状态框结构。

## 1. 状态框契约

- 覆盖网银账单生成、月度 Pending 数据核对、业务 OP 数据核对、月度银行对账单 BU 回填校验、重复入金匹配、VCC 业务 OP 计算、资金对账数据处理、前置资金对账、对账单修复和收单单据币种校验。
- 10 个目标状态框使用统一 `.status-box-content` 包装图标与文字；状态更新仍通过后代选择器写入原 `.status-box-text`。
- 图标盒固定为 14x14px、禁止收缩，SVG 使用块级显示，消除行内基线偏移。
- 单行状态时图标对齐文字中心；多行状态时图标对齐整段文字中心。
- 「新开账户余额账单生成」保持原直接子元素结构。

## 2. 标签与下拉框契约

- 网银账单生成「模式」、业务 OP 数据核对「BU」、前置资金对账「对账场景」、对账单修复「账单类别 / 场景」统一使用 48px 垂直轨道。
- 标签使用固定高度 flex 垂直居中；下拉框使用明确文字行高。
- BU 和前置资金对账绝对定位标签改按控件顶部定位，不再依赖父行 `50%` 位移。
- 对账单修复标签继续右对齐；前置资金对账横向槽位、按钮间距和 `-14px / +14px` 位移保持不变。
- Clear 生效样式与 General 兼容 CSS 同步，但不恢复 General 主题入口。

## 3. 长文案与布局边界

- 资金对账跨行 Grid 固定为 `48px + 18px + 110px`，父单元格保持 176px。
- 状态框限制在父单元格内，短文案垂直居中，超长文案从顶部开始并在框内滚动。
- 24 行回放中，状态框可视高度 174px、内容高度 531px，可滚至底部且不会撑高主面板。
- `1240x860` 默认窗口和 `1080x760` 最小窗口均不得产生水平溢出、内容越界或控件重叠。

## 4. 可复跑验收

- `npm run verify:main-panel-alignment` 使用真实 Electron 页面，在两种窗口尺寸与 DPR `1 / 1.25 / 1.5` 的六种组合下执行。
- 脚本逐个检查 10 个状态框的单行/三行中心差、内容边界和默认文案，检查 5 组标签/控件顶部、高度和中心，并验证资金状态长文案上下滚动可达。
- 同一脚本接入 Windows PR 与 Release workflow；PR CI 未通过不得合并，Release workflow 未通过不得发布。
- Windows 安装版 100% / 125% / 150% 的最终字形观感属于发布后人工 canary，自动几何验证不能替代人工观感确认。

## 5. 验证与归档

- 本地 `npm run release-check` 通过：unit 3702/3702、integration 1955/1955，lint 与 smoke 全绿。
- 本地 Electron 几何验收 6/6 PASS；最大状态中心差约 `0.004 CSS px`，五组控件几何差为 `0`。
- `npm run scan:vars` 与 `npm run check:vars -- --include-minor` 通过，无重要变量命中。
- 10 个主模块 preview 已生成并逐张复核，重复入金默认文案另由运行时脚本断言。
- 第一轮 self-review 暴露不可复跑几何证据和失败日志假阳性；补齐脚本、Windows 门禁并修复日志后，最终 PM/Development 复审均确认无 P0-P4 Finding。
- GitHub Windows PR workflow run `29733232198` 通过；PR #95 以 merge commit `1142f7e` 合入 `main`，远程与本地开发分支删除。
- 合并归档后的最终 `main` 已重新通过 `npm ci`、完整 release-check、六组合几何门禁和变量门禁，可进入受控 tag 发布。
- annotated tag `v3.0.20` 指向 `9b02fd1f8f9be9c615be8dce31b40292a0b993c3`；Windows Release workflow run [`29733820343`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/29733820343) 全部通过。
- GitHub Release [`v3.0.20`](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.20) 已发布为 latest、非 draft、非 prerelease，包含 Setup、Setup blockmap、portable 和 `latest.yml`。
- 匿名 feed 返回 `version=3.0.20`；Setup 大小 `99,722,015` 字节、文件头 `MZ`，SHA-512 与 `latest.yml` 完全一致；blockmap 与 portable 的公开地址可匿名访问。
- Windows 安装版三档缩放字形观感及旧版到 3.0.20 的升级数据保留，保留为发布后实机 canary。
