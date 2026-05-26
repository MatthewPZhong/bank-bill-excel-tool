# Spec — v2.1.8 资金红线评审 + 设计决策

| 字段 | 值 |
|---|---|
| 文档版本 | v0.5（2026-05-26 — F5 范围收敛：T12 实测发现根因 #5（subset-sum 剪枝在大 pool 下误剪），需 ILP/网络流范式重写，延期 v2.1.9；F5 v2.1.8 acceptance 降级为"修复 4/5 根因 + 28-43 行"；用户 2026-05-26 拍板暂停 F5）；v0.4 移除 TEST.xlsx；v0.3 T08 改 F5-D4；v0.2 27 决策；v0.1 起草 |
| 关联 PRD | `PRD-v2.1.8.md` v0.1 |
| 关联 tasks | `tasks.md`（待建） |
| 评审范围 | F5（算法重设）/ A3（跨进程）/ N1（cleanup 移出对账链路）/ N2（配置数据结构变更）/ N3（IPC 字段重命名 + 新 Sheet） |
| 评审豁免 | A4（决策依赖 A3）/ G1（不动业务代码） |

---

## 一、F5 — C4 manyToOne 算法重设 🔴

### 1.1 算法不变量（不可破坏）

- **资金平衡**：`Σ(left subset amount) === right.amount`（subset-sum 等式必须成立）
- **网关单向消费**：每条网关 right 行最多匹配 1 个 left subset
- **first-match-wins**：scenario 命中后 left 行进 rowLockSet 不再被其他 scenario 消费
- **modifiedRows + unmatchedRows = inputRows**（v2.1.7 F8 护栏）

### 1.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| F5-D1 ✅ | maxSize 放开策略 | (a) 完全放开 / (b) 按金额量级动态 / (c) 按 candidates pool size 动态 | **(c)**：pool ≤ 12 全跑；12-20 maxSize=12；> 20 maxSize=10 + warn |
| F5-D2 ✅ | manyToOne 遍历顺序 | (a) 子集大小降序 / (b) 金额降序 / (c) 复合 | **(c)**：金额降序 + 子集大小降序 |
| F5-D3 ✅ | currency 字段过滤 | (a) 加 / (b) 不加 | **(a)**：加 |
| F5-D4 🔄 | BillDate 字符串化位置 | (a) reader 入口 / (b) 引擎入口 | **(b) 引擎入口**（T08 Reverse Sync 2026-05-22 改 — (a) 影响共用函数 sheetToObjects 跨 8 sheet 全部字段，资金红线扩面；(b) 仅在 `c4-recon-id-fix.js:1058-1065` gateway 映射段把 createTime number → ISO 字符串后赋给 BillDate，影响面收敛到 c4 引擎一处）|
| F5-D5 ✅ | 性能护栏 | (a) 单渠道超时降级 / (b) 全局超时 / (c) 不做 | **(a)**：candidates > 25 → 降级 maxSize=8 + 日志 |

### 1.3 fixture 文件映射（2026-05-22 验证）

| spec 代号 | 实际文件名 | 大小 | sheet 结构 |
|---|---|---|---|
| **TEST2.xlsx** | `资金对账导出不平_ADM转JPM 多笔订单对一笔资金-TEST2.xlsx` | 46KB | 对账结果(76) + 网关账单(67) + 渠道账单(73) + **订单修复(57 行)** |
| ~~TEST.xlsx~~ | (历史快照，不作 acceptance) | 42KB | 与 TEST2 前 3 sheet 相同 + 订单修复(0 行) |

**关键性质**：两个文件**前 3 sheet 输入数据完全相同**，仅第 4 sheet「订单修复」不同。
**Reverse Sync v0.4（2026-05-22 用户拍板）**：TEST.xlsx 不作 acceptance ——
- 与 TEST2 前 3 sheet 完全相同 → 算法跑出来必然相同结果 → 无法用"0 行"做回归护栏
- TEST.xlsx 仅作"v2.1.6 算法 bug 历史快照"参考，不进 smoke / 不做断言

### 1.4 F5 acceptance criteria（用户 2026-05-22 拍板，v0.4 修订）

