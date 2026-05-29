# PRD — v2.1.11 迭代：单测运行日志 + pending 移除核对 + C2「银行对账单字段赋值」增强

| 字段 | 值 |
|---|---|
| 文档版本 | v0.2（2026-05-29 — §三.2 全部 decision points 用户确认按 PM 倾向采纳；spec/tasks 已产出） |
| 关联 backlog | `docs/iterations/v2.1.11/backlog.md`（性能主线 A3-multi-worker / F5-cont 另见 backlog） |
| 关联 spec | `spec.md`（待产出） |
| 关联 tasks | `tasks.md`（待产出） |
| 起草人 | PM（team-lead） |
| 目标版本号 | `2.1.11`（`2.1.11-beta.1` 起） |
| 工作分支 | `v2.1.11`（已从 main 检出） |
| 状态 | v0.2 — 全部 decision points 用户已确认（按 PM 倾向）；spec.md / tasks.md 已产出，待委托 dev 实现 |

---

## 一、版本目标 & 范围

### 1.1 本版打包（用户已拍板）

本 PRD 覆盖用户 2026-05-29 提出的 **3 个需求**：

| 编号 | 主题 | 性质 | 风险 | 涉及层 |
|---|---|---|---|---|
| **T1-test-log** | 单元测试框架增加运行日志（终端汇总 + 落盘存档） | 测试基建 | 🟢 LOW | scripts/ |
| **T2-pending-removal** | pending 月度核对新增「导入移除pending文件并核对」流程 | 数据核对 · 导出契约 | 🔴 HIGH（对账逻辑 + 输出契约 + 新表迁移） | DB / engine / session / writer / renderer / IPC |
| **T3-c2-config** | C2「银行对账单字段赋值」配置页 3 项增强（多条件 / FundType 下拉 / 对账字段可空） | 业务规则 · UI · 引擎 | 🟡 MID（引擎判定 + 老数据迁移） | renderer-dialogs / scenario-engine / constants / 迁移 |

> **与性能主线的关系**：v2.1.11 backlog 原立项性能/算法主线（A3-multi-worker 多 worker 并行 + F5-cont C4 算法重写，~4-5 周）。用户已拍板这 3 个需求**纳入 v2.1.11**，与性能主线**并存**。鉴于两类工作互相独立、体量差异大，**本 PRD 仅覆盖上述 3 个需求并先行推进**；性能主线作为 v2.1.11 的后续 Phase，沿用 backlog 已有的 D29-D36 决策，另起 spec，不在本 PRD 范围。

### 1.2 用户故事

- **T1**：作为开发者，我希望 `npm run test:unit` 像集成测试那样输出 `N/N PASS` 汇总和每文件耗时，并把完整结果落盘成带时间戳的日志文件，便于回溯历史运行与排查失败。
- **T2**：作为对账人员，月度 pending 核对时，我希望在导入某月 pending 数据后能选择性导入一份「移除归档 pending 文件」，系统用现有对账规则把它与对账产生的 `missing`（消失）行匹配，并在导出文件里清晰标出"哪些 missing 已被移除归档解释、哪些移除记录在 missing 里找不到"。
- **T3**：作为配置人员，在「银行对账单字段赋值」场景里，我希望①一种账单类型能用多个筛选条件（同时满足）来定义；②当筛选字段是 FundType 时，值改成下拉选择避免手输错；③对账字段允许留空（不强制配置）。

### 1.3 必做

