# Spec — 通用大表导入引擎（big-table-import）· 导入侧 + 收单首迁（v3.0.3 块 D）

> 状态：**已实施（PR-G1/G2/H 全部落地，release-check 全绿）** ｜ 目标版本：v3.0.3 块 D
> 性质：🔴 **资金红线**（收单导入链路换引擎；byte-for-byte contract 为放行闸）
> 决议链：O-7 二次修订（2026-06-10 本迭代抽取·仅导入侧）→ P1 路径修订（PR-P1 独立先做）→ O-5 五次修订（P1 以 1.20x 收口，**行切块/字节层性能债务转入本 spec PR-G 量化目标**）
> 上游输入：`changes/acquiring-import-recon-perf/spec.md` §八（引擎定义 §8.0 / 约束 §8.1 / 资产盘点 §8.2 / 适配清单 §8.5）+ PR-P1/P1b 实测解剖（本 spec §4 依据）

---

## 一、目标与范围

### 1.1 做什么
1. **引擎（导入侧）**：`src/backend/big-table-import/` 一组带契约参数的共享库（非框架），覆盖：yauzl 流式解压 → rels 正解 sheet 定位 → **字节层 row-scanner**（含列白名单直接定位）→ 行回调 → 导入编排（大事务整批拒绝 / 错误累积上限 / peek 预检 / 覆盖导入 / COMMIT 后 checkpoint）→ **worker 化整体管道**（主进程零阻塞 + 多文件并行解析、按文件序单写）。
2. **收单首迁（= W4 达成）**：收单 flow/bill 导入切换到引擎，`session.importFlowFiles/importBillFiles` 对 main.js 的接口不变；迁移后导入期间主进程不再执行解析与 INSERT（W4 体验目标），多文件场景并行解析。
3. **性能量化目标**（承接 O-5 五次修订转入的债务）：
   - 单文件解析段 ≥2x（vs PR-P1b 现状 9.98s/50w；依据 §4 解剖：字节层可同时吃掉行切块 ~5.5s 与解码地板 2.51s 的大部分）
   - 多文件并行（4 worker）≈3x 叠加
   - 500w 行（5+ 文件）导入端到端 ~40-60s（vs 现架构串行推算 ~150s+）

### 1.2 不做什么
- 对账侧 keyset 分页（30w 量级 OFFSET 无感，留 500w 模块需求确立时）。
- pending / biz-op / vcc / linked-table 的迁移（本迭代只交付引擎 + 收单首迁；适配结论已留档于 acquiring spec §8.5，后续迭代按崩点压力排期——pending 优先）。
- 多 sheet 数据读取（O-6 已决：数据源为多文件单 sheet）；引擎做 **rels 正解定位唯一 sheet + 发现多 sheet 显式报错**（防御项，杜绝收单现状 reader.js:23 硬编码 sheet1 的静默丢数据模式）。

---

## 二、架构

### 2.1 目录与组件

```
src/backend/big-table-import/
├── engine.js            # 入口编排：importFiles({ dbPath, files, contractModulePath, contractOptions,
│                        #   mode: 'append'|'overwrite', monthKey, parallel, onProgress }) → 在 import worker 进程域执行
├── zip-reader.js        # yauzl 打开 + workbook.xml(.rels) 正解定位唯一 sheet（多 sheet 报错）+ sharedStrings
│                        #   （自收单 reader.js openZipWithEntries/loadSharedStrings 平移泛化；
│                        #    rels 正解参照 biz-op-recon/reader-streamed.js:67-109 既有实现）
├── row-scanner.js       # 🔴 字节层行扫描器（§4）：Buffer 上扫 <row 边界 + 白名单直接定位 + 局部解码
├── import-worker.js     # worker_threads 入口：单文件「解析+契约行变换」（纯 CPU，不碰 DB）
├── pipeline.js          # 多文件并行调度：N 个解析 worker → 主 worker 按文件序消费 → 单连接 INSERT
└── contract.js          # 契约 schema 校验 + 必需列静态推导（§3 三层防护第 1 层）
```

### 2.2 进程拓扑（W4 的实现形态）

```
主进程（Electron main）
  └─ dispatch（复用 run-check-worker-pool 模式：jobId / onProgress 转发 / onLog 管道 / cancel）
       └─ import 主 worker（worker_threads；持 DB 写连接，PRAGMA 按 §2.4 契约）
            ├─ 解析子 worker ×N（文件级并行；纯解析无 DB；contractModulePath require 行变换）
            └─ 单写循环：严格按文件 index 顺序消费各文件行批 → prepared INSERT →
               大事务 BEGIN/COMMIT（整批拒绝语义不变）→ COMMIT 后 wal_checkpoint(TRUNCATE)（W2 平移）
```

