# TechDoc — 网银账单「账单里的余额」逐日余额校验

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.16（暂定） |
| 功能分支 | `feat/statement-balance-verification`，基于正式标签 `v3.2.15`（`5b5caf7b`） |
| 日期 | 2026-11-08 |
| 状态 | 已实现，待 PR 审查与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D11 |
| 格式来源 | `changes/v3.2.15/feat/statement-channels/techdoc.md` 的章节组织（按本任务规模精简） |

行号指本分支实现时的位置，以符号名为准。

## 一、目标与范围

- 「账单里的余额」逐日校验：预期 = 上一日余额 + 当日收入 − 当日支出；首日起点为最新种子，之后为上一日账单余额。
- 单一余额不符：统一确认后按账单余额生成；多候选都不符：维持现状报错。
- 断档不单独提示，并入校验；去掉 `+支出` 备选规则。
- 不含：「通过发生额计算」的校验、在弹窗里改种子、B32。

## 二、技术决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| T1 | `inferEndingBalance` 换成纯函数 `verifyStatementEndingBalance({ anchorBalance, entries, dateLabel })`，返回 `match` / `mismatch` / `unresolved`，并附收支合计、预期值、差额（`normalizers.js`） | 校验结果需要区分三种处理与展示差异；旧函数“推导不出即抛错”的形状无法承载确认 |
| T2 | 候选去重与比较沿用两位小数口径（容差 < 0.005），返回选中候选原值（12 位口径） | D3；沿用 v3.2.15 §3.6 |
| T3 | `deriveBalanceRecords` statement 分支：每组首日 `requireSeedRecord`（任意生成方式）+ `statementSeedOriginalBalance`；之后锚点为 `previousStatementBalance`（原值链）。当天没有余额先报“未找到期末余额”，再查种子 | D2、D4；首日无余额时要求补录没有意义 |
| T4 | `mismatch` 无论是否已确认都以账单值输出并作为下一日锚点；未确认的收集后在全部分组算完统一抛 `BALANCE_MISMATCH_CONFIRM_REQUIRED`（断档确认之后），已确认的作为 `confirmedBalanceMismatches` 返回 | D6；一次列全全部差异；与断档“统一询问、抛错早于写余额表与种子”的现有写法一致 |
| T5 | 确认键 `mismatch|模板|账号|币种|日期|锚点日|锚点余额|收入合计|支出合计|账单余额`（金额按分），与断档键共用会话内存确认集合（`acknowledgedBalanceGapKeys`，不落盘），以前缀区分；查询沿用 `hasAcknowledgedBalanceGap`，本次运行内各会话共享 | 复用整条确认链路（会话登记、重启失效、freshness）；D9：收支明细或上一日余额变化后键随之变化，需重新确认；确认范围与 v3.2.14 断档一致 |
| T6 | 确认通道照搬断档：warning `balance-mismatch-confirm` → prompt `reason: 'mismatch'`（`buildBalanceMismatchConfirmResult`）→ IPC `file:save-balance-seed` 的 `confirmBalanceMismatchKeys` → preflight `prepareBalanceMismatchConfirm` → execute 登记键并重算。路由优先级：补录种子 > 断档 > 余额不一致 | 与断档同一交互模式与安全边界，改动面可控 |
| T7 | `reason: 'mismatch'` 的 prompt 拒绝人工补录载荷（`BALANCE_MISMATCH_CONFIRMATION_INVALID`） | spec §4 非目标；防止状态框绕到补录弹窗写入种子 |
| T8 | 确认后告警 `balance-mismatch-confirmed`：导入摘要“N处余额校验不一致，已按账单余额生成”，报错文件逐条列出（`formatBalanceMismatchLine`） | D6 留痕；与断档跳过告警同口径 |
| T10 | 人工补录替换：`deriveBalanceRecords` 新增 `existingBalanceSeeds`（调用方按输出银行名 `readBalanceSeedRecords` 读一次）与 `acknowledgedBalanceSeedReplaceKeys`；每日算出写入值后，按 账号@@币种@@日期 查同日人工种子，比对原值（写入值 − 当日附加值累计）与人工值（按分），不一致记待确认，全部分组算完在余额不一致之后抛 `BALANCE_SEED_REPLACE_CONFIRM_REQUIRED`；确认键 `seed-replace|模板|账号|币种|日期|人工值|本次原值` | D10、D11；两种模板共用一处判断；读种子一次，避免逐日读文件；人工种子与原值同口径 |
| T11 | 替换确认通道与不一致同构：warning `balance-seed-replace-confirm` / `-confirmed`，prompt `reason: 'seed-replace'`（`buildBalanceSeedReplaceConfirmResult`），IPC 字段 `confirmBalanceSeedReplaceKeys`；preflight 把两类确认合并为 `prepareBalanceConfirmation(reason)`；生成层缺 `readBalanceSeedRecords` 依赖时跳过替换判断，因此用单测核对 main.js 装配 | 复用已验证的链路与安全边界；防止装配遗漏导致静默跳过 |
| T12 | 已有种子但首日多候选都不符（D7 调整）：`verifyStatementEndingBalance` 的 `unresolved` 结果带回 `candidateBalances`；`deriveBalanceRecords` 仍抛 `BALANCE_SEED_REQUIRED`（文案“上一账单日余额与账单对不上，请核对后重新补录”），`context.seedMismatch` 含种子日期/金额/生成方式、计算起点 `anchorBalance`、首日收支合计、预期、候选余额；生产路径（`statement-generation.js`）与 worker 路径（`prepareBalanceGroup`）把 `seedMismatch` 原样放进 `balance-seed-required` 的 prompt；`buildManualBalanceRequiredResult` 按有无 `seedMismatch` 选文案并在活动日志附 `formatBalanceSeedMismatchLine`；补录弹窗显示说明、预填种子日期与 `anchorBalance` | 沿用补录通道与覆盖确认，不新增错误码、IPC 字段或 prompt reason，路由与 freshness 不变；只改提示与预填，不改种子写入时机（仍先写后算） |
| T12 | 导出全部余额：`exportStatementByScope` 记下本次重算的告警（指定模板取 `generatedFiles.warnings`，按文件名映射取各组告警），导出后经 `withAcceptedBalanceRiskWarnings` 处理：成功且含三类已接受风险时改为 `createWarningResult`（`EXPORT_BALANCE_WARNING`，报错明细复用 `buildImportWarningDetailLines`），保留 `filePath`；部分模板已删除的分支以“数据不完整”开头 | D12；Codex 第二轮 P2 |
| T9 | 渲染层新增 `createBalanceMismatchConfirmDialog`，复用断档弹窗样式；`createManualBalanceSeedDialog` 遇 mismatch 转入；导入、导出、选择大账号后的自动弹出与状态框标题认 mismatch | D6 |