```
输入：TEST2.xlsx 前 3 sheet（对账结果 + 网关账单 + 渠道账单）
真实 scenario 配置：ADM（DB 导出，2026-05-22 T12 实测确认）：
  matchRules: { oneToOne: false, oneToMany: false, manyToOne: true }
  billTypes: MerchantId='6300156616' / merchantId='6300156616'
  reconGroups: Amount/receiveAmount locked
  output: { mode: 'opp', commonId: { source: 'main', suffix: '' } }
  billDateRange: { enabled: true, days: 5 }

F5 跑完后输出「订单修复」sheet：
  - 行数 = 57（= TEST2.xlsx 第 4 sheet A1:N58 数据行）
  - 渠道命中数（unique Reference） = 10
  - 与 TEST2.xlsx 第 4 sheet 逐行等价（按 ReconID 维度）

T12 实测分布（spec F5-D1 档位影响）：
  默认（safety-floor=8）: 28 行 / 9 Ref（= v2.1.7 单点 fix baseline）
  maxSize=16（甜点）:      43 行 / 8 Ref（最佳，距 57 行差 14 行 / 2 Ref）
  maxSize=20+:            21 行 / 6 Ref（非线性退步，PRD §10.3 根因 #4 类似现象）
```

### 1.5 回归保护矩阵（v0.4 修订）

| 用例 | 输入 | v2.1.7 baseline | v2.1.8 期望 | T12 实测 |
|---|---|---|---|---|
| TEST2.xlsx 期望基线 | 真实 ADM scenario | 28 行 / 9 Ref | ≥ 57 行 / 10 Ref | 28-43 行（按 maxSize 档位） |
| TEST2.xlsx T54SWIC494447 子集 | 16 行 = 9,751,101 | 漏（maxSize=8） | 命中 | 部分场景命中（待 spec F5-D1 二次评估） |
| TEST2.xlsx T54SWIC506630 子集 | 11 行 | 漏（maxSize=8） | 命中 | 部分场景命中 |
| TEST2.xlsx T54SWIC470181 子集 | 4M 子池 | 漏（被前面渠道抢） | 命中 | 待验证 |
| 19+ 个 smoke suite | 现有 | 全绿 | 全绿（0 regression） | ✅ 全绿（T08-T11 实测） |

~~TEST.xlsx（0 命中样本）~~ — 已从 v0.4 移除（与 TEST2 输入相同无法独立验证）

### 1.4 G1 协同 unit case 列表

F5 实现过程中必须落的 unit case：

- `parseBillDateMs` 接受 number 序列号（Excel 日期）→ ms（fix BillDate 数字日期）
- `findBestAmountSubset(candidates, target, maxSize=12)` → 子集（验证放开 maxSize）
- `findBestAmountSubset` candidates > 25 → 自动降级 maxSize=8（验证 D5 护栏）
- `tryManyToOnePool` 遍历顺序：金额降序 → 大子集优先（验证 D2）
- `tryManyToOnePool` currency 过滤前后候选池大小（验证 D3）

---

## 二、A3 — runCheck 跨进程化 🔴

### 2.1 IPC / 进程间契约（不可破坏）

- **session.runCheck onProgress 5 阶段语义**（v2.1.7 F6 已固化）：`importing → counting-stats → inserting-run → sql-joining → writing-xlsx → updating-paths`
- **错误类型**：`FileValidationError` 结构（code / message / detail lines / context）必须跨进程保留
- **取消语义**：用户取消后 DB 无锁残留、无 ghost runs 行
- **runId 唯一性**：单次 runCheck 全程使用同一 runId

