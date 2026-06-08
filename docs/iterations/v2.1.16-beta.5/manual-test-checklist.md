# Manual Test Checklist — v2.1.16-beta.5「JPM 调拨订单修复」

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-06-08）|
| 关联 | `PRD-JPM调拨订单修复-v2.1.16-beta.5.md` / `TECH_DESIGN-JPM调拨订单修复-v2.1.16-beta.5.md` |
| 前置 gate | ✅ `npm run release-check` 全绿（smoke + unit 1953/1953 + integration 952/952）|
| 范围 | 需求1 导入导出接线+布局 / 需求2 表库改名 / 需求3 ADM 派生 / 需求4 JPM 场景 seed / 需求5 JPM 三段匹配引擎 |

> 🔴 **资金对账敏感迭代**：本清单覆盖自动化测不到的 UI/IPC/Dialog/端到端导出，以及 PRD/TECH 标注的「实现期须核对真实数据」项（FundType 枚举、additionInfo 出账日期格式、智能路由不串引擎）。逐项打勾，发现问题记录"实际/预期"反馈 team-lead。

---

## 零、环境准备

- [ ] M0.1 当前分支 `v2.1.16-beta.5`；准备真实样本：银行对账单表(含 Channel=ADM 行)、中台调拨订单表、资金不平结果表(渠道账单含 merchantId=6300156616)
- [ ] M0.2 **数据备份**：备份 `{userData}/tool-data.sqlite`（本版有新表 `linked_adm_bank_deposit` migration + JPM 场景 seed，虽幂等不动旧表，仍建议先备份）
- [ ] M0.3 `npm start` 启动正常（无控制台报错）；migration 幂等（重启多次不报错）

---

## 一、需求1 + 布局 — 资金对账面板（GUI，~7 case）

入口：资金对账数据处理模块面板。

- [ ] M1.1 **布局**：「不平校验」行（row2）= 「导入不平表 / 导出文件」**两按钮**；面板**只有一个《开始运行》**（row1 右侧）；无第二个开始运行、无「不平校验导出」字样
- [ ] M1.2 **导入不平表**：点「导入不平表」→ 选资金不平结果表(4 sheet) → 走 `reconIdFix.import(gateway)`，弹「已导入不平表…」提示
- [ ] M1.3 🔴 **智能路由不串引擎（核心）**：先「导入对账单」(银行对账单) → 点《开始运行》→ 走**银行对账单 R1-R5 对账**（非网关）；再「导入不平表」→ 点《开始运行》→ 走**网关场景**。两者不串
- [ ] M1.4 **路由默认保守**：未导入任何文件时《开始运行》disabled；只有导入不平表后才走网关，其余情况走 R1-R5（不会误入网关引擎）
- [ ] M1.5 **开始运行（网关）**：导入不平表 + 启用 JPM 场景后点《开始运行》→ 运行已启用 gateway-recon-id-fix 场景；0 个启用→提示去场景管理启用；≥2 个→弹场景单选对话框
- [ ] M1.6 **导出文件**：运行后点「导出文件」→ `reconIdFix.export()` 导出网关对账单修复文件
- [ ] M1.7 **共用 session**：资金对账面板导入/运行/导出 与「对账单 ReconID 修复」网关子模式共用 session（在两模块间切换状态一致）

---

## 二、需求2 — 表库改名（GUI，~2 case）

- [ ] M2.1 链接表管理弹窗 → 第 5 行表库名显示「**银行对账单表**」（非「银行对账单入金表」）
- [ ] M2.2 导入银行对账单表后，导入结果明细对该表显示「银行对账单表」

---

## 三、需求3 — ADM 银行对账单链接表派生（GUI + 数据，~8 case）

入口：链接表管理 → 导入银行对账单表。前置：已导入中台调拨订单表。