| # | 必做项 | 归属 |
|---|---|---|
| F1 | `npm run test:unit` 终端输出 `N/N PASS` + 每文件用例数/耗时汇总（仿 `integration-runner.js`） | T1 |
| F2 | 每次单测运行落盘一份带时间戳的日志文件（保留历史） | T1 |
| F3 | pending 导入某月数据成功后，弹"是否核对移除pending数据"提醒；选是→导入移除文件并入库（关联月份），选否→跳过 | T2 |
| F4 | 移除文件按模板 `assets/移除归档Pending账单.xlsx` 解析入库（新增 DB 表 + migration） | T2 |
| F5 | 对账(上月 vs 本月)产生 `missing` 后，用对账规则 `matchFields` 把 `missing` 行与该月移除数据匹配 | T2 |
| F6 | 导出新增 sheet（最右侧）：放 `missing` 行 + 一列「移除核对状态」三态（`核对无误` / `核对有差异：字段(值≠值)` / `missing有_移除无`；配对后用 compareFields 内容核对）| T2 |
| F7 | 若有"移除pending有、missing无"的记录 → 再新增一张 sheet 放这些记录 | T2 |
| F8 | C2 账单类型支持每类型多筛选条件（AND 聚合）；删除按钮右侧加"新增"按钮→在当前行下方插入**空白**条件行 | T3.1 |
| F9 | C2 已保存场景（单条件）自动向后兼容迁移为多条件结构 | T3.1 |
| F10 | C2 条件行字段=`FundType` 时，值输入框替换为单选下拉，枚举值+排序运行时读 `assets/FundType枚举值.xlsx`（用户稍后提供） | T3.2 |
| F11 | C2 对账字段行放开非空校验（允许为空） | T3.3 |
| F12 | T2/T3 改了用户可见输出契约 → 按 `rules/integration-test-policy.md §四` 补集成测试 | 全部 |

### 1.4 明确不做（本版）

- ❌ 性能主线 A3-multi-worker / F5-cont（另起 spec，见 backlog）
- ❌ T2 移除核对暂不支持「聚合导出(exportAggregate)跨多 run」场景，仅单 run 导出（除非 §三.2 D-T2-5 用户改判）
- ❌ T3.2 FundType 下拉不做"枚举值在线编辑 UI"（仅从 xlsx 读取）
- ❌ 不改 pending 现有 `new`/`changed` 差异逻辑，仅在 `missing` 基础上叠加移除核对

---

## 二、主题详述

### 2.1 T1 — 单元测试运行日志

**现状（出处）**：`scripts/run-unit-tests.js` 仅 `spawnSync(node --test, {stdio:'inherit'})`（:43），结果直接打到终端、**不落盘、无 N/N 汇总**。对比 `scripts/integration-runner.js` 已有 `N/N PASS` 汇总并回写 `rules/integration-test-policy.md §七`。

> ⚠️ **顺带修正**：根目录 `CLAUDE.md` 写"No unit test framework — npm run smoke is the only automated test"已**过时**——实际已有 `test:unit` / `test:integration` / `release-check` 三层（`package.json` scripts 实证）。本版 reverse sync 修正这句。

**改造要点**：
1. 解析 `node --test` 输出，提取 pass/fail 计数 + 每文件耗时，终端打印 `==== N/N PASS ====` 汇总（与 integration runner 风格一致）。
2. 落盘日志文件（路径/格式见 §三.2 D-T1-1/2）。
3. `release-check` 串联不变（透传退出码语义保持）。

**涉及文件**：`scripts/run-unit-tests.js`（主改）、`CLAUDE.md`（修正过时表述）、可能新增 `tests/` 日志目录或 `.gitignore` 条目。

### 2.2 T2 — pending 月度核对新增「导入移除pending并核对」

**现状链路（调研出处）**：
- pending 两个**独立操作**：①「导入」月度数据入库 `pending-session.js runImport`（:139-248）；②「对账」选上月 vs 本月 `engine.js`（:56-184）产出 `new/missing/changed`。
- `missing` = 上月(upperMonth)未配对行（`engine.js:156-162`：`INSERT INTO diff_rows ... 'missing' ... WHERE A.year_month=upperMonth AND t.upper_id IS NULL`）。
- 对账规则全局单例 `rule-repository.js`：`{matchFields, compareFields}`；`matchFields`=配对 key（多轮 fallback，单字段相等即配对），`compareFields`=差异比较字段。
- DB `pending_rows` = 31 列（`pending-db/columns.js` PENDING_COLUMNS，源自 `Pending.xlsx` 结构）。
- `diff_rows` schema：`{id, run_id, type, upper_row_id, lower_row_id}`；读出 `diff-repository.js listDiffRows(db, runId, type?)`。
- 导出 `pending-export/writer.js`：`exportSingleRun` / `exportAggregate`，`appendSheetWithHeaderFont`→`XLSX.utils.book_append_sheet`（:218-224）顺序追加，**新 sheet 天然在最右** ✓。
- 移除模板 `移除归档Pending账单.xlsx` = **46 列**；与 31 列 `pending_rows` 前 28 列基本一致，`matchFields` 常用的 `order_no/recon_id/金额/channel/merchant_id/bank_ref` **两边都有** → "共用对账规则"可行 ✓。

