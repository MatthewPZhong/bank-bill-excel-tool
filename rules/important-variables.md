# 重要变量清单

> 手工维护的"关键变量"清单。**每次代码变动前必读**，命中条目要在改动完成后做关联功能 review。
>
> 全量自动统计在 `docs/analysis/var-reference-stats.md`（由 `npm run scan:vars` 生成）。
> 触发节点与 review 流程详见 `CLAUDE.md` § 重要变量变动 check。

## 元数据

| 字段 | 值 |
|---|---|
| 清单版本 | v11（对应 app v2.1.8 — 2026-05-26 发版收尾再升格 7 条 N1' + N4 涉及变量：Critical 3 条（`WRITER_OUTPUT_HEADERS_V2` / `TEMPLATE_BILL_HEADERS` / `bill_imports.raw_json` 内容契约 — N4）+ Important-skeleton 2 条（`ensureBillRawJsonV2Slim` — N4 / `setupIdleCleanupTimer` — N1'）+ Runtime-state 1 条（`lastUserActivityTs` 含 `IDLE_CLEANUP_MS` + `reportUserActivity` — N1'）+ deprecated 标记 1 条（`WRITER_OUTPUT_HEADERS` — N4）+ 更新 1 条（`cleanupAfterRunBackground` review 要点加 N1' v0.7 `includeDiff` 参数 + FK 反向同步）；触发：用户 2026-05-26 立项 N1' + N4；v10 = 2026-05-22 Phase 0 T02 升格 11 条；v9 = 2026-05-21 v2.1.7 T14 收口升格 10 条；v8 = 2026-05-19 v2.1.6 v0.7 fix4 收单流水侧对账字段切换 + DB 重命名 settle_*；v7 = 2026-05-18 acquiring-bill-currency 模块初版；v6 = v2.1.4 dev round 7 新增 2 条 Important-skeleton；v5 = v2.1.3 round 4 自 review 新增 2 条；v4 = v2.1.3 round 3 新增 3 条；v3 = v2.1.3 round 2 新增 1 条；round 1 已升格 13 条 v2.1.3 新符号保持） |
| 上次人工 review | 2026-05-22（v2.1.8 Phase 0 T02 升格 11 条 — F5/A3/N1/N2/N3 spec.md §七 评估） |
| 基线数据 | `docs/analysis/var-reference-stats.md`（85 个 JS 文件 / 853 顶层声明 — v2.1.7 T14 重跑后；A-share 146 / A-pair 247 / A-local 359 / B 393） |
| 下次重扫时机 | 版本号 bump / 合并到 `main` 或 `v1.5.x` 前 |
| 分层定义 | Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor |

## 如何使用本表

1. 准备改代码前：搜本表，看改动文件 / 改动符号是否在表中出现
2. 改完代码后：对命中的每一条，按"变更 review 要点"列出的清单自查一遍
3. PR body 追加"⚠️ 关联功能 review"段落，列出命中变量与 review 结论
4. 新发现的跨度 ≥ 3 的符号（见自动统计报告），评估是否升格入本表
5. 版本号 bump 时：人工完整 review 一次本表，同步进展到 CHANGELOG

本表中跨度/次数数据为**人工 review 时刻的参考**，不精确追踪每次改动（精确数据看自动报告）。

---

## 1. Critical — 业务契约锚点

**这批常量 / 类承载业务协议。**一旦修改语义，会引起**跨层联动 + 历史数据失效**，属于高风险区。

### `FIXED_FIELD_VALUE_PREFIX`
- 定义：`src/backend/database/utils.js`
- 当前值：`__FIXED__:`
- 关联功能：模板固定字段（如 `__FIXED__:MerchantId=NET001`）的序列化/反序列化
- 变更 review 要点：
  - 改前缀字符串 → 所有历史模板 JSON 失效
  - 改解析逻辑 → 固定字段注入的行数据可能错列
  - 涉及文件：`main.js`、`database/utils.js`、`statement-session.js`、模板 repository
  - 必须跑一次：带固定字段的模板导入 + 导出端到端

### `ADVANCED_MAPPING_FIELDS`
- 定义：`src/main.js`
- 关联功能：决定哪些字段走"高级映射"分支（签名金额 / 字段拆分 / 账单拆分合并 / 字段拼接）
- 变更 review 要点：
  - 增删成员 → 渲染层映射对话框 UI / 模板持久化 schema 都要同步
  - 涉及 CLAUDE.md "Amount mapping modes (4-way)" 的边界

### 4-way 金额映射模式标识
- `SIGNED_AMOUNT_MAPPING_FIELD` — 签名金额拆分
- `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` / `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` — 按字段区分发生额
- `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` / `AMOUNT_BASED_NAME_MAPPING_FIELD` — 账号 / 户名按金额匹配
- `BILL_SPLIT_MERGE_MAPPING_FIELD` — 账单拆分合并
- 定义位置：均在 `src/main.js`
- 变更 review 要点：
  - 四种模式互斥（CLAUDE.md Key Business Rules），改任意一个都要验证其他三种未串味
  - 模板 JSON bundle 的 `bundleVersion` 可能需要同步升格
  - 必跑：四种模式各一个样例模板的导入/导出

### `CONCAT_FIELDS_MAPPING_FIELD`
- 定义：`src/main.js`
- 关联功能：字段拼接映射（如 Narrative = 摘要 + 备注）
- 变更 review 要点：拼接顺序 / 分隔符变化会直接改动输出内容

### `MERCHANT_ID_SELF_INPUT_OPTION`
- 定义：`src/main.js`
- 关联功能：大账号弹窗"自行输入 MerchantId"选项；CLAUDE.md Big Account Selection 的默认分支来源
- 变更 review 要点：自行输入值落盘到 `lastFileImportContext`，导出时复用——改了标识要同步改匹配逻辑

### `BALANCE_CALCULATED_OPTION` / `BALANCE_DISABLED_OPTION`
- 定义：`src/main.js`
- 关联功能：余额字段的三态（直列 / 发生额推算 / 停用），CLAUDE.md Key Business Rules § Balance calculation
- 变更 review 要点：
  - 改枚举值会让历史模板持久化记录错位
  - **资金相关**，必跑：余额工作表（单币种 + 混币种）导出对比

### `FILENAME_MAPPING_TEMPLATE_ID`
- 定义：`src/main.js`
- 关联功能：文件名映射模板的保留 ID；不能被普通模板占用
- 变更 review 要点：若改 ID，`database/template-repository.js` 里所有 `where id = FILENAME_MAPPING_TEMPLATE_ID` 分支要同步

### `ALL_BANKS_TEMPLATE_SCOPE`
- 定义：`src/main-process/monthly-balance.js`
- 关联功能：月度余额聚合时"全行"特殊 scope 标识
- 变更 review 要点：跨表聚合逻辑依赖它识别"不限银行"

### `SUPPORTED_EXTENSIONS`
- 定义：`src/backend/file-service/common.js`
- 关联功能：文件选择对话框过滤 + 拖入校验
- 变更 review 要点：增加新格式要同步 reader 实现与 UI 提示文案

### `FileValidationError`
- 定义：`src/backend/file-service/common.js`
- 关联功能：**项目唯一自定义错误类**；所有导入/导出的错误报告格式统一靠它
- 变更 review 要点：
  - 字段 (code / message / detail lines / context) 是对外 error-report 的 schema
  - 改字段要同步所有 catch 分支 + 错误报告 writer

### `runReconciliation`（v2.1.3 业务OP数据核对）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 数据核对模块**资金对账总入口**；编排 4 步算法（流水累加 → 计算 T-1 OP → 1:N 逐行精准比 → 账户号差集）+ 落库 runs/diff_rows
- ⚠️ 命名冲突：与 v1.5.x Pending 模块同名 `runReconciliation` 存在；改前必先 `grep -rn "runReconciliation" src/` 确认改的是哪个模块
- 变更 review 要点：
  - **资金红线**：4 步流程任一改动直接影响差异判定结果
  - 改函数签名 / summary 字段 → IPC handler `bizOpRecon:run` 出参 schema 同步 + 前端状态栏文案同步
  - 关联拍板点：fix4（multiOpAccountSeen Set 防重复累加） / fix5（相等多 OP 行 push diffRows） / round1 I3（T-2 NaN end_balance 加 console.warn + summary.t2AnomalyAccountCount）
  - 必跑：smoke biz-op-recon Case A-K 全套 + 真实数据样本回放

### `compareT1OpWithComputed`（v2.1.3 1:N 精准标差异核心）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块 OPEN ISSUE #6 拍板 A 1:N 逐行独立比的核心算法；同账户号 N 条 T-1 OP 行各自与计算 T-1 期末余额比较，逐行独立标"相等/不相等"
- 变更 review 要点：
  - **资金红线**：epsilon=1e-2 容差不可放宽；超过 → 标"不相等"，进 diff_rows 表
  - **fix5 选项 B 关键不变量**：多 OP 账户的相等行（`t1Rows.length >= 2 && diff <= epsilon`）也必须 push diffRows，meta = `相等/空/是`；单 OP 相等行不进表
  - `amountDiffCount` 仅累计"不相等"行（相等多 OP 不计入差异计数）；`multiOpAccountCount` 按账户号去重统计
  - 必跑：smoke biz-op-recon Case B（多 OP 行）+ Case J（fix5 反例防回归）

### `runFlowImportAsync`（v2.1.3 流水对账单导入入口，**round 3 P1 升格 ⚠️ 资金红线**）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块流水对账单导入核心入口；接收 `{date, filePath}`，事务内做 28 列表头校验 + 出入方向枚举校验 + DELETE 旧流水 + **`clearRunsAndDiffsByDate(db, date)` 清该 date 跨所有 BU 的旧 runs/diff_rows** + INSERT 新流水
- 变更 review 要点:
  - **资金红线**（round 3 P1 修订前曾漏清）：流水换了对账没重跑 → 用户「导出差异」拿 stale 数据 = 资金事故。事务内必须包含 `clearRunsAndDiffsByDate(db, date)` 调用
  - **与业务OP 重导对照**：业务OP 重导只清单 BU（`clearRunsAndDiffsByDateBu`）；流水重导按 date 跨所有 BU 清（`clearRunsAndDiffsByDate`）— 两个清函数语义不可混
  - 改事务边界 / 清函数调用顺序 → 必跑 smoke Case P 防回归（构造同 date 跨 2 BU success run + 重导流水 + 断言所有 BU 的 runs/diff_rows 均被清）
  - 必跑：smoke biz-op-recon Case D（流水累加 + 出入方向）+ Case P（流水重导清 runs）+ 真实数据手测（同 date 跨 ≥ 2 BU 已 success run，重导流水后两 BU 的「导出差异」success 日期均消失，需重新跑对账）

