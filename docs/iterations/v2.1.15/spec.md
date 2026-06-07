# v2.1.15 迭代 Spec（总纲）

> 状态：draft v0.1（2026-06-07）｜版本：`2.1.15-beta.1` → 收敛 stable `2.1.15`
> 分支：`v2.1.15`，PR 方向 `v2.1.15 → main`
> 起草方式：team-lead 起草，dev agent 分项实现（本环境经验：spec 基础件主线程直接写更稳）
> ⚠️ W0/W1/W2 = 🔴 **资金红线**（对账产出 / C3 资金对账 / 写盘时序）。实施后提 PR 前**必须跑 `/check-vars`**。

---

## 1 范围总览

| 编号 | 内容 | 风险 | 关键文件 |
|---|---|---|---|
| W0 | 收单写差异文件提速（OFFSET 深分页 → 游标遍历） | 🔴 资金红线 | `run-repository.js`、`acquiring-bill-currency-writer.js`、`scripts/perf/` |
| W1 | C3「网关账单字段」枚举改读 `assets/网关对账单.xlsx` 表头 | 🔴 资金红线 + 破坏性 | `gateway-recon-headers-loader.js`(新)、`main.js`、`preload.js`、`renderer-dialogs.js`、`gateway-recon-fields.js` |
| W2 | C3 匹配成功后把差额写入银行行 `Extra Fee` 并标黄 | 🔴 资金红线 | `c3-gateway-recon-join.js`、`c3-gateway-recon-join.test.js` |
| W3 | 「场景管理」弹窗内加「网关对账单修复-管理」入口 | 低 | `renderer-dialogs.js` |
| W4 | 去掉调色盘「切换页面风格」+ 弃用 General 风格 | 低-中 | `index.html`、`renderer.js`、`preload.js`、`main.js`、`settings-repository.js`、`database.js` |

实施编排（按文件冲突）：W0/W2/W4 可并行（独立文件域）；W1 改 `main.js`/`preload.js` 与 W4 冲突 → W4 后；W3 改 `renderer-dialogs.js` 与 W1 冲突 → W1 后。

---

## 2 W0 · 收单写差异文件提速

**根因**：`acquiring-bill-currency-writer.js:162-205` 每 segment 内 `LIMIT 5000 OFFSET k` 深分页 + `run-repository.js:648` `ORDER BY json_extract(b.raw_json,'$."账单日期"')` 无索引全排序；整月通常单 segment，offset 0→N 退化 O(N²)。

**改法（输出逐行不变）**：
- `run-repository.js` 新增 `iterateDiffRowsByDateRange(db,{runId,startDate,endDate})`：SQL body 与 `listDiffRowsByDateRange` 逐字相同，仅去掉 `LIMIT/OFFSET`，`return stmt.iterate(runId,startDate,endDate)`（`node:sqlite` 已支持，`pending-archive-worker.js:47` 先例）。
- `writeDiffWorkbook` 内层 `while(true){ listDiffRowsByDateRange(...OFFSET...) }` 换成单次 `for (const d of iterateDiffRowsByDateRange(...))`；循环体（JSON.parse + 12 列构造 + sub-sheet 切分 + addRow().commit()）、外层 segment、`planSegments`、`fmtSheetName`、sanity check、`appendSummarySheet` 全不动。

**验证**：先写 `scripts/perf/bench-acquiring-diff-write.js`（仿 `bench-acquiring-overwrite-delete.js`：AppDatabase.init 真实建库 → 灌 N=50 万 bill + 1 run + N diff_rows 全 currency_mismatch → 调真实 `writeDiffWorkbook` 计时 + 存 baseline.xlsx）。改后再测 + new.xlsx；ExcelJS 读回**逐 sheet 逐行逐列对拍一致**。索引（`bill_imports` 账单日期表达式索引）列 bench 裁决项（预判 JOIN 顺序下排序用不上 + 拖慢导入，数据说话）。

---

## 3 W1 · 网关账单字段枚举改读 xlsx 表头

**现状**：`gateway-recon-fields.js` 硬编码 `GATEWAY_RECON_FIELDS`(31 列)；`preload.js` inline 同步副本；C3 弹窗 `assign-gw`(`renderer-dialogs.js:7522`)、条件行(`:7568`)、reconFields 均用它。

**决策（已拍板）**：xlsx 为准，旧硬编码作废，**存量场景需用户重配**（不迁移）。`assets/网关对账单.xlsx`（sheet `1409155847565936642`）31 列实测：`Billdate,Channel,merchantid,orderid,bussiness,oppBu,originBillSource,billType,Type,Reference,currency,amount,originBillBizId,ReconBillBizId,reconciliationid,TradeType,Merchant_status,Credit/Debit,name,cardNo,真实渠道,清算网络,createtime,finishtime,valueDate,remark1,bookdate,fileId,AccountRef,关联单号,账单状态` —— 与旧硬编码几乎全不一致。

