# 中台退款订单回填 — 规则原文 + 现有引擎 GAP 核对（v2.1.16-beta.6）

> **来源**：用户 2026-06-08 提供的完整业务规则，逐字存档。
> **定位**：需求 C 的**权威 spec**（Spec is Truth）。与代码冲突时以本文为准；但 beta.3/4 已拍板的 Q1~Q15 决议对原文的精化/裁决以决议为准（见 §三 标注）。
> **关联**：[PRD-v2.1.16-beta.6.md](./PRD-v2.1.16-beta.6.md) §四 需求 C；引擎 `src/main-process/scenario-engines/r5-refund-order-backfill.js`（595 行，已实现）。

---

## 一、规则原文（用户提供，逐字）

**一、** 启用该功能时，导入文件时需弹出提醒框，提醒需要导入中台退款订单表，如果用户导入文件时带有该表（通过识别表头），则不弹出提醒。

**二、** 导入的中台退款订单表（下文统称 refund order 表）里，状态为 SUBMITTED 的行数据参与对账。

**三、** 所有银行对账单中 fundtype 为 Ach Return 的数据，筛选掉 Fundtype 值变更过的行数据后，其他的行数据参与对账。

**四、** 先通过渠道大账号+金额+币种作为唯一值，分别捞出银行对账单和 refund order 满足条件的数据。

### 备注
1. 退款回填动作统一为：将银行对账单的 ReconciliationId 回填到退款模版的"渠道流水号"字段中、将银行对账单的 billdate 回填到退款模版的"渠道退款时间"字段中，将 refund order 表的"流水号"回填到退款模版的"退款单号"字段中、状态字段更新为 SUCCESS，并记录匹配命中详情。
2. 匹配命中详情的文本规则：`<匹配成功:"银行对账单哪个字段里的什么信息"匹配上了"refund order里的哪个字段的什么信息">` or `<匹配成功:"银行对账单哪个字段里的什么信息"匹配上了"银行对账单入金表里的哪个字段的什么信息">`
3. 导出文件的第一个 sheet 取中台退款订单回填模板.xlsx，E 列为"匹配命中详情"，该字段的值取退款回填动作里记录的匹配命中详情；第 F 列开始放对应银行对账单原数据。第二个 sheet 放未匹配上的银行对账单数据和报错信息。
4. MTX 加款单数据格式：`<MTX+19位数>`。

### 1. 银行对账单和 refund order 的唯一值"大账号+金额+币种"只有一笔（1:1）
- **S1 渠道流水号**：refund order 取"银行打款流水号"作关联 ID 查银行对账单，若关联到 ChannelOrderNo 或 CustomerRef，则执行退款回填动作。
- **S2 附言提取**：从银行对账单 Extra Information 提取带 MTX 的加款单信息，匹配 refund order 附言，匹配上则回填。
- **S3 付款人/卡号/虚拟卡号**：refund order 取付款人名称/付款卡号/虚拟卡号作判断 ID 查银行对账单，关联到 Drawee Name/Drawee CardNo/Payee CardNo 则回填。
- **S4 金额币种日期**：金额+币种关联，比对银行 billdate 与 refund valueDate（起息日），差异 ≤10 天则优先取最接近的回填；>10 天报错人工判断。

### 2. 银行=1 笔、refund=多笔（1:N）
- **S1**：refund 银行打款流水号查银行；若只 1 笔且关联到 ChannelOrderNo/CustomerRef → 回填，关联不到的 refund 不更新并提示；若多笔 → 报错人工介入。
- **S2**：银行 Extra MTX 匹配 refund 附言；只 1 笔 → 回填，关联不到的 refund 不更新并提示；多笔 → 报错。
- **S3**：refund 付款人/卡号/虚拟卡号查银行；只 1 笔且关联到 → 回填；多笔 → 报错。
- **S4**：金额+币种；refund 只 1 笔 → 比 billdate/valueDate ≤10 天取最近回填；refund 多笔 → 同样 ≤10 天取最近回填；>10 天报错。

### 3. 银行=多笔、refund=1 笔（N:1）
- **S1**：refund 银行打款流水号查银行，关联到 ChannelOrderNo/CustomerRef 只 1 笔 → 回填，关联不到的银行数据提示；关联到多笔 → 报错。
- **S2**：银行 Extra MTX 匹配 refund 附言；银行只 1 笔且匹配上 → 回填，关联不到的 refund 不更新并提示；银行多笔 → 报错。
- **S3**：refund 付款人/卡号/虚拟卡号查银行，只 1 笔且关联到 Drawee/Payee 且银行只 1 笔 → 回填；关联到多笔 → 报错。
- **S4**：金额+币种，refund 只 1 笔，按银行 billdate 早→晚顺序，先从最早 billdate 关联 refund，≤10 天取最近回填，多出的 refund 不更新；>10 天报错。

