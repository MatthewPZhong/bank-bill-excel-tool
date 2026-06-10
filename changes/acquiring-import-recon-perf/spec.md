# Spec — 收单单据模块导入/对账性能优化（P0 跨平台 + W Windows 专项）

> 状态：**已完成（全部落地，release-check 全绿）** ｜ 目标版本：**v3.0.3**（O-4 已决：纳入 v3.0.3 迭代，详见 changes/v3.0.3/spec.md）
> 收尾（2026-06-10）：P0 批次（P0-1 停写 flow raw_json / P0-2 预计算 / P0-3 索引瘦身 + covering / P0-4 单遍 JOIN stats）+ W 批次（W1 temp_store=MEMORY / W2 COMMIT 后 checkpoint / W3 多 worker 阈值 30w / W5 OneDrive 提示）+ P1 解析列裁剪（PR-P1，1.20x 收口、债务转块 D）全部落地；**引擎抽取 + 收单首迁见 `changes/big-table-import-engine/spec.md`（PR-G1/G2/H 已实施）**；**W4 导入挪 worker 经块 D 引擎达成（导入全程主进程零阻塞）**。实测：flow 导入段 6.36x、对账统计段 5.2x、解析段引擎 2.32x、4-worker 3.06x、收单端到端 1.53x。
> 决议进度：O-1 永久停写 ✅ ｜ O-2 本批直接合入 ✅ ｜ O-3 检测提示+文档 ✅ ｜ O-4 纳入 v3.0.3 ✅ ｜ O-5 五次修订·已收口（PR-P1 1.20x + 债务转 PR-G 字节层，引擎 2.32x 偿清）✅ ｜ O-6 多文件单 sheet ✅ ｜ O-7 二次修订·本迭代抽取仅导入侧（PR-G1/G2/H 已实施）✅
> 性质：🔴 **资金红线**（收单导入是金额/币种入库真理源；对账 SQL 是 spec §5 核心）
> 缘起：用户反馈「收单单据模块的导入文件和对账速度太慢」+「针对 Windows 端（SSD）专项优化」。
> 实测依据：`tmp/bench-acquiring-opt.js`（50 万行标尺，macOS 基准，2026-06-10 实测；Windows SSD 预期打 7-8 折）。
> 环境画像：Windows + SSD；典型数据量 ~30 万行/月（reader.js:4 记录的真实清结算数据规模）。

---

## 一、现状与瓶颈定位（已查实 + 实测）

### 已做优化（避免重复劳动）

| 版本 | 优化 | 效果 |
|------|------|------|
| v2.1.12-beta | 解析器 sax → 手写字节扫描（reader-handrolled.js） | 端到端 5.6x（122s→22s/50万行） |
| v2.1.10 A3/A4 | 对账挪 worker + chunked + cancel/resume | UI 不卡、可中断 |
| v2.1.12 β.1 | 对账多 worker（plan-b），**<100w 行回退单 worker**（D31） | 2.31-2.70x@50w（POC），但闸值挡住典型量级 |
| v2.1.15 W0 | writer 游标化 | 写盘段已优化 |
| 早期 | WAL + synchronous=NORMAL + 64MB cache + 256MB mmap | PRAGMA 基础到位 |

当前 50 万行导入 ≈ 22s（解析 ~13s + INSERT ~8.6s）；30 万行按比例 ≈ 13s。

### 实测瓶颈（macOS 基准，50 万行）

| # | 瓶颈 | 证据 | 实测收益 |
|---|------|------|---------|
| B1 | **flow_imports.raw_json 写入后零消费**：48 字段 JSON ~1.2KB/行，writer 只读 `bill_raw_json`（writer.js:181），对账 SQL 只取币种/金额单列；bill 侧 v2.1.8 N4 已瘦身，flow 被漏掉 | 全库 grep 无 flow raw_json SELECT | INSERT 8.64s→1.64s（**5.28x**）；单月库 **1013MB→77MB** |
| B2 | insertBillRow 每行 `require('./columns')` + 9×`BILL_HEADERS.indexOf()`（import-repository.js:89-94）；insertFlowRow 每行 require（:61） | 代码 | bill INSERT 3.85s→1.97s（**1.96x**） |
| B3 | 两表各 2 个冗余索引：`UNIQUE(month_key, recon_main_id)` 自带唯一索引，`idx_*_join` 与之完全重复、`idx_*_month` 是其左前缀（migrations.js:2498-2531）→ 每行 INSERT 多维护 2 个 B-tree | DDL | 单独删 1.10x；与 B1 叠加 flow INSERT **7.05x**（8.64s→1.22s） |
| B4 | 对账同一个大 JOIN 跑 3 遍：computeRunStats 的 matched + mismatch 两个全量 JOIN COUNT（run-repository.js:561-584）+ stage 4' INSERT 再 JOIN 一遍；且 JOIN 探测回表读含 raw_json 的宽行 | 代码 + bench | stats 合并 + covering index 后对账 DB 段 0.97s→0.43s（**2.24x**，冷缓存/受管机更大） |
| B5 | Windows 写放大链：raw_json 1GB → WAL 1GB（大事务期间无法 checkpoint）→ COMMIT 后 checkpoint 再写 1GB = 物理写 ~2GB，NTFS+Defender 过滤链全程扫两遍；且无主动 checkpoint、无 temp_store 设置 | database.js:86-94 仅 4 条 PRAGMA；全库无 wal_checkpoint 调用 | B1 落地后该链 ×0.08；W1/W2 进一步收编 |