**改法**（复用 C2 `fund-type-enum.js` 模式 — preload sandbox 不能读文件，必须 main 读 + IPC）：
- 新建 `src/constants/gateway-recon-headers-loader.js`：读 `assets/网关对账单.xlsx` 第一个 sheet 表头行，模块级缓存 + 文件缺失降级（fallback 旧硬编码防崩，正常走 xlsx）；assets 路径解析复用 fund-type-enum（打包后 `process.resourcesPath`）。
- `main.js`：启动加载 + IPC handler `scenarios:gateway-recon-headers`。
- `preload.js`：暴露 `desktopApi.scenarios.getGatewayReconHeaders`，**移除** inline `GATEWAY_RECON_FIELDS`。
- `renderer-dialogs.js`：C3 弹窗字段枚举从同步常量改异步加载（启动 `ensureGatewayReconHeaders()` 预热，弹窗渲染用缓存）。
- **防御**：读到表头含 sentinel `__CUSTOM__` 必须报错/剔除（`gateway-recon-fields.js:9-13` 红线）。

---

## 4 W2 · 匹配成功后写 Extra Fee 并标黄

**需求**：C3 勾选「网关对账单金额与银行对账单不一致」(`renderer-dialogs.js:7538`) 后，公式「网关金额 + `extraFee.amount` = 银行金额」差额，匹配成功后写入银行行 `'Extra Fee'`(`bank-statement-fields.js:33`) 并标黄。**原值已等于差额则只锁定不标黄**（与现有 assign 一致）。

**现状**（`c3-gateway-recon-join.js`）：`fee`(`:89`) 只参与 `gwMatchesBank`(`:69-75`) 匹配，不写盘；assign 在 `oldValue===newValue` 提前 `return`(`:198-206`) 会跳过 Extra Fee。

**改法**（🔴 改 lock/record 时序）：重构 `:190-212` —— `chosen` 确定后，assign 与 Extra Fee 各自独立判断 `old!==new` 才 `record`（标黄），最后统一 `lock(rowId)` + `usedGwRowIdx.add`。assign 原值相同不再 early-return，Extra Fee 仍能写入。fee 写入格式与银行金额列一致（实现核实）。标黄自动（`record`→`_modifiedColumns`→`exceljs-writer.js` `YELLOW_FILL`）。

**验证**：扩 `c3-gateway-recon-join.test.js`：①fee 启用+匹配成功+Extra Fee 空 → 写入+标黄；②Extra Fee 原值=fee → 不 record 不标黄；③fee 未启用 → Extra Fee 不动（byte-for-byte 回归）；④assign 原值相同但 Extra Fee 需写 → 解耦正确。

---

## 5 W3 · 场景管理弹窗加网关修复入口

**落点**：`createScenariosManagerDialog`(`renderer-dialogs.js:6143`) header `scenario-channel-filter-wrapper`(`:6175`) 内、`data-action="manage-channels"`「管理」按钮(`:6181`)右侧，加 `<span>网关对账单修复</span>` + 新「管理」按钮。

**天然隔离**：wrapper 在 `isCompactView`(单类别=ReconID) 时 `display:none` → 新入口只在资金对账入口（4 类别非 compact）显示。**额外精确化**：显隐再加 `filter?.includes('gateway-recon-join')`。

**点击**：`openModal(createScenariosManagerDialog(['gateway-recon-id-fix']))`（零依赖可复用）。验证嵌套打开关闭后 reopen 回退原弹窗。

---

## 6 W4 · 去掉「切换页面风格」+ 弃用 General

- `index.html`：删 `.palette-panel-style-row`(`:432-441`) + `#cssGeneral` link(`:12`)；保留 `<body data-style="clear">` + 色谱选择器等调色盘其余功能。
- `renderer.js`：简化 `applyUiStyle()`(`:3305`) 只留 Clear；删 `handlePaletteStyleConfirm()`(`:3969`)、`maybeSyncBackgroundColorOnStyleChange()`(`:3330`)、相关元素缓存(`:351`)/事件(`:5411`)/初始化(`:1743`)。
- `preload.js`/`main.js`/`database.js`/`settings-repository.js`：移除 set-ui-style 链路；保留读取兜底。
- **持久化兼容**：启动迁移 `getUiStyle()` 读到 `'General'` 视为 `'Clear'`（无感）。
- **保守**：`src/styles.css` 不物理删，仅移除加载与切换入口。

---

## 7 验证总览

- W0：bench 加速倍数 + 新旧 xlsx 逐行对拍。
- W1：C3 字段下拉显示 xlsx 31 列；`__CUSTOM__` 防御；文件缺失降级不崩。
- W2：`c3-gateway-recon-join.test.js` 4 类用例全过。
- W3：资金对账入口显示新入口可打开 ReconID 网关场景管理；ReconID 入口不显示。
- W4：调色盘无风格切换；老库 General→Clear 迁移；无 General 残留报错。
- 全局：`npm run release-check` 全绿；前端改动重跑相关 `npm run preview`；发版前更新文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE，含 W1 破坏性告知）。

## 8 风险

- W1 破坏性：存量 C3 场景引用旧字段名全部失效（已确认采用，USER_GUIDE/CHANGELOG 显著告知重配）。
- W2 资金红线：lock/record 解耦改对账写盘行为，单测 4 类 + 回归兜底。
- W0 资金红线：差异表内容逐行不变，对拍兜底。
- W4 兼容：老用户 General 平滑迁移，不可让 `setUiStyle` 抛错。