### 4. 银行=多笔、refund=多笔（N:N）
- **S1**：refund 银行打款流水号查银行；若打款流水号只 1 笔且关联 ChannelOrderNo/CustomerRef 只 1 笔 → 回填，关联不到的银行提示、关联不到的 refund 不更新并提示；若打款流水号多笔且关联 1 或多笔、或打款流水号 1 笔但关联多笔 → 报错。
- **S2**：银行 Extra MTX 匹配 refund 附言；银行只 1 笔且关联 refund 只 1 笔 → 回填，关联不到 refund 不更新并提示；银行多笔且关联 1 或多笔、或银行 1 笔且关联多笔 → 报错。
- **S3**：refund 付款人/卡号/虚拟卡号查银行；refund 只 1 笔且关联 Drawee/Payee 且银行只 1 笔 → 回填；refund 多笔且关联银行 1 或多笔、或 refund 1 笔且关联银行多笔 → 报错。
- **S4**：金额+币种，bank/refund 均多笔：若银行条数 < refund 条数，按银行 billdate 早→晚先从最早关联，≤10 天取最近回填，多出 refund 不更新；若银行条数 > refund 条数，同样按 billdate 早→晚关联，≤10 天取最近回填；>10 天报错。

### 五、银行对账单 Channel=JPM 时，S2 附言提取增加匹配逻辑
1. **JPM + 地区=HK**：先将银行对账单 Extra Information 和 Payment Detail 里的 `//` 清洗掉，然后提取对应流水号（格式 `<T54SWIC+6位数>`）；若可提取到，用该流水号去遍历 refund order 的所有字段信息，匹配上则执行退款回填动作。
2. **JPM + 地区=US**：取关联到的 refund order 表的"银行打款流水号"的值，去链接表里的「银行对账单入金表」匹配 ReconciliationId 和 ChannelOrderNo，匹配上则取该行 CustomerRef 的值与导入的银行对账单的 CustomerRef 的值匹配，匹配上则执行退款回填动作。

---

## 二、GAP 核对结论（现有引擎 vs 规则原文，2026-06-08 审查）

**吻合度：中—偏高**（引擎算法层高；端到端通路层低，因通路未通电）。

### ✅ 已正确实现（引擎层）
- 规则二/三/四（SUBMITTED 筛选 / Ach Return 且未被 R4 改写 / 大账号+金额+币种唯一值分组）：`r5-refund-order-backfill.js:299-331`
- 备注 1/2/3/4（回填动作 / 命中详情两句式 / 双 sheet / MTX 格式 `MTX\d{19}`）：`buildBackfillRow:90` / `detailBankToRo:82` / writer
- 4 基数 × 4 策略 16 格 + JPM HK/US：`runStrategiesForGroup:400` / `matchS1~S4` / `matchJpmHk:157` / `matchJpmUs:183`
- 字段映射全部一致：`constants/refund-backfill-fields.js`
- 导出 writer（E 列命中详情 + F~N 银行 9 字段 / sheet2 未匹配+报错）：`refund-backfill-writer.js`

### 🔴 唯一大缺口：整条通路未通电（本迭代 P0 主体）
- 门控 `ZHONGTAI_REFUND_BATCH_ENABLED=false`（`main.js:11305`）→ 退款导入被 `disabled` 跳过（`main.js:11459`）
- `refundOrderSession` 恒 null（`main.js:295`）→ 引擎入参硬桩 `[]`（`main.js:3608`）→ 引擎休眠
- **规则一「导入提醒框」完全未实装**（前端无对应代码）

### ⚠️ 规则原文 vs 现有代码的差异（本轮已拍板）
| 项 | 规则原文 | 现有代码 | 本轮决策 |
|----|---------|---------|---------|
| JPM-HK 匹配范围（C-4） | 遍历 refund **所有字段** | 仅比 refund「银行打款流水号」**单字段**（Q7） | **维持单字段（Q7）**，引擎零改 |
| 导出 sheet1 模板（E-1） | 取「中台退款订单回填模板.xlsx」 | 代码重建表头（A~D 对齐 + 新增 E/F~N） | **维持代码重建**，writer 零改 |

### 知会（引擎比规则原文更保守，已由 Q13/Q14/Q15 背书，无需改）
- 反向多笔报错（Q14）、报错链路 refund 锁定退出 S4（Q15）、S4 冻结快照 minDayDiff 判据（Q13）

---

## 三、结论

引擎/writer/字段映射**零改**。本迭代需求 C = 开通通路（P0-1~P0-3）+ 前端导入提醒框（P0-4，规则一新需求）+ 端到端测试。详见 PRD §四 + §七 PR 拆分。
