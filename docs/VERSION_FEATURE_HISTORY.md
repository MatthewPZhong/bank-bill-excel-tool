# 版本功能变更清单

说明：

- 本文档按版本号整理 `新增 / 变更 / 移除` 功能点。
- 内容以 [CHANGELOG.md](../CHANGELOG.md) 为事实来源整理。
- 以后每次版本迭代，需同时更新：
- `CHANGELOG.md`
- `docs/VERSION_FEATURE_HISTORY.md`
- `docs/USER_GUIDE.md`

## 1.5.3

### 新增

- **主页面「模板」下拉改为「模式」**：label 文本由「模板」改为「模式」，下拉值域收窄为两条——`制作网银账单`（默认选中，内部隐式使用 v1.5.2 的 `__FILENAME_MAPPING__`）和 `导出月度余额账单`（R1 新增）。真实模板与虚拟 ID 不再出现在主页面下拉，仅在「导出月度余额账单」模式的弹窗内出现。`制作网银账单` 模式下所有 v1.5.2 行为保留不变。
- **导出月度余额账单模式（R1）**：新增独立导出入口，点击「导出余额」弹出「请选择需要导出月度余额账单的银行渠道」对话框（模板下拉默认选中 `全部银行渠道`，另含全部普通模板；年份范围 = 近 10 年 ~ 今年+1；月份必须主动选）。完成后装配月度余额 records → 写入临时 xlsx → 再由系统保存对话框另存。文件命名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`，单文件单 sheet 合并所有模板/大账号/币种；表头固定取自 `assets/余额账单模版.xlsx`，模板未提供的字段空字符串补位。
- **Q2 最新余额定义**：优先取 `billDate === 月末最后一日` 的 seed；无则按 `billDate ≤ 月末最后一日` 取最大的一条（兜底）；全部 seeds `billDate > 月末` 或完全无 seed 则跳过该大账号（不报错）。多币种大账号按币种拆多行。
- **按钮可用/禁用矩阵**：`导出月度余额账单` 模式下 `导入文件 / 导出明细 / 账户映射` 置灰禁用；`导入模板 / 模板管理 / 导出余额` 可用。E1/E2/E3 校验（模板空 / 时间空 / 两者都空）通过 `createAlertDialog` 弹框，确认后重开弹窗保留已填值；E4 所选范围无余额记录时弹「所选模板在 {年}年{月}月的月末及更早均无余额记录，无法生成月度余额账单」。
- **自有账号合并入大账号表（R2）**：`template_big_accounts` 表新增列 `account_nature TEXT NOT NULL DEFAULT 'client'`（取值 `'client' | 'own'`）。导入银行账号信息 Excel 后，客资 + 自有都进入「维护大账号」对话框 tbody（UI 不加颜色/标识区分；view 态下 own 行 merchantView 前加 `[自有] ` 前缀，input 值保持裸 merchantId）。
- **§3.1 自有账户隔离规则（跨需求一致性约束）**：自有账户**仅在 R1「导出月度余额账单」场景参与**，其它所有场景（大账号排序、大账号选择弹框、明细账单生成、大账号检测、字段固定分配、余额管理、账户映射等）一律过滤。实现：SQL 层软过滤（`getTemplateBigAccounts` 默认只返客资；R1 装配链路显式传 `{ includeOwn: true }`）+ 维护大账号对话框初始化改走独立 IPC `big-account:get-with-own` 拿含自有的完整列表。
- **历史 own-accounts/*.json 启动迁移（D15/D16）**：启动时执行一次性幂等迁移，按 bankName 匹配模板展平 `{merchantId, currency}` 写入 `template_big_accounts`（nature='own'），冲突保留已有记录并写 `[CONFLICT]` 日志。迁移幂等 flag = `app_settings.own_accounts_migration_v1_5_3_done='1'`。迁移日志独立写 `{storageRoot}/own-accounts-migration-v1.5.3.log`。原 `own-accounts/*.json` 文件**保留不删除**，作为回退兼容。迁移失败不阻塞启动（D15），状态栏以 error tone 显示告警；orphan bankName 跳过不告警（D16）。
- **导出 xlsx 表头字体统一为 Courier New（R3）**：明细（COMMON）、余额（BALANCE）、月度余额、多模板合并文件、新开账户模块导出的 xlsx **第 1 行表头**字体统一改为 Courier New（字号/颜色/粗体/合并单元格属性保持原样）。数据区字体不变；**无 CJK 回退链**（Q10 决策，CJK 渲染依赖系统字体替换，风险由用户承担）。新依赖 `xlsx-js-style@^1.2.0`，仅在 `writers.js` 局部 `require`（其它文件仍用 `xlsx`）以减少打包体积增长；合并场景需在 `mergeGeneratedXlsxFiles` 内部局部 shadow 为 `xlsx-js-style` 并补一次字体注入，否则合并产物 styles.xml 会被 xlsx 社区版 writer 重建为 Calibri。报错 xlsx / error-reports 字体不改。
- **账单拆分合并浮点精度修复（R4/D17 hotfix）**：`buildMappedRows` 合并分支 `net = sumCredit - sumDebit` 结果套 `roundAmount(...)` 强制 2 位小数 round，吃掉 IEEE 754 浮点噪声。`2377.49 + 178.31 = 2555.80`、`65572.01 + 4917.90 = 70489.91`、`(0.1 + 0.2) - 0.3 = 0`（静默跳过合并组）等场景现在稳定输出精确值。初稿方案 `roundAmountHighPrecision`（12 位）对样本 2 不收敛，改用 `roundAmount`（2 位）覆盖全部样本。

### 变更

- **主页面 state 新增 `mode` / `monthlyBalanceReady` / `monthlyBalancePreview`**；`selectedTemplateId` 默认值改为 `FILENAME_MAPPING_TEMPLATE_ID`。`updateTemplateSelect` 重写为只同步下拉 value ↔ `state.mode`；option 改为静态 HTML（不再遍历 `state.templates` 构造）。
- **`handleExportBalance` 按 `state.mode` 三路分流**：月度余额模式未装配 → 弹月度余额导出对话框；已装配 → 调系统保存对话框另存；制作网银账单模式 → 保留 v1.5.2 原链路。切模式时清前端 `monthlyBalanceReady / preview`，后端 `lastGeneratedExports.monthlyBalance` session 保留。
- **新增 IPC**：`monthly-balance:assemble` / `monthly-balance:export` / `big-account:get-with-own`。`preload.js` 新增 `window.desktopApi.monthlyBalance = { assemble, export }` 和 `window.desktopApi.bigAccount.getWithOwn`。
- **Bundle v3 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `v3` 不升 v4。bundle 导出项 `bigAccounts[].accountNature` 字段可选携带（v1.5.2 读时忽略向后兼容；新版读旧 bundle 时缺省 `'client'`）。`groupBigAccountRows` 分组 key 扩展为 `merchantId::accountNature`，防止 client + own 同 merchantId 被错误合并。
- **`saveMappings` 透传 `accountNature`**：白名单校验 `'client' | 'own'`，非法/缺省默认 `'client'`；`expandBigAccountConfigurations` / `validateTemplateConfiguration` / `buildCompatibleBigAccounts` 同样保留字段。
- **SQL 过滤一致性（§3.1 落地）**：`listTemplates / getTemplate / listChildTemplates` 的 `bigAccountCount` 子查询加 `AND ba.account_nature = 'client'`；维护大账号对话框 `bigAccountCount` 不含自有，但 tbody 初始化另走 `big-account:get-with-own` 拿全量。
- **新开账户模块导出表头字体变为 Courier New**（D14 决策接受的副作用）：`new-account:generate` 共用 `writeBalanceWorkbook`，字体注入自动生效。

### 废弃保留

- `src/backend/own-account-store.js` + `big-account:save-own-accounts` IPC + `preload.js:bigAccount.saveOwnAccounts`：前端不再单独依赖，但过渡期**并行写**（json + 数据库同时写）以兼容旧代码路径（Q6）。原 `own-accounts/*.json` 文件保留不删除，作为 v1.5.2 回退兼容 fallback。

## 1.5.2

### 新增

- **按表头自动识别模板**：主页面「模板」下拉顶部新增虚拟枚举值「按文件名映射模板」并设为**默认**选中。导入时系统遍历所有模板，用 `matchesTemplateHeaders(filePath, template)` 逐个试表头自动匹配——用户无需在映射管理中配置任何字段（原映射管理对话框中的「按文件名映射模板」输入框模块**已删除**）。0 命中报 `FILENAME_MAPPING_NO_MATCH`、≥2 命中报 `FILENAME_MAPPING_AMBIGUOUS`，均**整批截断本次导入**；唯一命中直接按该模板解析（不再有 HEADER_MISMATCH 报错）。`filenameFixedField` 数据层保留不动（DB 列、Repo/IPC/Bundle 透传均在，只是 UI 删除，未来可能重新启用）。
- **表头唯一性校验**：导入模板文件时新表头与已有模板全量比较，完全相同则拒绝（`TEMPLATE_HEADERS_DUPLICATE`）；Bundle 导入时每个 entry 校验，重复则跳过并写 activity log 警告。确保按表头自动识别不会命中多个完全相同的模板。
- **多模板合并导出**：多个文件匹配到不同模板时，每组按各自模板独立生成（银行名称 / 所在地各自正确），合并为汇总文件：`{模板数量}-COMMON-{日期范围}.xlsx` / `{模板数量}-BALANCE-{日期范围}.xlsx`。合并方式为直接复制单元格保留格式，session 只 append 一次。
- **大账号确认页「单个账号匹多个文件」（M:1 映射）**：「提取大账号顺序」按钮右侧新增「单个账号匹多个文件」勾选框（**默认不勾选**）+ 编辑和完成**合并为 1 个 toggle 按钮**。勾选时不发生文本平移（visibility 占位），编辑态勾选 block 位置不变。完成后排序：uncovered 在前保持原序，covered 在后按组 a→z 排（组内按原文件顺序）。编辑还原：点编辑恢复原排序，保留已有映射供修改（不清空 multiGroups）。已映射 block 不参与「提取大账号顺序」，确认弹窗不显示已映射 block。左侧文件名左边新增字母列。勾选粒度 = **block**：同一文件的多个 block 可独立归属不同组或不归属任何组；支持"先左后右"与"先右后左"两种操作顺序。对话框主「完成」按 block 粒度把 `multiGroups` 展开为多条 `assignments`（key = `rowIndex`，同组多条 rowIndex 共享 MerchantId + Currency），与 1:1 部分合并后发送给后端。
- **主 / 子模板名校验**：映射关系管理「完成」按钮前置执行"子名.includes(主名)"字符串校验；勾选「设为子模板」+ 选中主模板时若当前模板名不包含主模板名，弹出提醒框「子模板与主模板模板名匹配不上，请检查。」，**整个 save 流程被阻断**，用户确认后重新打开对话框。未勾「设为子模板」或未选主模板时不触发校验。

### 变更

- **模板数据结构**：`templates` 表新增 `filename_fixed_field TEXT NOT NULL DEFAULT ''` 列（数据层保留，UI 已删除输入框）；`listTemplates` / `getTemplate` / `listChildTemplates` / `listTemplateBundleEntries` 的 SELECT 追加 `t.filename_fixed_field AS filenameFixedField`；新增 `saveTemplateFilenameFixedField(db, templateId, value)` 仓储方法。
- **Bundle v4 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `4` **不升 v5**。`filenameFixedField` 作为 v4 schema 下的透明扩展字段由 bundle 自动携带；旧 v4 bundle 导入时回退为空串；`bundleVersion > 4` 仍然拒绝。Bundle 导入时新增表头唯一性校验，重复 entry 跳过 + 日志警告。
- **大账号确认页 row 结构扩展**：`buildBigAccountSelectionRows` 每 row 追加 `fileIndex` 字段；前端新增状态机 `multiMode / multiEditing / multiGroups / pendingGroup`。
- **大账号确认页 UI**："导出当前文件"更名为"导出**当前批次文件**"；"导出所有"更名为"导出**所有批次文件**"。
- **固定模式与 M:1 互斥**：`rememberCheckbox` 与 `ba-multi-mode-checkbox` 双向 `disabled` 互斥；mode 切换时清空 `multiGroups / pendingGroup`。
- 新增 IPC `template:save-filename-fixed-field`；`preload.js` `templates` 对象追加 `saveFilenameFixedField`。
- **虚拟 ID 短路 helper**：`main.js` 与 `renderer.js` 各自定义 `isFilenameMappingMode(templateId)` helper，避免虚拟 ID 流入真实 DB 查询。

### 移除

- 映射关系管理对话框中的「按文件名映射模板」输入框模块（配置 filenameFixedField 的 UI 已删除，数据层保留）

## 1.5.1

### 新增

- **主/子模板**：模板可声明为「主模板」或「子模板」。映射关系管理 dialog header 新增「设为主模板」「设为子模板」checkbox，互斥逻辑；选「设为子模板」时出现主模板下拉框。模板管理页面新增「模板管理」标题；主模板行带 ▶/▼ 展开折叠按钮，子模板缩进显示。
- 主页面模板下拉框自动过滤子模板（只显示主模板）；文件导入时按 headers 精确匹配候选模板，在大账号选定后重建 rows。
- **账户映射按模板隔离**：`account_mappings` 表重建，以 `(template_id, bank_account_id)` 为联合唯一键；同一银行账号在不同模板下可配置不同映射。首次打开账户映射会检测迁移 flag 并弹「迁移分配对话框」引导用户将旧数据分配到具体模板。
- **账户映射 UI 调整**：表头文案「网银大账号ID」→「网银账单账户号」、「清结算系统大账号ID」→「清结算系统银行账号」；执行操作列编辑/完成切换交互，按钮左对齐；币种 ⓘ tooltip 展示说明文本；提取大账号顺序时如检测到桥接匹配 + 多币种会弹提醒框。
- **Bundle v4**：模板包导出/导入支持主/子模板关系（`parentTemplateKey`）和账户映射（`accountMappings`）。`SUPPORTED_BUNDLE_VERSION = 4`。导入时三阶段还原（模板 → 父子关系 → 账户映射）。
- **重复判定增强**：文件导入按「路径 > 文件名 > 内容（SHA-256 哈希）」三维度判重，提示框显示重复原因。

### 变更

- 移除账户映射弹框的 `noCurrency` checkbox，改为根据币种输入框值自动判断。
- 重复判定对话框改为两按钮（覆盖旧记录 / 取消本次导入），移除「保留两份」选项。
- 账户映射缺失不再阻断导入。
- Bundle v3 向下兼容（缺失字段默认空值）；`bundleVersion > 4` 的 bundle 仍然拒绝。
- `template:get-mappings` / `listAccountMappings` / `saveAccountMappings` / `listTemplates` / `listTemplateBundleEntries` 等 DB 层方法签名扩展 `templateId` / `isParent` / `parentTemplateId` 等参数。

### 移除

- 账户映射弹框的 `noCurrency` checkbox。

## 1.5.0

### 新增

- **发生额精度提升到小数点后 12 位**：`Credit Amount` / `Debit Amount` / 发生额 / 余额均支持最多 12 位小数，原始值有几位就保留几位，不补零。Excel 导出默认数字格式；有效数字超过 15 位时自动切换为文本格式保持精度。
- **「提取大账号顺序」功能**：网银账单解析大账号确认页左下角新增按钮，自动从文件识别账户号并在「确认大账号顺序」弹出页展示，支持双输入框编辑 + 精准匹配校验。「完成」按钮按条件覆盖右侧大账号顺序表。
- **「记住顺序」持久化增强**：固定模式下勾选「记住顺序」会持久化「文件个数 + 各文件账户数与账户号 + 排序」。下次导入按文件个数和账户匹配自动回显；文件数不匹配时切回「账号顺序不固定」模式；账户信息匹配不上时弹提醒框供用户选择「变更配置」或「确认」。
- **英文日期格式解析**：支持 `DD Mon YYYY`（`09 Apr 2026`）、`Month DD YYYY`（`April 9, 2026`）、以及「逗号 + 时间 + AM/PM」形式（`09 Apr 2026, 06:26:26 PM`）。
- **导入模板包同名覆盖确认**：`template:import-bundle` 在循环前扫描同名模板，用 Electron 原生 `dialog.showMessageBox` 弹确认框，避免静默覆盖。
- **使用手册导出格式扩展**：支持 `txt` / `md` / `html` 三种格式。HTML 使用 `marked` 库渲染 Markdown 后保存（新增 `marked` 依赖）。
- **指定账单实现功能**：按正负号 / 按字段区分发生额有值时出现「指定账单实现功能」勾选框 + 多选账单序号下拉。副区域有值未勾选指定时全部 Credit/Debit 禁用；勾选指定时被指定行禁用、未指定行保留行级 Credit/Debit 直接映射。

### 变更

- **模块名称**：新开账户模块按钮文本由「新开账户生成网银账单」改为「新开账户余额账单生成」。
- **大账号确认页重构**：页面标题和文案统一；主页面左右面板支持同步滚动。
- **提取大账号顺序弹框**：DOM 重构为 `.extract-scroll-container`，改为单滚动条。
- **大账号选择对话框条件单滚动条 + 文本化**：勾选「记住顺序」时切为单滚动条 + 右面板文本化只读显示；取消勾选恢复双滚动条 + checkbox 列表。
- **映射字段列位置固定**：`.concat-field-picker` / `.mapping-field-editor > button[hidden]` / `.bill-split-group-btn[hidden]` 改用 `visibility: hidden + pointer-events: none` 保留占位空间，不再因 `display: none` 导致列平移。
- **映射字段下拉框宽度固定**：`.mapping-select` 固定 `min-width: 260px; max-width: 260px`，长文本在下拉框内截断显示。
- **按正负号下拉框宽度**：`.bill-split-sub-row .mapping-select` 由 `min-width: 200px` 改为 `min-width: 260px; max-width: 260px`。
- **映射互斥补全**：发生额互斥由单向改为完整 3 选 1（按字段区分 / 按正负号 / 均无），修正空值误判为激活的 bug。
- **拼接字段预览文本截断**：移除 `.concat-preview` 的 `max-width: 200px` 硬限，截断阈值由 40 字符提升到 120 字符。
- **六列表格 UI 优化**：账单序号表头不换行；行级「完成」后 4 个 select 改为纯文本显示（表格 `table-layout: fixed` 防抖）；账单序号列抬头/数字缩进（`padding-left` 1em/2em）；维护大账号币种校验失败改为弹框提醒，不再只在状态栏显示。
- **主页面初始状态框文本**：启动文本由「已加载内置枚举表：COMMON枚举.xlsx」改为「欢迎使用小助手」。
- `roundAmount` 新增高精度版本，保留原实现兜底短精度路径。

### 移除

- 六列表格的「发生额」列（合并/拆分场景下不再需要）。

## 1.4.9

### 新增

- 映射关系管理新增「账单拆分合并管理」分组：`是否拆分/合并明细账单`（默认 `否`） + `复用模块字段的映射关系`（默认 `是`）两行开关。
- 启用 `是否拆分/合并明细账单` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额`、`按字段区分发生额` 形成 **四方互斥**。
- 新增「拆分/合并账单映射关系设置」弹框（宽度 `80vw`），用于在 `复用模块字段的映射关系 = 否` 时为非金额字段单独配置映射；右上角 `导入当前映射关系` 按钮可从主模板复制配置（自动排除 `Currency` / `Credit Amount` / `Debit Amount`）。
- 新增「拆分/合并账单映射关系管理」弹框：包含 `合并账单` 勾选框、`需要拆分成几份账单` 数字输入 + `拆` 按钮、六列表格（`账单序号` / `Currency` / `Credit Amount` / `Debit Amount` / `发生额` / `执行操作`）和副区域「拆分/合并账单——发生额映射关系管理」。
- 弹框二的合并账单 picker 为 checkbox-panel 多选样式；删除合并组内的拆分行时，会先弹出受影响合并组列表的二次确认（外科手术式解散）。
- 弹框二支持行级落库：`需要拆分成几份账单` 输入数字 N 后点 `拆` 生成 N 行，每一行的 `完成` 按钮单独锁定该行；行变只读后按钮变成 `编辑`，再点可解锁继续修改。
- 导入流程新增按弹框二配置展开 N 行输出的能力（`expandBillSplitForRow`），并按 `merged_group_seq` 分组求净值合并输出（`applyBillSplitMergeForRow`）。
- 新增 4 张 DB 表：`template_bill_split_meta` / `template_bill_split_mappings` / `template_bill_split_rows` / `template_bill_split_amount_rules`，配套 10 个 IPC handlers。
- 多文件导入时新增「以下文件全部未命中拆分/合并规则，请检查规则配置：…」聚合告警，与 1.4.8 的「按字段区分发生额」全部未命中告警平行独立。
- `Drawee Name` / `Payee Name` / `Drawee CardNo` / `Payee CardNo` 在拆分场景下按每个拆分行自己的收支方向独立分配，`reuseModuleMapping` 为 `是` / `否` 两条路径行为一致。

### 变更

- 单行拆分行的 `Credit Amount` 与 `Debit Amount` 同时为 0、或合并组净值为 0 时改为 **静默过滤** 不输出，不再报错或弹提示；合并组 `Currency` 不一致时仍然报错 `BILL_MERGE_CURRENCY_MISMATCH` 阻断导入。
- `bundleVersion` 升级到 `3`，导出 entry 新增 `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 四个字段；旧 `bundleVersion = 2` 的 bundle 按 4 张表的默认值兼容；`bundleVersion > 3` 仍然拒绝。
- `template:get-mappings` IPC 返回值补齐 `billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 5 个字段，修复冷启动后首次打开「拆分/合并账单映射关系管理」弹框只显示初始页面的 bug。

### 移除

- 无

## 1.4.8

### 新增

- 映射关系管理新增 `按字段区分发生额` 配置项（归入 `ADVANCED_MAPPING_FIELDS`，放分组末尾），下拉选项为空白（默认）/ `是`；选 `是` 时右侧出现 `发生额映射关系管理` 按钮。
- 启用 `按字段区分发生额` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额` 形成 **三方互斥**：选 `是` 自动清空并禁用另外三行；切回空白时按钮隐藏，弹框配置草稿独立保留，再切回 `是` 时回显。
- 新增「发生额映射关系管理」弹框：固定 2 行规则——一行 `当 [字段] 的值为 [输入] 时，[字段] 映射为 Credit Amount`，一行映射为 `Debit Amount`；4 个下拉框选项来自 `template.headers`，排除 `自己输入` / `需要拼接字段` 特殊值；同行内 `条件字段 ≠ 目标字段`。
- 条件值匹配规则：默认按字面值精确匹配（整串、大小写敏感、源值先 trim、不做数字归一化）；输入 `/pattern/flags` 形式按正则匹配，支持 `i` / `g` / `m` / `s` / `u` 等 JS RegExp flags；不支持多值，多值场景请用 `/^(C|CR|Credit)$/` 这类正则分组代替。
- 新增 DB 表 `template_amount_split_rules` 和 IPC `template:get-amount-split-rules` / `template:save-amount-split-rules`。
- 多文件导入时新增「以下文件全部未命中收支规则，请检查规则配置：…」聚合告警；按文件独立判定 + 跨文件聚合后弹一个合并告警框。
- 新增 `bundleVersion` 顶层字段（v2），导出 entry 包含 `amountSplitRules`；导入时 `bundleVersion > 当前支持版本` 被拒绝（v1.4.8 自身不会触发，为后续版本预埋）。

### 变更

- `saveMappings` 签名扩展为 6 参，最后一个参数 `amountSplitRules`（`null` = 保留原值，`[]` = 清空）。
- 无效正则保存时报错 `正则表达式语法错误`；同行内条件字段等于目标字段时报错。

### 移除

- 无

## 1.4.7

### 新增

- 大账号选择对话框重写为左右分栏布局：左侧按文件顺序展示，右侧按勾选序位展示，并新增搜索定位与勾选序号回显。
- 多账号账单导入新增 **账号顺序固定 / 不固定** 模式：固定模式下要求一次勾选全部大账号且按指定顺序导入，并支持「记住顺序」在下次导入时回显配置。
- 日期解析支持 BNI 点号时间格式 `HH.MM.SS`、Excel 日期序列号被字符串化后的解析（如 PAB-CN 的 `46102`）；`DD-MM-YY` 不歧义场景下 fallback 到 `MM-DD-YY`（`month > 12` 时）；`YYMMDD` 优先于 Excel 序列号识别。
- CSV 导入新增纯文本解析器 `parseCsvText`：所有值保持字符串、不过 `xlsx` 的类型推断，解决 20 位以上长数字（交易流水号）后几位被截断为 0 的问题；支持引号包裹 / 转义引号 / CRLF / LF / UTF-8 BOM。

### 变更

- 大账号对话框：`remember` 复选框在不固定模式下灰显而非隐藏；切换搜索关键字时重置选中索引；模式切换时清空搜索状态；初始化期间禁用交互；报错后保留对话框供用户重新设定。
- 新开账户模块的导出文件命名规则适配单 / 多账号场景。
- 新开账户余额账单的最晚日期改为「到昨天」。
- 全部账号 0 笔交易时直接报错 `没有账号存在交易数据`，不再进入大账号选择；修复 `identifyAccountBlocks` 空块 fallback 假块的问题。
- `MerchantId` 自动去除中间空格（如 `NRA 7101 2023 0223 63` → `NRA71012023022363`）。
- `Currency` 字段从映射对话框的多选拼接里排除，下拉不再出现 `需要拼接字段` 选项。
- `splitTemplateName` 修复多段 `-` 时的所在地取值：`BNI-ID-SG` 模板的 location 取第二段 `ID`，不再是 `ID-SG`。
- 修复 `rowsWithEmptyBlocks` 未持久化导致固定模式校验失败、空块 `sourceRowNumber` 回退值错误、元数据行被误当成数据行导出的问题。
- `xlsx` / `xls` 文件不受 CSV parser 改动影响，仍走 `XLSX` 库读取。

### 移除

- 移除映射对话框的日期格式下拉（`dateFormatSelect` 变量及 `saveMappings` 内 `dateFormat: dateFormatSelect.value` 一并删除）。

## 1.4.6

### 新增

- 新增「导入银行账号信息」入口：从 Excel 解析客资账号写入大账号表，自有账号写入独立 JSON 存储。
- 新增「余额管理」弹窗：按 `大账号 + 币种 + 日期 + 余额附加值 + 备注` 维护余额附加值；附加值会在余额导出时按 `MerchantId + Currency + BillDate` 累加注入到生成的余额账单。
- 新增 IPC channels：`bigAccount` 系列 + `balanceAdjustment` 系列。

### 变更

- 维护大账号弹窗的币种输入框小写自动转大写；多币种浮动面板溢出修复（`overflow-y: auto`）。
- 模板选择框启动时显示 `请选择模板` 占位符；未选模板时阻断导入操作；删除模板时清理相关缓存。
- 新开账户余额账单改为开户日到今天 **逐日生成**（上限 3650 天），不再只输出开户日和月末日。
- `维护大账号` / `账户映射` 等弹窗按钮新增文本溢出保护样式（`.primary-btn.small` 等）。

### 移除

- 无

## 1.4.5

### 新增

- 新开账户模块的多币种下拉新增固定搜索框，支持按币种代码、显示标签和中文名进行模糊匹配。
- 新增账号行现在会在 `银行账号` 文本右侧显示 `删除` 按钮，可直接删除当前行。

### 变更

- 新开账户模块中，`所在地` 输入框宽度缩窄为原来的三分之二，`币种` 列相应扩宽。
- 新开账户模块单币种下拉在未选择时改为空白占位，不再显示 `请选择币种`。
- 新开账户模块的多币种下拉在点击面板外空白处时会收起，并保留当前勾选结果与位序。

### 移除

- 无

## 1.4.4

### 新增

- 背景调色盘按钮右侧新增 `使用手册` 文本按钮，可将内置 `docs/USER_GUIDE.md` 另存为 `使用手册.md`。

### 变更

- 新开账户模块中的单币种输入改回下拉选择；勾选 `多币种账户` 后，币种控件会切换为带数字位序的多选下拉，并支持点击面板外空白处收起且保留已勾选结果。
- 新开账户模块在单币种切换到多币种时，会自动把原单一币种带入多选列表并标记为 `1.`；切回单币种时，会回填当前顺序中的第一个币种。
- 账户映射弹窗中的 `网银大账户ID` 文案统一改为 `网银大账号ID`，并同步更新相关校验报错文案。
- 账户映射弹窗中，`清结算系统大账号ID` 输入框宽度调整为与左侧输入框一致；其右侧新增 `删除` 文本按钮，`有账户号无币种` 勾选框移动到 `删除` 右侧。
- 版本迭代时需要固定同步更新的文档清单扩展为：`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。

### 移除

- 无

## 1.4.1

### 新增

- 网银账单生成模块支持导入 `PDF` 文件，覆盖表格式 PDF、扫描版图片型 PDF 和多页跨页续表 PDF。
- 映射关系管理支持多选源字段，并在保存时弹出多选顺序确认弹窗。
- `MerchantId = 自己输入` 场景支持多行大账号 / 币种分配弹窗，并可通过 `固定` 保存当前分配顺序和值。
- 新开账户模块支持通过 `银行账号` 右侧的文本按钮 `新增` 继续追加完整账号行。

### 变更

- 当 `MerchantId` 为固定映射且不为 `自己输入` 时，`Currency` 现在允许为空，导出的明细和余额账单也会保留空币种值。
- 应用中的币种输入统一升级为“文字输入 + 全量下拉 + 虚影补全”交互。
- 新开账户模块在多账号场景下会将所有账号合并导出为 1 份 `NEW_BALANCE` 文件，文件名中的账号部分固定写为 `多账号`。
- 左上角 GIF 缩小为当前尺寸的一半。

### 移除

- 无

## 1.4.0

### 新增

- 无

### 变更

- 这是一次内部治理与结构重构版本；之前的主要功能、导出结果和前端 UI 保持不变。
- `scripts/smoke-test.js` 按能力拆分为多个 smoke 场景与公共支持模块，继续保留 `npm run smoke` 入口。
- `src/backend/file-service.js` 拆分为文件读取清洗、标准化、行映射与写出等后端子模块，对外 API 保持原样。
- `src/backend/database.js` 拆分为迁移、模板仓储和设置仓储等内部模块，`AppDatabase` 继续作为门面层对外提供原有方法。
- `src/main.js` 中的账单导入会话和导出聚合逻辑被提取到独立模块，主进程入口更聚焦于装配和流程协调。
- 渲染层中的弹窗工厂与 preview 逻辑拆到独立脚本中，界面布局、按钮位置、文案与交互顺序保持不变。

### 移除

- 无

## 1.3.5

### 新增

- 网银账单生成模块支持一次导入多个原始账单文件。
- 同一模板在当前软件打开期间已导入过 2 次及以上时，点击 `导出明细` / `导出余额` 会弹出“导出当前文件”或“导出所有”的选择框。

### 变更

- 混合币种账单不再因为 `Currency` 多值而无法生成余额账单；系统会按币种分别计算余额，再把所有币种结果整合到同一个余额文件、同一个 sheet 中导出。
- “导出当前文件”明确表示“当前这次导入批次”，“导出所有”明确表示“当前软件打开后该模板导入过的全部文件”；统计范围只按模板，不再按大账号 / 币种拆分。
- 导出所有时，多个大账号和多个币种会整合到同一个 COMMON / BALANCE 文件里，导出文件名不再带大账号。
- 主模块余额文件命名中的 `Balance` 统一改为 `BALANCE`。

### 移除

- 无

## 1.3.4

### 新增

- 无

### 变更

- 修复多大账号模式下，导出明细和余额文件中的 `MerchantId / Currency` 会严格使用本次选中的 `大账号 / 币种` 组合，不再把内部固定标记写进导出文件。
- 原始网银账单自动清洗增加表尾汇总区过滤，`总收入笔数 / 总收入金额 / 总支出笔数 / 总支出金额` 之后的汇总行不再进入明细和余额链路。
- 收紧日期兜底解析，`0 / 1 / 0.00` 这类值不再被错误标准化成日期；首次确实缺少上一账单日余额时，会重新触发补录提示。

### 移除

- 无

## 1.3.3

### 新增

- 无

### 变更

- 映射关系管理中，`MerchantId` 选择 `自己输入` 后改为直接由“维护大账号”接管 `MerchantId + Currency`；当只维护出 1 条 `大账号 / 币种` 组合时，导入时会自动直通，不再弹选择框。
- `Currency` 行全局移除 `自己输入` 选项；在 `MerchantId=自己输入` 模式下，`Currency` 行直接隐藏，最终值取自“维护大账号”里的币种配置。
- 映射关系管理保存失败时，系统会先弹出错误提示，确认后回到原编辑内容继续修改，不再丢失当前草稿。
- 收掉了 `MerchantId / Currency` “选择自己输入后必须填写内容”的旧强校验实现，并兼容历史上使用固定 `MerchantId / Currency` 的模板配置。

### 移除

- `Currency` 的“自己输入”能力。

## 1.3.2

### 新增

- 新增版本功能变更清单文档 `docs/VERSION_FEATURE_HISTORY.md`。

### 变更

- 模板管理弹窗中，`执行操作` 标题与行内按钮组重新做了左边界对齐，底部 `导入模板文件 / 导出模板文件` 调整为右对齐按钮组。
- 模板管理中的单固定大账号摘要改为直接显示完整账户号，超长时省略显示并支持原生 tooltip 查看完整值。
- “维护大账号”弹窗新增行内 `完成 / 修改 / 删除` 状态切换，并优化多币种摘要显示规则；`修改 / 删除` 按钮组与 `执行操作` 标题左边界对齐。
- “维护大账号”弹窗中的多币种下拉改为浮层式渲染，修复展开内容被遮挡的问题。
- “新开账户生成网银账单”模块中，`银行名称 / 所在地 / 币种 / 银行账号 / 开户日期` 五个字段标签整体向右微调一个汉字宽度。

### 移除

- 无

## 1.3.1

### 新增

- 启动失败时新增系统错误框提示，并将异常记录到 `app_activity_log.txt`。

### 变更

- 修复 `1.3.0` 老版本用户升级后可能无法启动的问题；数据库迁移改为先补齐 `template_key`，再创建唯一索引。
- 补充 smoke test，覆盖旧数据库迁移和启动失败兜底行为。

### 移除

- 无

## 1.3.0

### 新增

- 网银账单生成模块支持直接导入原始网银账单，并自动定位真实表头、清理前置脏数据行、左侧脏列和右侧空尾列。
- 映射关系管理新增 `按正负号拆分的发生额`。
- 模板管理页新增 `大账号` 列、`重命名`、`导入模板文件`、`导出模板文件`。
- 新增模板库同步文件 `文档/网银账单生成小助手/templates/template-library.json`。

### 变更

- `BillDate` / `ValueDate` 导入后会自动清理时分秒、补全年月日位数，并按统一日期格式导出。
- `MerchantId` 支持维护多个“大账号 + 币种”配置，并在导入时选择本次使用的组合。

### 移除

- 无

## 1.2.13

### 新增

- 无

### 变更

- 模板管理页面中，模板列表 `执行操作` 列的行内按钮文案恢复为 `修改`；主界面入口按钮仍保持为 `模板管理`。
- 同步刷新用户使用文档，使文档内容与 `1.2.13` 的界面和导出规则一致。

### 移除

- 无

## 1.2.12

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块中，“多币种账户”文案的第二行“账户”调整为居中显示。

### 移除

- 无

## 1.2.11

### 新增

- 无

### 变更

- 统一 `Credit Amount` / `Debit Amount` 同时为 `0` 或空值时的过滤规则，这类记录会同时从明细账单和余额账单中过滤。
- 补充 smoke test，防止“明细已过滤但余额未过滤”的分叉行为再次出现。

### 移除

- 无

## 1.2.10

### 新增

- `Balance` 映射新增固定选项 `通过发生额计算`。
- 本地余额种子文件新增 `生成方式` 字段，用于区分 `账单里的余额`、`通过发生额计算` 和 `人工录入`。

### 变更

- 应用运行时所有面向用户的“模版”文案统一为“模板”。
- “新开账户生成网银账单”模块中，“多币种账户”复选框文案调整为上下两行显示。
- `app_activity_log.txt` 统一改为写入 `文档/网银账单生成小助手/`。

### 移除

- 无

## 1.2.9

### 新增

- 网银账单生成模块新增本地余额种子机制。
- 新增“因首次导入余额，请导入上一个账单日余额用于余额校验”提示状态；点击状态框可补录上一账单日日期和余额。
- 新增独立用户说明文档 `docs/USER_GUIDE.md`。

### 变更

- 余额种子文件按银行拆分保存在 `文档/网银账单生成小助手/balance-seeds/`，并支持重复录入确认覆盖。
- 当模板启用了 `Balance` 时，`MerchantId` 成为余额链路必填项。

### 移除

- 无

## 1.2.8

### 新增

- 映射关系弹窗底部新增“根据发生额做映射的户名 / 账户号”规则。
- 导出明细前新增 `Credit Amount` 与 `Debit Amount` 不能同时有值的强校验。
- 应用首次启动时会创建 `app_activity_log.txt` 记录关键操作与报错。

### 变更

- “映射关系设置”统一更名为“映射关系管理”。
- “新开账户生成网银账单”模块优化多币种下拉框宽度，开户日期默认显示为空白。
- 新生成余额账单命名规则调整为 `银行名称-所在地-银行账号-币种-NEW_BALANCE.xlsx`。
- 报错文件命名规则调整为 `YYYYMMDD-HHMMSS-模版名-错误步骤.txt`。

### 移除

- 无

## 1.2.7

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块在多币种账户场景下，导出文件名中的币种段固定输出为 `多币种`。

### 移除

- 无

## 1.2.6

### 新增

- “新开账户生成网银账单”模块新增多币种账户模式，可从 `币种映射表.xlsx` 的 C 列多选币种并批量生成多行账单。

### 变更

- “新开账户生成网银账单”模块中的开户日期默认显示为空白。
- 调色盘面板尺寸调整为 `6.8cm * 6.8cm`，“导入背景文件”按钮改为单行显示。

### 移除

- 无

## 1.2.5

### 新增

- 新增 `npm run icon:sync` 图标同步脚本。

### 变更

- Windows 安装包、portable 可执行文件、桌面快捷方式和任务栏窗口图标统一改为自定义应用图标。

### 移除

- 无

## 1.2.4

### 新增

- 无

### 变更

- 修复余额账单在“同一账单日期存在多条余额记录”场景下的推导逻辑，优先按 `上一余额 + Credit Amount - Debit Amount` 匹配期末余额。

### 移除

- 无

## 1.2.3

### 新增

- 无

### 变更

- 明细账单导出时不再保留 `Balance` 列。

### 移除

- 从明细账单导出中移除 `Balance` 列。

## 1.2.2

### 新增

- `Currency` 映射新增“自己输入”。

### 变更

- 明细账单导出时保留 `Balance` 列但不再输出该列数据。
- 若 `Credit Amount` 与 `Debit Amount` 同时为 0 或空值，对应记录不会写入导出的明细账单，并会在状态提示和报错文件中说明。
- `Balance` 字段在导入转换时会像收支字段一样清洗，仅保留数字和 `.` 后按数值参与余额账单计算。
- “新开账户生成网银账单”模块的导出文件命名规则调整为 `银行名称-所在地-银行账号-币种-新开银行账户余额录入-最早日期~最晚日期.xlsx`。

### 移除

- 无

## 1.2.1

### 新增

- 内置 `assets/币种映射表.xlsx`，用于非英文币种自动替换。

### 变更

- 网银账单生成模块主界面按钮文案调整为“模版管理”。
- `Credit Amount` / `Debit Amount` 导出前会清洗为仅保留数字和 `.`，并按数值格式写出。
- `Currency` 若不是纯英文，会模糊匹配映射表 A/B 列并替换为 C 列英文简称；匹配失败时保留原值导出并生成报错文件。

### 移除

- 无

## 1.2.0

### 新增

- 新增“新开账户生成网银账单”模块。
- 所有用户侧报错统一生成详细报错文件，状态框在有报错时支持点击导出。

### 变更

- 明细导出文件命名规则调整为 `模版名-COMMON-最早账单日期~最晚账单日期.xlsx`。
- 映射关系设置允许多个模版字段指向同一映射字段。
- `Channel` 从映射弹窗移除并改为固定取模版名称 `-` 前的值。
- `MerchantId` 新增“自己输入”模式并贯穿明细、余额及相关取值链路。
- 微调“新开账户生成网银账单”模块底部布局。

### 移除

- 从映射弹窗中移除 `Channel` 的手动映射项。

## 1.1.1

### 新增

- 无

### 变更

- 余额账单模板固定读取 `assets/余额账单模版.xlsx` 当前版本，不再回退到其他路径。
- 明细账单导出改为始终输出完整模版字段；未映射或源值为空时，字段保留且单元格留空。
- 余额账单导出改为按余额模板第一行字段动态补齐列，模板第二行及之后的旧示例数据会在写入前清空。
- 更新 smoke test，覆盖“未映射字段仍保留空列”和“余额模板额外字段保留空列”的导出场景。

### 移除

- 移除余额模板的路径回退逻辑。

## 1.1.0

### 新增

- 将 `COMMON枚举.xlsx` 作为应用内置资源随安装包分发，启动后自动加载。

### 变更

- 状态框改为展示内置枚举加载状态，不再承担枚举表导入入口。
- 更新运行说明与打包配置，移除 `init:enum` 启动前置步骤。
- 调整 smoke test，改为校验内置 `COMMON枚举.xlsx`。

### 移除

- 移除首次导入枚举表的运行依赖。
- 移除 `init:enum` 启动前置流程。

## 1.0.9

### 新增

- 无

### 变更

- 固定导出格式：`Credit Amount`、`Debit Amount` 输出为数字格式。
- 固定导出格式：`BillDate`、`ValueDate` 输出为日期格式。
- 固定导出格式：`MerchantId`、`Channel` 输出为文本格式。

### 移除

- 无

## 1.0.8

### 新增

- 新增账户映射弹窗预览图脚本。

### 变更

- 将“管理模版”和“账户映射”按钮调整为横向并排居中显示。

### 移除

- 无

## 1.0.7

### 新增

- 新增“账户映射”按钮和账户映射弹窗。
- 新增网银大账户ID校验规则。

### 变更

- 导出时若模板映射字段中存在 `MerchantId`，会按账户映射表把对应单元格值替换为清结算系统大账户ID。

### 移除

- 无

## 1.0.6

### 新增

- 无

### 变更

- 左上角 GIF 调整为距上方和左侧各 `0.5cm`，尺寸改为 `1.5cm * 1.5cm`。

### 移除

- 无

## 1.0.5

### 新增

- 无

### 变更

- 主标题字栈调整为以 `OpenAI Sans` 为首选、中文无衬线字体为回退。

### 移除

- 无

## 1.0.4

### 新增

- 无

### 变更

- 继续放大主标题“网银账单小助手”字号。

### 移除

- 无

## 1.0.3

### 新增

- 无

### 变更

- 主标题文案调整为“网银账单小助手”，并进一步增大字号。
- 左上角 GIF 调整为距上方和左侧各 `1cm`，尺寸改为 `2cm * 2cm`。

### 移除

- 无

## 1.0.2

### 新增

- 新增左上角固定循环 GIF 展示。
- 新增界面预览图生成脚本。

### 变更

- 主页面标题更新为“网银账单生成小助手”，字体调整为微软雅黑 Light 加粗并增加字间距。
- 管理模版弹窗移除标题文本，仅保留关闭按钮。
- 枚举表改为首次运行后由用户导入并持久化。
- 状态框首屏提示“请导入网银账单枚举表”，并支持点击状态框导入或覆盖枚举表。
- 仅允许导入文件名带有“枚举”的 `.xlsx` 作为枚举表，空文件或不可读文件会在状态框提示。
- 右下角版本文案改为 `Version`，字体调整为 `Courier New`。

### 移除

- 移除管理模版弹窗标题文本。
- 移除根目录静态读取枚举表的逻辑。

## 1.0.1

### 新增

- 新增 Windows `portable` 免安装打包目标。
- 新增 `npm run dist:win:portable` 和 `npm run dist:win:setup` 脚本。

### 变更

- `npm run dist:win` 默认同时生成安装版和免安装版。
- GitHub Actions 同时上传 `windows-installer` 和 `windows-portable-exe`。
- 为 Windows 主进程补充 `AppUserModelId` 设置。

### 移除

- 无

## 1.0.0

### 新增

- 初始化 Electron 桌面端应用骨架，支持 Windows 10 / 11。
- 实现自定义窗口栏、拖拽窗口、最小化 / 最大化 / 关闭。
- 实现模版导入、模版列表管理、映射关系设置与删除确认。
- 实现基于 SQLite 的模版和映射关系持久化。
- 实现 Excel / CSV 导入校验、COMMON 枚举加载、账单转换和 Excel 导出。
- 实现按日期生成输出目录与日志文件。
- 在页面右下角显示应用版本号。
- 补充版本迭代说明和版本回溯文档。

### 变更

- 无

### 移除

- 无
