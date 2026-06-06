# v2.1.13 迭代 PRD（需求规格）

> 状态：草稿（待用户 review）
> 分支：`v2.1.13`（基于 main，当前 main = 2.1.12）
> 目标版本号：`2.1.13-beta.1`
> 创建日期：2026-06-05

## 一、已确认决策（用户拍板）

| # | 决策点 | 选择 |
|---|---|---|
| D1 | 分支/版本 | 新建 `v2.1.13`（基于 main），bump 到 `2.1.13-beta.1` |
| D2 | 提取场景执行逻辑 | **保留** `extractByFeature` 提取逻辑，仅改 UI 展示文本 |
| D3 | 自带写死场景存储 | 新增 category 枚举 `builtin-fixed` + 场景-渠道**多对多关联表** |
| D4 | 镜像对调实现 | 复用现有 `.layout-mirrored`（CSS `direction:rtl`） |

## 二、需求清单（逐条编号 + 代码落点）

### A. 模块前端变动

| ID | 需求 | 落点（代码事实） |
|---|---|---|
| **A1** | 「银行对账单处理」模块前端页面沿中线镜像对调 | `bankStatementModulePanel`（index.html:271-296）加 `layout-mirrored` 类；CSS 机制已存在 styles-gemini-extra.css:952-954。**不影响** `recon-id-fix` 模块（独立 panel）|
| **A2** | 「对账单 ReconID 修复」模块场景管理去掉「银行渠道」功能 | `createScenariosManagerDialog` 内渠道下拉块 renderer-dialogs.js:6104-6115；ReconID 入口 `isCompactView=true`（6084）→ 隐藏渠道下拉 + 管理按钮 |

### B. 模块文本变动

| ID | 现文本 | 新文本 | 落点 |
|---|---|---|---|
| **B1** | `月度 Pending 数据核对`（含空格）| `月度Pending数据核对`（去空格）| renderer.js:50（`MODULES.pendingReconciliation.name`）；usage-stats.js:30 key；注释若干 |
| **B2** | `提取ReconId-From 网关`（gateway-recon-join）| `网关对账单赋值银行对账单` | renderer-dialogs.js:5536（LABELS）+ 6701（OPTIONS）|
| **B3** | `银行对账单字段赋值`（offset-bill-mark）| `银行对账单赋值自身` | renderer-dialogs.js:5535（LABELS）+ 6700（OPTIONS）|
| **B4**（增量，2026-06-06 用户追加）| `从银行对账单的信息里提取对账ID`（内置写死场景名）| `从银行对账单的信息里提取调拨订单对账ID` | migrations seed（BUILTIN_SCENARIOS）+ 新增 `ensureBuiltinFixedScenarioNameUpdate` 老库迁移（旧名→新名，幂等）+ category 迁移 WHERE 同步 + preview mock；⚠️ 改 DB 场景 name 字段 |

> 注：B2/B3 仅改**显示文本**，DB category 值（`gateway-recon-join` / `offset-bill-mark`）不变。

### C. 新增功能：复制场景

适用模块：**银行对账单处理** + **对账单 ReconID 修复** 的「新增/修改场景」配置弹窗（C1/C2/C3/C4）。

| ID | 需求 |
|---|---|
| **C1** | 配置弹窗右上角新增「选择」按钮，按钮左侧有文本「复制场景」 |
| **C2** | 点「选择」弹出框，框左上角文本「选择需要复制的场景」 |
| **C3**（银行对账单处理）| 框中间两个单选下拉：左框窄（左侧小号文本「银行渠道」，枚举=银行渠道），右框宽（枚举=左框所选渠道下的场景名称）。右框默认空（无显示的空值）|
| **C4**（ReconID 修复）| 框中间一个单选下拉（左侧小号文本「场景」，枚举=同类型的其他场景）。默认空（无显示的空值）|
| **C5** | 复制语义（✅ 已确认）：用所选源场景的 `config` 覆盖当前编辑场景的配置内容，**不覆盖场景名称**（避免重名）|

> 说明：「同类型」= 同 `category`。ReconID 修复 C4 当前编辑 category 为 `recon-id-fix` 时只列同为 `recon-id-fix` 的其他场景；`gateway-recon-id-fix` 同理（renderer-dialogs.js:163-171, 8160-8163）。
> 「复制场景」可用范围（✅ 已确认）：**新建和修改都可用**（新建时方便快速套用现有场景）。

