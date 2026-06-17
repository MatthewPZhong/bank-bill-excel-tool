# 用户手册去技术术语 Playbook（USER_GUIDE 零术语化）

> 沉淀自 2026-06-17 v3.0.8「整个手册技术术语审一遍删一下」全册清理（567 处替换）。
> 适用：每次新写 / 改 `docs/USER_GUIDE.md` 章节，或用户要求"清理术语 / 看不懂"时套用。

## 核心原则

1. **读者是业务 / 财务，不是工程师**：一切代码 / 工程概念翻成"软件里看到的操作"。
2. **只去术语，不删功能信息**：替换措辞，不删功能说明。
3. **软件界面真实文字 / Excel 真实列名 / 数据真值必须保留**（删了用户对不上屏幕），但旁边配中文解释。

## 禁用词清单（出现即清 → 业务白话）

- **工程概念**：IPC、handler、接口 / 通道、session / 会话、orchestrator / 编排、dispatcher / 调度、worker、async / 异步、事件循环、setImmediate、谓词、门控、normalize / 归一化、二跳、下推、仓储 / repository、payload、structuredClone / 深拷、RSS / 内存尖峰、字节级、golden、migration / 迁移（升级语境）、seed、state machine / 状态机、VACUUM、JSON Lines、subset-sum、saveDialog / confirmDialog / dialog
- **数据结构**：sheet、字段（→ 列）、字段映射 / 列映射、snake_case、raw_json、json_extract
- **内部标识**：轮次编号 R1/R2/R3.5/R5s2/R5s3、"5 轮对账"、first-match-wins、builtin-fixed、scenario.category
- **工程标记**：🔴资金红线、PR#NN、"需求 N"、"块 A/B"、"D-1"、"OPEN-x"、版本需求编号

## 保留清单（保留 + 配中文解释）

- **软件界面真实按钮 / 弹窗 / 场景名**：导入文件、导出文件、链接表管理、场景管理、开始运行、网关对账单修复、BOC调拨订单修复、迁移分配对话框 等
- **Excel 真实列名**：Credit Amount、Debit Amount、Remark-BU、Type、Reference、Amount、SubBizType、BizType、OrderId、ReconBillBizId、对账ID（ReconciliationId 作正文叙述时清、作真实列名引用时保留）等
- **渠道 / 数据真值**：ADM、BOC、JPM-US、DBS、CITI、BGL、Inbound、Inbound-VA、Ach Return、FundTransfer-in/out、FundType 取值等
- **故障排查给维护人员的真实命令**：sqlite3 / jq 命令、settings-key、环境变量名（用"给维护人员看"括注隔离）

## 统一术语译法表（保持全册一致）

| 术语 | 译法 |
|---|---|
| sheet | 工作表 / 表格的某一页 / 第一页 |
| 字段 | 列；字段映射 / 列映射 → 列的对应关系 |
| 链接表 | 「链接表管理」里保存的参考数据 |
| FundType | 资金性质 |
| Channel | 渠道 |
| migration（升级语境） | 升级 / 结构升级（仅真实 UI 名「迁移分配对话框」「自有账号迁移失败」保留"迁移"） |
| fallback | 对不上时再用…兜一道 / 留到最后兜一道；字体语境 → 自动改用…显示；设置非法值 → 自动回退默认 |
| worker / 后台进程 | 后台运算 / 放到后台单独跑；cold-start → 自动重新起一个后台运算 |
| first-match-wins | 谁先命中用谁 |
| 1v1 / N:1 / 1:N | 一对一 / 多对一 / 一对多（规则表 label、匹配模式控件名里的 1v1 保留） |
| orchestrator / 轮次 | 对账的某一步 / 运行流程 |
| normalize / 归一化 | 统一格式 |
| golden / 字节一致 | 和以前结果一样 |
| raw_json | 原始数据 / 原始明细 |
| saveDialog | 另存为窗口；confirmDialog / dialog → 弹窗 / 窗口 |

## 执行流程（ultracode workflow）

1. **并行分段只读审查**：USER_GUIDE 按大节（`##`）分 ~6 段，每段一个只读 agent，产出精确 `old→new` 替换对（structured schema）。`old` 取完整行 / 连续几行原文、含足够上下文保证全文件唯一；可能多处出现的标 `uniqueRisk:true`。各段遵循上面统一译法表。
2. **单 agent 串行应用**：一个写者收全部替换对、逐个 Edit。跨段同词统一译法；`uniqueRisk` / 多匹配的补上下文或 `replace_all`、无法安全定位则跳过并报告；保 markdown 结构。**禁止多 agent 并行写同一文件**（会互相覆盖）。
3. **grep 验证**：全册扫禁用词清零（排除保留清单 + 已配解释的）；对比改前后 `##` / `###` 标题数（零丢失）、代码围栏数（偶数配对）、总行数（无大段丢失）。

## 易错点（已踩 / 必查）

- **FAQ 问题 ↔ 答案要一起改**：别只改答案行、漏改问题行，否则问答自相矛盾（审查清单易只给答案的 pair）。
- **巨长行可顺带拆 bullet**：单行 1000+ 字符的"版本注记流水账"拆成 bullet 列表提升可读（这次最长行 1386 → 353）。
- **代码块里真实命令 / 列名保留**：故障排查的 sqlite3/jq 命令、settings-key 是给维护人员的，不在替换范围。
- **审查 agent 只看自己段** → 给的 `old` 可能全局不唯一 → 应用阶段必须处理多匹配。
- **team-lead 必须审 diff 兜底**：数百处大改动易误删信息 / 改坏意思 / 误伤列名 → 机器验证（标题数 / 围栏 / grep）+ 人眼抽查资金敏感章节。