### 2.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| A3-D1 ✅ | 跨进程方案 | (a) worker_threads / (b) utilityProcess | **(b)** Electron utilityProcess |
| A3-D2 ✅ | DB 连接 | worker 内独立打开 + 同 PRAGMA | **独立**，复用 `database.js` 启动钩子 |
| A3-D3 ✅ | 进度回调链路 | (a) 每 stage / (b) 100ms 节流 | **(b)** 100ms 节流（沿用 F6 范式） |
| A3-D4 ✅ | 错误序列化 | (a) JSON.stringify / (b) structuredClone / (c) 自定义协议 | **(c)** 包装 `{ type:'FileValidationError', code, message, detailLines, context }`，main 端反序列化 new FileValidationError() |
| A3-D5 ✅ | 取消协议 | (a) worker.terminate() / (b) postMessage('cancel') + worker 主动检查 | **(b)** + worker 每阶段入口检查 cancel flag |
| A3-D6 ✅ | 冷启动时机 | (a) 预启动 / (b) lazy / (c) 单例常驻 | **(c)** 单例常驻，worker 异常退出 main 自动重启 |

### 2.3 改动影响面

| 文件 | 改动 |
|---|---|
| `src/main-process/acquiring-bill-currency-session.js` | 拆 runCheck 可跨进程部分（去 Electron 依赖） |
| `src/main-process/acquiring-bill-currency-worker.js`（新建） | worker entry，包含 runCheck 主循环 |
| `src/main-process/acquiring-bill-currency-worker-host.js`（新建） | main 端 worker 单例 + 消息桥接 |
| `src/main.js:10281` | handler 改为通过 worker-host 调度 |
| `src/preload.js` | progress 订阅 API 不变 |
| `src/backend/database.js` | 抽出 PRAGMA 启动钩子函数，worker 端复用 |

### 2.4 回归保护矩阵

| 用例 | 验证手段 |
|---|---|
| 500w 行 runCheck 主窗口仍可交互 | 手测 |
| FileValidationError 跨进程保留 | smoke |
| 取消后 DB 无锁残留 | smoke + pragma_user_count check |
| worker 崩溃自动重启 | smoke kill worker |
| 进度回调 5 阶段依次到达 | 手测 + smoke |
| 19 个 smoke suite 全跑 | npm run smoke |

---

## 三、N1 — cleanup 移出对账链路（β 方案）

### 3.1 不变量

- runCheck 数据完整性：DB 已 COMMIT 的数据不允许丢失
- 启动期孤儿清理（`cleanupOrphanData`）行为不变
- 已有 mutex lock 仍保持 import/run/export/cleanup 互斥

### 3.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N1-D1 ✅ | `cleanupPending` 持久化位置 | (a) runs 表新列 / (b) settings 表 / (c) 内存 | **(a)** `acquiring_bill_currency_runs.cleanup_pending` 列 |
| N1-D2 ✅ | app.before-quit 模态框 | (a) 自定义模态框 / (b) 系统对话框 | **(a)** 自定义模态框，支持进度条（复用 onProgress） |
| N1-D3 ✅ | 进入模块兜底触发点 | (a) renderer 切 tab / (b) IPC handler 入口 / (c) UI 挂载钩子 | **(b)** IPC handler 入口 |
| N1-D4 ✅ | 多 run 累积清理 | (a) 串行 / (b) 并行 | **(a)** 串行清 |
| N1-D5 ✅ | 退出时 cleanup 失败处理 | (a) 仍退 / (b) 阻止退 / (c) 弹错 + 退 | **(c)** console.error + 弹错误 + 仍退出（启动 cleanupOrphanData 兜底）|

### 3.3 改动影响面

| 文件 | 改动 |
|---|---|
| `src/backend/database/migrations.js` | 新增 migration：`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN cleanup_pending INTEGER DEFAULT 0` |
| `src/backend/acquiring-bill-currency-db/run-repository.js` | 新增 `markCleanupPending(db, runId)` / `clearCleanupPending(db, runId)` / `listPendingCleanupRuns(db)` |
| `src/main-process/acquiring-bill-currency-session.js` | runCheck return 前 `markCleanupPending`；移除 main.js 端 setImmediate 触发 |
| `src/main.js:10307` | 移除 setImmediate(cleanupAfterRunBackground) |
| `src/main.js` app.before-quit 钩子 | 新增 `app.on('before-quit', async (event) => { ... })` |
| `src/main.js` acquiringBillCurrency IPC 入口 | 检查 `cleanupPending` runs → 触发后台 cleanup + toast |
| `src/renderer.js` | 监听 cleanup toast 事件 + 退出进度模态框（preload 新增订阅 API） |
| `src/preload.js` | 新增 `onCleanupQuitProgress` + `onCleanupBackgroundToast` 订阅 API |