### `runBizOpImportAsync`（v2.1.3 业务OP 导入入口，**round 4 P1 升格 ⚠️ 资金红线**）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块业务OP 导入核心入口；接收 `{date, filePath}`，事务内做 23 列表头校验 + 双重校验 + DELETE 旧业务OP `(date, BU)` + **`clearRunsAndDiffsByDateBu(db, date, BU)` 清当天作为 T-1 的 runs/diff_rows**（#15 拍板 A 已实现）+ **`clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 清下一日作为 T-2 的 runs/diff_rows**（round 4 P1 新增）+ 落库前 `bu_name = String(rawBuName).trim()`（I2 round 1）+ INSERT 新业务OP
- 变更 review 要点:
  - **资金红线**（round 4 P1 修订前曾漏清下一日）：业务OP 某日数据**双角色** — 既是当天对账 T-1 也是下一日对账 T-2 输入（参见 PRD §3.4.1 步 4.2.a `计算 T-1 OP = T-2 期末 + 流水累加`）。漏清下一日 (date+1, BU) run → D+1 日 run 仍按"旧 T-2 期末 + 流水累加"算 = stale 差额 → 「导出 D+1 差异」拿错数据 = 资金事故
  - **必须两次调用 `clearRunsAndDiffsByDateBu`**：一次 `(date, BU)`（当天 T-1）+ 一次 `(addOneDay(date), BU)`（下一日 T-2）；缺一不可
  - **`addOneDay` 必须 UTC 实现**：避免本地时区抢跑/滞后导致跨日错位；时区错乱直接错日期 → 漏清下一日 run 或误清后天 run = 资金事故（详见 `addOneDay` 条目）
  - **与 `runFlowImportAsync` 区分语义**：业务OP 单 BU 跨 2 日清（D + D+1）；流水跨 BU 单日清（D 跨所有 BU）— 不可对调
  - 改事务边界 / 清函数调用次数 / addOneDay 实现 → 必跑 smoke Case Q 防回归（构造 BU-A 跨 D-1/D/D+1 三日业务OP + 跑 D 与 D+1 两 run 成功 + 重导 D 业务OP + 断言 D 与 D+1 两 run 均被清）
  - 必跑：smoke biz-op-recon Case A（核心对账）+ Case M（C1 大小写归一）+ Case N（I2 BU trim 归一）+ Case Q（业务OP 重导清下一日 runs）+ 真实数据手测（同 BU 跨 ≥ 3 日业务OP + 跑 D 与 D+1 两 run，重导 D 业务OP 后两 run 「导出差异」success 日期均消失）

### `acquiring_bill_currency_flow_imports.settle_amount_abs`（v2.1.6 收单流水通道清算金额绝对值入库列，v0.7 fix4 重命名自 recon_amount_abs）
- 定义：`src/backend/database/migrations.js` 中 `ensureAcquiringBillCurrencyTablesSupport` DDL；写入路径在 `src/backend/acquiring-bill-currency-db/import-repository.js` 的 `parseAmountAbs` + `insertFlowRow`
- 关联功能：收单单据币种校验 — 流水侧**通道清算金额**绝对值入库列；差异表 `流水_通道清算金额` 直接取该列值（无二次 ABS）
- v0.7 fix4 变更：取值列从 Excel 第 13 列「对账金额」(values[12]) 切换为第 29 列「通道清算金额」(values[28])
- 变更 review 要点：
  - **资金红线**：`parseAmountAbs` 改实现（含 `Number(...)` 解析方式 / `Math.abs` / `toString` 精度） → 差异表金额值漂移
  - 修改 DDL 列类型（TEXT → REAL 等） → 必须同步 reader 入库 + writer 输出格式
  - 改取值列号（values[28]） → 必须同步 spec §3.1 ★ 标列 + smoke fixture
  - 必跑：smoke acquiring-bill-currency Case A / J（通道清算金额入库 + 输出值精度）+ 真实数据手测（含负数金额行）

### `acquiring_bill_currency_*.settle_currency` / `settle_currency_norm`（v2.1.6 收单流水/单据通道清算币种入库列，v0.7 fix4 对账核心字段）
- 定义：`src/backend/database/migrations.js` DDL；写入路径在 `src/backend/acquiring-bill-currency-db/import-repository.js` 的 `insertFlowRow`（流水侧取 values[29]「通道清算币种」）/ `insertBillRow`（单据侧取 values[19]「对账币种」）+ `normalizeCurrency`
- 关联功能：收单单据币种校验 — **对账核心比对字段**，SQL JOIN 时与对侧 settle_currency_norm 比较判定是否差异
- v0.7 fix4 关键决策：流水侧取值列从 Excel 第 14 列「币种」(values[13]) 切换为第 30 列「通道清算币种」(values[29])；单据侧列号 values[19] 保持（语义本就是清算视角，仅 DB 字段重命名）。原因 = 单据「对账币种」是清算视角，订单视角的「币种」对账必然 100% match 是字段语义错位
- 变更 review 要点：
  - **资金红线**：流水侧取值列号改动 → 完全改变对账结果（v0.6 = 100% match / v0.7 ≈ 56% mismatch）
  - `normalizeCurrency`（LOWER+TRIM）改实现 → 大小写/空格差异被误判为不一致
  - 必跑：smoke acquiring-bill-currency Case J/K/L 全套（matching / mismatch / 流水侧空） + 真实数据手测（混合多币种）

### `acquiring_bill_currency_diff_rows.flow_currency` / `flow_amount_abs`（v2.1.6 差异表输出关键 2 列）
- 定义：`src/backend/database/migrations.js` DDL；写入路径在 `src/backend/acquiring-bill-currency-db/run-repository.js` 的 `insertDiffRowsByJoin`（核心 SQL JOIN）
- 关联功能：收单单据币种校验差异表输出末尾 2 列 — `流水_通道清算币种` + `流水_通道清算金额`（v0.7 fix4 输出标签修订）；财务据此判断是否需要修正单据币种
- v0.7 fix4 变更：DB 列名保留 flow_currency/flow_amount_abs（避免 schema 二次变更），**值的语义改为通道清算视角**（SQL `SELECT f.settle_currency, f.settle_amount_abs`）
- 变更 review 要点：
  - **资金红线**：`insertDiffRowsByJoin` SQL JOIN 条件改动（`f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id` + `COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')`） → 直接影响差异表行选择
  - 改 `diff_type` 判定逻辑（`bill_currency_missing` vs `currency_mismatch`）→ 用户语义混淆
  - 改 SQL `settle_currency_norm` 比较 → 必须同步 import-repository 入库归一函数 `normalizeCurrency`
  - 改输出列名常量 `WRITER_OUTPUT_FLOW_CURRENCY_HEADER` / `_FLOW_AMOUNT_ABS_HEADER` → 必须同步 spec §6.2 + smoke Case A 末列表头断言
  - 必跑：smoke acquiring-bill-currency Case A/C/E/J/K/L 全套 + writer 输出 xlsx 末 3 列值断言

### `runAllScenarios` / scenario-dispatcher（v2.1.7 F8 升格 Critical ⚠️ 资金红线契约锚点）
- 定义：`src/main-process/scenario-dispatcher.js:66` `function runAllScenarios(bankRows, gwRows, scenarios)`
- 关联功能：银行账单场景化引擎统一入口 — 编排 C1（提取reconId）/ C2（账单打标）/ C3（网关核销）三类场景；按 scenarios 顺序遍历 first-match-wins；维护 `rowLockSet` 命中集合；**v2.1.7 F8 新增反向 filter `unmatchedRows = bankRows.filter(r => !rowLockSet.has(r._rowId))` 保证 `modifiedRows + unmatchedRows = bankRows`（无遗漏 + 互斥契约）**
- 跨文件度：3+（`src/main.js:3033/3036/3109/3116` IPC handler 接入 + `src/main-process/bank-statement-io.js:213` writer 桥接 + 自身 dispatcher）
- 变更 review 要点：
  - **资金红线**：first-match-wins 改为多 match 会破契约 → 同一行可能被 C1+C2 双改 → 输出错列；改遍历顺序（C1→C2→C3）→ 优先级语义变 → 用户配置场景顺序失效
  - **`unmatchedRows` 反向 filter 契约**（v2.1.7 F8 新增 Critical）：`modifiedRows + unmatchedRows.length === bankRows.length` 必须永远成立；改 `rowLockSet.has(r._rowId)` 判断条件 → 双计 / 漏计 → 第 2 sheet "未命中场景行" 数据集合错位
  - 改返回字段 schema（`{modifiedRows, unmatchedRows, stats}`）→ `src/main.js:3033-3116` IPC + `src/main-process/bank-statement-io.js:212-213` writer 接入必须同步
  - C4 走独立流水线（reconIdFix 模块）**不进 dispatcher** — 不要把 C4 加进 scenarios 数组
  - 必跑：smoke `npm run smoke`（19 suite 含 c1/c2/c3 全套）+ 真实银行账单端到端（混合 C1+C2+C3+空场景） + F8 第 2 sheet 行数 = bankRows - modifiedRows 断言

### `unmatchedRows`（v2.1.7 F8 dispatcher 反向 filter 输出字段，升格 Critical ⚠️ 资金红线）
- 定义：`src/main-process/scenario-dispatcher.js:152` 反向 filter；引用 `src/main.js:3036/3110/3116/3270/3309-3420`（reconIdFix 模块也用同名字段，**两条流水线共享名但语义独立** — 见下方区分说明）+ `src/main-process/bank-statement-io.js:212-213` writer 第 2 sheet 输入 + `src/main-process/acquiring-bill-currency-session.js:211` 收单单据校验也用
- 关联功能：dispatcher first-match-wins 遍历后未命中任何场景规则的行集合；导出阶段透传给 `writeBankStatementOutput` 输出第 2 sheet "未命中场景行"
- 跨流水线区分（两条 unmatchedRows 不可混）：
  1. **dispatcher unmatchedRows**（`scenario-dispatcher.js:152`）— 所有场景未命中的银行账单行；服务于 F8 第 2 sheet
  2. **reconIdFix unmatchedRows**（`src/main.js:3309-3420`）— C4 reconId 修复模块的未匹配行；服务于"导出未匹配"独立功能
- 变更 review 要点：
  - **资金红线**：dispatcher unmatchedRows 是反向 filter 派生数据；保证 `modifiedRows + unmatchedRows = bankRows` 是核心契约（F8 spec §9.8 + spec §11.3 反向同步明确）
  - 改 `_rowId` 内部字段名 → 必须同步 dispatcher rowLockSet add + 反向 filter has 判断 + writer 输出剥 internal field
  - dispatcher 与 reconIdFix 两条同名字段维护**严格分离** — 改一条不要扩散到另一条
  - writer `stripInternalFields` helper 必须保证第 2 sheet 输出不暴露 `_rowId` 等内部字段
  - 必跑：smoke 19 suite 含 baseline `modifiedRows.length` 不变（F8 上线后 baseline 严守）+ F8 第 2 sheet 行数 + unmatchedRowCount stats

### `conditionsLogic`（v2.1.7 F1 C1 AND/OR 切换契约字段，升格 Critical ⚠️ 资金红线）
- 定义：scenario.config 持久化字段 — `src/main-process/scenario-engines/c1-extract-recon-id.js:103` `runC1Scenario` 消费 + `src/renderer-dialogs.js:5744/6292/6298/6303/6306` dialog 创建+读取 + `src/renderer-previews.js:872` preview 注入；schema 位置：scenario 配置 JSON（数据库 + 内存）
- 当前值域：`'AND'` / `'OR'` / `undefined`（老 scenario 无字段 → fallback `'OR'` 维持 v2.1.7 前历史行为）
- 关联功能：F1 C1 提取 reconId 场景多条件聚合逻辑切换 — `'AND'` = 同时满足所有条件才命中；`'OR'` = 满足任一条件即命中（默认 fallback）；**新 scenario 强制默认 `'AND'`**（R5 资金红线三层护栏：createDefaultScenarioConfig 注入 + dialog helper + 引擎 fallback）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏拍板）：默认值改回 `'OR'` 或删除 fallback → 用户新建多条件场景被静默"或"逻辑命中过多行 → 错改账单
  - 三层护栏缺一不可：① `createDefaultScenarioConfig` 默认 `'AND'`（renderer-dialogs.js:5744）② `pickConditionsLogicChecked` helper mode=create 跟随 draft / mode=edit-老数据 fallback `'OR'`（renderer-dialogs.js:6298-6306）③ `runC1Scenario` 引擎 fallback `'OR'`（c1-extract-recon-id.js:103）
  - 改字段名 `conditionsLogic` → 所有 scenario 持久化 JSON 失效 + 老用户配置回退到默认
  - 改值域字符串（'AND'/'OR' → 'AND_MODE'/'OR_MODE'）→ 同上失效
  - 必跑：smoke c1 AND/OR 切换 + 新建场景 dialog 默认 AND radio 选中（preview F1 截图）+ 老 scenario 编辑 OR radio 选中（兼容性）

