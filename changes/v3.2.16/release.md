# v3.2.16 发布与集成记录

本文件记本轮范围、模块合入与最终证据；模块内的审查处置与验证细节见各自 spec / TechDoc，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.16（暂定；`package.json` 仍为 3.2.15，升版在清单 C1） |
| 正式基线 | `v3.2.15` → `5b5caf7b9349160957b0e60f617bc90abc3fd611` |
| release 分支 | `release/v3.2.16`，远端已从基线创建（2026-11-09 核对时远端末端即基线）；本地跟踪分支与工作树 `.claude/worktrees/release-v3.2.16` 于 2026-11-09 建立 |
| 远端 main | `5b5caf7b`，已包含在 release 历史 |
| PR | [#248](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/248)，`release/v3.2.16` → `main`，draft；2026-11-09 用户授权推送并开 draft PR（首次推送末端 `cdf448c9`） |
| 合并方式 | release → main 必须使用 merge commit（见 `AGENTS.md`「约定与分支」） |

## 纳入范围（清单 A4）

| 内容 | 源分支 / 末端 | 合入提交 | 准入依据 | 文档 |
| --- | --- | --- | --- | --- |
| 映射字段「字段筛选特征值」 | `feat/mapping-feature-filter` / `5a78bc18` | `61fe40fd`（`--no-ff`） | Codex 三轮审查（`codex review --base main`）：第一轮 3×P2、第二轮 1×P1 + 2×P2 均已修复，第三轮无发现；模块分支与 release 合入后 `release-check` 见下 | [Spec](feat/mapping-feature-filter/spec.md)、[TechDoc](feat/mapping-feature-filter/techdoc.md) |
| MerchantId「原始账单仅有币种无账户号」+【映射管理】 | `feat/statement-currency-big-account` / `e3b0a7c7` | `59970cf5`（`--no-ff`） | 对账专项审查（币种模糊识别改为阻断，spec D4）；Codex 两轮审查（`codex review --uncommitted`）：第一轮 2×P2 已修复，第二轮无发现；模块分支 `release-check` 通过（两个工具箱内存类偶发失败单独重跑通过） | [Spec](feat/statement-currency-big-account/spec.md)、[TechDoc](feat/statement-currency-big-account/techdoc.md) |
| 模板管理【余额管理】（余额种子查看 / 改余额 / 删除；维护大账号原【余额管理】改名「余额附加值」） | `feat/balance-seed-management` / `2e416ab3` | `dc768d9a`（`--no-ff`） | 对账专项审查（D3 转人工录入为资金口径，见下）；Codex 三轮只读审查：第一轮 3×P2 + 1×P3 + 1 项归属歧义、第二轮 2 项均已修复，第三轮无发现，按其建议补强测试；模块分支 lint、架构检查、smoke、单测、集成通过 | [Spec](feat/balance-seed-management/spec.md) |
| 网银账单「账单里的余额」逐日余额校验（不一致确认、人工补录替换确认、导出全部带已接受风险告警） | `feat/statement-balance-verification` / `13e54948` | `bbcfbd03`（`--no-ff`） | 对账专项审查；提交后 Codex 五轮只读审查，P1（资金红线：多模板共用种子时人工补录替换确认取决于处理顺序）与各 P2 均已修复（见 TechDoc §七）；合入后 release 级 Codex 审查见下 | [Spec](feat/statement-balance-verification/spec.md)、[TechDoc](feat/statement-balance-verification/techdoc.md) |
| backlog 登记：`run-check-multiworker` B0 在 Windows CI 偶发等待超时 | `chore/backlog-b70-multiworker-flake` / `6f8a31fc` | `3f583ae7`（`--no-ff`） | 仅 `knowledge/backlog.md` 一条登记 | — |

合入「原始账单仅有币种无账户号」时与「字段筛选特征值」的冲突按并集处理；两者都把模板包升到 v6，统一为同一规则：任一模板用到其中之一时写 v6，否则写 v5（`resolveTemplateBundleVersion`）。两边测试替身互补对方新增的依赖。

合入【余额管理】时：`knowledge/backlog.md` 模块分支上的 B72 与 release 已有的 B72–B74 重号，改编为 B75（spec 同步）；`rules/integration-test-policy.md` 取 release 版本，完整集成后回写（`aeb85dde`）。合入后架构检查报 12 处 `ARCH-POLICY-HISTORY`：release 历史中另两个模块的 12 个提交仍持有 `renderer-dialog-configuration` 原 `allowedApiFields.api` 集合，按 v3.2.15 先例在 `architecture/boundaries.json` 逐个补登放宽记录（`94f6a825`），之后通过。

合入「账单里的余额」逐日校验时（2026-11-09 用户要求合入未纳入的功能分支）：`src/backend/file-service.js` 导出取并集，该分支以 `verifyStatementEndingBalance` 取代 `inferEndingBalance`；`src/main.js` 去掉 `inferEndingBalance` 的 import，导入告警明细同时保留特征值未命中与余额确认两类；`src/renderer-previews.js` 保留两个新预览、注释沿用「余额附加值」；backlog 排为 B75–B70；`rules/integration-test-policy.md` 取 release 版本，完整集成后回写（`79b63692`）。`chore/backlog-b70-multiworker-flake` 的 B70 与该分支 B70 重号，改为 B76。合入后架构检查报 3 处 `ARCH-POLICY-HISTORY`（`9f7624a8`、`13e54948`、`6f8a31fc` 仍持有原 api 集合），补登后通过（`7503c498`）。该分支 spec 头部仍为 `status: in-progress`，按其提交记录与 TechDoc 已完成审查与验证，状态由模块负责人更新。

release 上另有直接提交 `356753e4`：按用户 2026-11-09 要求清理 Agent 指令文件（`CLAUDE.md`、`CODEX.md`、`AGENTS.md`、`unknowns-first` Skill、`rules/important-variables.md`），不涉及运行代码。

2026-11-10 按用户要求在 release 上直接调整「账单里的余额」报错文案（spec D13、TechDoc T16）：非首日多个余额都对不上时写明银行账号与币种，与上一账单日之间缺日期时写明缺的日期并提示核对是否漏了交易；只改文案，仍不生成余额账单。

同一需求另有一份实现 `feat/mapping-feature-value`（工作树 `.claude/worktrees/mapping-feature-value`，口径不同；之后已在该分支提交，末端 `d8ff7b20`，Codex 第五轮无发现）。2026-11-09 用户选定以 `feat/mapping-feature-filter` 为准合入；该分支未纳入、未改动 release；2026-11-09 用户确认保留分支与工作树、本轮不纳入。

## 待人工复核

- ⚠️ 资金红线：「字段筛选特征值」第二轮审查 P1——BillDate 取该值且源列含合计标签时，合计金额曾被当作交易导出；已修复（TechDoc T12），回归用例在修复前复现多导出一行、修复后按合计行跳过。按 `CODEX.md`「验证与风险审查」须人工复核后再发布。

- 「原始账单仅有币种无账户号」决定每行 MerchantId 与余额链归属（资金红线）：对账专项审查结论见其 [TechDoc §十](feat/statement-currency-big-account/techdoc.md)；币种列只会是代码已由用户确认（spec D5）。按 `CODEX.md` 须人工复核后再发布。

- ⚠️ 资金红线：「账单里的余额」逐日校验——确认继续后以账单余额为准回写种子，差异只在本次导入提示、报错文件和活动日志中留痕；同值回写后的人工补录保护只在本次运行有效；两个模板对同一账号同一天给出不同余额时取后写入（B35，既有）。实机 GUI 与真实账单回归未做，登记 [B70](../../knowledge/backlog.md)；只含一天前半段交易的账单无法被逐日校验发现（B71，既有）。须人工复核后再发布。

- ⚠️ 资金红线：【余额管理】修改种子后生成方式转为「人工录入」（spec D3），改变断档锚点与首日附加值扣回口径；同银行段其他归属写入的同账号种子不在当前选项显示（spec A1）。实机界面与“打开 → 修改 → 重新生成”未做，登记 [B75](../../knowledge/backlog.md)，须人工复核后再发布。

## 验证证据

- 2026-11-09 release 工作树（`61fe40fd`）`npm run release-check`：lint、架构检查、smoke 通过；单测 9996/10000、0 失败；集成 98/99，`toolbox-biff8-admission` 报 `EXECUTION_SYSTEM_MEMORY_PRESSURE`（本机可用内存不足），单独重跑 15/15 通过；随后完整重跑 `npm run test:integration` 99/99 通过，`rules/integration-test-policy.md` §七回写单独提交。
- 2026-11-09 release 工作树（`59970cf5`，合入「原始账单仅有币种无账户号」后）`npm run release-check`：lint、架构检查、smoke 通过；单测 10020/10024、0 失败；集成 99/100，`toolbox-large-split-multi-sheet` 的 RSS 增量预算断言失败（负载敏感，模块分支上同样出现、单独重跑 31/31 通过）；随后完整重跑 `npm run test:integration` 100/100 通过，§七回写单独提交。合入前另跑渲染生命周期 `configuration-dialogs` + `statement-controller` 109/109。
- 2026-11-09 release 末端 `c38a39f9`（两个模块合入后）复核「字段筛选特征值」未被冲突处理改动：功能相关标识在 8 个源文件中与 `feat/mapping-feature-filter` 一致；`statement-feature-filter.js` 46/46、`feature-filter.test.js` 9/9、渲染生命周期 `configuration-dialogs` 96/96（含本功能 5 例）。
- 2026-11-09 release 工作树（合入【余额管理】后，`94f6a825`）：合并前 lint 通过、受合并影响的单测 74/74、`balance-seed-management` 集成 5/5；`npm run check:architecture` 通过（补登后）；随后 `npm run lint`、`npm run smoke` 通过，单测 10034/10038、0 失败（4 个 Windows 专用跳过），渲染生命周期 `configuration-dialogs` + `statement-controller` 112/112，`npm run test:integration` 101/101 通过，§七回写单独提交（`aeb85dde`）。以上为分项运行，未在最终末端跑一次完整 `npm run release-check`。
- 2026-11-09 release 工作树（合入「账单里的余额」逐日校验与 backlog 登记、补登策略后，`7503c498`）：合并后 lint 通过；`npm run check:architecture` 通过；`npm run smoke` 通过；单测 10091/10095、0 失败（4 个 Windows 专用跳过）；渲染生命周期 `configuration-dialogs` + `statement-controller` 118/118；`npm run test:integration` 102/102（新增 `statement-balance-verify.js` 67/67），§七回写单独提交（`79b63692`）。分项运行，未在最终末端跑一次完整 `npm run release-check`。
- 2026-11-09 release 级 Codex 只读审查（`356753e4..3f583ae7`，合并冲突与跨模块交互）：无 P0–P2；1 项 P3 为集成清单未含新脚本，已由上面的完整集成回写关闭。内存实验覆盖【余额管理】改值/删除后的逐日校验与人工补录替换确认、两套写入前核对叠加、按币种推出的账号与特征值筛出的日期进入逐日链、告警缓存路径，均未发现问题；资金口径仍按上面「待人工复核」处理。
- 2026-11-10 release 工作树（D13 报错文案调整）：`npm run lint` 通过；`statement-balance-verify.test.js` 53/53，其余余额相关单测（`statement-balance-gap`、`statement-balance-review-fixes`、`statement-generation-e09-c`、`statement-legacy-golden-e09-p0`）127/127；`node scripts/integration/statement-balance-verify.js` 73/73（原 67，新增 Step9）。未跑全量单测与完整集成，§七清单条数待下次完整集成回写。
- 真实应用 GUI 人工检查未做（本机开发版启动受 BizOP 资源预检阻断）；界面由渲染生命周期用例与布局截图覆盖。
