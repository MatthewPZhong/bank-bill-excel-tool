# v2.1.14：清结算小助手改名 + 资金对账数据处理模块 + 链接表管理 + 场景配置弹窗微调

> 纯前端迭代，不涉及后端。分支 `v2.1.14` → `main`。

## 一、主体改动

### 1. 全局改名
- 主标题「网银账单小助手」→「清结算小助手」（`<title>` / H1 / 启动失败弹窗 / `package.json` description + productName）。`build.appId` 不动（应用唯一标识）。
- 模块「银行对账单处理」→「资金对账数据处理」（仅改 `MODULES.bankStatementProcess.name`，`module.id='bank-statement-process'` 不变）。

### 2. 资金对账数据处理面板重构
- `#bankStatementModulePanel` 改 control-row 三行布局（左两组导入/导出 + 状态框，右三按钮：开始运行/场景管理/链接表管理）。
- **真实接通**（复用现有 IPC）：导入对账单 / 导出文件(预加工) / 导入不平表(`importGatewayRecon`) / 开始运行 / 场景管理。
- **占位**（`showComingSoon`，不伪装成功）：资金对账不平校验导出 / 链接表批量导入。
- 左侧每组 `[导入][导出]` 往两侧张开 14px。

### 3. 链接表管理弹窗（新增 `createLinkedTableManagerDialog`）
- 4 表库：网关对账单 / 中台调拨订单表库 / 外汇期权表库 / 外汇交割表库；列「表库名 / 数据日期范围 / 表库更新日期」；底部 [导入(占位) / 退出]。UI 骨架，不读 DB、不持久化。

### 4. 场景配置弹窗微调（C2「银行对账单赋值自身」/ C3「网关对账单赋值银行对账单」）
- C2 赋值区 field 选 FundType → value 下拉加「自己输入」→ 选中就地切输入框（编辑态已有自定义值自动进输入框）。
- C2/C3 标题「— 类别名」后缀不加粗（modeLabel 保持）。
- C2 赋值两下拉缩窄至 160px（C3「对账成立后赋值」保持原宽，长字段名需完整显示）。
- 去掉账单类型 #x.x 子序号 + 对账字段 #x 序号（保留「账单类型 #x」分组标题）。

### 5. assets 模板
- 7 个新模板入库（中台加款单剔除模板 / 中台调拨订单 / 中台退款订单 / 中台退款订单回填模板 / 入账原始订单 / 外汇交割表vPayment / 网关对账单）。🚧 `外汇期权订单.xlsx` 缺失待补。

### 6. 工具改进
- 修复 `check-vars` skill 的 `src/**/*.js` glob 坑（git 默认 `**` 不跨 `/`，漏掉 src/ 顶层 renderer.js/main.js/preload.js），改为 `-- src/` 筛 `.js`。

## 二、验证
- `npm run release-check`：smoke + unit + integration 三层全过（17 集成脚本 952 断言），EXIT=0。
- preview 回归：bank-statement-panel / linked-table-manager / scenario-config-c2 / scenario-config-c3。
- smoke 断言同步：启动失败弹窗标题随改名更新（`scripts/smoke/scenarios.js`）。

## ⚠️ 关联功能 review（check-vars）
- **`elements`**（Runtime-state）：新增 3 个按钮 DOM 缓存，已同步初始化。
- **`MODULES` / `setCurrentModule`**（Important-skeleton）：仅改 name、id 不变 → 路由/tab 不受影响。

**请手动验证**（自动测试覆盖不到的 UI 交互）：
- [ ] 7 模块逐一切换，无 `Invalid current_module`。
- [ ] 资金对账链路：导入对账单 → 开始运行 → 导出（面板 DOM 重构，需确认现有 run/export 未受影响）。
- [ ] 场景配置 C1/C2/C3 新建/编辑/保存正常（`renderScenarioValueControl` 加了 allowCustom/customMode/extraClass 参数，默认值保证 C1/C3 行为不变）。
- [ ] C2「自己输入」：FundType → value 选「自己输入」→ 变输入框 → 能保存。

## 待办（后续版本）
- `外汇期权订单.xlsx` 模板补充。
- 占位功能后端接入：资金对账不平校验导出、链接表批量导入与持久化。