### 3.4 回归保护

| 用例 | 期望 |
|---|---|
| runCheck 成功后 DB 数据保留 | flow/bill/diff 表均有数据 |
| cleanup_pending=1 标志位 | DB 查询确认 |
| 退出时弹模态框 | 手测 |
| 退出时 cleanup 完成 | 退出后启动查询，表为空 |
| 进入模块兜底触发 | toast 出现 + 后台清完 |
| 启动期孤儿清理仍工作 | 强杀应用后重启验证 |

---

## 四、N2 — 场景配置数据结构变更

### 4.1 不变量

- 旧 scenario 必须 graceful 升级（用户场景库已沉淀，不能丢）
- 模板 bundle v3 reader 必须能读 v2.1.8 新字段（向前兼容）
- 引擎 `c3-gateway-recon-join.js` 已有命中路径不受影响

### 4.2 数据结构变更

#### 旧（v2.1.7 及之前）
```js
config_json.assign = {
  gwField: "Amount",
  bankField: "Credit Amount"
}
```

#### 新（v2.1.8）
```js
config_json.assign = {
  gwField: "Amount",
  bankField: "Credit Amount",          // 'direct' 模式仍保留
  mode: 'direct' | 'custom',           // 新增
  customValue: "用户填写的字符串"      // 'custom' 模式
}
```

### 4.3 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N2-D1 ✅ | 'custom' 模式 bankField 取值 | (a) 保留 / (b) 清空 / (c) 特殊 value | **(c)** `bankField='__CUSTOM__'`，旧 reader 看到时 fallback 不赋值 |
| N2-D2 ✅ | migration 触发时机 | (a) 启动 / (b) lazy / (c) 首次保存 | **(a)** 启动 migration |
| N2-D3 ✅ | "自取值" UI label 文案 | (a) "自取值" / (b) "自定义值" / (c) "固定值" | **(a)** 按用户原话 |
| N2-D4 ✅ | bundle import 行为 | (a) 自动补 mode='direct' / (b) 报错 | **(a)** 静默升级 |
| N2-D5 ✅ | bundle export 行为 | (a) 永远导 / (b) mode='direct' 时省略 | **(b)** 省略，体积更小 + 旧 reader 兼容 |

### 4.4 模板 bundle 兼容性测试

| 场景 | 期望 |
|---|---|
| v2.1.7 bundle 导入 v2.1.8 | scenario 自动补 mode='direct'，行为不变 |
| v2.1.8 bundle（含 custom）导入 v2.1.7 | reader 忽略 mode/customValue，按 direct 路径走，bankField=`__CUSTOM__` 时引擎 fallback 不赋值 + warning |
| v2.1.8 bundle（全 direct）导入 v2.1.7 | mode/customValue 字段缺省，行为完全一致 |

### 4.5 回归保护

| 用例 | 期望 |
|---|---|
| 旧 scenario 自动升级 | 启动后 DB 查询确认 mode='direct' |
| 新建 scenario 选「自取值」+ 保存 | DB 存 mode='custom' + customValue |
| 新建 scenario 选「自取值」+ 空 customValue + 保存 | 校验报错 |
| 引擎 mode='custom' 跑通 | 输出列填 customValue |
| 引擎 mode='direct' 跑通 | 输出列填 chosen.row[gwField]（行为不变） |

---

## 五、N3 — 银行对账单：场景号修复 + Sheet 3 导出

### 5.1 不变量

- `modifiedRows + unmatchedRows = inputRows`（v2.1.7 F8 护栏）
- Sheet 1（渠道对账单）+ Sheet 2（未命中场景行）格式不变
- first-match-wins 行为不变