---

## 二、改造方案

### P0 批次（跨平台，Windows 收益自动放大）

#### P0-1 · flow 导入不写 raw_json（对应 B1）🔴
- **改动**：`import-repository.js` `insertFlowRow` — 删除 rawObj 构造 + `JSON.stringify`，`raw_json` 列写 `''`（schema `NOT NULL` 满足，无需 migration；存量数据不动）。
- **不变量**：对账结果与 diff/report 输出 byte-for-byte 不变（diff 输出仅消费 bill raw_json + diff_rows 的 flow_currency/flow_amount_abs 快照列）。
- **风险**：未来若出现「流水侧原始行还原/导出」需求则无数据 → **O-1 需用户确认**。

#### P0-2 · 插入函数 per-row 开销预计算（对应 B2）
- **改动**：`import-repository.js` — 模块顶部 require columns 一次；预计算 `TEMPLATE_BILL_HEADERS → BILL_HEADERS 下标` 映射数组。
- **不变量**：纯等价重构，行为零变化。

#### P0-3 · 冗余索引清理 + covering 升级（对应 B3 + B4 的回表）
- **改动**：`migrations.js` — 新增幂等 migration：
  - DROP `idx_acquiring_bill_currency_flow_month` / `flow_join` / `bill_month` / `bill_join`
  - CREATE `idx_acquiring_bill_currency_flow_join_v2 (month_key, recon_main_id, settle_currency_norm)`；bill 同
  - 同步修改 `ensureAcquiringBillCurrencyTablesSupport` 的初始建索引段（新库直接建 v2 索引）
- **净效果**：每表 B-tree 数 -1（导入更快），对账 JOIN 探测 index-only 不回表。
- **验证**：`EXPLAIN QUERY PLAN` 确认全部 month_key 查询（getMonthReadiness/listMonths/deleteMonthBySide/cleanup 等）落 UNIQUE 自建索引或 v2 索引。

#### P0-4 · computeRunStats 两 JOIN 合并为一（对应 B4）🔴
- **改动**：`run-repository.js` `computeRunStats` — matched/mismatch 用一条 `COUNT(*) + SUM(CASE WHEN <币种不等> THEN 1 ELSE 0 END)` JOIN 得出。
- **等值断言**：bench 已验证（25000 diff 全等）；正式 unit test 覆盖边界（空表 / 全 match / 全 mismatch / NULL 与 '' 币种混合 / 多月共存）。

### W 批次（Windows 专项）

#### W1 · `PRAGMA temp_store = MEMORY`
- **改动**：PRAGMA 清单 **4 处同步**（spec §2.5 契约）：`database.js` + `run-check-worker.js` + `run-check-multiworker-worker.js` + `biz-op-recon-import/import-worker.js`，顺序一致追加；同步更新 §2.5 强制清单文档。
- **收益**：SQLite 临时排序/B-tree 不落 NTFS temp 文件（绕开 Defender 过滤链）。

#### W2 · 导入大事务 COMMIT 后 `wal_checkpoint(TRUNCATE)`
- **改动**：`acquiring-bill-currency-session.js` `importFilesInTransaction` / `importFilesWithOverwrite` — COMMIT 成功后执行 checkpoint（失败仅记日志不抛）。
- **收益**：WAL 立即收编（P0-1 后仅 ~80MB，亚秒级），对账 worker 独立连接读路径无 WAL 回放叠加。

#### W3 · 多 worker 行数闸下调（O-2 已决：本批直接合入）
- **改动**：`acquiring-bill-currency-session.js` `MULTIWORKER_MIN_TOTAL_ROWS` 1000000 → 300000（含注释与配套单测断言同步）。
- **依据**：代码注释自记 POC 50w 行 plan-b 2.31-2.70x 正收益（session.js:206）；SSD + 多核下 CPU 是瓶颈，并行收益成立。
- **剩余风险兜底**：30-50w 区间未在 Windows 实测——但 ① 闸值只影响快慢不影响结果（单/多 worker byte-for-byte contract 已锁）；② D33 内存闸（<2GB 强制单 worker）+ D29 CPU clamp 保留；③ settings workerCount=1 可让用户手动关闭并行。发版后若反馈负收益，回滚 = 改回一个常量。

#### W5 · OneDrive 检测提示 + Defender 排除项指引
- **改动**：
  - `main.js` `ensureStorageRoot` 路径含 `OneDrive` 时启动后单次 toast 提示（导出目录被同步接管会拖慢写盘）；
  - `docs/USER_GUIDE.md` 新增「Windows 性能建议」一节：Defender 排除项（userData 目录 + 文档工作目录）、受管终端联系 IT。
- **形态**：**O-3 用户选**（推荐 检测提示+文档；备选 仅文档）。

### 不在本 spec 实施范围（已评估，记录原因）