**流程设计（用户拍板：挂「导入」流程 + 入库）**：
```
①导入某月 pending 数据成功
   ↓
②【新】弹"是否核对移除pending数据？"
   ├─ 否 → 跳过（现状流程不变）
   └─ 是 → 导入移除文件 → 解析 → 写入【新表 removed_pending_rows】，关联月份
   ↓
③用户跑「对账」(上月 vs 本月) → engine 产出 missing
   ↓
④【新】用 matchFields 把 missing 行(上月) 与 该月移除数据匹配
   → 标记每条 missing：核对无误 / 核对有差异:字段(值≠值)（compareFields 内容核对）/ missing有_移除无（未配上）
   → 标记移除数据中"未匹配任何 missing"的（移除有_missing无）
   ↓
⑤导出 → 【新】最右 sheet「missing × 移除核对」+【新·条件】sheet「移除有_missing无」
```

**新增数据结构（spec 细化）**：DB 新表 `removed_pending_rows`（schema 见 §三.2 D-T2-3）+ `pending-db/migrations.js` 幂等迁移。

**涉及文件**：`pending-db/migrations.js`（新表）、新增 `pending-db/removed-repository.js`（CRUD）、新增 `backend/pending-import/`（移除文件 reader/解析）或复用现有 import worker、`pending-session.js`（导入后流程）、`pending-reconcile/engine.js` 或新模块（missing↔移除匹配）、`pending-export/writer.js`（2 张新 sheet）、`renderer-pending.js`（提醒弹窗 + 导入移除文件入口）、`preload.js` + `main.js`（新 IPC channel）。

> 🔴 **资金/对账红线**：missing↔移除匹配错误 → 核对结论错误；导出新 sheet 改变用户可见契约。**强制** unit（匹配函数）+ integration（端到端契约）+ manual GUI case。

### 2.3 T3 — C2「银行对账单字段赋值」配置页增强

**现状（出处）**：C2 = scenario category `offset-bill-mark`（v2.1.7 F4 由"打标"改名），UI `renderer-dialogs.js:7698-7839`，引擎 `scenario-engines/c2-offset-bill-mark.js`，字段枚举 `constants/bank-statement-fields.js`（44 列含 `FundType`，且 `preload.js` 内联副本需同步）。

#### T3.1 账单类型多筛选条件（AND 聚合）

- **现状**：账单类型每行 = `{seq, field, op, value}`，一行=一种类型=**单条件**；引擎 `classifyRowsByBillTypes`(:30-42) 每行调一次 `evaluateCondition`。顶部"+新增账单类型"追加新 seq(:7806)。
- **目标**：一种账单类型可由**多个条件 AND 组合**定义。每行 `[×]` 右侧加 `[新增]` 按钮 → 在**当前行下方插入空白条件行**（同属一个账单类型 seq）。顶部"+新增账单类型"语义不变（新 seq）。
- **数据结构变更**：`config.billTypes` 从 `[{seq,field,op,value}]` → `[{seq, conditions:[{field,op,value},…]}]`。
- **引擎变更**：`classifyRowsByBillTypes`/判定改为"某行满足该类型**全部** conditions(AND) 才归入该 seq"。
- **老数据迁移**：已存场景 `{field,op,value}` → `{conditions:[{field,op,value}]}`（向后兼容，必做）。
- **行4/行5 引用 seq**：类型数量语义不变 → 引用逻辑基本不受影响 ✓。

#### T3.2 FundType 值下拉

- **目标**：账单类型条件行里，`field === 'FundType'` 时，`value` 文本输入框(:7709)替换为**单选下拉**；下拉枚举值+排序运行时读 `assets/FundType枚举值.xlsx`。
- **Blocker**：`assets/FundType枚举值.xlsx` **当前不存在**，用户稍后提供（assets/ 现仅有 `移除归档Pending账单.xlsx`）。
- 作用范围（账单类型条件行 / 是否含"赋值"行 value）见 §三.2 D-T3-2。

#### T3.3 对账字段行可空