### 5.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N3-D1 ✅ | displayIndex 派发口径 | (a) repository 层附 / (b) dispatcher 入参时 main.js 算 / (c) UI 与 main 各算 | **(a)** `scenarios-repository.listScenarios` 返回时附 displayIndex，UI 和引擎共享 |
| N3-D2 ✅ | IPC 字段重命名 | `hitScenarioIds` → `hitScenarios: [{id, displayIndex, name}]` | **是**，grep 所有调用方同步 |
| N3-D3 ✅ | Sheet 3 名称 | "命中场景行" | ✓ 用户已拍板 |
| N3-D4 ✅ | 命中场景列位置 | 末尾 | ✓ 用户已拍板 |
| N3-D5 ✅ | 命中场景列值格式 | `[${displayIndex}] ${scenarioName}` | ✓ 用户已拍板 |
| N3-D6 ✅ | Sheet 3 行排序 | (a) inputRows 原顺序 / (b) 按场景分组 | **(a)** 与 Sheet 1 一致，对照查 |

### 5.3 displayIndex 派发口径（D1 详细）

`src/backend/database/scenarios-repository.js`：

```js
function listScenarios(db) {
  const rows = db.prepare('SELECT * FROM scenarios ORDER BY sort_order ASC, id ASC').all();
  return rows.map((row, idx) => ({
    ...row,
    displayIndex: idx + 1  // 1-based 按 UI 显示顺序
  }));
}
```

dispatcher 拿到的 scenarios 数组每个元素都已含 displayIndex；UI `renderer-dialogs.js:5506` 也用同一份。

### 5.4 改动影响面

| 文件 | 改动 |
|---|---|
| `src/backend/database/scenarios-repository.js` | `listScenarios` 返回时附 `displayIndex` |
| `src/main-process/scenario-dispatcher.js:99` | `hitScenarioIds.push(scenario.id)` → `hitScenarios.push({id, displayIndex, name})` |
| `src/main.js:3045` | IPC return 字段 `stats.hitScenarioIds` → `stats.hitScenarios` |
| `src/renderer.js:3319` | 状态框文案改用 `displayIndex` |
| `src/main-process/exceljs-writer.js` | 新增 Sheet 3 写入分支 + 「命中场景」列拼装 |
| `src/main-process/bank-bu-recon-writer.js` 或 `bank-statement-io.js` | exceljs-writer 入参可能需扩展（传 scenarios 映射） |

### 5.5 回归保护

| 用例 | 期望 |
|---|---|
| 状态框序号 = 场景管理 UI 序号 | 手测对比 |
| Sheet 3 行数 = modifiedRows.length | smoke |
| Sheet 3 「命中场景」列值 = `[序号] 场景名称` | smoke |
| Sheet 1 列结构不变 | smoke diff vs v2.1.7 baseline |
| Sheet 2 列结构不变 | smoke diff vs v2.1.7 baseline |
| modifiedRows + unmatchedRows = inputRows | smoke |

---

## 六、整体并行带宽

### 6.1 用户决策（2026-05-22）

✅ **v2.1.8 单版本走完 7 项**（不拆 v2.1.8a / v2.1.8b）

### 6.2 PM 建议串并行

```
Week 1:
  - G1：框架搭建 + 第 1 层 8 个文件铺设
  - F5：spec 阶段 + TEST2.xlsx fixture 准备（与 G1 c4-recon-id-fix unit case 协同）

Week 2:
  - G1：第 1 层剩余 + 第 2 层启动
  - F5：实现 + smoke
  - N2：实现 + dialog + migration

Week 3:
  - G1：第 2 层完成
  - N1：实现 + app.before-quit + migration
  - N3：实现 + dispatcher + writer

Week 4:
  - A3：spec + worker 搭建
  - F5 / N1 / N2 / N3 round 反馈循环

Week 5:
  - A3：实现完成 + smoke
  - A4：决策（做 / 不做）
  - 三件套更新 + check-vars + PR
```

### 6.3 阻塞依赖

- F5 算法重设 → blocks → G1 c4-recon-id-fix unit case
- A3 设计完成 → blocks → A4 决策
- N3-1 displayIndex 派发 → blocks → N3-2 Sheet 3 列值

---

## 七、重要变量升格评估

**v2.1.7 baseline scan:vars 已跑**（2026-05-22）：85 files / 853 top-level names / A-share 146。