| 项 | 原因 | ⚠️ 500w 行量级反转（§八） |
|----|------|--------------------------|
| W4 导入挪 worker | ✅ **已达成（v3.0.3 块 D）**：经通用引擎多文件 worker 并行管道达成，导入全程主进程零阻塞、4-worker 3.06x，见 changes/big-table-import-engine/spec.md（PR-G2/H）。<br>原（2026-06-10 范围扩容）：纳入 v3.0.3 块 D（经通用引擎达成）。<br>更原决策：不缩短总时长，纯体验项；单独 change 立项（复用 run-check-worker-pool 设施） | 500w 下解析 ~130s，挪 worker + 并行成为必做 |
| P1 解析列裁剪（flow 仅需 4/48 列） | ✅ **已达成（v3.0.3 PR-P1 + 块 D）**：PR-P1 收单 reader-handrolled 内列白名单（flow 4/48）1.20x 收口（实测天花板 ~1.4x）；剩余债务由块 D 引擎字节层 row-scanner 偿清（解析段 2.32x，PR-G1）。<br>原（2026-06-10 四次修订）：纳入 v3.0.3 为独立 PR-P1。<br>更原决策：解析段再 1.5-2x，但 allEmpty 语义等价改写需重型 contract test；待 P0 落地后再立项（O-5） | **反转为必做**（解析是 500w 绝对大头） |
| OFFSET→keyset 分页 | 仅 100w+ 行多 worker 自适应分片时退化有感；典型 30w 量级占比可忽略 | **反转为必做**（多 worker 自适应分片下 OFFSET 二次方代价数十秒级） |
| userData Roaming→Local / cache_size 自适应 | P0-1 后库仅 77MB，收益存疑，观察 | 500w 模块库体积重新评估 |

---

## 三、预期效果（30-50 万行标尺）

| 链路 | 现状 | P0+W 后（macOS 实测推算） | Windows SSD 预期 |
|------|------|--------------------------|------------------|
| 流水导入 | ~13-22s | 解析 ~8-13s + INSERT ~0.7-1.2s ≈ **9-14s（1.5x）** | 同左（Defender 扫描量 ×0.08） |
| 单据导入 | ~8-13s | ≈ **5-9s** | 同左 |
| 对账 DB 段 | ~0.6-1s（热） | **~0.3-0.45s（2.2x）**；W3 生效后多核再叠加 | 冷缓存收益更大 |
| 单月库体积 | ~600MB-1GB | **~50-80MB（×0.08）** | WAL/checkpoint/备份全线受益 |

---

## 四、OPEN 决策表（请用户拍板）

| # | 决策点 | 决议 |
|---|--------|------|
| O-1 | flow raw_json 永久不写？ | ✅ **已决（2026-06-10）：永久停写**（零消费实证；diff 快照列已够；存量数据不动） |
| O-2 | W3 闸值 100w→30w 合入时机 | ✅ **已决（2026-06-10）：本批直接合入**（依据 POC 注释 50w plan-b 2.31-2.70x；30-50w 区间未实测的剩余风险由 D33 内存闸 + workerCount settings 兜底，详见 §9.3-W3） |
| O-3 | W5 形态 | ✅ **已决（2026-06-10）：启动检测提示 + USER_GUIDE 文档** |
| O-4 | 版本归属 | ✅ **已决（2026-06-10 二次修订）：纳入 v3.0.3 迭代**（与状态框渠道:场景明细、USER_GUIDE 补全组成 v3.0.3；开工前提 = 用户完成 §九 离线 review） |
| O-5 | P1 解析列裁剪是否立项 | ✅ **已决（2026-06-10 五次修订·最终）：PR-P1/P1b 已落地并以 1.20x 收口**——机制（列白名单+直接定位+allEmpty 等价+三方 harness）全部交付且三层测试全绿；实测解剖（tmp/bench-p1-whitelist.js 含物理地板）证明 1.5x 在当前行切块架构下不可达（上限 ~1.4x：inflate+decode 地板 2.51s + 行切块字符串管理 ~5.5s 列裁剪均不可触及）。**剩余性能债务显式转入块 D PR-G 量化目标**（字节层 row-scanner：单文件解析段 ≥2x + 多文件并行 ≈3x，见 changes/big-table-import-engine/spec.md）。AC-A7 同步修订 |
| O-6 | 未来 500w 行数据源的物理形态 | ✅ **已决（2026-06-10）：多文件单 sheet** → 并行单元=文件级（§8.1-1：多 sheet 遍历降级为防御项） |
| O-7 | 通用引擎（§八 阶段 2）立项时机 | ✅ **已决（2026-06-10 二次修订）：本迭代抽取（仅导入侧）**——收单为首个迁移用户，P1/W4 经由引擎达成；对账侧 keyset 仍留 500w 模块；见 changes/big-table-import-engine/spec.md |

## 五、实施编排（小批次约束：单 PR ≤ 3-5 文件；详细设计见 §九）

