# Test Spec — v3.0.25 设置弹窗与平盘功能文案调整

> status: release-ready-pass（PR #100 已合并；发布门禁通过；Release 待发布）
> created: 2026-07-23
> updated: 2026-07-23

## 1. 设置提交

- 存档设置修改保留期限后点击全局【确认】，断言只调用一次 `setRetentionDays`，成功关闭弹窗。
- 保存失败时断言弹窗仍在、错误反馈可见、按钮恢复 enabled。
- 未修改时点击【确认】直接关闭，不调用 API。
- 保存 pending 时重复点击不产生第二次请求。
- 右上角关闭与返回箭头均不调用保存 API。
- `retentionDays=null` 回显“永久”，并可从永久修改为 90 天后正常保存。
- 缺失或非法保留期配置回退为 60 天；既有 30/90/180/365/永久配置保持原值。
- 下拉枚举为 30/60/90/180/365/永久，初始默认选中 60 天，并可成功保存 60。
- 返回后下拉框立即恢复已保存值；重新进入时加载完成前【确认】禁用。
- 自动更新已下载时，更新页显示【稍后】；存档页和存档设置显示【确认】。

## 2. 模板排除退役

- Renderer DOM 不含模板排除区域、复选框、保存/取消按钮或旧 API 调用。
- Preload/Main 不暴露或注册模板策略 IPC。
- 控制器不再提供模板排除方法。
- 分别以 `["2"]`、损坏 JSON、空字符串及缺失配置创建控制器，断言 app setting 统一为 `[]`。
- 网银账单与月度余额携带 `templateIds` 时正常建档。
- 直接传入 `runtime.skipArchive=true` 时仍跳过存档。

## 3. 文案与视觉

- Renderer 源码与渲染 DOM 中不存在三段被删除说明。
- Renderer 源码与渲染 DOM 中不存在“锁定批次不参与自动清理。默认保留期为 90 天。”和“默认保留”。
- NSIS 更新说明节点隐藏；portable 仍显示固定下载提示。
- “已开启”和“已关闭”计算字号均为 `14px`，切换前后尺寸不漂移。
- 在 `1240x860`、`1080x760` 及 100% / 125% / 150% 缩放下：
  - 更新内容右边界与全局按钮左边缘差值 `<= 1 CSS px`。
  - 无横向滚动、内容截断或按钮溢出。
- 生成并人工查看自动更新与存档设置 preview。

## 4. 平盘名称

- 第二项 label 为“平盘对账数据处理”。
- value 仍为 `position-data-info-backfill`。
- 第一项仍默认选中，三个 value 顺序不变。
- 五个按钮仍只调用 `showComingSoon`。

## 5. 回归与门禁

- 定向单测：
  - archive center controller / operation tracker
  - archive center UI contract
  - app update contract
  - position reconciliation renderer
- `npm run preview:app-update-settings`
- `npm run preview:archive-center`
- 设置布局六组合几何验证
- `npm run release-check`
- `npm run scan:vars`
- `npm run check:vars -- --include-minor`
- `npm run startup:measure`

## 6. 合并验收结果

- 存档相关定向测试：`36/36 PASS`。
- `npm run release-check`：unit `3818/3818`、42 个 integration 脚本 `1963/1963`，lint 与 smoke PASS。
- `npm run verify:app-settings-layout`：`6/6 PASS`，右边界误差 `0px`，开关状态文字 `14px`。
- `npm run startup:measure`：建窗到可见平均 `98.202ms`，ready-to-show 平均 `167.323ms`。
- GitHub PR #100 workflow run `29991926713` PASS；最终 self-review P0-P4 Finding 0。
- PR #100 已以 `047275f` 合入 `main`。
- 合并归档后的干净 `npm ci` + `release-check` 再次通过：unit `3818/3818`、integration `1963/1963`，lint 与 smoke PASS。
- 发布前 `verify:app-settings-layout` 与 `verify:main-panel-alignment` 均为 `6/6 PASS`。
- 发布前启动建窗到可见平均 `100.985ms`，ready-to-show 平均 `170.123ms`。
- `scan:vars` 为 202/2320；`check:vars -- --include-minor` 因 `src` 无新改动安全跳过。
- `npm audit --omit=dev` 报告 7 条既有生产依赖告警（2 moderate、5 high、0 critical）；本迭代无生产依赖变更。
- tag、Release workflow 和公开资产证据待补充。