### `findBestAmountSubset`（v2.1.8 F5 新增 Critical ⚠️ 资金红线 — C4 manyToOne subset-sum 核心）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:298` `function findBestAmountSubset(candidates, targetCents, mainBillDate, options = {})`
- 关联功能：C4 网关对账 ReconID 修复模块 manyToOne 子集和算法核心；从 left 候选池找出金额合计 = right 目标金额的子集；F5 算法重设主修对象（v2.1.7 PRD §10.3 根因 #2 maxSize=8 硬上限）
- 变更 review 要点：
  - **资金红线**：subset-sum 等式 `Σ(left subset amount) === right.amount` 不变量绝对不可破坏
  - F5 实施方案（spec.md §1.2 F5-D1）：maxSize 动态档位 — pool ≤ 12 全跑 / 12-20 maxSize=12 / > 20 maxSize=10 + warn；F5-D5 性能护栏 — candidates > 25 → 降级 maxSize=8
  - 改 maxSize → 性能 O(2^n) 影响巨大，必须性能 smoke + 单渠道超时降级
  - F5 acceptance（spec.md §1.4）：TEST2.xlsx 跑出 57 行 / 10 渠道；TEST.xlsx 仍为 0 行（不应误升）
  - 必跑：smoke `npm run smoke` 全套 + F5 fixture（F5-TEST.xlsx / F5-TEST2.xlsx）+ unit case（G1 协同）

### `tryManyToOnePool`（v2.1.8 F5 新增 Critical ⚠️ 资金红线 — C4 网关单向消费遍历）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:719` `function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode, ...)`
- 关联功能：C4 manyToOne 主循环；按 right 行遍历 left 池子（subset-sum + 单向消费）；F5 算法重设核心改造点（v2.1.7 PRD §10.3 根因 #3 遍历顺序偏置）
- 变更 review 要点：
  - **资金红线**：「网关 right 行单向消费」不变量（每条 right 最多匹配 1 个 left subset）+ first-match-wins 不可破坏
  - F5 实施方案（spec.md §1.2 F5-D2）：复合排序 — 金额降序 + 子集大小降序；保大渠道优先
  - F5-D3 currency 字段过滤：在候选池构造时加 currency 等值过滤
  - 改遍历顺序 → 命中行数变化（v2.1.7 实测 28 行 vs TEST2.xlsx 期望 57 行差距即源于此）
  - 必跑：smoke + F5 fixture + TEST2.xlsx 3 个关键子集验证（T54SWIC494447 16 行 / T54SWIC506630 11 行 / T54SWIC470181 4M 子池）

### `WRITER_OUTPUT_HEADERS_V2`（v2.1.8 N4 新增 Critical ⚠️ 资金红线 — 收单差异表对外输出 12 列契约）
- 定义：`src/backend/acquiring-bill-currency-db/columns.js:88` `const WRITER_OUTPUT_HEADERS_V2 = Object.freeze([...TEMPLATE_BILL_HEADERS, 单据_对账币种, 流水_通道清算币种, 流水_通道清算金额])`
- 关联功能：收单单据币种校验差异表 xlsx 12 列输出契约（spec v0.10 §三.1 N4-D3 = 模版顺序）；用户 / 财务 / Excel 自动化下游 100% 依赖
- 变更 review 要点：
  - **对外输出契约**：任何修改（加/删/换列名 / 改顺序）→ 用户 Excel 自动化失效
  - 必须同步：模版 xlsx + writer.js + smoke caseA 末 N 列断言 + USER_GUIDE
  - 旧 `WRITER_OUTPUT_HEADERS`（29 列）标 deprecated 仅历史参照，新代码用 V2
  - 列名常量来源：`TEMPLATE_BILL_HEADERS`（前 9）+ `WRITER_OUTPUT_BILL_COPY_HEADER`（10）+ `WRITER_OUTPUT_FLOW_CURRENCY_HEADER`（11）+ `WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER`（12）
  - 必跑：smoke caseA 列数 = 12 + 末 4 列表头断言 + N4 migration 用例

### `TEMPLATE_BILL_HEADERS`（v2.1.8 N4 新增 Critical ⚠️ 资金红线 — 模版 9 列 truth source）
- 定义：`src/backend/acquiring-bill-currency-db/columns.js:82` `const TEMPLATE_BILL_HEADERS = Object.freeze(['账单日期', 'originBillBizId', '单据类型', '主对账Id', '业务订单号', '对账金额', '对账币种', 'valueDate', 'channel'])`
- 关联功能：模版（`assets/收单币种校验导出差异表模版.xlsx`）前 9 列字段；writer + migration 共用 truth；DB raw_json 瘦身后唯一保留的 9 字段
- 变更 review 要点：
  - **对外输出契约**：模版字段是 N4 设计的 PSU；改之 → migration 失效 + 历史数据中 raw_json 仅含旧 9 字段
  - 必须同步：assets/收单币种校验导出差异表模版.xlsx + WRITER_OUTPUT_HEADERS_V2 + ensureBillRawJsonV2Slim N4_TEMPLATE_BILL_HEADERS 内部副本
  - 字段顺序（D3=a）：必须与模版一致；不可按其他顺序保留
  - 必跑：N4 caseN4_billRawJsonSlimMigration 全流程

### `bill_imports.raw_json`（v2.1.8 N4 内容契约变更 ⚠️ 资金红线 — 永久删除 17 字段）
- 定义：`src/backend/database/migrations.js:1023` DDL `raw_json TEXT NOT NULL`
- 关联功能：收单单据导入数据的 JSON 序列化字段；v2.1.7 及之前存 26 字段，v2.1.8 N4 起仅存 9 模版字段；migration 通过 `ensureBillRawJsonV2Slim` 一次性 rewrite
- 变更 review 要点：
  - **数据不可逆**：17 字段值（ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间）永久删除
  - 历史月份差异表重导出也少这些字段 → 不能反悔
  - 下游消费方调研（v2.1.8 commit 37299cf）：仅 writer.js + run-repository.js 4 处 SQL `json_extract '$."账单日期"'` 使用；17 字段无下游消费
  - import-repository 写入 raw_json 时**仍按 26 字段写入**（reader 读 xlsx 全字段），migration 后续生效；下次需要时可在 import 阶段也裁字段
  - 必跑：N4 migration 全流程 + caseA 末 N 列表头 + readback raw_json 仅 9 字段

---

## 2. Important-skeleton — 系统骨架

**跨层协作入口。**改函数签名/语义会让上下游解析错位，但不会让历史数据失效。

### `templateRepository`
- 定义：`src/backend/database.js`（门面）
- 关联功能：所有模板 CRUD 的唯一入口；`main.js` 里 33 次调用
- 子方法（均在 `database/template-repository.js`）：
  - `saveMappings` / `getTemplate` / `deleteTemplate` / `listTemplates`
  - `saveBillSplitAmountRules` / `saveBillSplitMeta` / `saveBillSplitMappings`
  - `saveBillSplitMergeGroup` / `clearBillSplitMergeGroups` / `saveBillSplitRow`
  - `saveBillSplitRowCount` / `deleteBillSplitRow` / `setChildParent` / `setParentStatus`
  - `saveAmountSplitRules` / `getAmountSplitRules` / `getTemplateBigAccounts`
- 变更 review 要点：增减方法要同步 preload IPC 暴露与 renderer 对应调用

### `settingsRepository`
- 定义：`src/backend/database.js`
- 关联功能：全局设置读写（背景色、启动偏好等）
- 变更 review 要点：renderer 侧缓存与 main 侧持久化的 key 必须对齐

### 数据清洗基础设施
- `normalizeCell` — `file-service/common.js`（**跨 13 个文件**）
- `normalizeText` — `database/utils.js` + `database/migrations.js`
- `parseNumericValue` — `file-service/normalizers.js`
- `parseDateValue` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 变更 review 要点：
  - 任何改动都会放大到 reader/writer/migrations 三条链
  - 必跑：`npm run smoke`（会触发读写管线）
  - 必验证：多种源文件格式（Excel / CSV / PDF）输入下的规范化一致性

### 读/写管线入口
- `readRows` / `readRowsWithMetadata` — `file-service/readers.js`
- `extractHeaders` / `loadEnumValues` — `file-service/readers.js`
- `writeWorkbookRows` / `writeBalanceWorkbook` — `file-service.js`（经由 `backend/file-service.js` 门面）
- `loadCurrencyMappings` — `file-service.js`（加载 `assets/币种映射表.xlsx`）
- 变更 review 要点：
  - 签名变化要同步 `main.js` orchestration
  - 输出列变化要同步 `writers.js` 的格式化规则
  - 币种映射改动 → 混币种余额表可能出现分表错位

### `ipcRenderer`（preload）
- 定义：`src/preload.js`（61 次出现）
- 关联功能：主/渲染进程通讯唯一桥；整个 `window.desktopApi` 的底座
- 变更 review 要点：新增/删除 IPC channel 必须同步 main 端 `ipcMain.handle`

### `normalizeBu`（v2.1.3 业务OP / v2.1.2 月度BU回填校验共用）
- 定义：`src/main-process/biz-op-recon-session.js` + `src/backend/biz-op-recon-import/validator.js`（v2.1.3）；v2.1.2 月度BU回填校验也有同名实现
- 实现：`String(v).trim().toLowerCase()`
- 关联功能：BU 名归一化比较；流水 `bu_dept` vs 业务OP `bu_name` 跨表关联；OPEN ISSUE #7 拍板 C
- 变更 review 要点：
  - 多文件多 repository SQL 内嵌 `LOWER(TRIM(...))` 必须与函数实现保持一致（C1 round1 fix：`clearByDateBu` 已对齐 `LOWER(TRIM(?))`）
  - 改 normalize 规则要同步 v2.1.2 + v2.1.3 两处实现 + repository 内 SQL
  - 仅用于比较，**不改写落库原值**
  - 必跑：smoke biz-op-recon Case G（BU 隔离 + 大小写差异容忍）

### `normalizeAccountKey`（v2.1.3 账户号匹配 anchor）
- 定义：`src/main-process/biz-op-recon-session.js` + `src/main-process/biz-op-recon-writer.js`
- 实现：仅 `String(v).trim()`（**不**做大小写归一；账户号是资金 key）
- 关联功能：业务OP `账户号` 与流水 `账户编号` 跨表 key 归一；区间导出 sort key（M4 round1：writer 排序 key 改用 normalizeAccountKey）
- 变更 review 要点：
  - 跨 session.js / writer.js 两文件使用，改实现要同步
  - 不可加 toLowerCase（账户号大小写有业务含义）
  - 必跑：smoke biz-op-recon Case A/B + Case K（区间排序）