### D. 功能变动：自带写死场景

| ID | 需求 |
|---|---|
| **D-1**（对应 2.2.1）| 「银行对账单处理」新增场景类别选项中**删除** `提取ReconId-From Self`（extract-recon-id）——用户不可再新建该类别。落点：ALL_CATEGORY_OPTIONS renderer-dialogs.js:6699 删除该项 |
| **D-2**（对应 2.2.2）| 新增功能类别「自带写死场景」（DB category=`builtin-fixed`）。特性：① 前端**无任何展示**（不出现在新增类别下拉、功能类别列不显示"自带写死场景"字样）；② 仅存于「通用」渠道；③ 序号固定；④ 优先级固定 0；⑤ 执行操作列仅「管理」文字按钮（无转移/删除）；⑥ 保留「是否启动」勾选框 |
| **D-3**（对应 2.2.2.1）| 点「管理」→ 弹框，左上角文本「请选择适用银行渠道」；中间多选下拉（左侧文本「银行渠道」，枚举=场景管理-银行渠道的值，默认全选），样式同「网银账单生成-模板管理-映射关系管理-维护大账号」的多币种多选下拉（renderer-dialogs.js:2086-2414）；右下角两按钮：左「保存」、右「返回」|
| **D-4**（对应 2.2.2.2）| 原内置场景「从银行对账单的信息里提取对账ID」（现 category=extract-recon-id，migrations.js:314-344）归入「自带写死场景」：置于「通用」渠道、序号固定「1」、功能类别列显示文本「银行对账单赋值自身」（**仅文本**，对应 B3 改名后的 offset-bill-mark label）、优先级 0、执行操作仅「管理」、保留「是否启动」 |
| **D-5**（对应 D2 决策）| 该场景**实际执行仍跑 `extractByFeature` 提取逻辑**（功能不变），通过执行引擎对 `builtin-fixed` 加路由实现 |

## 三、自带写死场景「适用银行渠道」的执行语义（✅ 已确认：跨渠道生效）

现状：场景按 `channel_id` **单渠道**归属；运行某渠道时，dispatcher 只拉该渠道的场景（`listByChannelIdAndCategory`，scenarios-repository.js:195-212）。

定稿语义：`builtin-fixed` 场景 channel_id 仍为 1（通用），但其「适用银行渠道」是**多选列表**；运行渠道 X 时，若 X 在该场景的适用渠道列表内**（或适用列表为空=全部）**，则该写死场景对渠道 X 生效。默认全选=对所有渠道生效（保持现有行为）。dispatcher 需据此把符合条件且 enabled 的 builtin-fixed 场景并入执行集。

## 四、验收标准

1. 银行对账单处理模块面板左右镜像；ReconID 修复模块不受影响。
2. ReconID 修复场景管理无银行渠道下拉/管理；银行对账单处理仍有。
3. 模块名显示「月度Pending数据核对」（无空格），各引用点一致。
4. 功能类别显示「网关对账单赋值银行对账单」「银行对账单赋值自身」。
5. 新增场景类别下拉无「提取ReconId-From Self」。
6. 场景列表中「从银行对账单的信息里提取对账ID」：序号 1、类别列「银行对账单赋值自身」、优先级 0、仅「管理」按钮、有启用勾选框；**运行时仍能正确提取对账ID**（功能回归）。
7. 点该场景「管理」→ 多选适用银行渠道（默认全选）→ 保存生效。
8. C1/C2/C3/C4 配置弹窗右上角有「复制场景 / 选择」；复制能正确套用源场景配置。
9. `npm run release-check` 全绿；相关 `npm run preview:*` 回归无异常。

## 五、风险提醒（人工复核）

- **数据迁移**：新增 `builtin-fixed` 到 category CHECK（重建表）+ 新建多对多表 + 把已有提取场景 category 改为 builtin-fixed。需保证迁移幂等 + 老库升级不丢数据。
- **状态机/执行引擎**：runScenario 分派 + dispatcher 按渠道选场景逻辑改动，影响银行对账单处理的实际产出，必须功能回归。
- **对外兼容**：场景 bundle 导出/导入（scenarios:export-bundle / import-bundle）需兼容新 category 与多对多表。
- 命中 `rules/important-variables.md` 的变量需走 `/check-vars`（提 PR / 版本 bump / 合并前）。