- **现状**：`renderer-dialogs.js:6816-6818` C2 校验保留"非空行两端字段必填"；引擎 `c2-offset-bill-mark.js` 已支持 `reconFields=0`（"衍生方案A无条件赋值"，:11-16）—— **引擎已放开，UI 校验未放开**。
- **目标**：放开 C2 对账字段行校验，允许整行为空 / 允许 0 行（与引擎对齐）。

**涉及文件**：`renderer-dialogs.js`（C2 渲染 + 校验 + 事件）、`scenario-engines/c2-offset-bill-mark.js`（多条件判定）、`backend/database/scenarios-repository.js`（迁移读取）、新增 `constants/fund-type-enum`（读 xlsx）或运行时加载、`preload.js`（若枚举需暴露给 renderer）、`scripts/render-modal-preview.js` 相关 preview（`scenario-config-c2` 回归）。

> ⚠️ **important-variables**：T3 改 `scenario-engines` + scenario config 结构，实现阶段**必须跑 `/check-vars`**；前端改动必须重跑 `npm run preview:scenario-config-c2`（及相关 C2 preview）。

---

## 三、决策点

### 3.1 已拍板（4 轮，2026-05-29）

| ID | 主题 | 结论 |
|---|---|---|
| D-SCOPE | 版本范围 | 3 需求纳入 v2.1.11，与性能主线并存；本 PRD 先推这 3 个 |
| D-T1 | 单测日志形态 | 终端 `N/N PASS`+每文件耗时 **且** 落盘带时间戳日志文件 |
| D-T2-time | 移除核对时机 | 挂「导入」流程 + 移除文件**入库**（关联月份）；对账后用 matchFields 匹配 missing |
| D-T3-1a | 多条件逻辑 | 同一账单类型多条件 = **AND 全部满足** |
| D-T3-1b | 行内新增内容 | "新增"→在当前行下方插入**空白**条件行 |
| D-T3-2-src | FundType 枚举来源 | 运行时读 `assets/FundType枚举值.xlsx`（用户稍后提供） |

### 3.2 spec 阶段决策（PM 倾向 — ✅ 用户 2026-05-29 确认全部按 PM 倾向采纳）

| ID | 主题 | 选项 | PM 倾向 |
|---|---|---|---|
| **D-T1-1** | 单测日志落盘路径 | (a) 项目内 `logs/unit-tests/`（gitignore）/ (b) `docs/iterations/<ver>/test-logs/` / (c) 用户 Documents 运行目录 | (a)——本地构建产物，gitignore |
| **D-T1-2** | 日志格式 | (a) 纯文本（含汇总+原始输出）/ (b) JSON Lines | (a)——简单可读 |
| **D-T1-3** | 是否一并统一 integration runner 日志 | (a) 仅 unit / (b) unit+integration 统一落盘 | (a)——本版只动 unit，integration 另议 |
| **D-T2-1** | 移除文件关联哪个月 | (a) 关联导入的当月 / (b) 关联对账的"上月"(missing 来源) | (b)——missing 来自上月，移除文件应描述上月被移除项 |
| **D-T2-2** | missing↔移除匹配触发 | (a) 对账完成后自动跑 / (b) 导出时跑 / (c) 手动按钮 | (a)——对账后自动，结果随 run 持久化 |
| **D-T2-3** | `removed_pending_rows` schema | (a) 全 46 列存 / (b) 仅 matchFields 公共列 + 元信息 | (a)——全列存便于导出展示，匹配时取公共字段 |
| **D-T2-4** | 移除文件 sheet 解析 | 模板 sheet 名是数字 ID（如 `1405800876820465666`）→ (a) 取第一个 sheet / (b) 按名匹配 | (a)——取第一个 sheet，表头行定位 |
| **D-T2-5** | 聚合导出是否支持移除核对 | (a) 仅 single run / (b) aggregate 也支持 | (a)——先 single run，aggregate 留后续 |
| **D-T2-6** | 移除核对状态列（手测增强为三态）| 列名「移除核对状态」；值 `核对无误` / `核对有差异：字段(missing值≠移除值)` / `missing有_移除无`（配对后用 compareFields 内容核对、数值复用 C1 归一化）| ✅ 已实现 |
| **D-T2-7** | 两张新 sheet 命名 | sheetA「missing核对移除」/ sheetB「移除有missing无」 | 待确认中文名 |
| **D-T3-1c** | 多条件 UI 呈现 | (a) 同 seq 缩进分组、子序号 `#1.1 #1.2` / (b) 同 seq 用分隔/底色分组 | (a)——子序号最清晰 |
| **D-T3-2-scope** | FundType 下拉作用范围 | (a) 仅账单类型条件行 value / (b) 同时含"赋值"行(markValue) value | (b)——一致性，赋值写入 FundType 也应合法枚举 |
| **D-T3-2-strict** | 下拉是否限制只能选枚举内值 | (a) 严格(仅枚举) / (b) 允许自定义输入 + 枚举建议 | (a)——避免手输错（用户初衷） |
| **D-T3-mig** | C2 老数据迁移时机 | (a) 读取时惰性迁移 / (b) DB migration 批量改 config JSON | (a)——惰性迁移，零停机、低风险 |