- **按文件序单写**：解析完成顺序乱，但 INSERT 必须按文件 index 序（文件 i 全部行先于 i+1）→ 表内 rowid 顺序与现状串行导入一致 → 对账 chunked 按 id 切片的顺序不变 → byte-for-byte 口径最干净。
- **缓冲策略 v1**：每文件解析产物全量缓冲（白名单裁剪后行负载小：收单 flow 4 列 ≈ 60-170MB/百万行文件），`maxParallel`（默认 min(4, cpus-2)）限制并发文件数；message+ack 节流与流式背压留 v2（500w 实测后再评估）。
- **cancel**：沿用 CancelError 语义——解析子 worker terminate + 主 worker 事务 ROLLBACK（整批拒绝天然支持中断=放弃）。

### 2.3 契约接口（业务模块声明，~50-100 行/模块）

```js
// 契约模块（worker 内 require，必须可序列化定位：路径 + options）
module.exports = {
  expectedHeaders,                  // string[] 表头契约（全列；表头行恒全列解析）
  valueColumnWhitelist,             // number[] | null 取值列白名单（null=全列；§3 防护约束其下限）
  validateHeaders(cells),           // → { ok, error, detailLines }
  mapRow({ rowR, values, ctx }),    // 行变换：返回 { params: [...] }（INSERT 绑定参数）
                                    //   | { skip: true }（空行等）
                                    //   | { error: { rowIndex, reason } }（累积，达上限整批拒绝）
  insertSql,                        // prepared INSERT 语句（列即存储契约）
  requiredColumns,                  // number[] 业务声明的必需列（monthKey 提取列、校验列等）
  monthKeyOf({ values }),           // 归属键提取（跨月混杂校验由引擎做）
};
```
错误累积上限（MAX_COLLECTED_ERRORS=100）、跨月校验、peek 预检、覆盖导入（先 DELETE 单侧再导）均为引擎编排，语义平移自收单 session/reader 现行为。

### 2.4 PRAGMA 契约（第 5 处）

import 主 worker 的 DB 连接按既有强制清单（foreign_keys → WAL → synchronous → cache_size → mmap_size → temp_store + busy_timeout 30s）+ verify 映射（temp_store: 2）——成为继 database.js / run-check-worker / run-check-multiworker-worker / biz-op import-worker 之后的**第 5 处契约成员**；引擎落地后建议后续迭代将清单收敛为单一导出模块（本迭代不做，避免面扩大）。

---

## 三、列白名单的三层防护（🔴 漏列 = 静默数据错误的对策）

> 依据：2026-06-10「列裁剪应用到其他模块的影响」分析。白名单漏配一列不报错——该列恒空串，若被消费即静默空值入库（资金场景=金额/币种静默丢失）。

1. **静态推导校验（引擎启动时）**：`contract.js` 推导必需列集合 = `requiredColumns ∪ monthKey 列 ∪ insertSql 绑定涉及列（由 mapRow 声明）`；`valueColumnWhitelist` 非 null 时必须 ⊇ 必需列集合，否则**拒绝启动**（throw 配置错误，绝不带病运行）。
2. **byte-for-byte contract 范式（每模块迁移时）**：白名单版 vs 全列版（whitelist=null）同 fixture 全等——PR-P1 已建成的三方 harness 平移泛化为引擎标准件。
3. **默认安全**：白名单 opt-in；不声明 = 全列解码 = 行为与逐 cell 全解码逐字节相同。

各模块适用性结论（留档自 acquiring spec §8.5 调研）：收单 flow 4/48 高收益、VCC ~5/28 高收益且零约束（流水不入库）、pending/biz-op/linked-table 全列入库 → 白名单传 null（收益来自 yauzl 防崩点 + 并行管道）。

---

## 四、字节层 row-scanner（PR-G 性能核心）

### 4.1 设计依据（PR-P1/P1b 实测解剖，50w 行 / 1797MB 解压后字符量）

| 层 | 现状耗时 | 字节层方案 |
|----|---------|-----------|
| inflate + StringDecoder 全量转 JS 字符串 | 2.51s（地板） | **不再全量转字符串**：Buffer 直接扫描，仅对取值局部（目标 cell body）做 `buf.toString('utf8', start, end)` → 地板大部分消除 |
| 行切块字符串管理（indexOf + 每行 slice 推进缓冲） | ~5.5s | **Buffer.indexOf(Buffer.from('<row')) + 整数游标推进**，跨 chunk 半行用小缓冲拼接；零字符串拷贝 |
| cell 解析（P1b 直接定位后） | ~2s | 白名单 ref 串预编码为 Buffer（`r="A`+rowR 字节拼接），Buffer.indexOf 直接定位（P1b 语义平移：含右引号防前缀误命中 / 同列重复取最后 / `<c` 归属验证 / hasAnyCellText 等价探测与退化路径） |

- UTF-8 安全性：`<row`/`r="` 等定位锚点均为 ASCII 字节序列，UTF-8 多字节字符不含 ASCII 字节 → Buffer 级 indexOf 无误命中风险；中文内容只在取值局部解码时处理。
- 目标：单文件解析段 9.98s → **≤5s（≥2x）**；验收以 bench（§6.3）为准。