### `BIZ_OP_HEADERS`（v2.1.3 业务OP 23 列定义）
- 定义：`src/backend/biz-op-recon-db/columns.js`
- 关联功能：业务OP 表头校验 anchor + writer 输出列顺序 + reader 字段映射；模板 `assets/业务OP账单.xlsx` 23 列冻结数组
- 变更 review 要点：
  - 改顺序/列名 → 表头严格匹配会拒绝旧版业务OP 文件
  - writer / reader / validator 三处必须同步引用本数组
  - 配合 differ 的 4 列 meta（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）→ 差异表 27 列结构
  - 必跑：smoke biz-op-recon Case A/E + 真实业务OP 文件回放

### `FLOW_HEADERS`（v2.1.3 流水对账单 28 列定义）
- 定义：`src/backend/biz-op-recon-db/columns.js`
- 关联功能：流水对账单表头校验 anchor + reader 字段映射；模板 `assets/流水对账单.xlsx` 28 列冻结数组
- 变更 review 要点：
  - 改顺序/列名 → 表头严格匹配会拒绝旧版流水文件
  - 与 BIZ_OP_HEADERS 同步管理（配套常量）
  - 必跑：smoke biz-op-recon Case D（流水累加 + 出入方向）+ 真实流水文件回放

### `ALL_MODULE_IDS`（v2.1.4 — 7 个主模块 ID 全集 anchor）
- 定义：`src/backend/database/settings-repository.js`
- 关联功能：单文件定义，但被 `CURRENT_MODULE_VALID`（`setCurrentModule` 校验）+ `setEnabledModules`（启用列表校验）共用；renderer 端 `MODULES` 常量必须与之一致；新增模块时两边都要加
- 变更 review 要点：
  - 新增模块 → 必须同步加到 `ALL_MODULE_IDS` + renderer 端 `src/renderer.js` 的 `MODULES` 常量（两边定义必须完全一致）
  - 如忘了同步 → 用户切到新模块会抛 `Invalid current_module`（v2.1.2/v2.1.3 即遗留过此 bug，v2.1.4 修复）
  - 修改 ID 字符串 → DB 内已持久化的 `current_module` / `enabled_modules` 会因 sanitize 被回退到默认值
  - 必跑：`npm run smoke`（settings-repository 内部测试）+ 手动验证 7 个模块逐一切换 + 收纳弹窗启用各模块后切换

### `enabled_modules`（v2.1.4 — 左上角模块切换菜单的启用列表全链路）
- 定义：
  - 持久化 key：`app_settings.enabled_modules`（JSON 数组）— `src/backend/database/settings-repository.js`（`ENABLED_MODULES_KEY` 常量 + `getEnabledModules` / `setEnabledModules` / `DEFAULT_ENABLED_MODULES`）
  - facade：`src/backend/database.js`（`AppDatabase.getEnabledModules` / `setEnabledModules`）
  - IPC channel：`settings:get-enabled-modules` / `settings:set-enabled-modules` — `src/main.js` + `src/preload.js`
  - app:get-info 启动注入字段：`enabledModules`
  - renderer 缓存：`state.enabledModules`（`src/renderer.js`）
  - 渲染入口：`renderTopModuleSwitcher()`（`src/renderer.js`，按 `state.enabledModules` 动态渲染 `#moduleSwitcherMenu`）
  - 收纳弹窗工厂：`createModuleCabinetDialog`（`src/renderer-dialogs.js`）
- 关联功能：左上角模块切换菜单的状态驱动；用户可通过 🔄 收纳弹窗自定义启用模块及顺序；持久化跨重启
- 跨文件度：5+ 文件（settings-repository / database / main / preload / renderer / renderer-dialogs / renderer-previews）
- 变更 review 要点：
  - 改持久化 schema（JSON 数组元素 → 对象）→ 必须写迁移读旧格式 + 改 `getEnabledModules` sanitize 逻辑
  - 改 `DEFAULT_ENABLED_MODULES`（默认 3 个 → 改 N 个）→ 影响新用户首次启动体验；旧用户已 seed 不受影响
  - 改启用区"至少保留 1"约束（O3）→ 需同步 renderer 端 `updateControls` + repo 端 `setEnabledModules('') throw` 校验
  - 改 `setCurrentModule` fallback 逻辑（`current_module` 不在启用列表时切到第 1 个）→ 影响 `initialize()` 启动序 + 收纳弹窗 `onCommit` 回调
  - 必跑：① 新 DB 启动 → seed 默认值；② 旧 DB（无该 key）启动 → seed；③ DB 写入非法 JSON → 回退默认；④ `setEnabledModules([])` 抛错；⑤ 弹窗 ➡️/⬅️/拖拽 三种交互后菜单同步刷新

### `parseBillDateMs`（v2.1.8 F5 新增 Important-skeleton — BillDate 字符串化入口）
- 定义：`src/main-process/scenario-engines/c4-recon-id-fix.js:168` `function parseBillDateMs(s)`
- 关联功能：C4 BillDate 日期解析，正则 `^(\d{4})[-/](\d{1,2})[-/](\d{1,2})`；v2.1.7 PRD §10.3 根因 #1 — Excel 真日期 raw:true 读出 number 序列号导致解析全 fail（v2.1.7 单点 fix 仅修 28 行的根因）
- 变更 review 要点：
  - F5 实施方案（spec.md F5-D4 v0.3 Reverse Sync 后）：**不动** parseBillDateMs 本身，**不动** reader 入口 raw 模式；改在 `c4-recon-id-fix.js:1058-1065` gateway 映射段做 number → ISO 字符串转换后再赋给 BillDate（让 parseBillDateMs 拿到字符串能解析）
  - 跨文件度 10（scan-vars baseline），改函数签名 / 返回类型要 grep 全部调用方
  - 改正则 → 历史 BillDate 字符串可能匹配失败 → 候选池消失
  - 必跑：smoke c4 + F5 fixture + unit case（输入字符串 / 输入 number 序列号 → ISO 后输入对比）

### `cleanupAfterRunBackground`（v2.1.8 N1 新增 Important-skeleton — runCheck 后置清理函数；v0.7 N1' 加 includeDiff 参数）
- 定义：`src/main-process/acquiring-bill-currency-session.js:295` `async function cleanupAfterRunBackground({ db, monthKey, runId, onProgress, includeDiff = false })`
- 关联功能：收单单据币种校验模块 runCheck 后清理；每批 50000 行 + setImmediate 让出 event loop
- 变更 review 要点：
  - N1 β 方案（spec.md §三）：触发链路改造 — runCheck → app.before-quit 主 + 进入模块兜底
  - **N1' v0.7 改造**（spec.md v0.10 §三）：
    - 主触发改 idle 30min（`setupIdleCleanupTimer`）；before-quit 降级静默兜底；进入模块降级崩溃恢复兜底
    - 新增 `includeDiff=false` 参数（默认）：仅清 flow_imports；bill_imports + diff_rows 保留（**FK 约束** `diff_rows.bill_import_id REFERENCES bill_imports(id)` 无 CASCADE 强制）
    - `includeDiff=true` 仅 cleanupOrphanData Phase 2 用（清孤儿 run 脏数据 → diff → bill → flow 顺序解 FK）
  - **不动 cleanup 算法本身**（50000 行/批 + setImmediate）；仅触发时机 + 范围
  - 调用方变化：v2.1.7 main.js:10307 setImmediate → v2.1.8 移除 → v0.7 新增 setupIdleCleanupTimer / before-quit / listMonths 三触发
  - 必跑：smoke caseP（默认 includeDiff=false → bill/diff 保留 + flow 清）+ caseP2（includeDiff=true → 3 表清）+ caseQ cleanupOrphanData 不动