- [ ] M3.1 **触发**：导入银行对账单表(含 Channel=ADM 行)落库成功后，自动派生 ADM 表
- [ ] M3.2 🔴 **FundType 枚举核对**：仅 `Channel=ADM` ∧ `FundType∈{Fundtransfer-out, Fundtransfer-out&FX}` 行进 ADM 表。**对照 `assets/FundType枚举值.xlsx` 确认字面值 byte 一致**（大小写/连字符/&FX 后缀），非目标行不进
- [ ] M3.3 **批次号**：同 ChannelOrderNo 行批次号同值 = `<规范化BillDate>-<ChannelOrderNo>`；不同日期格式输入不致批次号分裂
- [ ] M3.4 **全匹配成功**：CustomerRef 与中台「渠道流水号」一对一全对上 → 弹「ADM银行对账单链接表已创建」；调拨号/Fundtransfer-in金额已回填
- [ ] M3.5 **部分成功仍建表**：含未匹配行(中台无对应/重复) → 部分成功建表，报错框列未匹配行(批次号/CustomerRef/BillDate/ChannelOrderNo + 错误码)
- [ ] M3.6 **冲突判定**：中台侧渠道流水号重复 或 ADM 侧 CustomerRef 重复 → 判冲突、不赋值、进报错（两侧任一重复都冲突）
- [ ] M3.7 **中台表为空**：未导入中台调拨订单直接导入银行对账单表 → 报错框提示「请先导入中台调拨订单表」，ADM 表已建但调拨号/金额留空
- [ ] M3.8 **重导覆盖**：二次导入银行对账单表 → ADM 表重建（整表覆盖），已有匹配标志归零（如有 UI 提示则确认）；ADM 表不在链接表管理弹窗显示（隐藏表）

---

## 四、需求4 + 反馈2 — JPM 写死场景 + 操作列保护（GUI，~5 case）

入口：资金对账模块 → 网关对账单修复-场景管理。

- [ ] M4.1 **场景存在**：列表含「JPM调拨订单修复」，功能类别「网关对账单修复」，序号 1
- [ ] M4.2 **默认休眠**：JPM 场景默认「是否启动」= 否（enabled=0）；手动启用后才参与运行
- [ ] M4.3 🔴 **操作列保护**：JPM 行执行操作列显示「（内置场景）」只读 placeholder，**无编辑/删除/转移按钮**，不可删除
- [ ] M4.4 **批量保护**：JPM 行 checkbox disabled（不可被批量选中删除）
- [ ] M4.5 **不误伤其他内置场景**：C2/C3/builtin-fixed 等其他内置场景在主面板**仍可删可改**（D14 保持，仅 JPM/gateway-recon-id-fix 类被保护）
- [ ] M4.6 **seed 幂等**：重启 app 多次 → JPM 场景不重复插；用户删不掉(保护)，即使能删除重启也不复活(独立 marker)

---

## 五、需求5 — JPM 三段匹配引擎（端到端，~8 case）

入口：启用 JPM 场景 → 导入资金不平结果表 → 开始运行 → 导出文件。

- [ ] M5.1 **渠道账单过滤**：渠道账单 sheet 无 merchantId=6300156616 行 → 空结果 + 提示（引擎 no-op，不报错）
- [ ] M5.2 🔴 **additionInfo 出账日期核对**：渠道账单 additionInfo(真实样例 `...ATS OF 26/05/04...`) 提取 `YY/MM/DD`→`2026-05-04`。**核对真实 additionInfo 格式**；JSON 内金额(如 2100000.00)不被误当日期；提取不到的行跳过(不中断)
- [ ] M5.3 **金额整组汇总**：BillDate=出账日期 的全部 ADM 行 Fundtransfer-in金额汇总 = 渠道账单 receiveAmount(精确到分) → 命中；不等→不命中
- [ ] M5.4 **渠道匹配回写**：命中 → 组内 ADM 行资金对账ID = 渠道 reconciliationId、是否与渠道账单匹配=1
- [ ] M5.5 **批次 gating**：同一批次号(同 ChannelOrderNo)的 ADM 行「是否与渠道账单匹配」全为1 才进网关段；部分匹配不进
- [ ] M5.6 **网关匹配 + Type**：网关账单 OrderId↔ADM 调拨号 匹配 → Reference=资金对账ID；同批次号行数>1→Type=2、=1→Type=0；ADM 是否与网关账单匹配=1
- [ ] M5.7 **导出修复文件**：网关账单 Type∧Reference 有值的行 → 导出网关对账单修复文件(14 列 ORDER_REPAIR_FIELDS_GATEWAY)
- [ ] M5.8 **幂等可重入**：同一 JPM 场景连续运行 2 次 → ADM 表匹配标志/资金对账ID 幂等(不累积、不冲突)，结果一致