---

## 四、风险红线（CLAUDE.md 规则 7）

| 主题 | 风险 | 级别 | 缓解 |
|---|---|---|---|
| T2 | missing↔移除匹配逻辑错 → 核对结论错（对账红线邻近） | 🔴 HIGH | 复用经过验证的 matchFields 逻辑；unit 覆盖匹配函数多档；integration 端到端契约；manual GUI |
| T2 | 新表 + migration（数据迁移） | 🔴 HIGH | 幂等迁移；migration 前后 smoke；不动现有 `pending_rows`/`diff_rows` |
| T2 | 导出新增 sheet 改变用户可见契约 | 🟡 MID | integration 校验列结构 + sheet 顺序；manual 核对导出文件 |
| T3.1 | 账单类型多条件判定错 → C2 赋错值/漏赋值（对账输出契约） | 🔴 HIGH | 引擎 unit 覆盖 AND 多条件分类；老数据迁移 contract test；preview 回归 |
| T3.1 | scenario config JSON 结构变更 → 老数据不兼容 | 🟡 MID | 惰性迁移 + 迁移 unit；保留旧结构读取兜底 |
| T3 | 命中 `rules/important-variables.md` | 🟡 | 实现阶段强制 `/check-vars` |

---

## 五、验收矩阵

| # | 验收项 | 验证方式 |
|---|---|---|
| AC1 | `npm run test:unit` 输出 `N/N PASS`+耗时，且生成带时间戳日志文件 | 跑命令看输出 + 查日志文件 |
| AC2 | `release-check` 仍全 PASS（退出码语义不变） | `npm run release-check` |
| AC3 | 导入 pending 后弹移除核对提醒；选否流程不变 | GUI 手测 |
| AC4 | 导入移除文件入库；对账后 missing 标三态（核对无误 / 核对有差异 / missing有_移除无）；覆盖导入同月时旧移除归档被清、不复用 | GUI + integration |
| AC5 | 导出最右 sheet 含 missing+匹配标记；有"移除有missing无"时出第二 sheet | 打开导出文件核对 |
| AC6 | C2 账单类型可加多条件(AND)；行内"新增"插空白条件行；老场景正常打开 | GUI + 迁移 unit |
| AC7 | C2 字段=FundType 时 value 为下拉（枚举来自 xlsx，排序一致） | GUI（需 FundType xlsx 就位） |
| AC8 | C2 对账字段可留空/0 行，保存不报错，引擎走无条件赋值 | GUI + smoke |
| AC9 | 新增 integration 脚本（T2 端到端 / T3 多条件引擎）入 release-check | `npm run test:integration` |
| AC10 | `npm run preview:scenario-config-c2` 等 C2 preview 回归通过 | 看截图 |

---

## 六、文档三件套登记（发版前一次性更新）

按 README/CLAUDE.md 约定，发 `2.1.11` stable 前统一更新：
- [ ] `CHANGELOG.md`
- [ ] `docs/VERSION_FEATURE_HISTORY.md`
- [ ] `docs/USER_GUIDE.md`（pending 移除核对操作说明 + C2 多条件/FundType 下拉说明）
- [ ] 顺带：`CLAUDE.md` 修正"No unit test framework"过时表述（T1）

---

## 七、变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-05-29 | 起草；4 轮决策拍板（D-SCOPE/D-T1/D-T2-time/D-T3-1a/D-T3-1b/D-T3-2-src）；调研 pending 链路 + C2 配置 + 模板列结构并落出处 |

---

## 八、实施记录（dev 阶段填）

> Phase / PR / commit / 测试结果在此追加。