### `setupIdleCleanupTimer`（v2.1.8 N1' v0.7 新增 Important-skeleton — idle 30min cleanup 触发器）
- 定义：`src/main.js:10620` `function setupIdleCleanupTimer()`；关联常量 `IDLE_CLEANUP_MS = 30 * 60 * 1000` / `IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000`；关联状态 `lastUserActivityTs`
- 关联功能：app.whenReady 后启动定时器；每 2min tick 检查 `Date.now() - lastUserActivityTs >= 30min` → 复用 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded`（含 mutex 抢锁 + 防重入）
- 变更 review 要点：
  - **触发条件 AND 设计**（spec v0.10 §3.2.2 N1''-D6）：renderer 上报 user-activity + mutex 间接判定 main 未忙；改任一条件 → idle 误判风险
  - 改 IDLE_CLEANUP_MS 常量 → 用户体验大变（短 → cleanup 频繁打扰；长 → 数据长期不清）
  - 改 tick 粒度 → 触发延迟 + CPU 开销 trade-off
  - **不能加 .unref() 删除**（避免阻塞退出，但要确保 cleanup mutex 在 before-quit 之前抢到）
  - 必跑：手测 30min 不动 → 触发 + log；smoke 中 fake timer 验证 idle 路径（v2.1.9 G1 全量铺时补 unit case）

### `INTERNAL_FIELDS`（v2.1.8 N3-2 新增 Important-skeleton — writer 内部字段过滤白名单）
- 定义：`src/main-process/exceljs-writer.js:25` `const INTERNAL_FIELDS = new Set([...])`
- 关联功能：exceljs-writer 输出 Excel 时过滤行数据的"内部字段"（`_hitScenarioId` / `_hitScenarioName` / `_rowId` 等下划线前缀字段不暴露给用户）
- 变更 review 要点：
  - N3-2 实施（spec.md §五）：新增 Sheet 3「命中场景行」时，保留 INTERNAL_FIELDS 过滤总规则，仅「命中场景」列通过**白名单显式拼装**（不破坏其他下划线字段的过滤）
  - 改字段名集合 → 其他下游 writer 可能漏过滤导致内部字段泄露
  - 必跑：smoke N3-2（Sheet 3 含「命中场景」列 + 其他 _ 前缀字段仍被过滤）+ N3-1 状态框 displayIndex 对齐

### `BANK_STATEMENT_FIELDS_FOR_C3`（v2.1.8 N2 新增 Important-skeleton ⚠️ preload 双写坑）
- 定义：
  - `src/constants/bank-statement-fields.js:60` `const BANK_STATEMENT_FIELDS_FOR_C3 = Object.freeze([...])`
  - `src/preload.js:19`（inline 重复一份，**双写坑**）
- 关联功能：C3「对账成立后赋值」第二下拉（assign-bank）的枚举源；45 项（44 标准字段 + 1 虚拟字段「发生额绝对值」）
- 变更 review 要点：
  - N2 实施（spec.md §四）：枚举列表第 2 位插入「自取值」`{ value: '__CUSTOM__', label: '自取值' }`
  - **必须两处同步**：`bank-statement-fields.js` + `preload.js` —— 漏改一处 UI / 引擎语义就分裂
  - 跨文件度 3（scan-vars baseline），改字段集合 → C3 dialog 显示 / 引擎赋值 / scenario 持久化都受影响
  - 必跑：smoke N2（dialog 显示「自取值」第 2 位 + 引擎 mode='custom' 分支 + DB migration 旧 scenario 升级）

---

## 3. Runtime-state — 运行时全局状态

**运行时唯一实例。**改赋值/清理时机会让 UI 与数据不同步。

### `dialog`
- 定义：`src/main.js`（来自 `require('electron')`）
- 次数：230+
- 关联功能：所有原生对话框（文件选择 / 错误报告 / 覆盖确认）
- 变更 review 要点：改 dialog 调用必须考虑用户取消分支
- ⚠️ check-vars 命中说明：`dialog` 是通用名，renderer 层 dialog factory 里也常写 `const dialog = document.createElement(...)`。命中时需人工判断是 `src/main.js` 的 `require('electron').dialog`（真命中）还是渲染层局部变量（可忽略）

### `state`
- 定义：`src/renderer.js` 顶层（单例）
- 次数：120+
- 关联功能：渲染层唯一状态对象；CLAUDE.md State Management § Renderer
- 变更 review 要点：
  - 任何子字段改动都可能引起 UI 重渲染失效
  - 特别注意：模板列表 / 当前模块 / 导出可用性 三组联动

### `elements`
- 定义：`src/renderer.js` 顶层
- 次数：100+
- 关联功能：DOM 引用缓存；初始化后不可变
- 变更 review 要点：增删 DOM 节点要同步 cache 初始化

### `setStatus`
- 定义：`src/renderer.js`
- 关联功能：状态栏唯一写入口；UI 反馈核心
- 变更 review 要点：改消息格式要同步所有调用点的语气一致性

### `lastGeneratedExports`
- 定义：`src/main.js`
- 关联功能：上次导出缓存；**CLAUDE.md State Management 明确列为"不持久化全局"**
- 变更 review 要点：
  - 改生命周期会让重复导出/打开导出目录的行为异常
  - 已知副作用：重启丢失，不要为它加持久化（与现有设计冲突）

### `statementImportSessions` / `lastFileImportContext`
- 定义：`src/main.js`
- 关联功能：会话级导入上下文（CLAUDE.md State Management 提及）
- 变更 review 要点：session key 生成逻辑变化会让导出阶段丢失上下文

### `MODULES` / `setCurrentModule`
- 定义：`src/renderer.js`
- 关联功能：模块切换状态机
- 变更 review 要点：增加模块枚举要同步 UI tab + 路由分发

### `refreshTemplates`
- 定义：`src/renderer.js`
- 关联功能：模板列表刷新唯一入口
- 变更 review 要点：模板增删改后必须调用此函数，否则列表不同步

### `app`
- 定义：`src/main.js`（来自 `require('electron')`）
- 关联功能：Electron app 生命周期
- 变更 review 要点：改启动 / 退出钩子要考虑未保存状态

### `AppDatabase` / `AppDatabase.init`（v2.1.7 F7-A1 升格 Important-skeleton ⚠️ 全局影响）
- 定义：`src/backend/database.js:33` `class AppDatabase`（门面）；`init()` 方法在 `database.js:42` 附近设全局 PRAGMA
- 关联功能：项目唯一 SQLite DB 入口；CLAUDE.md State Management § SQLite 唯一持久化层；**v2.1.7 F7-A1 在 init() 内设全局 PRAGMA**（`journal_mode=WAL` / `synchronous=NORMAL` / `cache_size=-65536` 即 64 MB / `mmap_size=268435456` 即 256 MB）
- 跨文件度：2+（`src/backend/database.js` 定义 + `src/main.js:10431` 单例 `new AppDatabase(dataPath)`）
- 变更 review 要点：
  - **WAL 模式破坏性副作用**：用户机器 `tool-data.sqlite` 同目录会产生 `*.sqlite-wal` + `*.sqlite-shm` 旁文件；备份策略必须同步含旁文件（USER_GUIDE 已加 F7 WAL 旁文件备份提示）
  - 改 `cache_size` / `mmap_size` 数值 → 内存占用直接放大（64M cache + 256M mmap）；低配 Windows 机器需评估
  - 改 `journal_mode` → 回滚到 DELETE/MEMORY 会让并发读写性能退化（v2.1.6 → v2.1.7 性能提升核心来源）
  - 改 `synchronous` → NORMAL→FULL 写性能下降 ~2x；NORMAL→OFF 崩溃可能丢已提交事务（资金红线警戒）
  - init() 调用时机变化（如延迟到首次操作）→ 启动期间未跑迁移即用 DB
  - 必跑：smoke 19 suite 全套（PRAGMA 全局影响）+ 真实 DB 备份恢复演练（含 WAL 旁文件）+ 启动 cold/warm 双跑

### `updateStatusBox`（v2.1.7 R3+B5 升格 Important-skeleton ⚠️ 全局影响）
- 定义：`src/renderer.js:520` `function updateStatusBox(box, message, tone, options)`
- 当前实现：`String(message).replace(/：/g, '：\n')` 中文「：」自动换行（R3 全局规则）+ `box.dataset.tone = tone` 联动 `data-tone` 属性选择器（解决历史 tone 不生效 bug）
- 关联功能：渲染层状态栏唯一写入口；**v2.1.7 R3 加全局中文「：」换行**（配合 `src/styles-gemini-extra.css:1852` `white-space: pre-wrap`）；**B5 wiring 加固后**所有模块（acquiring / bankStatement / reconIdFix / bankBuRecon / bizOpRecon 等 6+ 模块）的状态栏全部走该入口
- 跨文件度：4+（`src/renderer.js`:520/552/561/3333/3686/3913/4143/4254 共 8+ 直接调用 + `src/styles-gemini-extra.css` + `src/styles.css` CSS 联动 + `src/renderer-dialogs.js` 部分模块间接调用）
- 变更 review 要点：
  - **全局影响**：改 `replace(/：/g, '：\n')` 规则 → 全模块状态栏文案视觉变化；删除 → 所有 ":" 文案重新挤一行
  - **B5 wiring 契约**（v2.1.7 round 3）：所有 statusBox 写入必须走 `updateStatusBox(box, message, tone)` 不能直写 `box.textContent = ...`（绕过会丢 tone + 换行）；新增模块状态栏时必须走该入口
  - 改 `box.dataset.tone` 联动逻辑 → CSS `[data-tone="error"]` / `[data-tone="success"]` 选择器失效
  - 改 `options` 参数 schema → 6+ 调用方需同步
  - **半角 `:`** 不在 R3 规则范围（仅中文「：」）；改规则覆盖半角需评估 acquiring 模块时间戳文案影响
  - 必跑：smoke 19 suite（含 R3 全局回归）+ 6+ 模块状态栏手测（每模块写入一次状态后检查换行 + tone 颜色生效）+ B5 wiring 防回归（直写 `box.textContent` 引入 → smoke 应拒绝）

---

## 4. Risk-sensitive — 资金 / 过滤 / 迁移红线

**CLAUDE.md 第 7 条"风险显式提醒"覆盖区。**错一次会直接变成业务事故。

### 金额计算
- `roundAmount` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 关联功能：金额舍入 + 格式标准化
- 变更 review 要点：
  - **资金安全**：精度/舍入规则变化会直接改账单数值
  - 必须跑：带小数点精度的 Excel 样例 + 负数样例 + 货币别名样例
  - 必须高亮提醒人工复核

### 余额计算
- `calculateEndingBalanceFromAmounts` — `file-service/normalizers.js`
- `inferEndingBalance` — `file-service/normalizers.js`
- 关联功能：由发生额倒推期末余额（CLAUDE.md Balance calculation）
- 变更 review 要点：
  - 算法变化会让所有"通过发生额计算"模式的模板输出数值变化
  - 必跑：单币种 + 混币种余额表对比
  - **资金相关**，必须高亮

### 行过滤
- `isRowMeaningful` — `file-service/common.js`
- `hasEffectiveAmount` — `file-service/normalizers.js`
- 关联功能：CLAUDE.md "Rows with both Credit and Debit = 0/empty are silently skipped"——**静默跳过判定依据**
- 变更 review 要点：
  - 判定变宽 → 会引入无意义空行
  - 判定变严 → 会吞掉真实数据（**风险更高**）
  - 必跑：带零值样本 / 仅单边有值 / 两边都非零（应该 abort）的样例

### 账单合并
- `mergeMappedDetailRows` — `main-process/statement-session.js`
- `cloneRowsWithMetadata` — `main-process/statement-session.js`
- 关联功能：账单拆分合并模式的核心实现
- 变更 review 要点：合并键变化会让历史模板合并行为不一致

### 固定字段解析
- `resolveSinglePreparedFieldValue` — `main-process/statement-session.js`
- 关联功能：`FIXED_FIELD_VALUE_PREFIX` 的消费方
- 变更 review 要点：与 Critical § `FIXED_FIELD_VALUE_PREFIX` 一起改，不可单独改

### 数据库迁移
- `hasColumn` — `database/migrations.js`
- `ensureAccountMappingCurrencySupport` / `ensureAccountMappingTemplateSupport`
- `ensureAmountSplitRulesSupport`
- `ensureBillSplitMergeSupport` / `ensureBillSplitTargetSeqSupport`
- `ensureParentTemplateSupport`
- `ensureTemplateBigAccountNatureSupport`
- `ensureTemplateDateFormatSupport`
- `ensureTemplateFilenameFixedFieldSupport`
- 定义：全部在 `src/backend/database/migrations.js`
- 关联功能：幂等 schema 升级
- 变更 review 要点：
  - **数据库迁移**，CLAUDE.md 第 7 条明确红线
  - 新增迁移必须幂等（可重复运行不破坏）
  - 必跑：空库启动 + 老版本库启动（可用之前的 `tool-data.sqlite` 备份）
  - 不允许 DROP / 破坏性 ALTER
  - **N4 例外（v2.1.8 破坏性 raw_json rewrite）**：`ensureBillRawJsonV2Slim` 是已立项的破坏性 migration，强制配套 DB 备份 + 事务回滚 + 标志位

### `ensureBillRawJsonV2Slim`（v2.1.8 N4 新增 Important-skeleton + 🔴 破坏性 + 资金红线）
- 定义：`src/backend/database/migrations.js:803` `function ensureBillRawJsonV2Slim(db, dbPath)`
- 关联功能：v2.1.8 首次启动自动备份 DB 到 `<dbDir>/backups/tool-data-bak-pre-N4-<ts>.sqlite` → 事务包裹分批 rewrite `acquiring_bill_currency_bill_imports.raw_json` 仅保留 9 模版字段 → 写 marker `app_settings.acquiring_bill_raw_json_v2_migrated=true`
- 变更 review 要点：
  - **数据不可逆**：17 字段值永久删除；备份失败 → migration 不启动（数据完整性优先）
  - 幂等保护：marker 已写 → 跳过；失败回滚不写 marker → 下次重试
  - **不能改 N4_TEMPLATE_BILL_HEADERS 内部副本**而不同步 `TEMPLATE_BILL_HEADERS` 常量（Critical §1）
  - 备份方式 `PRAGMA wal_checkpoint(TRUNCATE) + fs.copyFileSync` 不能改成不一致的方式
  - 必跑：smoke caseN4_billRawJsonSlimMigration（首次 migrated + 幂等跳过 + 备份文件存在 + 9 字段保留 + 17 字段删除）

### `lastUserActivityTs` + `IDLE_CLEANUP_MS` + `reportUserActivity`（v2.1.8 N1' v0.7 新增 Runtime-state）
- 定义：
  - `src/main.js:25` `let lastUserActivityTs = Date.now()`（模块级）
  - `src/main.js:23` `const IDLE_CLEANUP_MS = 30 * 60 * 1000`
  - `src/preload.js:88` `reportUserActivity: () => ipcRenderer.send('app:user-activity')`
  - `src/main.js:3550` `ipcMain.on('app:user-activity', () => { lastUserActivityTs = Date.now(); })`
  - `src/renderer.js:226` `setupUserActivityReporter()`（mousemove/keydown/click/wheel/touchstart 10s 节流）
- 关联功能：N1' idle 30min 后台 cleanup 判定依据（spec v0.10 §3.2.2 N1''-D6/D7/D8）
- 变更 review 要点：
  - **节流间隔 10s**：renderer 10s 内必上报一次（避免长按拖动误判）；改短 → IPC 压力；改长 → 误判风险
  - **常量 IDLE_CLEANUP_MS 改值** → 用户体验大变；建议常量集中保留，未来 v2.1.9 评估 settings 化（D8=a 锁定不做）
  - lastUserActivityTs 是模块级单例 `let`，跨 IPC handler 共享；不能改成对象属性 + 多实例
  - 必跑：手测移鼠标 → lastUserActivityTs 更新；闲置 30min → setupIdleCleanupTimer tick 触发 cleanup

### 大账号数据迁移
- `splitTemplateName` — `database/own-accounts-migration.js` + `database.js`
- `appendMigrationLog` / `MIGRATION_FLAG_KEY` / `buildSanitizedBankNameIndex`
- 定义：`src/backend/database/own-accounts-migration.js`
- 关联功能：2026-04 之前大账号数据从 template-scoped 到 own-accounts-scoped 的迁移（详见 memory `workflow_multi_version`）
- 变更 review 要点：
  - 这是"一次性且不可回退"的迁移
  - MIGRATION_FLAG_KEY 的含义不可改（已落盘到用户机器）

### 路径归一化
- `normalizeInputFilePaths` — `main-process/statement-session.js`
- 关联功能：跨平台路径处理（Windows 反斜杠 / 网络路径）
- 变更 review 要点：必跑 Windows 环境 + 中文路径

### `aggregateFlowByAccount`（v2.1.3 流水按账户汇总）
- 定义：`src/main-process/biz-op-recon-session.js`
- 关联功能：业务OP 模块步骤 4.1 — 按 normalizeBu 过滤 + 按账户号累加 signedAmount → Map
- 变更 review 要点：
  - **资金红线**：累加错误直接导致计算 T-1 期末错位 → 全表差异判定失效
  - 内部依赖 `parseSignedAmount`（Risk-sensitive 红线）+ `normalizeBu` + `normalizeAccountKey` 三个函数
  - NaN 行 continue 跳过（导入阶段已通过 `validateFlowRow` 拦截，对账阶段二次保护）
  - 必跑：smoke biz-op-recon Case D（流水累加）+ Case G（BU 隔离）

### `parseSignedAmount`（v2.1.3 出入方向 → 正负号）
- 定义：`src/main-process/biz-op-recon-session.js`
- 实现：`'入' → +num` / `'出' → -num` / 其他 → `NaN`（OPEN ISSUE #3 拍板）
- 关联功能：流水累加时把出入方向枚举转换为正负发生额；**资金红线核心**
- 变更 review 要点：
  - **资金红线最高级**：错一个 case 分支直接资金事故（正负号倒置）
  - case 必须**完全枚举**（仅「入」/「出」），未知值必须返回 NaN，不可默认 +/-
  - 与 `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT` 常量配套（Risk-sensitive）
  - 与 `validateFlowRow` 配套：导入拦截 + 对账二次保护
  - 必跑：smoke biz-op-recon Case D（含「DEBIT」/ 空值 / 错别字反例）

### `validateBizOpRow`（v2.1.3 业务OP 双重校验）
- 定义：`src/backend/biz-op-recon-import/validator.js`
- 关联功能：业务OP 行级双重校验（OPEN ISSUE #1 拍板 B）：
  - `(1) 发生额 == 发生额（入） - 发生额（出）`
  - `(2) 期末余额 == 期初余额 + 发生额`
  - epsilon = `AMOUNT_EPSILON` (1e-2)
- 变更 review 要点：
  - **资金红线**：任一行不过 → 整批拒绝 + 失败报告（OPEN ISSUE #5 拍板）
  - 改 epsilon 阈值 → 直接影响整批拒绝判定，可能让带瑕疵数据漏入主表
  - reason 文案变化要同步失败报告 writer 的展示
  - 必跑：smoke biz-op-recon Case E（双重校验失败 + 整批拒绝 + 失败报告 xlsx）

### `validateFlowRow`（v2.1.3 流水出入方向枚举校验）
- 定义：`src/backend/biz-op-recon-import/validator.js`
- 关联功能：流水行级校验：`direction ∈ {入, 出}` + `recon_amount` 可数值化 + `account_no` 非空（OPEN ISSUE #3 拍板）
- 变更 review 要点：
  - **资金红线**：枚举判定不严会让脏值漏到对账阶段，触发 `parseSignedAmount` NaN → 静默跳过（资金事故）
  - 与 `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT` 共用常量；改任一处必须同步
  - 必跑：smoke biz-op-recon Case D + 真实流水样本检查脏值

### `AMOUNT_EPSILON`（v2.1.3 浮点精度门槛）
- 定义：`src/backend/biz-op-recon-db/columns.js`（M2 round1 提取后 — 原分散在 session.js / validator.js 两处）+ `src/backend/biz-op-recon-import/validator.js` + `src/main-process/biz-op-recon-session.js` 引用
- 当前值：`1e-2`（即 1 分钱）
- 关联功能：业务OP 双重校验（`validateBizOpRow`）+ 测算金额对比（`compareT1OpWithComputed`）共用浮点精度门槛
- 变更 review 要点：
  - **资金红线**：放宽 → 带瑕疵数据漏过校验/比对；收紧 → 误判增多
  - 必须保证多处引用同一常量（M2 round1 已提取，避免数值不一致）
  - 必跑：smoke biz-op-recon Case A/B/E（覆盖测算 + 双重校验两种使用路径）

### `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT`（v2.1.3 出入方向枚举常量）
- 定义：`src/backend/biz-op-recon-import/validator.js`（+ 引用 `src/main-process/biz-op-recon-session.js` `parseSignedAmount`）
- 当前值：`'入'` / `'出'`（中文字符）
- 关联功能：流水「出入方向」字段的合法值枚举（OPEN ISSUE #3 拍板）
- 变更 review 要点：
  - **资金红线**：值变化（如改成 'IN' / 'OUT'）→ 历史数据全部不通过校验，导入全部失败
  - 与 `validateFlowRow` + `parseSignedAmount` 三处必须同步
  - 不能加同义词（如 'in' / '入款'），避免歧义
  - 必跑：smoke biz-op-recon Case D（覆盖正反例）

### `subOneDay`（v2.1.3 业务OP T-1 → T-2 日期减一 helper，**双源**）
- 定义：`src/main-process/biz-op-recon-session.js:83` + `src/backend/biz-op-recon-db/run-repository.js:155`（**双源副本**，实现完全一致）
- 实现：`UTC + setUTCDate(getUTCDate() - 1)` + `toISOString().slice(0, 10)`（避免本地时区抢跑导致跨日错日期）
- 关联功能：业务OP 模块对账日期减一（D → D-1），即 T-1 → T-2；
  - `runReconciliation` 在 session.js 调用本地 `subOneDay` 计算 t2Date
  - `listReadyDates` 在 run-repository.js 调用本地 `subOneDay` 判定"三件齐"日期
- 变更 review 要点：
  - **资金红线**：时区错乱直接错日期 → 整批对账日期偏 1 天 → 拿错 T-2 业务OP 数据 → 计算 T-1 OP 错位 → 差异表全部失真
  - **双源**：保留双源符合 architecture 边界（避免 backend → main-process 反向依赖）；维护时**必须双侧同步**
  - **维护检查**：改任一处实现后，`grep -n "function subOneDay" src/` 确认两处行为一致
  - 不能改用 `setDate(getDate() - 1)`（本地时区版）— 在 UTC+12 / UTC-12 边界时区会抢跑或滞后 1 天
  - round 2 R2-M4 升格（spec ↔ code 对齐时发现双源；保留双源 + 加显式 review 要点）
  - 必跑：smoke biz-op-recon Case A（核心对账，验证 T-1/T-2 取数日期正确）

### `addOneDay`（v2.1.3 业务OP D → D+1 日期加一 helper，**round 4 P1 资金红线 ⚠️ 新增**）
- 定义：`src/main-process/biz-op-recon-session.js`（**单源**，与 `subOneDay` 双源不同 — addOneDay 仅在业务OP 重导清逻辑使用，无 backend 反向依赖问题）
- 实现：`new Date(date + 'T00:00:00Z')` + `setUTCDate(getUTCDate() + 1)` + `toISOString().slice(0, 10)`（与 `subOneDay` 对偶；UTC 处理避免本地时区抢跑/滞后导致跨日错位）
- 关联功能：业务OP `(date, BU)` 重导时，`runBizOpImportAsync` 在事务内调用 `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 清下一日作为 T-2 的 run（业务OP 某日数据双角色：当天 T-1 + 下一日 T-2，参见 PRD §3.4.1 步 4.2.a）
- 变更 review 要点：
  - **资金红线**（round 4 P1 新增）：时区错乱直接错日期 → 漏清下一日 (date+1) run（用 setDate 在 UTC+12 滞后到 date）或误清后天 (date+2) run（在 UTC-12 抢跑到 date+2）→ stale 差异表 = 资金事故
  - **必须 UTC 实现**：不能改用 `setDate(getDate() + 1)`（本地时区版）；与 `subOneDay` UTC 实现完全对偶
  - **单源**：addOneDay 仅在业务OP 重导清逻辑使用（仅 `runBizOpImportAsync` 调用），无 listReadyDates 一类的双源场景；改实现只动 `src/main-process/biz-op-recon-session.js` 一处
  - **维护检查**：改实现后 `grep -n "function addOneDay" src/` 确认仅 1 处命中（如出现 2 处 → 评估是否可合并 / 是否双源同步）
  - **与 `subOneDay` 对照**：subOneDay 双源（session.js + run-repository.js）；addOneDay 单源（仅 session.js）— 业务边界不同
  - round 4 P1 升格 Risk-sensitive（与 `subOneDay` round 2 R2-M4 升格 Risk-sensitive 对齐 — 时区操作类 helper 同级红线）
  - 必跑：smoke biz-op-recon Case Q（业务OP 重导清下一日 runs；验证 addOneDay 时区安全性 + 不抢跑 / 不滞后）+ 真实数据手测（UTC+12 / UTC-12 边界时区设备跑 Case Q 不出错）

