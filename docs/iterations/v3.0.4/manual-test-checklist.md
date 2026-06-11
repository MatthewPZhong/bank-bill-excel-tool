# v3.0.4 手动测试清单

> 汇总六块（A JSZip 止血 / B pending 引擎 / C biz-op flow 引擎 / D 银行对账输出三修复 / E BOC调拨订单修复 / F Payment线下调拨回填）的手测项。
> 来源：四份 spec 手测段（`changes/v3.0.4/spec.md` §2.3/§4.3/§5.3、`changes/bank-recon-output-fixes/spec.md` §9.3、`changes/boc-dispatch-order-fix/spec.md` §9.3、`changes/payment-offline-allocation-backfill/spec.md` F7/§5）。
> 🔴 = 资金红线项，**必须用真实数据人工核对，不得仅看自动化绿**。
> 顺序建议：先跑各块独立项，资金红线（块 D/E/F）放真实样本核对窗口集中做。

---

## 块 A — JSZip 崩点止血 + 报错可见性

- [ ] **98w 行实证文件重导**：导入此前撞崩（`uncompressed data size mismatch` 天书）的 98 万行 / ≈2.56GB 链接表 xlsx → 弹**明确中文错误**（含「表格内容解压后约 X.XX GB，超出当前导入通道单文件上限（2GB）」「请拆分为约 80 万行以内/文件」），不再是 JSZip 天书报错
- [ ] **日志可查**：上一步报错后到 `Documents/网银账单生成小助手/logs/{年-月}/{月-日}/` 查 error 级日志条目存在（含 entry 名与字节数）
- [ ] **正常文件不误伤**：≤2GB 的链接表文件导入正常通过（预检 fail-open 不引入误伤）
- [ ] C3 / 运行前提醒两入口导入链接表失败时 → 弹 per-file 失败明细 alert（用户不再完全无感）

## 块 B — pending 挂账导入迁移大表引擎 🔴🔴

- [ ] **大文件导入期间 UI 流畅**：导入大 pending 文件期间主进程零阻塞、窗口可交互（W4 属性不回退）
- [ ] **取消**：导入中点取消 → <5s 内中止、无残留半批数据
- [ ] 🔴 **覆盖重导联动清理（R-1 人工复核）**：对同一 `yearMonth` 覆盖重导 → 确认 `diff_runs` / `removed_pending_rows` / `pending_removal_matches` / `diff_rows` / `pending_rows` / `pending_months` 六表按顺序联动清理，无旧归档残留（残留会让 reconcile 用陈旧数据错标核对结论）
- [ ] **回退开关验证**：env `PENDING_FORCE_LEGACY_IMPORT=1` 启动 → 导入走旧 utilityProcess + worker.js 链路，结果与引擎路径一致
- [ ] **多 sheet 文件报错（divergence）**：导入含多个 sheet 的 pending 文件 → 引擎 rels 正解**明确报错**（不再静默读第一个 sheet）；报错文案可读
- [ ] **错误超 1000 截断**：导入含 >1000 错误行的文件 → 错误报告 xlsx 截断计数语义正确（带 cells）

## 块 C — biz-op flow 流水导入迁移大表引擎 🔴

- [ ] **多文件合并导入**：一次多选多个流水表文件 → 合并入库到该日期、UI 流畅
- [ ] **取消 / 整批拒绝**：行级校验错 → 整批拒绝（全 ROLLBACK），错误报告 xlsx 含 rawRow
- [ ] **回退开关验证**：env `BIZOP_FLOW_FORCE_LEGACY_IMPORT=1` → 走旧 import-worker.js 链路，结果一致
- [ ] **业务OP 侧不受影响**：bizOp（业务OP）侧导入仍走旧链路、零回归（OPEN-1 不迁）

## 块 D — 银行对账输出三点修复 🔴（一次 /verify 覆盖三点终态）

> 准备样例：同时产生 warnings + C3 extraFee 命中的真实银行对账单 + 网关对账单。

- [ ] 🔴 **F1 主输出 Extra Fee 取反**：勾选「金额不一致」填差额（如填 `5`）→ C3 对账成立后主输出 `Extra Fee` 列写**相反数**（`-5`）+ 单元格黄底 + 命中明细文本含负值记录（匹配语义不变，仍按原差额匹配成功）
- [ ] 🔴 **F1 三出口符号一致**：核对同一份真实样本 → 主输出 / 命中明细文本 / 命中场景行报表三个出口的 Extra Fee 符号**全部为取反值**、彼此一致
- [ ] 🔴 **F1 负输入对称**：差额填 `-3` → 写 `3`；填 `0` → 写 `0`（不出 `-0`）
- [ ] **F2 目录互换 — 错误报告**：`error-reports/{date}/{ts}-error-report.xlsx` 存在（从 bank-statement-process 移来）
- [ ] **F2 目录互换 — 命中场景行**：`bank-statement-process/{date}/命中场景行-*.xlsx` 存在且 Extra Fee=取反值（从 error-reports 移来）
- [ ] **F2 cancel 路径**：导出时点取消（saveDialog 前已落盘）→ **查文件系统**确认 error report 落新目录 `error-reports/{date}/`（UI 无任何提示，只能查文件夹）
- [ ] **F3 对账ID列**：打开 error-report → 第 3 列表头=**对账ID**；有 ReconciliationId 的行显示对账ID值，空值行回退显示 `row_N`

