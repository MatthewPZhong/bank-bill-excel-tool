# v2.1.9 迭代清单（Backlog）

> 立项阶段清单；v2.1.8 PR #52 merge 后启动 spec 评审。
> 来源：v2.1.8 PRD §十四「延期到 v2.1.9」+ self-review SR6 沉淀。

## 主题概览

v2.1.8 延期项 + self-review 补强项 + 已知坑收尾，共 **10 个独立条目**：

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **F5-cont** | C4 manyToOne 根因 #5：subset-sum 剪枝误剪 → ILP 算法重写 | 资金红线 · 算法重写 | 🔴 HIGH | ~1-1.5 周 | v2.1.8 PRD §十四 / TEST2.xlsx 43/57 → 57/57 |
| **G1-cont** | 单元测试全量铺：第 1 层剩余 13 + 第 2 层 24 | 工程基建 · 测试覆盖 | 🟢 LOW | ~1-2 周 | v2.1.8 PRD §十四 |
| **A3** | runCheck 跨进程化（worker_threads / utilityProcess） | 架构级 · 跨进程 IPC | 🔴 HIGH | ~1-1.5 周 | v2.1.7 PRD §10.6 + v2.1.8 §十四 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批 | 性能优化 | 🟡 MID | 与 A3 联合评估 | v2.1.7 PRD §12.1.3 + v2.1.8 §十四 |
| **N4-cont-1** | 收单单据 raw_json 历史保留体积治理：手动清入口 / 滚动保留窗口 | 体积治理 · UX | 🟡 MID | ~3-5 天 | v2.1.8 PRD §十四 / N4 后续 |
| **N4-cont-2** | FK CASCADE 改造：`diff_rows.bill_import_id` / `run_id` 加 ON DELETE CASCADE | DB schema 优化 | 🟡 MID | ~2-3 天 | v2.1.8 PRD §十四 |
| **N4-cont-3** | import-repository 写 raw_json 时也按 9 字段裁字段（避免新写入 17 字段残留 DB） | 一致性补强 | 🟢 LOW | ~1 天 | v2.1.8 self-review SR2 N4 Minor-3 |
| **SR-policy-1** | integration-runner.js 末尾自动输出"当前清单 markdown 表" → 自动同步 integration-test-policy.md §七 | 工程化补强 | 🟢 LOW | ~0.5 天 | v2.1.8 self-review SR4 |
| **SR-backup-1** | N4 备份用 sqlite backup API（取代 fs.copyFileSync）— 保证一致性 + 大库无锁 | 鲁棒性补强 | 🟢 LOW | ~1 天 | v2.1.8 self-review SR2 N4 Important-1 |
| **N1-settings** | idle 阈值 settings 化（v2.1.8 N1''-D8 锁定硬编码，v2.1.9 评估配置化） | UX · 可配置 | 🟢 LOW | ~0.5 天 | v2.1.8 spec §3.2.2 D8 |

## 主题间依赖

```
独立可并行：F5-cont / G1-cont / N4-cont-1/2/3 / SR-policy-1 / SR-backup-1 / N1-settings
联动评估：A3 + A4（A3 spec 阶段一起拍板）
```

## 风险提醒（CLAUDE.md 规则 7）

- 🔴 **F5-cont** 算法重写涉及资金红线 subset-sum 等式契约，必须保 v2.1.8 4 根因 fix 不退化
- 🔴 **A3** 跨进程化涉及 cleanup / runCheck / import / export 全部 mutex 重新设计；可能与 N1' idle 计时器交互
- 🟡 **N4-cont-2** FK CASCADE 改造是 schema 破坏性变更（与 v2.1.8 N4 raw_json migration 同等级别）；考虑放到 v2.1.9 的"次级破坏性 migration"

## v2.1.8 self-review 已落实清单（不进 v2.1.9）

已在 v2.1.8 PR #52 self-review 阶段处理：

- ✅ SR1 dryrun-user-sample.js hitScenarioIds 残留修复（必修）
- ✅ SR1 N4 双源真理 TEMPLATE_BILL_HEADERS（必修）
- ✅ SR2 N4 WAL checkpoint 返回值检查 + busy abort
- ✅ SR2 N4 备份时间戳改紧凑格式
- ✅ SR2 N4 totalRewritten 统计修正（剔除 JSON.parse 跳过行）
- ✅ SR2 N4 fault injection 2 用例（backup-failed + batch-failed）
- ✅ SR3 N1' 多 run 累积串行清 smoke
- ✅ SR3 N1' Phase 2 多 monthKey FK 边界 smoke
- ✅ SR4 gateway-recon-fields `__CUSTOM__` sentinel 防踩坑注释
- ✅ SR4 integration-runner 失败 stderr 截最后 30 行
- ✅ SR4 scenario-dispatcher displayIndex fallback 语义注释
- ✅ SR4 exceljs-writer INTERNAL_FIELDS 投影过滤说明注释
- ✅ SR4 integration-test-policy §三 N/N PASS 硬约束 + §六 release-check 仅开发机本地跑备注
- ✅ SR5 spec §3.2.2 N1''-D6 实施简化反向同步
- ✅ SR5 spec §3.2.2 N1''-D7 多窗口语义补
- ✅ SR5 spec §3.2.2 N1''-D11 三重保险降级路径文档化

---

**当前状态**：起草中（2026-05-26 v2.1.8 self-review SR6 立项）。
**下一步**：v2.1.8 PR #52 merge 后启动 spec 评审。