## 三、数据流

```
deriveBalanceRecords(statement)
  ├─ 缺种子 → BALANCE_SEED_REQUIRED → balance-seed-required → 补录弹窗（既有）
  ├─ 多候选都不符 → 首日 BALANCE_SEED_REQUIRED（已有种子时带 seedMismatch，补录弹窗写明原因并预填）/ 其后 FILE_READ
  └─ 单一余额不符（未确认）→ BALANCE_MISMATCH_CONFIRM_REQUIRED
        → statement-generation: warning balance-mismatch-confirm
        → buildImportResultFromGeneratedFiles / 导出全部 / 重算 → buildBalanceMismatchConfirmResult（prompt reason=mismatch）
        → 渲染层确认弹窗 →【确认继续生成】saveBalanceSeed({ confirmBalanceMismatchKeys })
        → preflight 校验键 ⊂ prompt.mismatches + freshness → execute 登记确认键、warn 日志 → 重算
        → 余额表与种子按账单余额写出；warning balance-mismatch-confirmed → 导入告警与报错文件
```

## 四、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/file-service/normalizers.js`、`file-service.js` | `verifyStatementEndingBalance` 取代 `inferEndingBalance` 及其导出 |
| `src/main-process/statement-generation-business.js` | statement 分支重写；确认键；新错误码；worker 路径 `prepareBalanceGroup` 同步映射 |
| `src/main-process/statement-generation.js` | 新 warning 两类；`extractBalanceMismatchConfirmItems`；导入结果路由 |
| `src/main.js` | `buildBalanceMismatchConfirmResult`、`formatBalanceAmount`、`formatBalanceMismatchLine`；导入告警；重算 / `balancePending` / 导出全部（两处）/ 补录 IPC execute 路由；移除 `inferEndingBalance` 引用 |
| `src/main-process/manual-balance-seed-preflight.js` | `prepareBalanceConfirmation`（不一致 / 人工补录替换）；两类 prompt 拒绝人工补录 |
| `src/renderer/dialogs/configuration.js`、`src/renderer/controllers/statement.js` | 确认弹窗、分派与自动弹出、状态框标题 |
| `src/renderer-previews.js`、`src/renderer.js` | 预览 `balance-mismatch-confirm-dialog` |
| `src/styles-gemini-extra.css` | 注释：两类确认共用样式 |
| `scripts/smoke/scenarios.js`、`rules/important-variables.md` | 改用新函数 / 更新风险说明 |

## 五、测试