## 块 E — BOC调拨订单修复 🔴（boc spec §9.3 全部）

- [ ] **场景管理列表**：「网关对账单修复-场景管理」中「BOC调拨订单修复」显示为**序号 2** / 只读行（操作列仅「管理」）/ **默认未启用**
- [ ] **三序导入收敛一致**：fx（外汇交割表）→ bank（银行对账单表）→ fx 三序导入 → BOC链接表结果收敛一致
- [ ] 🔴 **单 sheet .xlsx 交割表走数组路径**：导入单 sheet .xlsx 外汇交割表 → 确认走**数组路径**（非流式，分组依赖物理行号不丢）；分组/调拨单号正确派生
- [ ] **缺银行数据弹引导框（两路）**：链接表库无 BOC 银行数据时导入交割表 → 弹「是否现在导入 BOC 银行对账单」引导框；分别测「导入」→ 复用链接表导入流程、「取消」→ 关闭
- [ ] **missing-payment-detail 重导引导**：用旧 13 字段时代导入的 bank-deposit（无 Payment Detail）→ 弹**重新导入**银行对账单表的引导文案
- [ ] **activity log unlinked 明细**：链接ID 有空值时 → activity log 出现 unlinked 明细（含行号/交易编号），**前端无任何显示**
- [ ] 🔴 **修复引擎端到端**：启用「BOC调拨订单修复」场景 → 导入资金对账不平表（gateway 模式）→ 运行 → 弹框逐条显示失败文案（前 5 条 + 「等 N 条，详见操作日志」）→ 导出另存为 → 人工核对一份真实样本输出：14 列 / Type=2（number）/ Reference=组内行链接ID / Amount=组内行货币1金额、11 列从网关源行同源
- [ ] 🔴 **整组失败语义**：构造组级校验失败（调拨单号不一致 / OrderId 0 或 ≥2 命中 / 链接ID 空）→ 该组整组**不产出、不消耗渠道行**

## 块 F — Payment线下调拨订单回填 🔴（payment /verify 路径）

- [ ] **UI 勾选 + 三输入框**：R5 场景2「请选择适用的银行渠道」弹窗 → 勾选「Payment线下调拨订单回填处理」→ 展开「银行渠道 / 地区 / 大账号」三组 label+输入框（独立多行布局）；取消勾选保留输入值；三项全必填、inline 校验不关弹窗；加载完成前保存禁用
- [ ] **config 持久化**：填三输入框保存 → 重开弹窗回填一致；🔴 确认 config 浅合并**未丢** funcCategory/subCategory/roundPhase/directions/dateToleranceDays（场景仍在 r5s2 桶）
- [ ] 🔴 **导两表 + run + 三出口**：勾选启用 → 导入中台调拨单表 + 导入银行对账单 → 开始运行 → 核对三出口：①命中行 ReconciliationId 回填+标黄（渠道流水号写入）；②差错池二轮匹配生效；③未匹配行进 error-report
- [ ] 🔴 **双引擎互斥**：确认 R5s2（网关回填）先跑、其消费/回填的银行行不被 R5s2b 触碰（无重复写 / 无互相覆盖）
- [ ] **周数边界**：用跨年样本（如 2025-12-29 / 2027-01-01 附近）核对周标签与「+1」日期语义不错配
- [ ] 🔴 **stale 拒导出**：先 run 出结果 → 重导中台调拨单表 → 直接导出**被拒**（processingResult 已清，防 stale 资金数据导出）
- [ ] **preview 截图**：`npm run preview:builtin-fixed-channel-manage` + `preview:builtin-fixed-channel-manage-payment`（展开态）无布局回归

---

## 块 G — Charge转outbound 多行取 Debit Amount 最大行 🔴

- [ ] 🔴 **多行桶只转最大行**：构造/选取同一 ReconciliationId 关联多条 `FundType='Charge'` 行（Debit Amount 不同）的真实样本 → 运行资金对账处理 → 主输出中**仅 Debit Amount 最大那行** FundType 改为 outbound 并标黄，其余 Charge 行保持原值不标黄
- [ ] **单行桶行为不变**：同 reconid 仅一条 Charge 行 → 照常转 outbound（与 v3.0.3 一致）
- [ ] **并列最大取首行**：两行 Debit Amount 相同 → 文件原序靠前那行转，靠后不转
- [ ] **其余子场景不受影响**：ach-return / hx-out 等同桶多行仍逐条全转（抽一例核对）
- [ ] **链式联动**：被选中行可继续 outbound→HX-out；未选中 Charge 行不进 HX-out 链（对照升级前后 HX-out 行数变化与预期一致）

---

## 收口守卫（非手测，留档对照）

- [ ] `npm run release-check` 全绿（smoke + unit + integration 三层）
- [ ] `npm run scan:vars` + `/check-vars` 硬节点产出（命中 linked-table / scenarios / recon-id-fix / 大表引擎域）
- [ ] `npm run preview`（动了 renderer-dialogs.js / renderer.js 的块 E/F）回归无布局回归