### 4.2 等价性
- row-scanner 输出契约与 PR-P1b 的 `{ rowR, values, hasAnyCellText }` 完全一致；
- PR-P1 三方 harness 升四方：sax 基线 ≡ 手写全列 ≡ 手写白名单（P1b）≡ **引擎字节层**——逐行逐列值 / monthKey / importedCount / 错误信息全等；
- 真实 50w/100w fixture 全量对比（沿 v2.1.12 parser-compare 的 SHA1 范式）。

---

## 五、收单首迁（PR-H = W4 达成）

1. 新增契约模块：`acquiring-bill-currency-import/contract-flow.js` / `contract-bill.js`（从 import-repository 的 insertFlowRow/insertBillRow 提取 mapRow + insertSql；flow 白名单 {0,6,28,29}、bill null——bill 裁剪留后续单独评估）。
2. `acquiring-bill-currency-session.js`：`importFilesInTransaction`/`importFilesWithOverwrite` 改为 dispatch 引擎（接口对 main.js 不变；progress 事件形状不变——`{ sourceFile, importedCount }` 每 1w 行节流平移）；W2 checkpoint 移交引擎编排（session 内两处删除）。
3. **回退预案**（沿 v2.1.12 reader 切换模式）：reader-handrolled.js 原封保留；session 内单行开关（require 引擎适配层 ↔ 直调 reader-handrolled）——出问题一行回退。
4. UNIQUE 冲突 / 跨月 / 表头错误的报错文案与 detailLines 结构 byte-for-byte（harness 锁）。
5. ⚠️ main.js 的 `acquiringBillCurrencyOperationLock`（导入/对账互斥）语义不变——引擎 dispatch 仍在 handler 持锁区间内 await。

## 六、PR 拆分与验收

| PR | 内容 | 文件（≤5） | 验收 |
|----|------|-----------|------|
| **PR-G1** | 引擎核心（zip-reader + row-scanner + contract 三层防护）纯新增不接线 | big-table-import/{zip-reader,row-scanner,contract}.js + unit | 四方 harness 全等（用收单契约作测试契约）；row-scanner bench ≥2x；多 sheet fixture 显式报错 |
| **PR-G2** | 管道 + worker 化（engine/pipeline/import-worker + pool dispatch）纯新增 | big-table-import/{engine,pipeline,import-worker}.js + 集成脚本 | 多文件并行 byte-for-byte（rowid 序=串行导入）；cancel<5s；PRAGMA 第 5 处 verify；4-worker bench ≈3x |
| **PR-H** | 收单迁移接线 + 回退开关 + 契约模块 | contract-flow/bill.js + session.js + 集成回归 | 全链（导入→对账→writer）与迁移前 byte-for-byte；release-check 全绿；手测导入期 UI 流畅（W4）+ 取消 + 覆盖导入 |

### 6.3 bench 与留档
`tmp/bench-p1-whitelist.js` 扩展引擎组（50w/100w）；多文件并行 bench 新增（4×50w 文件）；全部数字归档 `docs/iterations/v3.0.3/`。

## 七、风险

- 🔴 导入链路整体换引擎 = 本迭代最大资金红线刀口；放行闸 = 四方 harness + 全链 contract + 单行回退开关。
- ⚠️ worker 化后错误对象跨线程序列化（ImportValidationError.detailLines）——沿 run-check-worker 的 serialize-error 既有方案。
- ⚠️ 并行内存：v1 全量缓冲 × maxParallel，500w 场景理论峰值 ~700MB——D33 同款内存闸（freemem<2GB 降并行度 1）。
- ⚠️ Windows 实机未校准——PR-G1 落地后将 bench 在 Windows SSD 复跑一次留档（W3 同批校准）。

## 八、变更记录

| 日期 | 内容 |
|------|------|
| 2026-06-10 | v1：固化引擎导入侧实施级设计（字节层 row-scanner 承接 O-5 五次修订转入的性能债务；W4 经 PR-G2/H 达成；三层白名单防护；收单首迁 + 单行回退；PR-G1/G2/H 拆分） |
| 2026-06-10 | **实施完成**：PR-G1/G2/H 全部落地，release-check 全绿。row-scanner 最终实现以**单遍字节状态机替代 §4.1 原拟的 Buffer.indexOf 方案**——profile 实证后者约 70% 时间耗在跨界（跨 chunk）搜索上，状态机单遍扫描避开重复回扫。实测：单文件解析段 **2.32x**（50w 4.26s vs P1b 9.87s）、4-worker 并行 **3.06x**、收单全链对比 **34 断言 byte-for-byte**（含 rowid + 报错逐字符）。契约接口落地微调：`mapRow` 的 ctx 增量补 `{sourceFile}`；contract 新增 `formatBatchError` / `errorName` / `deleteSqlForOverwrite` 三个可选字段（覆盖导入 DELETE 语句 + 跨线程错误格式化/错误类名）。单行回退开关常量名 `USE_BIG_TABLE_IMPORT_ENGINE` |
