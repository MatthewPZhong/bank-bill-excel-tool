# v2.1.16-beta.4 ③中台退款订单回填引擎（Layer 1）— 任务与待测清单

## 交付范围（Layer 1：引擎层，休眠 + 全单测）

| # | 任务 | 文件 | 单测 | 状态 |
|---|---|---|---|---|
| 1 | 跨表常量 | `src/constants/refund-backfill-fields.js` | 21 | ✅ |
| 2 | 引擎主体（4基数×4策略+JPM HK/US+反向多笔修复） | `src/main-process/scenario-engines/r5-refund-order-backfill.js` | 51 | ✅ |
| 3 | 双 sheet writer + 文件命名 | `src/main-process/refund-backfill-writer.js` / `bank-statement-io.js` | 8 | ✅ |
| 4 | orchestrator 集成 R5 场景4 | `src/main-process/reconciliation-orchestrator.js` | 7 | ✅ |
| 5 | seed（enabled=0 休眠 + 独立 marker 绕短路坑） | `src/backend/database/migrations.js` / `database.js` | 6 | ✅ |
| 6 | main.js 安全接线（run 注入 + export 双 sheet，休眠 no-op） | `src/main.js` | node --check | ✅ |

**质量门**：`npm run release-check` exit 0 — unit **1863/1863** + integration **952/952** + smoke 全过，零回归。

**对抗式验证**：矩阵工作流真跑引擎发现 3 个资金红线 bug（反向多笔/S4 顺序依赖/报错后复用），用户拍板 Q13/Q14/Q15（PRD §九 bis）后修复 + 补 10 单测。

**不在本轮（Layer 2）**：翻 `ZHONGTAI_REFUND_BATCH_ENABLED` + 实装 refundOrderSession 导入 + renderer 真提醒 → 真正端到端可手测。

---

## 待测清单（用户尚未手测项 — 累积自 beta.2 / beta.3 / 本版 beta.4）

> ⚠️ 本节合并历史欠测。自动化测试已全绿，但**真实数据 + 全链路运行导出仍需人工把关**（资金红线）。
> 来源：`changes/v2.1.16-beta.2/TASKS.md`「下版待测清单」+ beta.3 PRD §7 手测清单 + 本版 beta.4。

### A. 本版 beta.4（退款回填引擎，Layer 1 休眠）

- [ ] **A1 休眠 no-op 验证**：场景4 默认禁用（seed enabled=0）下，现有「开始运行 / 导出」行为与 beta.3 完全一致（退款引擎不执行、不产文件、行数守恒不变）。
- [ ] **A2 场景管理 UI 呈现**：场景管理列表出现「中台退款订单回填」一条，默认**禁用**状态，功能类别归「中台订单数据处理（platform-order）」。
- [ ] **A3 旧库 seed 补种**：用 beta.2/beta.3 旧库（已写 recon-round marker）启动 beta.4 → 退款场景被独立 marker 补种且 enabled=0；删除后重启不复活。
- [ ] **A4（需 Layer 2 前置）退款回填端到端**：翻门控 + 实装退款导入后，4 基数×4 策略 + JPM HK/US 用**真实退款订单 + 银行对账单 + 入金表**跑通；核对回填模板 E 列命中详情、F~N 9 列（含 Debit 无 Credit）、sheet2 两类「结果类型」、反向多笔报错不回填。**Layer 2 未做前无法手测。**

### B. beta.3（①Channel枚举 + ②银行入金表）— 自动化覆盖，未手测

- [ ] **B1 ②入金表导入端到端**：链接表弹窗「导入」选 `银行对账单.xlsx` → 识别为 bank-deposit → 裁 13 字段落库；重开弹窗第 5 行显示数据日期范围/更新时间。
- [ ] **B2 ②整表覆盖**：连续导入两份不同入金表，第二份覆盖第一份。
- [ ] **B3 ②预加工不串**：同一 `银行对账单.xlsx` 走「批量导入对账单」仍识别为主表，不落入金表。
- [ ] **B4 ①枚举沉淀**：导入含 JPM-HK 等组合的银行对账单后，查库 `channel_enum_values` 出现去重的 channel / channel-region；地区空只落 channel。

### C. beta.2（5 轮对账编排器 + R1/R4/R5 引擎）— 🔴 仅测过「场景管理列表 UI」，全链路从未手测

