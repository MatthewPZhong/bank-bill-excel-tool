# Test Spec — v3.0.24 平盘对账前端与 Payment 多大账号支持

> status: verified（自动验证完成，人工资金复核待完成）
> created: 2026-07-22
> updated: 2026-07-22

## 1. 平盘模块矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| UI-01 | 模块注册 | `MODULES` 与 `ALL_MODULE_IDS` 均含新 ID，总数为 12 |
| UI-02 | 默认列表 | 新模块不在 `DEFAULT_ENABLED_MODULES`，位于功能收纳闲置区 |
| UI-03 | 启用与切换 | 可启用、排序、切换并持久化 current module |
| UI-04 | 功能下拉 | 三个 value/label 顺序固定，默认第一项 |
| UI-05 | 页面结构 | 两行槽位、五按钮、空标签轨道和状态框符合 spec |
| UI-06 | 场景文案 | 新模块内不出现可见“场景”标签或场景下拉 |
| UI-07 | 占位交互 | 五按钮分别弹后续开放提示，业务 API 调用计数为 0 |
| UI-08 | 状态框 | 初始“欢迎使用小助手”，星形和文字垂直居中 |
| UI-09 | 响应式 | 两个窗口尺寸、三个 Windows 缩放比例无重叠或截断 |
| UI-10 | 回归 | 对账单修复页面 DOM、样式和交互不变 |
| UI-11 | 按钮颜色 | 仅开始运行为蓝色，其余四个按钮为白色 |
| UI-12 | 按钮尺寸 | 开始运行、导出文件均为 140px，不继承 180px 最小宽度 |

## 2. 多账号输入矩阵

| 编号 | 输入 | 预期 |
|---|---|---|
| IN-01 | `A` | 保存 `A`，旧单账号兼容 |
| IN-02 | ` A 、 B ` | 保存 `A、B` |
| IN-03 | `、A` / `A、` / `A、、B` | 原弹窗报错，不保存 |
| IN-04 | `A、 A ` | 重复账号报错，不保存 |
| IN-05 | `A,B` / `A，B` | 提示使用中文顿号，不保存 |
| IN-06 | `A、a` | 合法，大小写敏感视为不同账号 |
| IN-07 | 校验失败后 | 草稿、勾选态和其它配置字段不丢失 |
| IN-08 | 保存合法值 | 完整 config 浅合并，`funcCategory/subCategory/roundPhase` 不丢失 |

## 3. 多账号引擎矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| ENG-01 | 单账号旧 fixture | modifications/warnings/matchedPairs 与旧结果一致 |
| ENG-02 | A、B 各一对合法数据 | 两对分别命中并回填 |
| ENG-03 | A 银行行只有 B 订单同金额币种日期 | A 不命中，不发生跨账号回填 |
| ENG-04 | A/B 相同金额、币种、日期、周桶 | 仍按账号各自匹配 |
| ENG-05 | 主轮、日期容差轮、跨周兜底轮 | 三轮均要求账号相等 |
| ENG-06 | 多账号多候选 | 现有就近排序和原序 tie-break 不变 |
| ENG-07 | 两账号争用场景 | 全局银行/订单消费集合仍严格 1:1 |
| ENG-08 | 账号首尾空格 | trim 后精确匹配 |
| ENG-09 | 账号大小写不同 | 不匹配 |
| ENG-10 | 运行时非法配置 | no-op + `payment-offline-invalid-big-account-config` |
| ENG-11 | R5s2 已消费行 | 仍被排除，不进入 Payment 多账号池 |
| ENG-12 | 输出回归 | matchedPairs、核对 sheet、行数守恒不变 |

## 4. 自动验证

1. Payment parser、引擎、编排器、dialog 和 error cause 定向单测。
2. 新模块 registry、DOM、占位交互和 module cabinet 定向单测。
3. 新模块主页面 preview 与 `npm run verify:main-panel-alignment`。
4. `npm run release-check`。
5. `npm run scan:vars` 与 `npm run check:vars -- --include-minor`。
6. `npm run startup:measure`。

## 5. 人工复核

- 使用至少两个真实或脱敏大账号，逐笔核对银行 MerchantId、订单收款账户、金额、币种、日期和最终 ReconciliationId。
- 特别构造两个账号金额币种日期完全相同的样本，确认不发生跨账号回填。
- 未完成人工复核时只能报告自动门禁结果，不得宣称资金业务验收完成。
