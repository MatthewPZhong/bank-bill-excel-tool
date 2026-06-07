# v2.1.12 迭代 PRD（索引 / 导读）

> 状态：已发布 stable `2.1.12`（2026-06-01）｜分支：`v2.1.12`（PR 方向 → main）
> 性质：**大版本，跨 α（业务+收尾）/ β（性能架构）两阶段**，需求规格由 `backlog.md` + 分阶段 spec 承担。
> 本文件为**统一入口（索引）**：汇总范围 + 指向各源文档，对齐项目 `PRD-<版本>.md` 命名惯例，补齐归档结构。

---

## 一、为什么本版本没有单一 PRD 正文

v2.1.12 体量大（立项粗估 α ~3-4 周 + β ~6 周），采用 Gradual Spec 工作流：**立项画像（backlog）→ 阶段总纲（spec-alpha / spec-beta）→ 子需求 spec**。需求规格分散在下列文档，本索引统一串联，不重复正文。

---

## 二、范围总览与源文档地图

### α 阶段（业务 + 收尾）

| 块 | 内容 | 风险 | 源 spec |
|---|---|---|---|
| 需求1 | VCC 业务 OP 计算（新建第 6 模块）| 🟡 新持久化 + 🔴 金额计算 | [`spec-alpha-req1-vcc.md`](./spec-alpha-req1-vcc.md) |
| 需求5 | 网关 extra fee 匹配（改 C3 匹配）| 🔴 资金红线 | [`spec-alpha-req5-extrafee.md`](./spec-alpha-req5-extrafee.md) |
| 需求6 | 资金对账不平跳过提示修正 | 🟢 | [`spec-alpha-req6-cleanup.md`](./spec-alpha-req6-cleanup.md) §1 |
| 收尾批 | SR-log-1 / I6 / I7 | 🟢（SR-log-1 破坏性）| [`spec-alpha-req6-cleanup.md`](./spec-alpha-req6-cleanup.md) §2-4 |
| α 总纲 | 串起 3 份子 spec + 汇总全局风险与开放问题 | — | [`spec-alpha.md`](./spec-alpha.md) |

**不做边界（α）**：VCC 模块不导出 Excel（仅"显示余额"）、不跨月汇总、多币种暂不合并；extra fee 默认仅 C3、不含 C4。

### β 阶段（性能架构）

| 内容 | 风险 | 源 spec |
|---|---|---|
| 收单/对账写盘性能架构（byte-for-byte 一致性 + SQLite WAL single-writer 并发 + OOM 防护）；**Phase 0 POC 为进实现硬门槛** | 🔴 资金红线 + 🔴 并发红线 + 🟡 OOM | [`spec-beta.md`](./spec-beta.md) |

> 立项画像、决策点（D29-D36 沿用 v2.1.11 backlog、F5-cont 不做、3 新需求拍板）见 [`backlog.md`](./backlog.md)「立项拍板结论（v0.2）」。

---

## 三、交付与发布状态

- **α 阶段**：业务 3 需求（VCC OP 计算 / extra fee 匹配 / 不平提示修正）+ 收尾批落地（PR #56 系列 `v2.1.12-alpha.N`）。
- **β 阶段**：PR #57 merge `86829b1`，三块性能改造合入 main。
- **转正**：`2.1.12-beta.1 → 2.1.12`（2026-06-01）。
- **defer**：bizOp 百万行集成测试 / bill 大文件手测 / I4 / 2 Minor 转 stable 后 follow-up（见 spec-beta §10.4/§11.3）。

---

## 四、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-07 | 补建索引 PRD，统一归档结构。原始需求规格见 `backlog.md` + `spec-alpha*.md` + `spec-beta.md`，本文件不改写其内容 |
