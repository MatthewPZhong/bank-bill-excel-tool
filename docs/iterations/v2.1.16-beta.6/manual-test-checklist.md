# v2.1.16-beta.6 手动测试清单

> 三需求：A 导出按钮互斥 / B 预加工导出双 sheet / C 退款回填全链路开通
> 🔴 需求 C 是**资金红线**（退款单状态机 + 对账 ID 回填）——端到端手测是主要验证手段（引擎已有单测，通路靠手测）。
> 自动化覆盖：release-check 全绿（unit 1962/1962 / smoke / integration 952/952）+ 需求 B 双 sheet 单测 7 个。

---

## 需求 A：导出按钮互斥（纯 UI，靠手测 + preview）

- [ ] **A-1** 导入对账单成功后：《导入不平表》右侧《导出文件》**禁用**；《导入对账单》右侧《导出文件》在「开始运行」后可点
- [ ] **A-2** 导入不平表成功后：《导入对账单》右侧《导出文件》**禁用**；《导入不平表》右侧《导出文件》可点
- [ ] **A-3** 初始（都未导入）：两个《导出文件》都禁用
- [ ] **A-4** bank→gateway→bank 来回切：每次切换后互斥关系正确，无「两个都亮」或「该亮的不亮」

## 需求 B：预加工导出双 sheet（导出后用 Excel 打开肉眼核对）

- [ ] **B-1** sheet1 名「未命中场景」；第 1 行 A1 加粗「请检查，导入前请删除该sheet」
- [ ] **B-2** sheet1 第 2 行是表头（列名）；第 3 行起数据，`FundType=Mark without result` 的行**排在最前**
- [ ] **B-3** sheet2 名「命中场景」；命中行**仍标黄**（保留原标黄）；第一列是「命中明细」
- [ ] **B-4** 命中明细格式 `<命中场景:"场景名";"字段名";变更前:"旧";变更后:"新">`；一行改多个字段时**多段换行**显示，改前/改后值与实际一致
- [ ] **B-5** 全命中 / 全未命中边界：对应 sheet 仅含 A1 提示/表头，不报错
- [ ] **B-6** 行数守恒：未命中 sheet 数据行 + 命中 sheet 数据行 = 原始总行数

## 需求 C：退款回填全链路（🔴 资金红线，逐项核对）

### C-1 导入提醒框（规则一）
- [ ] **C-1a** 场景管理启用「中台退款订单回填」+ 走《导入对账单》只选银行对账单（不带退款表）→ 弹提醒「需补充导入中台退款订单表」
- [ ] **C-1b** 启用 + 一次多选「银行对账单 + 中台退款订单」→ **不弹**提醒，批量明细显示「中台退款订单（N 行）」
- [ ] **C-1c** 未启用退款场景 → 导对账单不弹退款提醒（回到休眠语义）

### C-2 端到端回填（启用场景 → 导两表 → 开始运行 → 导出）
- [ ] **C-2a** 导入退款订单表后落 session；开始运行后引擎产出回填行（状态框/导出反映行数）
- [ ] **C-2b** 导出退款回填文件：sheet1 = 回填模板（E 列「匹配命中详情」+ F~N 银行原数据）、sheet2 = 未匹配银行数据 + 报错信息
- [ ] **C-2c** 回填动作正确：退款单号←refund 流水号、状态→SUCCESS、渠道流水号←bank ReconId、渠道退款时间←bank BillDate
- [ ] **C-2d** 命中详情文案符合规则备注 2（两句式：bank 字段 ↔ refund 字段 / bank 字段 ↔ 入金表字段）

### C-3 四基数矩阵（每种造样本核对 回填/报错/提示）
- [ ] **C-3a** 1:1 — S1~S4 命中即回填；S4 日期差 >10 天报错
- [ ] **C-3b** 1:N — 多笔报错-人工介入；关联不到的 refund 不更新并提示
- [ ] **C-3c** N:1 — 关联到多笔报错；关联不到的银行数据提示
- [ ] **C-3d** N:N — 严格 1↔1 互配；正向/反向多笔报错，refund 锁定

### C-4 JPM 特殊分支
- [ ] **C-4a** JPM-HK：Extra Information/Payment Detail 清洗 `//` → 提 `T54SWIC+6位` → 匹配 refund 银行打款流水号（单字段，Q7）→ 回填
- [ ] **C-4b** JPM-US：refund 银行打款流水号 → 入金表 ReconId/ChannelOrderNo → CustomerRef ↔ bank CustomerRef → 回填

### C-5 不串/隔离
- [ ] **C-5a** 退款回填不影响 R1-R5 主对账（modifiedRows 不含退款回填行）
- [ ] **C-5b** 重导退款订单表 → refundOrderSession 整体覆盖（不追加）
- [ ] **C-5c** 🔴 跨批不复用（PR#65 Finding1）：batch1（银行对账单A + 退款X）运行后 → batch2 只导银行对账单B → run **不应**注入旧退款 X
- [ ] **C-5d** 🔴 运行后补导退款（PR#65 Finding1）：运行一次后再导退款订单表 → processingResult 清空、导出强制重新运行，**不用**旧 refundBackfill
- [ ] **C-5e** 同批顺序无关（PR#65 Finding1）：一次多选「退款订单 + 银行对账单」，**无论文件顺序**，退款 session 都是本批的（不被银行对账单分支误清）
- [ ] **C-5f** 🔴 ADM 重建清 JPM 结果（PR#65 Codex FindingB）：run JPM 后经链接表管理重导银行对账单表（ADM 重建）→ export 强制重新 run，**不用**旧 ADM 内容的 stale gateway fixes
- [ ] **C-5g** 🔴 mid-allocation 触发 ADM 重建（PR#65 新Finding1）：先导银行对账单表、后导（或重导）中台调拨订单表 → ADM 调拨号/金额刷新为新值 + 弹 ADM 派生框 + 清 JPM 结果；随后 run JPM 读到新 ADM（非 stale）
- [ ] **C-5h** mid-allocation 边界（PR#65 新Finding1）：① 未导银行对账单表时导中台调拨订单表 → **不**重建 ADM、不清 reconIdFixResult（无 bank 源）；② 一次多选「银行对账单表 + 中台调拨订单表」→ ADM 派生弹框 stats = 最后一次重建（与 DB 最终态一致，非首个文件旧态）
- [ ] **C-5i** 单文件 import 清退款 session（PR#65 新Finding2）：经 `bankStatement.import()` 单文件入口导银行对账单（非批量）→ 旧 refundOrderSession 被清；随后 run 不注入上一批退款订单（注：当前 UI 走 batchImport，此为 legacy IPC 防御）

---

## 回归
- [ ] release-check 全绿（PASS/FAIL 源）
- [ ] `npm run preview`（前端改动：需求 A/C 动 renderer.js）