- [ ] **C1 🔴 5 轮对账端到端**：链接表导入网关 → 预加工导入银行对账单 → 跑 R1→R5 → 导出银行对账单 + 中台加款单剔除文件。核对：改写行标黄、行数守恒 `modifiedRows+unmatchedRows=bankRows`、剔除文件命名/落位。
- [ ] **C2 🔴 Q1 网关 TradeType 真实取值核对**：R4/R5 判定字符串是 seed 默认值（`AchReturn`/`WireReturn`/`HX_OUTBOUND`/`HX_INBOUND`/`Inbound-VA`/`FundTransfer-out·in`）。**与真实网关字面不符会静默不命中**（不报错、不改写、不剔除）。逐子场景用真实数据核对，按需改 config（不动代码）。
- [ ] **C3 C3 场景字段大小写回归**：`gateway-recon-join`（默认禁用）config 字段是驼峰、链接表 `linked_gateway_bill` 真实表头是小写，启用 C3 会匹配不上。决定：修 C3 config 还是读链接表时做字段名归一。
- [ ] **C4 「提取调拨订单对账ID」功能类别显示**：无 funcCategory 回退显示「银行对账单赋值自身」，确认是否符合预期。
- [ ] **C5 Q2–Q6 默认值核对**：R4 子场景平级 priority 序 / Charge→outbound 触发条件（仅凭有 R1 匹配）/ 剔除附言取 R4 后 FundType / `InternelFundTransfer` 拼写本版未改 / reconciliationid 大小写敏感。
- [ ] **C6（Minor）R4 同 reconid 多网关行叠加改 FundType**：脏数据下结果取决于网关行顺序（末次胜）；干净数据无影响。用真实数据确认 reconid 唯一性假设。
- [ ] **C7（Minor）网关链接表空时静默 no-op**：未导入网关对账单时 R1/R4/R5 全静默不命中、无提示。考虑加运行前提示。

### D. Self-review 发现（2026-06-08 team-lead 对抗式 self-review；无 Critical/Important，以下为 Layer2 待办 + 增强）

> 全交付 7 维度初审 + 真跑核实：核心修复（Q13/Q14/Q15）+ 字段映射 + 双 sheet 契约 + 数据隔离 + 行数守恒 + seed enabled=0 + main.js no-op 全部通过；另有 7 条初审疑点经核实推翻为误判。以下 2 条 Minor 不阻塞合并：

- [ ] **D1 🔴 Layer2 必解：`refundOrderSession` 清空对称**：三处导入 handler（`main.js:3485` 单选 / `:11344` 批量 / `:3537` 网关导入）清空了 `processingResult`/`gatewayReconSession` 但未清 `refundOrderSession`。Layer1 恒 null 不可触发；**Layer2 实装退款导入后**跨批次会残留过期退款单 → 数据污染。实装 session 时按其生命周期补对称清空 + 「多批次导入后 refundOrderSession 正确清空」集成测试。

  > **决策记录（team-lead 2026-06-08，为何不在 beta.4 当场补这 3 行）**：
  > 1. **不可触发**：Layer1 `refundOrderSession` 恒 null（门控 `ZHONGTAI_REFUND_BATCH_ENABLED=false`），缺口在本版无任何运行期影响，非合并阻塞。
  > 2. **现在补属猜测**：「该在哪几处、按什么语义清空」依赖 Layer2 退款 session 的生命周期设计（例：导入网关时该不该清退款 session、批量导入首文件 vs 后续文件如何处理）——session 写入逻辑尚未实装，此刻硬塞 `refundOrderSession = null` 是对未定语义的猜测，猜错反埋新坑。
  > 3. **正确做法 = 连同 session 写入一起做**：Layer2 实装退款导入读取/落库（写 `refundOrderSession`）时，清空点与写入点天然成对设计、同一上下文落地最稳，并补「多批次导入后正确清空」集成测试守护。
  > 结论：作为 Layer2 必解项记此，不在 beta.4 投机修复。用户 2026-06-08 认可此决策。
- [ ] **D2（增强）空 MerchantId/Currency 分组守卫**：唯一值分组键 `账号||币种||金额分` 在空 MerchantId/Currency 时可能误并组。前置筛选（SUBMITTED + Ach Return）已大幅降概率，PRD 未要求。可选：分组前加非空守卫，空值行直接入 RESULT_NOTICE。非阻塞。
- [ ] **D3 🔴 Layer2 端到端 + 真实样本回归**：翻 enabled=1 前，对「反向多笔报错粒度 / S4 超容差 10 天边界 / 锁定 refund 不复用 / JPM-US 二跳」补端到端集成测试，并用**真实 JPM 报文样本**（`//` 切断脏形态、T54SWIC/CustomerRef 提取）回归一次（当前仅标准形态单测覆盖）。

---

## 工作树污染文件（非本版交付，待用户处置）

> 源自 beta.2 dev 并行 `git stash` 误灌入（`changes/v2.1.16-beta.2/TASKS.md:113`），至今挂在工作树。本版 PR **未提交**它们。处置（保留/归档到对应分支/丢弃）由用户拍板。

- `assets/外汇期权表.xlsx`
- `docs/iterations/v2.1.12/PRD-v2.1.12.md` / `v2.1.13/` / `v2.1.14/` / `v2.1.15/PRD-v2.1.15.md` / `v2.1.16-beta.1/`
- `docs/prs/PR58-v2.1.13.md`
- `rules/doc-archive-policy.md`
- `rules/integration-test-policy.md`（已跟踪被改动；integration-runner 每次跑也会自动同步 §七）
- `scripts/perf/bench-acquiring-overwrite-delete.js`