### `clearRunsAndDiffsByDate`（v2.1.3 流水重导清 runs，**round 3 P1 资金红线 ⚠️ 新增**）
- 定义：`src/backend/biz-op-recon-db/run-repository.js`
- 实现：DELETE diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=?) → DELETE biz_op_recon_runs WHERE data_date=?（按 date **跨所有 BU** 清）
- 关联功能：流水对账单 (`biz_op_recon_flow_imports`) 重导时清该 date 所有 BU 的旧 runs + diff_rows；由 `runFlowImportAsync` 在事务内调用
- 变更 review 要点：
  - **资金红线**（round 3 P1 新增）：流水按 date 跨 BU 共用，重导后该 date 所有 BU 旧 run 失效；漏调本函数 → 用户拿旧差异表上报 = 资金事故
  - **与 `clearRunsAndDiffsByDateBu` 区分语义不能混**：本函数按 date 跨 BU 清；`clearRunsAndDiffsByDateBu` 按 (date, BU) 单 BU 清。流水重导专用本函数；业务OP 重导专用 `clearRunsAndDiffsByDateBu`。误用对方 → 资金红线（流水重导只清单 BU 残留其他 BU stale / 业务OP 重导清光所有 BU 数据丢失）
  - DELETE 顺序固定：diff_rows → runs（FK 依赖；若反序 → 外键约束错）
  - 必跑：smoke biz-op-recon Case P（构造同 date 跨 2 BU success run + 重导流水 + 断言两 BU runs/diff_rows 均被清，业务OP 主表不动）