---

## 六、回归（~5 case）

- [ ] M6.1 「对账单 ReconID 修复」模块自身(business/gateway 子模式、C4 普通场景)配置/导入/运行/导出**不受影响**(分流仅对 JPM subCategory 生效)
- [ ] M6.2 资金对账面板银行对账单线(导入对账单→开始运行 R1-R5→导出文件)**不受影响**
- [ ] M6.3 其它链接表(网关对账单/中台调拨/外汇交割/外汇期权)导入与显示**不受影响**(ADM 表隐藏不入 listLinkedTableMeta)
- [ ] M6.4 场景管理(C1/C2/C3/C4/builtin-fixed)、银行渠道管理 等现有功能冒烟正常
- [ ] M6.5 应用启动 migration 幂等(重启多次不报错，旧数据完好)

---

## 七、累积欠测（v2.1.16-beta.2~4，随本版一起测）

> v2.1.16 beta 系列除 beta.1 已手测（批量导入/链接表/优先级，用户验证通过）外，以下自动化全绿但真实数据+全链路未手测，累积至本版一起把关。来源：`docs/prs/PR62-v2.1.16-beta.2.md` / `PR64-v2.1.16-beta.4.md` + `changes/v2.1.16-beta.2,4/TASKS.md`。

### C — beta.2 资金对账 5 轮编排器（🔴 最重，只测过场景管理 UI）

- [ ] M7C.1 **5 轮对账端到端**：链接表导入网关 → 预加工导入银行对账单 → 跑 R1→R5 → 导出银行对账单 + 中台加款单剔除文件。核对改写行标黄、行数守恒、剔除文件命名与落位
- [ ] M7C.2 🔴 **Q1 网关 TradeType 真实取值核对**：R4/R5 seed 默认值(`AchReturn`/`WireReturn`/`HX_OUTBOUND`/`HX_INBOUND`/`Inbound-VA`/`FundTransfer-out`·`-in`) 与真实网关数据字面一致；不符则**静默不命中**(已 config 化可调)
- [ ] M7C.3 **C3 字段大小写回归**：内置 `gateway-recon-join`(C3,默认禁用) config 字段(`Currency`/`Amount`/`MerchantId`/`Bank`/`reconciliationId`)与链接表真实小写表头；启用是否失效
- [ ] M7C.4 **功能类别显示**：「从银行对账单提取调拨订单对账ID」无 funcCategory 回退「银行对账单赋值自身」，确认是否要改
- [ ] M7C.5 **Q2-Q6 默认值**：R4 子场景 priority 平级序 / Charge→outbound 触发条件(仅凭有 R1 匹配) / 剔除附言取 R4 后 FundType / `InternelFundTransfer` 拼写本版不改 / reconciliationid 大小写敏感
- [ ] M7C.6 **2 Minor**：R4 同 reconid 多网关行叠加 / 网关空时静默 no-op

### B — beta.3 入金表 + Channel 枚举（自动化覆盖，未手测）

- [ ] M7B.1 **入金表导入端到端**：银行对账单表(原入金表)导入 → 落库 13 字段
- [ ] M7B.2 **整表覆盖**：重导覆盖不累积
- [ ] M7B.3 **预加工不串**：入金表与预加工导入数据源不串
- [ ] M7B.4 **Channel 枚举沉淀**：①Channel 枚举值正确

### A — beta.4 退款回填引擎（休眠，端到端需 Layer 2 前置）