| PR | 内容 | 文件 |
|----|------|------|
| PR-A | P0-1 + P0-2 + P0-4 + unit/contract tests | import-repository.js, run-repository.js, tests/unit/** |
| PR-B | P0-3 索引 migration + EXPLAIN 验证 | migrations.js, scripts/integration/** |
| PR-C | W1 + W2 + W3（O-2 决议并入；PRAGMA 4 处同步 + spec §2.5 文档） | database.js, run-check-worker.js, run-check-multiworker-worker.js, import-worker.js, session.js |
| PR-D | W5 + USER_GUIDE | main.js, docs/USER_GUIDE.md |
| PR-P1 | P1 解析列裁剪（O-5 四次修订：独立先做）：flow 列白名单（仅取 4/48 列）+ allEmpty 等价判定 + 与 sax 基线 byte-for-byte contract harness（供块 D 引擎迁移复用） | reader-handrolled.js, tests/**（harness）；前提 = PR-A 合入后 |

## 六、测试与验证计划

1. **资金红线 contract**：P0-1/P0-4 前后对同一 fixture 跑全流程（导入→对账→writer 输出），断言 runs 统计行、diff_rows 全表、diff.xlsx 内容 byte-for-byte 一致。
2. **unit**：computeRunStats 新旧等值（空表/全 match/全 mismatch/NULL+'' 币种/多月共存）；bill 字段映射预计算等值。
3. **EXPLAIN QUERY PLAN**：P0-3 后全部 acquiring SQL 计划核对（无全表扫描回归）。
4. **现有测试**：`npm run release-check` 全绿（unit + integration + smoke；含 v2.1.10 a3/a4、v2.1.12 contract）。
5. **bench 复跑**：`tmp/bench-acquiring-opt.js` 改动前后对比留档；Windows 实机校准一次（W3 依据）。
6. **硬节点**：每 PR 前 `/check-vars`；`npm run scan:vars` 于版本 bump 前刷新。

## 七、风险清单（人工复核点）

- 🔴 P0-1/P0-4 落在资金红线（金额/币种入库 + 对账 SQL）——以 §六-1 contract 为放行闸。
- ⚠️ PRAGMA 4 处同步契约（spec §2.5）：漏一处 → 主/worker 连接行为漂移。
- ⚠️ P0-3 migration 在用户存量库上执行 DROP/CREATE INDEX（30w 行级建索引 ~1-2s，启动期可接受；migration 幂等）。
- ⚠️ W2 checkpoint 失败需容忍（仅日志），不得影响导入成功语义。

---

## 八、模板化展望 — 500w 行量级通用引擎（用户 2026-06-10 提出）

> 背景：用户确认「以后的模块接触的 xlsx 都是 500 万行以上」，并问本次改造能否作为模板复用。
> 结论：**可以，且 P0 实施时即按"留缝"约束写**（见 §8.3）；通用引擎抽取放阶段 2（O-7）。

### 8.0 「通用引擎」定义（O-7 决策依据）

**它是什么**：一组带契约参数的共享库函数（形态对标现有 `runWriteSplitChunks`——它已是 80% 成品的对账引擎），放在 `src/backend/big-table-import/`（暂名）。**不是框架、不是 DSL**。新模块从「复制 500 行 reader 改写」变成「声明 ~50-100 行契约」：

```
业务模块只写契约：{ expectedHeaders, 取值列白名单, 表头/行校验规则,
                    目标表+列映射, 归属键(monthKey)规则, 比对键+比对表达式 }
引擎负责机械部分：yauzl 流式解压 → sheet 定位(rels 正解) → 手写字节扫描
                  → 列白名单裁剪 → 行回调 → prepared INSERT 管道
                  → 大事务/整批拒绝/错误累积/peek 预检/覆盖导入 → checkpoint
                  → [对账] keyset 分片 → 单/多 worker gate → chunked INSERT
                  → chunk_progress/cancel/resume → 单遍 JOIN 统计
```

**职责边界（资金红线切分）**：引擎保证「不丢行、不重行、可中断恢复、byte-for-byte 可复验」；业务模块保证「列取对、规则算对」（金额方向、币种归一等语义永远在契约回调里，不进引擎）。

**它取代什么**：现状每个模块 copy-paste-adapt 一套 reader+编排（已积累 3 套流式 reader 技术债 + PRAGMA 清单 4 处手抄）。引擎落地后 PRAGMA 清单、contract test harness（byte-for-byte 对比脚本范式）一并收敛为单一出口。

### 8.1 硬性架构约束（500w 必须先解决，否则不是慢而是错）

1. **xlsx 单 sheet 上限 1,048,576 行** → ✅ O-6 已决：数据源为**多文件单 sheet**（每文件 ≤104.8w 行），并行单元 = 文件级（收单现有多文件 for 循环编排即骨架）。多 sheet 遍历降级为**防御项**：仍做 rels 正解定位唯一 sheet（biz-op-recon/reader-streamed.js:67-109 已有实现——防"物理名不是 sheet1.xml"，该坑已踩过），发现多 sheet 时显式报错拒绝而非静默丢数据（收单 reader 现状 reader.js:23 硬编码会静默丢）。
2. **ZIP 基座必须 yauzl**：JSZip 基座（pending-import/streaming-xlsx-reader.js:213 `loadAsync(buffer)` 整文件进内存）在 ~100w 行 / 3.8GB 解压 entry 实测崩（reader-handrolled.js:7 POC 记录）。单文件 104.8w 行 ×48 列解压后 ~3-4GB，恰在 JSZip 崩点上——500w 量级仅 yauzl 路线可用（100w 行已验证）。
3. **SQLite 单写者**：INSERT 无法并行；并行解析（文件 = 天然并行单元，500w≈5+ 文件喂饱 4-5 worker）→ 单消费者 INSERT 管道是正确拓扑。

### 8.2 可复用资产盘点（模板素材，按成熟度）

| 资产 | 位置 | 复用度 |
|------|------|--------|
| 对账多 worker 执行器 | run-check-multiworker.js `runWriteSplitChunks` | **已参数化**（selectSql/partColumns/targetTable/prefixValues 全是参数），近乎即用 |
| chunked + cancel/resume + chunk_progress | run-repository.js + session.js | 编排模式可平移，SQL 需换 keyset 分页 |
| worker pool + PRAGMA 契约 | run-check-worker-pool.js + spec §2.5 | 即用 |
| yauzl + 手写字节扫描解析 | reader-handrolled.js | 核心算法即用；需参数化（headers/关键列/多 sheet/列白名单） |
| 导入编排（大事务整批拒绝/表头校验/错误累积/peek/覆盖导入/W2 checkpoint） | session.js + reader | 业务模式可平移 |
| 存储契约模式（P0-1/P0-3/P0-4：只存对账列 + 快照列、covering index、单遍 JOIN 统计） | 本 spec | 设计原则直接套用 |

### 8.3 P0 实施时的「留缝」约束（本批次成本增量极小）

- P0-2 预计算映射写成「headers 契约 → 下标映射」的纯函数，不内联收单专名。
- P0-3 covering index 命名/结构注释中写明「对账 JOIN 探测列 = (分区键, 业务键, 比对键) 」通用模式。
- P0-4 合并 stats SQL 抽成模板注释（matched/mismatch 单遍 JOIN 的 SUM(CASE) 范式）。
- 不做提前抽象：不建 `big-table-import/` 目录、不改三套 reader 现状——等 O-7 时机。

### 8.4 500w 行量化推演（基于 50w 实测线性外推 + 非线性项）

| 段 | 现架构直接跑 500w | 通用引擎后（估） |
|----|-------------------|------------------|
| 解析 | ~130s（多文件可读但串行） | 列白名单 ~70s → 多文件 4-5 worker 并行 ~20-35s |
| INSERT | ~86s（含 raw_json）| 瘦身+减索引 ~15-25s，与解析管道重叠 |
| 导入端到端 | ≈ 3.5-4 分钟（错误结果） | **~40-60s** |
| 对账 DB 段 | OFFSET 二次方 + 回表，~60-120s | covering + keyset + 多 worker（500w 是 D31 主场）**~5-10s** |
| diff writer | 5% mismatch = 25w 行 | ExcelJS streaming ~20-30s（已游标化，可接受） |
| 库体积/月 | 失控 | bill 快照 ~1.5-2GB → raw_json retention（v2.1.10 idle 清理）必须随引擎平移 |

### 8.5 存量模块适配清单（2026-06-10 全仓调研）

**导入引擎潜在用户（按迁移优先级）**：

| 模块 | 现状 reader / worker | 实证量级 | 适配度与动机 |
|------|---------------------|---------|-------------|
| 收单单据 | yauzl+手写（引擎前身）/ worker_threads | 30-100w 验证 | ✅ 原型（本 spec P0 留缝） |
| 挂账 pending | JSZip 流式 / **child process 8GB heap** | **121w 实证，300w 设计**（worker.js:67/79） | ✅✅ **最高优先**：300w×31 列 sheet ≈3-4GB **正撞 JSZip 3.8GB entry 崩点**；child process → worker_threads 顺带统一 |
| 业务OP核对 biz-op-recon | JSZip+SAX（reader-streamed）/ utilityProcess | 百万行（注释实证，曾撞 SheetJS 512MB 上限） | ✅✅ 高优先：同 JSZip 崩点风险 |
| VCC OP 计算 | JSZip+SAX | 78.7w/811MB 实证 | ✅ 高优先：同上；多 sheet 表头匹配逻辑已有，易契约化 |
| 链接表 linked-table | v3.0.2 spec 选 JSZip 流式（**待实施**） | 65.7w 实证（增长中） | ✅ **跨 spec 风险**：1.72GB 已达崩点一半，建议该 spec 留 yauzl 切换缝 |
| 银行BU回填 bank-bu-recon | SheetJS 全量 | <10w | ⚠️ 可选（量级小无痛点） |
| 主流程账单 file-service | SheetJS 全量 + 动态列映射模板 | 几千-几万 | ❌ 不迁（另一范式） |

**对账引擎适配（编排层与比对语义分开评）**：

| 模块 | 对账范式 | 编排层（chunked/cancel/resume/worker） | 比对核心 |
|------|---------|----------------------------------------|---------|
| 收单 | 两表 SQL JOIN 等值比对 | ✅ 原型 | ✅ SQL 契约即用 |
| 未来 500w 模块 | （若两表 JOIN 范式） | ✅ | ✅ |
| 挂账 pending | 多轮单字段 1对1 配对（SQL 驱动，engine.js） | ✅ 可复用（百万行配对正需要 chunked+cancel） | ⚠️ 配对 SQL 语义特殊，留契约 |
| 业务OP biz-op | 4 步 JS 内存算法（session.js:136 聚合在 JS） | ⚠️ 部分 | ❌ JS 语义不强迁 |
| 银行BU / VCC / 5轮编排 orchestrator | 配对+比对 / 聚合计算 / 内存多轮回填 | ❌ 量级小或范式不同 | ❌ |

**收敛价值**：现存 **3 套 reader 基座**（SheetJS 全量 / JSZip 流式 / yauzl 手写）+ **3 种 worker 模型**（child process / utilityProcess / worker_threads）+ 4 处手抄 PRAGMA → 引擎统一为 yauzl + worker_threads 池 + 单一 PRAGMA 出口。

### 8.6 演进路径

```
阶段 1（本 spec P0+W）：收单模块内实施 + 留缝（§8.3）→ 验证模式、拿到 Windows 实测
阶段 2（O-7 触发）：抽通用引擎（§8.0：yauzl 基座 + rels 正解 sheet 定位 + 列白名单
                  + 多文件并行解析→单写 INSERT 管道 + keyset chunked 对账 + runWriteSplitChunks），
                  首个 500w 模块直接用，收单迁移作第二用户，顺带收敛三套 reader 技术债
```

---

## 九、实施级详细设计（PR-A ~ PR-D）

> 本章为 O-4 用户指示「先详细写一版 spec」的产物。每个 PR 给出：改动点（文件/函数/前后形态）、受影响测试清单、验收标准、回滚方式。
> **PR-A~D 开工前提（用户 §九 review）已于 2026-06-10 达成**——本章 PR-A~D 进入开工状态。
> 🔴 通用约束：每 PR 提交前跑 `/check-vars` + `npm run release-check`；commit message 格式 `[acquiring-import-recon-perf] <简述>`。

### 9.1 PR-A — P0-1 停写 flow raw_json + P0-2 预计算 + P0-4 stats 合并

#### 9.1.1 P0-1 · `insertFlowRow` 停写 raw_json

**文件**：`src/backend/acquiring-bill-currency-db/import-repository.js`

**改动前**（line 47-71 现状骨架）：
```js
function insertFlowRow(stmt, { monthKey, sourceFile, row, importedAt }) {
  // ... reconMainId / settleAmount / settleAmountAbs / settleCurrency 提取（不变）
  const rawObj = {};
  const FLOW_HEADERS = require('./columns').FLOW_HEADERS;   // ← 每行 require
  for (let i = 0; i < FLOW_HEADERS.length; i++) { rawObj[FLOW_HEADERS[i]] = ...; }
  rawObj[FLOW_HEADERS[0]] = normalizeBillDate(rawObj[FLOW_HEADERS[0]]);
  const rawJson = JSON.stringify(rawObj);                    // ← 48 字段 stringify
  stmt.run(..., rawJson, importedAt);
}
```

**改动后**：
```js
function insertFlowRow(stmt, { monthKey, sourceFile, row, importedAt }) {
  // ... 提取段逐字不变 ...
  // O-1 决议（2026-06-10）：flow raw_json 永久停写（全代码库零消费实证；
  //   writer 仅读 bill_raw_json；diff 输出的流水侧字段来自 diff_rows.flow_currency/flow_amount_abs 快照列）。
  //   schema raw_json TEXT NOT NULL → 写 ''；存量行不动。
  stmt.run(monthKey, sourceFile, rowIndex, reconMainId, settleAmount, settleAmountAbs,
    settleCurrency, settleCurrencyNorm, '', importedAt);
}
```

**连带变化**：
- `normalizeBillDate` 在 flow 侧的调用随 rawObj 一起删除（它只服务 raw_json 内容；`month_key` 来自 reader 层 `extractMonthKey`，不受影响）。bill 侧调用保留。
- flow 侧不再依赖 `FLOW_HEADERS` → P0-2 的 flow 部分自动消解。
- **不改 schema、不加 migration**：`raw_json TEXT NOT NULL` 由 `''` 满足。

**受影响测试排查清单**（实施时逐个跑，断言 raw_json 内容的改为断言 `''`）：
- `tests/unit/backend/acquiring-bill-currency-db/import-repository.test.js`（几乎必含 flow raw_json 内容断言）
- `tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js`（retention 只清 bill，flow 部分若有 fixture 需核）
- `tests/unit/backend/acquiring-bill-currency-import/reader-handrolled-contract.test.js`（contract 比 reader 输出，理论不涉 DB 行；核验即可）
- `tests/unit/main-process/acquiring-multiworker-contract.test.js`、`tests/unit/backend/acquiring-bill-currency-db/run-repository.test.js`（fixture 构造若手插 flow raw_json，不影响断言；核验）
- `scripts/integration/acquiring-bill-currency-n4-migration.js`、`acquiring-bill-currency-idle-cleanup.js`（bill raw_json 主题，flow 仅 fixture；核验）

#### 9.1.2 P0-2 · bill 侧字段映射预计算

**文件**：同上。模块顶部新增（require 段之后）：
```js
const { FLOW_HEADERS, BILL_HEADERS, TEMPLATE_BILL_HEADERS } = require('./columns');
// 预计算：TEMPLATE 9 字段 → BILL_HEADERS 下标（每行 9×26 indexOf → 模块加载时一次）
//   通用模式（§8.3 留缝）：headers 契约 → 下标映射的纯数据，不内联业务名
const TEMPLATE_BILL_KEY_INDICES = TEMPLATE_BILL_HEADERS
  .map((key) => [key, BILL_HEADERS.indexOf(key)])
  .filter(([, idx]) => idx >= 0);
```
`insertBillRow` 内 `require('./columns')` 与 `indexOf` 循环替换为遍历 `TEMPLATE_BILL_KEY_INDICES`；其余（`normalizeBillDate`、`JSON.stringify`）不变。

#### 9.1.3 P0-4 · `computeRunStats` 单遍 JOIN

**文件**：`src/backend/acquiring-bill-currency-db/run-repository.js`（line 561-584 替换）

**改动后 SQL**（totalBillRows 单独 COUNT 不变；matched/mismatch 合并）：
```sql
SELECT
  COUNT(*) AS matched,
  COALESCE(SUM(CASE WHEN COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
                    THEN 1 ELSE 0 END), 0) AS mismatch
FROM acquiring_bill_currency_bill_imports b
INNER JOIN acquiring_bill_currency_flow_imports f
  ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
WHERE b.month_key = ?
```
- 🔴 **空集陷阱**：`SUM()` 对 0 行返回 `NULL`（非 0）→ 必须 `COALESCE(..., 0)`。bench 版未踩到是因为有数据；正式实现必带。
- 🔴 mismatch 的 `CASE WHEN` 比较表达式必须与 `DIFF_TYPE_CASE_SQL` 所在 JOIN（`DIFF_JOIN_BODY_SQL` 的 WHERE）**逐字同源**——建议抽共享常量 `CURRENCY_MISMATCH_PREDICATE_SQL`，stats 与 chunked INSERT 两处引用，防漂移（同 v2.1.12 β.1-T2 的 DRY 手法）。
- 返回形状 `{ totalBillRows, matchedRows, mismatchRows, unmatchedRows }` 不变（unmatched = total − matched）。

#### 9.1.4 测试设计

**新增 unit**：`tests/unit/backend/acquiring-bill-currency-db/run-repository-stats-merge.test.js`
- 旧 3-SQL 实现内联进测试作基线，对同一临时库断言新旧 4 字段全等。
- 用例：① 空两表 ② 全 matched 无 mismatch ③ 全 mismatch ④ NULL 与 '' 币种混合（双侧）⑤ 多月共存只算目标月 ⑥ 存在 unmatched（bill 有 flow 无）。

**契约回归**：`scripts/integration/v2.1.10-a3-phase1.js`（直调 vs worker byte-for-byte）+ 现有全部 acquiring 集成用例；P0-1 后全链（导入→runCheck→writer）跑通且 diff.xlsx 内容与统计一致。

#### 9.1.5 验收与回滚
- 验收：`npm run release-check` 全绿；§9.1.4 新 unit 全过；bench 复跑 flow INSERT ≥4x、bill ≥1.7x（Mac 口径）。
- 回滚：单 commit revert（无 schema/数据迁移，无状态残留）。

### 9.2 PR-B — P0-3 索引瘦身 + covering 升级

#### 9.2.1 migration（`src/backend/database/migrations.js`）

新增幂等函数（runMigrations 清单尾部注册）：
```js
// acquiring-import-recon-perf P0-3：删冗余索引（UNIQUE(month_key,recon_main_id) 已覆盖
//   idx_*_month 前缀 + idx_*_join 全键）；join 索引升级 covering（+settle_currency_norm）
//   → 导入每行少维护 1 B-tree；对账 JOIN 探测 index-only 不回表（通用模式：分区键+业务键+比对键）
function ensureAcquiringBillCurrencyIndexSlimV2(db) {
  db.exec('BEGIN');
  try {
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_flow_month');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_flow_join');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_bill_month');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_bill_join');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join_v2
      ON acquiring_bill_currency_flow_imports(month_key, recon_main_id, settle_currency_norm)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join_v2
      ON acquiring_bill_currency_bill_imports(month_key, recon_main_id, settle_currency_norm)`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
```
- `ensureAcquiringBillCurrencyTablesSupport` 初始建表段同步：旧 4 个 CREATE INDEX 删除、改建 2 个 v2（`idx_bill_source_file` 保留）——新库一步到位，老库由上面函数迁移。
- 迁移时长：30w 行/表建 covering ~1-2s（启动期同步，有 N4 更重先例）。

#### 9.2.2 EXPLAIN QUERY PLAN 验证清单（集成脚本断言无全表扫描回归）

| SQL 来源 | 预期计划 |
|---------|---------|
| getMonthReadiness 两个 COUNT / listMonths / deleteMonthBySide / clearMonth / cleanup 批删子查询 / listSourceFilesByRun | UNIQUE autoindex 或 v2 索引前缀（`SEARCH ... USING [COVERING] INDEX`） |
| computeRunStats 合并 SQL | 双侧 v2 covering（无 `SEARCH TABLE` 回表行为劣化） |
| chunked INSERT 子查询（`WHERE month_key=? ORDER BY id`） | 留档现计划；只验不劣化（PK 扫或索引+sort 均可接受，OFFSET 问题属 §八阶段 2 keyset 范畴） |

新增 `scripts/integration/acquiring-index-slim-v2.js`：老 schema 库 fixture → 跑 migration → 断言索引清单（`PRAGMA index_list`）+ 上表 EXPLAIN 含 `USING INDEX` + 对账结果与迁移前一致。

#### 9.2.3 验收与回滚
- 验收：集成脚本过 + release-check 全绿 + bench 对账段 ≥1.8x（Mac 口径）。
- 回滚：反向 migration（DROP v2 + 重建旧 4 索引）；或直接 revert（旧库已被改的，回滚版启动时 CREATE IF NOT EXISTS 自愈重建旧索引——需在回滚 commit 中保留旧建索引段）。

### 9.3 PR-C — W1 temp_store + W2 checkpoint + W3 闸值

#### W1（PRAGMA 4 处同步，🔴 spec §2.5 顺序契约）
- 追加 `PRAGMA temp_store = MEMORY;` 于 **mmap_size 之后**（主进程清单尾；worker 清单中 busy_timeout 之前）：
  1. `src/backend/database.js`（:94 后）
  2. `src/main-process/run-check-worker.js`（PRAGMA 清单 + **verify 映射加 `temp_store: 2`**——MEMORY 的查询返回值是整数 2）
  3. `src/main-process/run-check-multiworker-worker.js`（同上含 verify）
  4. `src/backend/biz-op-recon-import/import-worker.js`
- 同步更新 §2.5 强制清单注释（4 文件内注释 + 本 spec 此节为新的 source of truth）。

#### W2（`src/main-process/acquiring-bill-currency-session.js`）
`importFilesInTransaction`（:79）与 `importFilesWithOverwrite`（:134）的 `db.exec('COMMIT')` 之后：
```js
// W2：导入大事务后立即收编 WAL（Windows 写放大 + 对账 worker 读路径免 WAL 回放）
//   失败仅记日志不抛——checkpoint 失败不影响导入成功语义（数据已 COMMIT）
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); }
catch (cpErr) { appendModuleLog({ level: 'warning', source: 'main', domain: 'acquiring-bill-currency',
  message: '[acquiring-bill-currency] wal_checkpoint 失败（不影响导入结果）',
  details: [cpErr && cpErr.message ? cpErr.message : String(cpErr)] }); }
```

#### W3（同文件 :209）
`MULTIWORKER_MIN_TOTAL_ROWS = 1000000` → `300000`，注释追加 O-2 决议依据与回滚说明。受影响测试排查：`tests/unit/main-process/acquiring-multiworker-contract.test.js` 及 session 单测中以 100w 为边界的 gate 用例（断言值同步 30w；gate 逻辑本身不改）。

#### 验收与回滚
- 验收：4 文件 PRAGMA 清单 diff 一致 + worker verify 通过 + release-check 全绿 + 手测一次 30w+ 行对账走多 worker（progress 出现 multiWorker 路径、无 fallback 诊断字段）。
- 回滚：三项互不依赖，可独立 revert；W3 回滚 = 常量改回。

### 9.4 PR-D — W5 OneDrive 检测提示 + USER_GUIDE

- **检测**（`src/main.js`）：仅 `process.platform === 'win32'`；`ensureStorageRoot()` 结果 `/onedrive/i` 命中 → 用 **Electron `Notification`**（复用 notifyAcquiringBillCurrencyResult 同款机制，零 renderer/preload 改动）提示一次：「导出目录位于 OneDrive 同步路径，大文件导出可能变慢，建议在 OneDrive 设置中排除该目录」。
- **防重**：settings 新增 key `win_onedrive_storage_notice_shown`（settings-repository 现有 get/set 范式），提示后置 '1'。
- **文档**（`docs/USER_GUIDE.md`）新增「Windows 性能建议」：① Defender 排除项（`%APPDATA%` 下 userData 目录 + `Documents/网银账单生成小助手`；受管终端联系 IT）② OneDrive 重定向说明 ③ 与本批次性能改进的简述。
- 验收：win32 模拟路径单测（检测函数纯函数化便于测试）+ 文档 review。回滚：revert。

### 9.5 全局验收与留档

1. 四 PR 各自 release-check + `/check-vars` 全过；合并前 `npm run scan:vars` 刷新。
2. `tmp/bench-acquiring-opt.js` 改动前后各跑一次留档进 `docs/iterations/<版本>/`（O-4 定版后归位）。
3. Windows 实机（SSD）跑一次 bench 校准并留档——作为 §八阶段 2 引擎立项的输入基线。
4. 手测清单：30w 行真实文件导入（耗时/进度/取消）→ 对账（多 worker 命中）→ diff.xlsx 打开核对 → clearMonth → 重导覆盖路径。