- 新增 `tests/unit/main-process/statement-balance-verify.test.js`：校验函数三种结果、容差边界、首日缺种子、无余额、多组多日一次列全、确认与部分确认、键随金额失效、断档并入、多候选、`+支出` 不再匹配、附加值口径、calculated 不变、preflight、主进程结果与告警文案、生成层未确认 / 确认后。
- 资金红线“确认后按账单余额回写种子”专项（同一单测文件「红线-回写1–7」，真实 xlsx → 生成层 → 真实余额表写出 → 主进程 `storeGeneratedBalanceSeeds` → 真实种子文件）：确认前一条都不写（含同模板校验通过的账户）、确认后余额表与回写种子逐行一致、部分确认不写、下一次导入以回写值为起点且旧确认不外溢、修正账单重导以更早种子为起点并覆盖、附加值回写后扣回不重复叠加、负数与高精度保持；同日人工种子被生成种子覆盖为现状口径（v3.2.15 起既有），列出供人工复核。集成脚本 Step6 另核对按文件名映射多模板：通过的组照常回写、待确认的组不写、确认后补写。
- `tests/unit/main-process/statement-balance-gap.test.js`：导出全部遇不一致记下全部模板组上下文；补录 IPC execute 确认后登记键并重算、重算仍不一致返回下一次确认。
- 新增 `scripts/integration/statement-balance-verify.js`：真实 xlsx → 缺种子补录 → 跨周末通过 + 两处不一致 → 确认后回读余额表与种子 → 告警文案 → 下一次导入接着校验 → 按文件名映射多模板不出部分汇总、确认后重算。
- `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`、`statement-controller.js`：确认框列出差异与缺的日期、返回核查不提交、确认继续一次提交全部键并锁定、150% 放大下正文滚动按钮可见；导入后自动弹出、状态框标题与重开。
- 人工补录替换：单测覆盖两种模板、只认人工补录、按原值比对（附加值）、与不一致的先后顺序、确认键失效、preflight、主进程文案与 main.js 装配；「红线-回写7–9」走真实链路（提醒前不写、返回核查不写、确认后替换、两步确认、相符不提醒）；`statement-balance-gap.test.js` 覆盖导出全部与补录 IPC 的替换路由；renderer-lifecycle 夹具覆盖替换弹窗（列出两个值、返回核查、确认、由不一致转入、状态框重开）；集成脚本 Step7 覆盖两种模板与真实种子文件。
- 已有种子但首日对不上（T12）：单测覆盖 `candidateBalances`、KBANK 形态数据（补 0 → 带明细的补录提示；补期初余额 → 正常生成）、附加值种子的原值与起点、缺种子时不带明细、生成层真实 xlsx 与种子文件、主进程文案与日志；renderer-lifecycle 覆盖补录后转入说明弹窗（标题、说明、预填、改值提交）与普通补录弹窗不受影响，状态框标题；集成脚本 Step8 走真实种子文件（补 0 → 提示 → 覆盖为期初余额 → 回读余额表与种子）。
- 未做：弹窗截图受 B34 影响不可用；真实应用 GUI 与真实账单回归登记 B70。
- 首日须有种子后更新的既有用例：`statement-balance-review-fixes`（单测与集成）、`statement-legacy-golden-e09-p0`、`statement-generation-e09-c`、`statement-balance-gap`（账单里的余额不做断档判定）。

## 六、兼容与回滚

- 不改表结构、迁移、种子文件格式与 IPC 通道名（`file:save-balance-seed` 增加可选载荷字段）。
- 回滚即回退本分支提交；期间按账单余额回写的种子与旧版口径一致（旧版单一余额同样直接采用并回写）。

## 七、实施记录

- 2026-11-08 Codex 第二轮只读审查一条 P2，已核实：导出全部重算时已确认差异只提示“文件导出成功”（断档未补录同样如此，v3.2.14 起既有）→ 用户决定三类都带告警（D12），补 `statement-balance-gap.test.js` 三个用例（按文件名映射、指定模板复现场景、部分模板已删除）。
- 2026-11-08 Codex 只读审查两条 P2，均已核实：
  - 确认键只含预期与账单余额，明细改动而净额、余额不变时旧确认仍生效 → 按 D9 在键中加入锚点余额与当日收支合计，补回归用例。
  - 确认在本次运行内跨会话生效 → 与 v3.2.14 断档确认的既定设计一致（其 spec 写明“本次运行期间对完全相同的断档有效”），用户决定沿用，修正本 spec 措辞，不改代码。

- 2026-11-08 用户反馈（v3.2.15，KBANK-VN）：首日两笔余额，上一账单日余额误填 0 后补录框反复弹出、重启仍提示。根因是多候选都不符时回到与缺种子相同的提示，前端以空白输入重开同一弹窗，错误种子已落盘。用户确认调整 D7（T12）：提示写明已有余额对不上并预填；种子写入时机不变。真实文件核对：填账单上的期初余额后 v3.2.15 可生成；本分支另在该账单一处中间缺日期的账单日报单一余额不一致，属 D6 预期行为。真实账单金额不入库，回归用例用同结构的合成数据。
- worker 路径（E09-C，staging-only、未接入生产）：`prepareBalanceGroup` 与生产路径同样产出 `balance-mismatch-confirm` / `balance-mismatch-confirmed`；worker 只把 `balance-seed-required` 视为需人工结算，与断档确认现状一致，未扩展。