- [ ] M7A.1 **休眠 no-op**：退款回填场景默认 enabled=0，不运行、不影响现有对账（零叠加风险）
- [ ] M7A.2 **场景管理 UI**：退款回填场景在列表呈现禁用态
- [ ] M7A.3 **旧库 seed 补种**：旧库升级补种退款场景 enabled=0（独立 marker）
- [ ] M7A.4 **端到端待 Layer 2**：真正退款回填端到端需翻 `ZHONGTAI_REFUND_BATCH_ENABLED` + 实装 refundOrderSession（下一轮）——**本版不可端到端测**
- [ ] M7A.5 **2 Minor(beta.4)**：D1 refundOrderSession 清空对称 / D3 真实样本端到端回归

---

## 八、case 计数与结论

| 模块 | case 数 | 通过 | 备注 |
|---|---|---|---|
| 需求1+布局 | 7 | | 🔴 M1.3 智能路由不串引擎 |
| 需求2 改名 | 2 | | |
| 需求3 ADM 派生 | 8 | | 🔴 M3.2 FundType 枚举核对 |
| 需求4+反馈2 场景保护 | 6 | | 🔴 M4.3 操作列只读 |
| 需求5 JPM 引擎 | 8 | | 🔴 M5.2 additionInfo 格式核对 |
| 本版回归 | 5 | | |
| 累积 C beta.2 | 6 | | 🔴 5 轮编排器/Q1 TradeType |
| 累积 B beta.3 | 4 | | 入金表全链路 |
| 累积 A beta.4 | 5 | | 退款引擎(端到端待 Layer2) |
| **合计** | **51** | | 本版 36 + 累积 15 |

- **未覆盖范围/需真实数据敲定**：
  - FundType 枚举字面值（M3.2）、additionInfo 出账日期真实格式（M5.2）——依赖真实样本，自动化用约定值，手测核对。
  - 网关 OrderId↔调拨号 匹配基数（决策8：每调拨号各匹配一网关行，Type=2 仅标记多行聚合）—— 用真实数据验证匹配关系符合预期。
  - 性能：ADM 派生/JPM 匹配走内存，数据量预期与现有网关对账同量级，未列性能 case。
- 发现问题 → 记录到本表 + 反馈 team-lead 修复后回归。

---

## 九、self-review 已修 finding + 遗留 F4（2026-06-08）

team-lead self-review + 2 个 Claude review agent 对抗审查（codex 网络失败改用），已修复**全部 F3 级以上 finding**，release-check 三层全绿（unit 1955 + integration 952 + smoke）。**已修**：
- **F1** JPM 无启用框（用户发现，功能不可用）→ gateway compact 加「是否启动」列，JPM 可勾选启用
- **F2** 同批次跨多出账日期时网关 Reference 取批级首行 reconId 写错（资金红线）→ 改行级 `a[资金对账ID]` + 补回归单测
- **F3a** assignBatchNo 取首个可解析 BillDate（防首行脏数据致日期段空）
- **F3b** 同出账日期多笔渠道账单 → channel-date-collision warn（防静默不平误导）
- **F3c** 资金对账《开始运行》enable 判据对齐路由 mode（消除「亮起却 abort」）
- **F-1** collectChecked 批量删除排除收窄至 builtin-fixed+JPM（C2/C3 零回归）

**遗留 F4（beta.5 当时不修；均已在 v2.1.16-beta.6 PR#65 self-review 闭环）**：
- [x] M9.1 JPM 二次运行（不重导入金表）warnings/stats 失真（导出 fixedRows / 资金对账ID **仍正确**，仅反馈"0 命中+N 警告"失真）→ ✅ **v2.1.16-beta.6 修复**：采「引擎入口重置标志真幂等」，`jpm-dispatch-order-fix.js` 在 channels>0 后整批重置三标志再全量重算 + 2 个幂等单测（非「禁用《开始运行》」——该按钮 bank/gateway 共用会误伤连跑）
- [x] M9.2 JPM seed 冲突识别正则 `/UNIQUE|constraint/i` 过宽 → ✅ **v2.1.16-beta.6 修复**：`migrations.js` 3 处收窄为 `/UNIQUE constraint failed/i`（防 FK/CHECK/NOT NULL 真实错误被误当"已 seed"静默吞掉；:1626 注释本就写「其它错误如 CHECK→抛出」，过宽正则恰好打败本意）