PRD 涉及的关键变量在 baseline 中的 A-share 数据：

| 变量 | 跨文件数 | 备注 |
|---|---|---|
| `parseBillDateMs` | 10 | A-share，已跨 10 文件，F5 改动必须 review 全部 |
| `findBestAmountSubset` | 4 | A-share，F5 算法重设核心 |
| `tryManyToOnePool` | 4 | A-share，F5 遍历顺序改造核心 |
| `cleanupAfterRunBackground` | 3 | A-share，N1 触发链路改造 |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | A-share，N2 枚举新增（含 preload 双写坑） |

Phase 0 T02 启动后需对照 `rules/important-variables.md` 评估升格。

| 变量 | 文件 | 当前层级 | 评估建议 |
|---|---|---|---|
| `findBestAmountSubset` | c4-recon-id-fix.js | Critical（已在表） | 保持 |
| `tryManyToOnePool` | c4-recon-id-fix.js | Important-skeleton（已在表？待 grep） | 评估升 Critical（F5 改动重大） |
| `parseBillDateMs` | c4-recon-id-fix.js | 待评估 | 至少 Important-skeleton |
| `cleanup_pending`（DB 新列） | acquiring_bill_currency_runs | 新增 | Risk-sensitive |
| `cleanupAfterRunBackground` | acquiring-bill-currency-session.js | Important-skeleton（已在表？待 grep） | 保持 + 添加 N1-β 触发时机 review 要点 |
| `config_json.assign` | scenarios | 接口契约（待评估） | Risk-sensitive |
| `hitScenarioIds` → `hitScenarios` | scenario-dispatcher.js + main.js + renderer.js | IPC 字段（待评估） | Risk-sensitive（重命名 + 结构变更） |
| `INTERNAL_FIELDS` | exceljs-writer.js | 待评估 | Important-skeleton |
| `displayIndex` | scenarios-repository.js + UI + main | 新增 | Risk-sensitive（跨多层一致性） |
| `BANK_STATEMENT_FIELDS_FOR_C3` | constants/bank-statement-fields.js | 待评估 | Important-skeleton（preload 双写） |

---

## 八、用户最终确认（2026-05-22）

- [x] F5 5 个决策点（F5-D1 ~ D5）✅ 全部按推荐
- [x] A3 6 个决策点（A3-D1 ~ D6）✅ 全部按推荐（A3-D1 = Electron utilityProcess）
- [x] N1 5 个决策点（N1-D1 ~ D5）✅ 全部按推荐
- [x] N2 5 个决策点（N2-D1 ~ D5）✅ 全部按推荐
- [x] N3 6 个决策点（N3-D1 ~ D6）✅ 全部按推荐（N3-D1 = repository 层附 displayIndex）
- [x] 整体并行带宽 5 周 ✅ 已拍板单版本走完

**用户决策口径**：「全按推荐」（2026-05-22）

**Reverse Sync 修订记录**：
- v0.3: F5-D4 reader 入口 → 引擎入口（2026-05-22 T08 实施前调研发现 sheetToObjects 共用函数影响 8 sheet × N 字段，资金红线扩面）— 用户 2026-05-22 拍板方案 C
- v0.4: 移除 TEST.xlsx acceptance（2026-05-22 T12 实测发现 TEST/TEST2 前 3 sheet 相同，算法跑出来必然相同，无法独立验证）— 用户 2026-05-22 拍板「不要看 TEST.xlsx，是错的」
- v0.5: F5 范围收敛 v2.1.8 / 根因 #5 延期 v2.1.9（2026-05-26 T12 深挖发现 subset-sum 剪枝在大 pool 下误剪正确解 — 孤立测试证据：仅 16 行 candidates + maxSize=30 ✅ 0ms 找到；38 行 pool + maxSize=30 ❌ 找不到，需 ILP/网络流范式重写超出 v2.1.8 范围）— 用户 2026-05-26 拍板「先别做 F5 了」

---

**当前状态**：v0.2 定稿。等 v2.1.7 → main 合并 + 用户给「启动 Phase 0」信号后，按 tasks.md T01-T42 推进。