### `clearRunsAndDiffsByDateBu`（v2.1.3 业务OP 重导清 runs，**round 3 升格 Risk-sensitive ⚠️**）
- 定义：`src/backend/biz-op-recon-db/run-repository.js`
- 实现：DELETE diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=? AND LOWER(TRIM(bu_name))=LOWER(TRIM(?))) → DELETE biz_op_recon_runs WHERE data_date=? AND LOWER(TRIM(bu_name))=LOWER(TRIM(?))（按 (date, BU) **单 BU** 清；C1 round 1 修订已对齐 LOWER+TRIM）
- 关联功能：业务OP (`biz_op_recon_imports`) 重导时清该 (date, BU) 二元组的旧 runs + diff_rows；由 `runBizOpImportAsync` 在事务内调用（OPEN ISSUE #15 拍板 A 联动清空）
- 变更 review 要点：
  - **资金红线**：与 `clearRunsAndDiffsByDate` 区分语义不能混（详见上一条）；业务OP 按 (date, BU) 分片，本函数只清单 BU；其他 BU 数据保留
  - **C1 round 1 修订**：BU 比较 SQL 必须 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`，与 `getRowsByDateBu` 完全对齐；脱口 → 大小写差异时清不掉旧数据 = 资金红线
  - DELETE 顺序固定：diff_rows → runs（FK 依赖）
  - 必跑：smoke biz-op-recon Case L（C1 大小写归一防回归）+ Case O（I2 BU trim 边界扩展）

### `pickConditionsLogicChecked`（v2.1.7 F1+R5 helper，升格 Risk-sensitive ⚠️ 资金红线三层护栏第 2 层）
- 定义：`src/renderer-dialogs.js:6298-6306` 函数
- 实现：
  - mode=create（draft.config.conditionsLogic 已注入 'AND'）→ `cfg.conditionsLogic === 'OR' ? 'OR' : 'AND'`（跟随 draft）
  - mode=edit/view（老 scenario 无字段）→ `cfg.conditionsLogic === 'AND' ? 'AND' : 'OR'`（fallback 'OR' 兼容历史）
- 关联功能：F1 C1 dialog conditionsLogic radio 默认选中决策；R5 资金红线**三层护栏第 2 层**（第 1 层 createDefaultScenarioConfig 默认 / 第 3 层 runC1Scenario fallback）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏）：与 `conditionsLogic` 字段配套维护；改 helper 决策方向（如把 edit fallback 改为 AND）→ 老用户编辑场景被默认改为 AND → 多条件场景命中行数突变 → 错改账单
  - helper 必须**只读决策**：不能修改 draft.config（用户切换 radio 后才落 config.conditionsLogic）
  - 改 mode 判定逻辑（mode === 'create' / 'edit' / 'view' 分支）→ 必须同步 dialog 三种入口的 wiring
  - 必跑：smoke c1 AND/OR 默认值（mode=create 新建场景默认 AND）+ 老 scenario 编辑（mode=edit，conditionsLogic 字段缺失，默认 OR）+ preview F1 mode=create 截图 AND radio 选中

### `runC1Scenario`（v2.1.7 F1 C1 提取 reconId 引擎，升格 Risk-sensitive ⚠️ 资金红线三层护栏第 3 层）
- 定义：`src/main-process/scenario-engines/c1-extract-recon-id.js:103` `function runC1Scenario(scenario, bankRows)`
- 关联功能：C1 场景执行 — 按 scenario.config.conditions（数组）+ scenario.config.conditionsLogic（'AND'/'OR'/undefined）遍历 bankRows；命中行按 regex 提取 reconId 写入 row[reconIdField]；**v2.1.7 F1 引擎 fallback**：`conditionsLogic === 'AND' ? AND逻辑 : OR逻辑`（**默认 OR 维持历史行为** — R5 三层护栏第 3 层）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke test 引用）
- 变更 review 要点：
  - **资金红线**（R5 三层护栏第 3 层）：fallback 默认改为 AND → 老 scenario 无 conditionsLogic 字段会被引擎"且"逻辑跳过原本应命中行 → 漏改账单
  - 改 conditions 数组语义（regex / value 字段判定）→ 影响所有 C1 场景命中行集合
  - 改 reconId 写入字段名（默认 `reconId`）→ 下游所有依赖该字段的功能失效（C3 网关核销 / reconIdFix / 导出）
  - 与 `pickConditionsLogicChecked` helper 默认值"对偶"：helper edit fallback `'OR'` ↔ 引擎 fallback `'OR'` 必须一致
  - 必跑：smoke c1 AND/OR 切换全套 + 真实银行账单 C1 端到端 + R5 三层护栏防回归

### `runC2Scenario`（v2.1.7 F4 C2 银行对账单字段赋值引擎，升格 Risk-sensitive ⚠️ 资金红线）
- 定义：`src/main-process/scenario-engines/c2-offset-bill-mark.js:57` `function runC2Scenario(scenario, bankRows)`
- 关联功能：C2 场景执行 — 按 scenario.config.billTypes（≥ 1，v2.1.7 F4 放宽，原为 ≥ 2）+ scenario.config.reconFields（可 0，v2.1.7 F4 放宽）筛选命中行，命中行字段赋值；**v2.1.7 F4 重命名**：原 "账单打标" → "银行对账单字段赋值"（功能扇出 ~10 处文案）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke）
- 变更 review 要点：
  - **资金红线**（F4 放宽）：billTypes ≥ 1 + reconFields 0 无条件赋值是 v2.1.7 拍板（spec §5.7 方案 A），改回 ≥ 2 + ≥ 1 → 用户场景全部失效
  - reconFields = 0 时无条件赋值（不需要条件匹配）— 改回带条件 → 用户单 billType + 0 reconFields 场景失效
  - 改 billTypes 校验逻辑 → 必须同步 dialog 校验（renderer-dialogs.js C2 dialog `>= 1` 门槛）+ delete 按钮门槛（F4 R1 + F4 删空）
  - 字段重命名扇出（10+ 处）→ 已 v2.1.7 commit a5d6eed 全量替换；新增引用必须用新名"银行对账单字段赋值"
  - 必跑：smoke c2 全套（billTypes=1 / reconFields=0 / 混合）+ 真实银行账单 C2 端到端

### `runC3Scenario`（v2.1.7 F2 C3 网关 1v1 引擎，升格 Risk-sensitive ⚠️ 资金红线方案 A）
- 定义：`src/main-process/scenario-engines/c3-gateway-recon-join.js:68` `function runC3Scenario(scenario, bankRows, gwRows)`
- 关联功能：C3 场景执行 — 网关 reconId 1v1 join；**v2.1.7 F2 方案 A**：用 Set 候选池（gwCandidatePool）严格 1v1 — 一个网关行匹配后从池移除，避免同一网关行被多个银行行重复匹配（资金红线核心修复）
- 跨文件度：2+（自身定义 + `src/main-process/scenario-dispatcher.js` runAllScenarios 调用 + smoke c3 5 case）
- 变更 review 要点：
  - **资金红线**（F2 方案 A 核心契约）：删除 Set 候选池 / 改回 1v多 → 同一网关行可能被多个银行行重复匹配 → 用户错改账单出现"幽灵核销"
  - 改 Set 数据结构（如改 Array indexOf）→ 性能 O(n²) 风险 + 删除语义不变
  - 改 match key（默认 reconId）→ 必须同步 dialog 配置 + bankRows / gwRows reader 字段
  - gwRows 入参允许 null/empty（C3 场景 gw 文件可选）→ 改逻辑必须保留空数组兜底
  - 必跑：smoke c3 5 case（包含 1v1 / 1v多反例 / 候选池耗尽 / 空 gw）+ 真实银行账单 + 网关账单端到端

### `writeBankStatementOutput`（v2.1.7 F8 升格 Risk-sensitive ⚠️ 资金红线 + F8 第 2 sheet 契约）
- 定义：`src/main-process/exceljs-writer.js:53` `async function writeBankStatementOutput(rows, headers, savePath, unmatchedRows = null)`
- 关联功能：银行账单导出唯一 writer — 仅修改行 + 单元格黄底 + 表头；**v2.1.7 F8 新增第 4 参数 `unmatchedRows`**：非 null 时输出第 2 sheet "未命中场景行"；命名 sheet 1 = "渠道对账单"（exceljs-writer.js:56 SHEET_NAME 常量真实值，self-review I-10 修正）、sheet 2 = "未命中场景行"
- 跨文件度：2+（自身定义 + `src/main-process/bank-statement-io.js:20/212-213` 桥接调用）
- 变更 review 要点：
  - **资金红线**（F8 契约）：sheet 1 仅写 rows（modifiedRows）— 严守 v2.1.7 之前 baseline 不变（smoke baseline 已锁定 modifiedRows.length 不漂移）
  - sheet 2 输入 unmatchedRows 必须经 `stripInternalFields` 剥 `_rowId` 等内部字段
  - 改第 4 参数默认值（null → []）→ 老调用方未传第 4 参数时**不应**触发第 2 sheet 输出（兼容性）
  - 改 sheet 命名（"已处理" / "未命中场景行"）→ 用户文件名认知不一致 + USER_GUIDE 同步
  - 改黄底单元格判定逻辑 → 全模块视觉变化
  - **ExcelJS vs SheetJS**：v2.1.7 dev 路径已用 ExcelJS（commit d289779）；spec §9.8.4 PM sketch 当初按 SheetJS 起草已反向同步双版本说明；改 writer 库需评估 cellStyle / sheet 命名 / 性能
  - 必跑：smoke `npm run smoke` 全 19 suite（含 F8 第 2 sheet 行数断言）+ 真实银行账单端到端（带未命中场景）+ baseline modifiedRows 防回归

### `cleanup_pending`（v2.1.8 N1 新增 Risk-sensitive — DB 新列，cleanup 延后触发标志）
- 定义：`acquiring_bill_currency_runs.cleanup_pending INTEGER DEFAULT 0`（v2.1.8 N1 新增列，migration 在 `src/backend/database/migrations.js`）
- 关联功能：N1 β 方案 — runCheck 成功后 SET=1 标识"待清理"；app.before-quit 钩子检测并触发清理；cleanup 完成后 SET=0
- 变更 review 要点：
  - **migration 必须幂等**：`ALTER TABLE ... ADD COLUMN ... DEFAULT 0`，旧记录默认 0（已完成清理）
  - 改默认值 → 旧记录可能被误判为"待清理"触发不必要的清理
  - 改列类型 / 列名 → 所有 runs 表查询 / repository 方法同步
  - 涉及 API：`run-repository.js` 新增 `markCleanupPending` / `clearCleanupPending` / `listPendingCleanupRuns`
  - 必跑：smoke N1（migration 幂等 + 标志位 SET/CLEAR + 启动孤儿清理仍工作）

### `config_json.assign`（v2.1.8 N2 新增 Risk-sensitive ⚠️ 对账契约扩展 — v0.5 修订）
- 定义：scenarios.config_json 字段下 `assign` 对象（v2.1.7 仅 `{gwField, bankField}`，v2.1.8 扩展为 `{gwField, bankField, mode, customValue}`）
- 关联功能：C3「对账成立后赋值」配置；v2.1.8 N2 新增"自取值"模式 — **「自取值」加在 assign-gw（数据源），v0.5 修订 from assign-bank（写入目标）**；`mode: 'direct' | 'custom'`；`customValue` 在 mode='custom' 时使用
- 变更 review 要点：
  - **对账契约扩展**：scenarios 数据结构升级，老 scenario 必须 graceful 升级（用户场景库已沉淀不能丢）
  - migration 必须幂等：扫描所有 category='gateway-recon-join' 的 scenarios，对缺 `assign.mode` 的补 `mode='direct'`
  - bundle 兼容（spec.md §四 N2-D4/D5）：v3 bundle 向前兼容 — 旧 bundle 自动补 mode='direct'；v2.1.8 bundle export 时 mode='direct' 省略字段（体积更小）
  - **`__CUSTOM__` sentinel（v0.5）**：mode='custom' 时 gwField='__CUSTOM__'（数据源 sentinel）+ customValue=用户输入；bankField 不变（仍是真实银行字段写入目标）；旧 reader 看到 gwField='__CUSTOM__' → chosen.row['__CUSTOM__']=undefined → normalizeCellValue → '' → 不抛错但行为退化为"写空值"
  - 引擎读取（`c3-gateway-recon-join.js:158-172`）必须按 mode 分支：`mode==='custom'` → `String(assign.customValue || '')` / 否则 → `normalizeCellValue(chosen.row[assign.gwField])`
  - 必跑：smoke N2（migration + 引擎分支 + bundle 来回 import/export 兼容）

### ~~`GATEWAY_RECON_FIELDS`~~（v0.5 升 Important-skeleton 计划 → **v0.6 撤回**）

**v0.6 撤回原因**：v2.1.8 N2 实施前发现 GATEWAY_RECON_FIELDS 被 `bank-statement-io.js:114` 用作网关账单 reader 表头校验 + `renderer-dialogs.js:5908/6131/6212` 多处条件下拉。在数组里加 `'__CUSTOM__'` 会破坏 reader 表头校验。改为仅在 `renderer-dialogs.js:6105-6108` assign-gw select 渲染层单独拼接 `<option value="__CUSTOM__">自取值</option>`，constants 保持不变。

GATEWAY_RECON_FIELDS 维持原有非升格状态（已经在 scan-vars 中是 A-share 跨度）。

### `hitScenarios`（v2.1.8 N3-1 新增 Risk-sensitive ⚠️ IPC 字段重命名 + 结构变更）
- 定义：scenario-dispatcher.js stats.hitScenarios 数组元素 `{id, displayIndex, name}` —— **取代 v2.1.7 的 hitScenarioIds (number[])**
- 关联功能：
  - 推送：`src/main-process/scenario-dispatcher.js:99` `hitScenarios.push({id, displayIndex, name})`
  - IPC：`src/main.js:3045` 返回 `stats.hitScenarios`
  - 状态框：`src/renderer.js:3319` 显示 `displayIndex` 替代 DB id
- 变更 review 要点：
  - **IPC 字段重命名**：`hitScenarioIds` → `hitScenarios`，必须 grep 全部调用方同步
  - 结构变更（number[] → object[]）：消费方读取方式从 `ids.join('、')` 改 `arr.map(s => s.displayIndex).join('、')`
  - 不变量护栏（v2.1.7 F8 已有）：`modifiedRows + unmatchedRows = inputRows` 不变
  - 必跑：smoke N3-1（状态框序号 = 场景管理 UI 序号 + grep `hitScenarioIds` 零命中）+ smoke F8（modifiedRows + unmatchedRows 守恒）

### `displayIndex`（v2.1.8 N3-1 新增 Risk-sensitive ⚠️ 跨多层一致性）
- 定义：scenarios 实体新增计算字段 `displayIndex`（1-based 按 sort_order + id 顺序），在 `src/backend/database/scenarios-repository.js.listScenarios` 返回时统一附加
- 关联功能：N3-1 修复"状态框命中场景号与场景管理 UI 序号不一致"
- 变更 review 要点：
  - **派发口径**（spec.md §五 N3-D1）：在 repository 层统一附 displayIndex，UI / 引擎共享同一份计算 — 避免双源真理
  - 改派发口径（移到 UI 自算 / dispatcher 入参时算）→ 编号体系再次分裂，N3-1 修复失效
  - 必跑：smoke N3-1（main 端 displayIndex 与 UI 列表 displayIndex 字段值逐项相等）+ 手测对比场景管理 dialog 与状态框

---

## 5. Minor — 提示性（次要）

不在前四层、但跨 ≥3 文件、且命中频率高的符号。改动时**知会**即可，不强制全量 review。

- `sanitizeBankName` — 银行名规范化，3 文件跨度
- `compileRegexLiteral` / `isRegexLiteral` — 正则字面量识别，映射 UI 用
- `groupBigAccountRows` — 大账号行聚合工具
- `inferDateCellFormat` / `toExcelSerial` — 日期格式推断
- `getStatementSessionEntries` / `getStatementSessionKey` — session 查询
- `getSetting` / `setSetting` — settings 读写
- `loadEnumValues` / `loadCurrencyMappings` — 资源加载入口
- ~~`recon-id-fix-io.js raw 模式`~~（v2.1.8 F5 立项时计划，**T08 Reverse Sync v0.2 已撤回** — sheetToObjects 共用函数 raw:false 影响 8 sheet × N 字段；改为方案 C：在 `c4-recon-id-fix.js:1058-1065` gateway 映射段做 number → ISO 字符串转换，影响面收敛到 c4 引擎一处。详 spec.md F5-D4 v0.3）

这一层从自动扫描报告里可以随时捞出 top—N，不需要在本表硬编码。

---

## 如何维护本表

本表覆盖范围有意做窄（约 60 条），追求**高信噪比**而非全覆盖。表是活的，需要随代码演进升格/降级。

### 维护分工：agent 起草 + 用户审批

**默认由 agent 起草条目草稿，用户只做审批**。用户不需要自己写变量名、关联功能、review 要点——这些由 agent 从 `scan-vars` 数据 + 代码上下文推断填入。

| 环节 | 谁做 |
|---|---|
| 发现升格/降级候选 | 脚本 (`scan:vars`) + agent (`/check-vars`) 自动扫 |
| 起草条目（层级 / 定义位置 / 关联功能 / review 要点） | agent，按下文"双门槛"判断 |
| 起草降级/删除 diff | agent |
| 最终审批 / 层级拍板 | 用户（看 diff 后 yes / no / 改层级） |
| 元数据"上次人工 review"更新 | agent，在用户 yes 后自动更新 |

**典型交互**：agent 在 PR 前 / 版本 bump 时主动汇报候选 + diff → 用户看一眼说 yes 或微调层级 → agent 落盘。用户 90% 只需说 yes，除非有层级边界争议或业务语义判断。

如果 agent 该主动起草却没起草，提醒用户：**请 agent 重读本节的"维护分工"**。

### 会不会新增？

**会**。新增来源有四类：
1. 新功能引入的新常量 / 类 / 门面（最常见）
2. 现有符号跨度扩大（本来单文件私有 → 重构后跨多文件共享）
3. 首批漏收的既有符号（数据驱动发现）
4. 降级/移出后释放出的位置

### 升格标准（双门槛，两条都过才入表）

#### 门槛一：数据门槛（硬性，由 `scripts/scan-vars.js` 自动判断）

候选必须满足以下至少一条（阈值参考 `docs/analysis/var-reference-stats.md`）：

| 条件 | 阈值 |
|---|---|
| **A-share** | `fileSpan ≥ 3` |
| **A-pair 高频** | `fileSpan = 2` 且 `totalHits ≥ 15` |
| **单文件高位** | `fileSpan = 1` 且 `totalHits ≥ 60`（仅 Runtime-state 例外） |

数据门槛未过 → 留在自动报告，**不入本表**。

#### 门槛二：语义门槛（软性，人工判断决定层级）

过数据门槛后，按语义命中决定入哪层。必须**至少命中一条**才升格：

| 层级 | 语义判据 | 参考例子 |
|---|---|---|
| **Critical** | 承载跨进程/跨版本**协议**：字符串前缀、枚举值、保留 ID、bundle 版本号、错误类 schema | `FIXED_FIELD_VALUE_PREFIX`、4-way 映射标识、`FileValidationError` |
| **Important-skeleton** | 跨层**门面 / 入口**：Repository、IPC、读/写管线 | `templateRepository`、`normalizeCell`、`ipcRenderer` |
| **Runtime-state** | 运行时**唯一实例**：单例全局 / DOM 缓存 / 会话缓存 | `state`、`elements`、`lastGeneratedExports` |
| **Risk-sensitive** | 踩 CLAUDE.md 第 7 条**红线**：资金 / 行过滤 / 迁移 / 状态机 | `roundAmount`、`isRowMeaningful`、`hasColumn` |
| **Minor** | 过数据门槛但不命中以上四条的**公共工具** | `sanitizeBankName`、`pad` |

数据门槛过 + 语义门槛未过 → 只留在自动报告，不入本表（噪音过滤）。
语义门槛过 + 数据门槛未过 → 继续观察，跨度攒够再入。

### 明确排除（不升格）

- **技术性 require**：`fs`、`path`、`XLSX` 等（运行时底座，不是业务锚点）
- **测试/脚本专用符号**：`scripts/` 不在 `scan:vars` 扫描范围内
- **私有辅助函数**：大文件内部跨度高但无跨文件协作

### 降级 / 移出标准

为避免表膨胀失焦：

1. **跨度跌破**：连续两个版本 scan-vars 显示 `fileSpan < 2` 且非 Runtime-state 单例 → 降入 Minor 或移出
2. **改名/内联**：原名不存在 → 直接删除，不保留墓碑
3. **语义消失**：业务规则变更导致该符号不再承载契约 → 按新形态重评
4. **被更高抽象替代**：出现新的更高层门面取代它 → 移入 Minor 或删除

### 触发时机与责任人

| 节点 | 动作 | 责任方 |
|---|---|---|
| 提 PR 前 | `/check-vars` 输出「升格候选」段（自动报告里新出现的 A-share ∉ 本表） | team-lead agent 提示 |
| 版本号 bump | 完整过一遍本表 + scan-vars，评估升格/降级 | 用户 + Claude 协作 |
| 合并到受保护分支前 | 增量评估（不要求全量） | team-lead agent |
| 日常 Edit/Write | 不做升格判断（只做命中 review） | agent |

### 元数据维护

每次升格/降级后，更新本文件顶部元数据表的两项：

- `上次人工 review` → 当天日期
- `清单版本` → 若结构性变化（增删层级 / 大量条目变更），版本号小升

### 结语

本表是"给下一个改代码的人 / agent 看的 SOP 手册"，不是"全量索引"。宁可漏收 2 条边缘符号，也不要把表膨胀到没人愿意看的地步。
