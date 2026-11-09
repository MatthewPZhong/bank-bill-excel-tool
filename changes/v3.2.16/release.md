# v3.2.16 发布与集成记录

本文件记本轮范围、模块合入与最终证据；模块内的审查处置与验证细节见各自 spec / TechDoc，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.16（暂定；`package.json` 仍为 3.2.15，升版在清单 C1） |
| 正式基线 | `v3.2.15` → `5b5caf7b9349160957b0e60f617bc90abc3fd611` |
| release 分支 | `release/v3.2.16`，远端已从基线创建（2026-11-09 核对时远端末端即基线）；本地跟踪分支与工作树 `.claude/worktrees/release-v3.2.16` 于 2026-11-09 建立 |
| 远端 main | `5b5caf7b`，已包含在 release 历史 |
| PR | 尚未创建（清单 A5：推送与开 draft PR 须授权） |
| 合并方式 | release → main 必须使用 merge commit（见 `AGENTS.md`「约定与分支」） |

## 纳入范围（清单 A4）

| 内容 | 源分支 / 末端 | 合入提交 | 准入依据 | 文档 |
| --- | --- | --- | --- | --- |
| 映射字段「字段筛选特征值」 | `feat/mapping-feature-filter` / `5a78bc18` | `61fe40fd`（`--no-ff`） | Codex 三轮审查（`codex review --base main`）：第一轮 3×P2、第二轮 1×P1 + 2×P2 均已修复，第三轮无发现；模块分支与 release 合入后 `release-check` 见下 | [Spec](feat/mapping-feature-filter/spec.md)、[TechDoc](feat/mapping-feature-filter/techdoc.md) |
| MerchantId「原始账单仅有币种无账户号」+【映射管理】 | `feat/statement-currency-big-account` / `e3b0a7c7` | `59970cf5`（`--no-ff`） | 对账专项审查（币种模糊识别改为阻断，spec D4）；Codex 两轮审查（`codex review --uncommitted`）：第一轮 2×P2 已修复，第二轮无发现；模块分支 `release-check` 通过（两个工具箱内存类偶发失败单独重跑通过） | [Spec](feat/statement-currency-big-account/spec.md)、[TechDoc](feat/statement-currency-big-account/techdoc.md) |

合入「原始账单仅有币种无账户号」时与「字段筛选特征值」的冲突按并集处理；两者都把模板包升到 v6，统一为同一规则：任一模板用到其中之一时写 v6，否则写 v5（`resolveTemplateBundleVersion`）。两边测试替身互补对方新增的依赖。

同一需求另有一份未提交实现 `feat/mapping-feature-value`（工作树 `.claude/worktrees/mapping-feature-value`，口径不同）。2026-11-09 用户选定以 `feat/mapping-feature-filter` 为准合入；该分支未纳入、未改动，去向由用户决定。

## 待人工复核

- ⚠️ 资金红线：「字段筛选特征值」第二轮审查 P1——BillDate 取该值且源列含合计标签时，合计金额曾被当作交易导出；已修复（TechDoc T12），回归用例在修复前复现多导出一行、修复后按合计行跳过。按 `CODEX.md`「验证与风险审查」须人工复核后再发布。

- 「原始账单仅有币种无账户号」决定每行 MerchantId 与余额链归属（资金红线）：对账专项审查结论见其 [TechDoc §十](feat/statement-currency-big-account/techdoc.md)；币种列只会是代码已由用户确认（spec D5）。按 `CODEX.md` 须人工复核后再发布。

## 验证证据

- 2026-11-09 release 工作树（`61fe40fd`）`npm run release-check`：lint、架构检查、smoke 通过；单测 9996/10000、0 失败；集成 98/99，`toolbox-biff8-admission` 报 `EXECUTION_SYSTEM_MEMORY_PRESSURE`（本机可用内存不足），单独重跑 15/15 通过；随后完整重跑 `npm run test:integration` 99/99 通过，`rules/integration-test-policy.md` §七回写单独提交。
- 2026-11-09 release 工作树（`59970cf5`，合入「原始账单仅有币种无账户号」后）`npm run release-check`：lint、架构检查、smoke 通过；单测 10020/10024、0 失败；集成 99/100，`toolbox-large-split-multi-sheet` 的 RSS 增量预算断言失败（负载敏感，模块分支上同样出现、单独重跑 31/31 通过）；随后完整重跑 `npm run test:integration` 100/100 通过，§七回写单独提交。合入前另跑渲染生命周期 `configuration-dialogs` + `statement-controller` 109/109。
- 真实应用 GUI 人工检查未做（本机开发版启动受 BizOP 资源预检阻断）；界面由渲染生命周期用例与布局截图覆盖。
